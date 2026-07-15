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

VAULT_VERSION = "v3"

# (passphrase, salt-hex, iter) -> [enc_key, mac_key]
def derive_keys(pass, salt_hex, iter)
  salt = [salt_hex].pack("H*")
  out  = OpenSSL::PKCS5.pbkdf2_hmac(pass, salt, iter, 64, OpenSSL::Digest.new("SHA256"))
  [out[0, 32], out[32, 32]]
end

# raw envelope string -> plaintext bytes (raises on any tamper / bad key)
def decrypt(envelope, enc_key, mac_key)
  tag, ver, iv_hex, ct_hex, mac_hex, extra = envelope.strip.split(":")
  raise "envelope: wrong field count" if extra || mac_hex.nil?
  raise "envelope: unsupported #{tag}:#{ver}" unless tag == "xenv" && ver == VAULT_VERSION
  raise "envelope: wrong iv/mac length" unless iv_hex.length == 32 && mac_hex.length == 64
  raise "envelope: ct not block-aligned" if ct_hex.empty? || ct_hex.length % 32 != 0
  raise "envelope: non-hex" unless (iv_hex + ct_hex + mac_hex).match?(/\A[0-9a-f]+\z/)

  # MAC verify FIRST — encrypt-then-MAC, constant-time, scope binds version+iv+ct.
  scope    = "#{VAULT_VERSION}:#{iv_hex}:#{ct_hex}"
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
  enc, mac = derive_keys(pass, v.fetch("salt"), v.fetch("iter"))
  label = "#{v['name']} (#{v['expect']})"
  begin
    got = decrypt(v.fetch("envelope"), enc, mac)
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
