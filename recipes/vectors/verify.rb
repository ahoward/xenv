#!/usr/bin/env ruby
# frozen_string_literal: true
#
# verify.rb — check an xenv decrypt implementation against the official
# conformance vectors in ./vectors.json, using NOTHING but this file and
# that JSON. No vault, no `xenv` binary, no network.
#
# This doubles as the smallest possible reference read-only loader: given
# (passphrase, salt, iter, envelope) it returns plaintext bytes. Port these
# ~20 lines of crypto to any language and run it against vectors.json to
# prove your loader is correct — that is the whole conformance contract.
#
#   ruby verify.rb            # → prints PASS/FAIL per vector, exits non-zero on any failure

require "openssl"
require "json"
require "base64"

# (passphrase, salt-hex, iter) -> [enc_key, mac_key]
def derive_keys(pass, salt_hex, iter)
  salt = [salt_hex].pack("H*")
  out  = OpenSSL::PKCS5.pbkdf2_hmac(pass, salt, iter.to_i, 64, OpenSSL::Digest.new("SHA256"))
  [out[0, 32], out[32, 32]]
end

# raw envelope string -> plaintext bytes (raises on any tamper / bad key).
# Dual-read: v3 takes salt/iter from the caller (README-frontmatter model);
# v4 is self-contained — salt/iter come from the envelope.
def decrypt(envelope, passphrase, v3_salt, v3_iter)
  parts = envelope.strip.split(":")
  raise "envelope: not xenv" unless parts[0] == "xenv"

  case parts[1]
  when "v3"
    _, _, iv_hex, ct_hex, mac_hex, extra = parts
    salt_hex, iter = v3_salt, v3_iter
    scope = "v3:#{iv_hex}:#{ct_hex}"
  when "v4"
    _, _, salt_hex, iter, iv_hex, ct_hex, mac_hex, extra = parts
    raise "envelope: bad salt" unless salt_hex.to_s.match?(/\A[0-9a-f]{32}\z/)
    # iter is attacker-controllable in v4 → bound it before PBKDF2 (DoS guard)
    raise "envelope: bad iter" unless iter.to_s.match?(/\A[0-9]+\z/) && iter.to_i.between?(1, 10_000_000)
    scope = "v4:#{salt_hex}:#{iter}:#{iv_hex}:#{ct_hex}"
  else
    raise "envelope: unsupported version #{parts[1]}"
  end

  raise "envelope: wrong field count" if extra || mac_hex.nil?
  raise "envelope: wrong iv/mac length" unless iv_hex.length == 32 && mac_hex.length == 64
  raise "envelope: ct not block-aligned" if ct_hex.empty? || ct_hex.length % 32 != 0
  raise "envelope: non-hex" unless "#{salt_hex}#{iv_hex}#{ct_hex}#{mac_hex}".match?(/\A[0-9a-f]+\z/)

  enc_key, mac_key = derive_keys(passphrase, salt_hex, iter)

  # MAC verify FIRST — encrypt-then-MAC, constant-time.
  expected = OpenSSL::HMAC.digest("SHA256", mac_key, scope)
  provided = [mac_hex].pack("H*")
  unless expected.bytesize == provided.bytesize &&
         OpenSSL.fixed_length_secure_compare(expected, provided)
    raise "MAC verification failed"
  end

  c = OpenSSL::Cipher.new("aes-256-cbc")
  c.decrypt
  c.key = enc_key
  c.iv  = [iv_hex].pack("H*")
  c.update([ct_hex].pack("H*")) + c.final
end

data = JSON.parse(File.read(File.join(__dir__, "vectors.json")))
pass = data.fetch("passphrase")
fail_count = 0

data.fetch("vectors").each do |v|
  label = "#{v['name']} (#{v['wire']} #{v['expect']})"
  begin
    got = decrypt(v.fetch("envelope"), pass, v.fetch("salt"), v.fetch("iter"))
    if v["expect"] == "ok"
      want = Base64.decode64(v.fetch("plaintext_b64"))
      if got == want
        puts "  ok    #{label}"
      else
        puts "  FAIL  #{label}: plaintext mismatch"
        fail_count += 1
      end
    else # expected a failure but decrypt succeeded
      puts "  FAIL  #{label}: expected #{v['expect']} but decrypt SUCCEEDED"
      fail_count += 1
    end
  rescue StandardError => e
    if v["expect"] == "ok"
      puts "  FAIL  #{label}: #{e.message}"
      fail_count += 1
    else
      puts "  ok    #{label}: rejected (#{e.message})"
    end
  end
end

puts(fail_count.zero? ? "\nALL VECTORS PASS" : "\n#{fail_count} FAILED")
exit(fail_count.zero? ? 0 : 1)
