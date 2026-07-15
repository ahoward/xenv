#!/usr/bin/env ruby
# frozen_string_literal: true
#
# xenv recipe for Ruby — minimal but complete (get / set / load).
#
# Reference implementation generated from ../README.md. Reads and writes
# the xenv on-disk format. Zero gems — only the stdlib `openssl`, which
# ships with every MRI Ruby and covers PBKDF2-SHA256, AES-256-CBC, and
# HMAC-SHA256 (plus a constant-time compare).
#
# Usage as a library:
#   require_relative 'xenv'
#   v   = Xenv.get('production', 'API_KEY')          # => String (BINARY)
#   Xenv.set('production', 'NEW_KEY', 'hello')
#   all = Xenv.load('production')                      # => { "KEY" => "value" }
#
# Usage as a CLI:
#   ruby xenv.rb get  <env> <key>          # prints plaintext
#   ruby xenv.rb set  <env> <key> <value>  # writes encrypted value
#   ruby xenv.rb load <env>                # prints KEY=value lines

require 'openssl'

module Xenv
  VAULT_VERSION = 'v3'
  VALUE_EXT     = '.value.enc'

  module_function

  def root
    ENV['XENV_ROOT'] || 'xenv'
  end

  def env_var_name(env_name)
    'XENV_KEY_' + env_name.upcase.tr('-', '_')
  end

  def passphrase(env_name)
    v = ENV[env_var_name(env_name)] || ENV['XENV_KEY']
    raise "no passphrase: set $#{env_var_name(env_name)} or $XENV_KEY" if v.nil? || v.empty?

    v
  end

  # Parse the per-env README frontmatter — naive split-on-first-colon,
  # exactly matching the spec. Returns [iter, salt_hex].
  def read_params(env_name)
    readme = File.join(root, 'envs', env_name, 'README.md')
    raise "no README at #{readme}" unless File.file?(readme)

    found = {}
    in_block = false
    File.foreach(readme) do |line|
      line = line.chomp
      if line == '---'
        break if in_block

        in_block = true
        next
      end
      next unless in_block

      stripped = line.strip
      next if stripped.empty? || stripped.start_with?('#')

      colon = stripped.index(':')
      next if colon.nil?

      found[stripped[0...colon].strip] = stripped[(colon + 1)..].strip
    end

    raise "params: unsupported or missing version: #{found['version']}" \
      unless found['version'] == VAULT_VERSION
    raise 'params: invalid salt' unless found['salt'].to_s.match?(/\A[0-9a-f]{32}\z/)
    raise 'params: invalid iter' unless found['iter'].to_s.match?(/\A[0-9]+\z/)

    [found['iter'].to_i, found['salt']]
  end

  def derive_keys(pass, salt_hex, iter)
    salt = [salt_hex].pack('H*')
    out  = OpenSSL::PKCS5.pbkdf2_hmac(pass, salt, iter, 64, OpenSSL::Digest.new('SHA256'))
    [out[0, 32], out[32, 32]]
  end

  # Dual-read: v3 uses the caller's README-derived keys; v4 is
  # self-contained — salt/iter come from the envelope.
  def decrypt_envelope(envelope, passphrase, v3_enc, v3_mac)
    parts = envelope.strip.split(':')
    raise 'envelope: not xenv' unless parts[0] == 'xenv'

    case parts[1]
    when 'v3'
      raise 'envelope: wrong field count' unless parts.length == 5
      _, _, iv_hex, ct_hex, mac_hex = parts
      enc_key, mac_key = v3_enc, v3_mac
      mac_scope = "v3:#{iv_hex}:#{ct_hex}"
    when 'v4'
      raise 'envelope: wrong field count' unless parts.length == 7
      _, _, salt_hex, iter, iv_hex, ct_hex, mac_hex = parts
      raise 'envelope: bad salt' unless salt_hex.match?(/\A[0-9a-f]{32}\z/)
      # iter is attacker-controllable in v4 → bound it before PBKDF2 (DoS guard)
      raise 'envelope: bad iter' unless iter.match?(/\A[0-9]+\z/) && iter.to_i.between?(1, 10_000_000)
      enc_key, mac_key = derive_keys(passphrase, salt_hex, iter.to_i)
      mac_scope = "v4:#{salt_hex}:#{iter}:#{iv_hex}:#{ct_hex}"
    else
      raise "envelope: unsupported version #{parts[1]}"
    end

    raise 'envelope: wrong iv/mac length' unless iv_hex.length == 32 && mac_hex.length == 64
    raise 'envelope: ct not block-aligned' if ct_hex.empty? || (ct_hex.length % 32 != 0)
    raise 'envelope: non-hex content' unless (iv_hex + ct_hex + mac_hex).match?(/\A[0-9a-f]+\z/)

    # MAC verify FIRST (encrypt-then-MAC; constant-time compare).
    expected  = OpenSSL::HMAC.digest('SHA256', mac_key, mac_scope)
    provided  = [mac_hex].pack('H*')
    unless expected.bytesize == provided.bytesize &&
           OpenSSL.fixed_length_secure_compare(expected, provided)
      raise 'MAC verification failed — wrong key or tampered vault'
    end

    cipher = OpenSSL::Cipher.new('aes-256-cbc')
    cipher.decrypt
    cipher.key = enc_key
    cipher.iv  = [iv_hex].pack('H*')
    cipher.update([ct_hex].pack('H*')) + cipher.final
  end

  def encrypt_envelope(plaintext, enc_key, mac_key)
    iv = OpenSSL::Random.random_bytes(16)
    cipher = OpenSSL::Cipher.new('aes-256-cbc')
    cipher.encrypt
    cipher.key = enc_key
    cipher.iv  = iv
    ct = cipher.update(plaintext) + cipher.final

    iv_hex = iv.unpack1('H*')
    ct_hex = ct.unpack1('H*')
    mac_scope = "#{VAULT_VERSION}:#{iv_hex}:#{ct_hex}"
    mac_hex = OpenSSL::HMAC.hexdigest('SHA256', mac_key, mac_scope)
    "xenv:#{VAULT_VERSION}:#{iv_hex}:#{ct_hex}:#{mac_hex}\n"
  end

  def atomic_write(dest, content)
    tmp = dest + '.tmp'
    File.binwrite(tmp, content)
    File.chmod(0o600, tmp)
    File.rename(tmp, dest)
  end

  def get(env_name, key)
    iter, salt = read_params(env_name)
    pass = passphrase(env_name)
    v3_enc, v3_mac = derive_keys(pass, salt, iter)
    file = File.join(root, 'envs', env_name, key + VALUE_EXT)
    raise "no such key: #{key}" unless File.file?(file)

    decrypt_envelope(File.binread(file), pass, v3_enc, v3_mac)
  end

  def set(env_name, key, plaintext)
    plaintext = plaintext.b
    iter, salt = read_params(env_name)
    enc_key, mac_key = derive_keys(passphrase(env_name), salt, iter)
    env_dir = File.join(root, 'envs', env_name)
    raise "no env directory: #{env_dir}" unless File.directory?(env_dir)

    atomic_write(File.join(env_dir, key + VALUE_EXT),
                 encrypt_envelope(plaintext, enc_key, mac_key))
  end

  def load(env_name)
    iter, salt = read_params(env_name)
    pass = passphrase(env_name)
    v3_enc, v3_mac = derive_keys(pass, salt, iter)
    env_dir = File.join(root, 'envs', env_name)
    out = {}
    Dir.children(env_dir).sort.each do |file|
      next unless file.end_with?(VALUE_EXT)

      key = file[0...-VALUE_EXT.length]
      out[key] = decrypt_envelope(File.binread(File.join(env_dir, file)), pass, v3_enc, v3_mac)
    end
    out
  end
end

if $PROGRAM_NAME == __FILE__
  verb, env_name, key, value = ARGV
  usage = 'usage: ruby xenv.rb {get|set|load} <env> [<key>] [<value>]'

  begin
    $stdout.binmode
    case [verb, ARGV.length]
    when ['get', 3]
      $stdout.write(Xenv.get(env_name, key))
    when ['set', 4]
      Xenv.set(env_name, key, value)
    when ['load', 2]
      Xenv.load(env_name).each do |k, v|
        $stdout.write("#{k}=")
        $stdout.write(v)
        $stdout.write("\n")
      end
    else
      warn usage
      exit 2
    end
  rescue StandardError => e
    warn "xenv: #{e.message}"
    exit 1
  end
end
