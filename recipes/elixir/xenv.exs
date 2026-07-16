#!/usr/bin/env elixir
# xenv recipe for Elixir — minimal but complete (get / set / load).
#
# Reference implementation generated from ../README.md. Reads and writes
# the xenv on-disk format. Zero deps — only Erlang/OTP's built-in
# `:crypto`, which covers PBKDF2-SHA256, AES-256-CBC, and HMAC-SHA256.
# CBC via :crypto is raw (no padding), so PKCS#7 is applied by hand.
#
# Usage as a library (from another script/module in the same VM):
#   v   = Xenv.get("production", "API_KEY")        # => binary
#   Xenv.set("production", "NEW_KEY", "hello")
#   env = Xenv.load("production")                   # => [{"KEY", "value"}]
#
# Usage as a CLI:
#   elixir xenv.exs get  <env> <key>          # prints plaintext
#   elixir xenv.exs set  <env> <key> <value>  # writes encrypted value
#   elixir xenv.exs load <env>                # prints KEY=value lines

defmodule Xenv do
  import Bitwise

  @vault_version "v3"
  @value_ext ".value.enc"

  def root, do: System.get_env("XENV_ROOT") || "xenv"

  def env_var_name(env),
    do: "XENV_KEY_" <> (env |> String.upcase() |> String.replace("-", "_"))

  def passphrase(env) do
    case System.get_env(env_var_name(env)) || System.get_env("XENV_KEY") do
      nil -> raise "no passphrase: set $#{env_var_name(env)} or $XENV_KEY"
      "" -> raise "no passphrase: set $#{env_var_name(env)} or $XENV_KEY"
      v -> v
    end
  end

  # Parse the per-env README frontmatter — naive split-on-first-colon.
  def read_params(env) do
    readme = Path.join([root(), "envs", env, "README.md"])
    unless File.exists?(readme), do: raise("no README at #{readme}")

    found =
      readme
      |> File.read!()
      |> String.split("\n")
      |> parse_frontmatter()

    version = Map.get(found, "version")
    unless version == @vault_version, do: raise("params: unsupported or missing version: #{version}")

    salt = Map.get(found, "salt", "")
    unless Regex.match?(~r/\A[0-9a-f]{32}\z/, salt), do: raise("params: invalid salt")

    iter = Map.get(found, "iter", "")
    unless Regex.match?(~r/\A[0-9]+\z/, iter), do: raise("params: invalid iter")

    {String.to_integer(iter), salt}
  end

  defp parse_frontmatter(lines) do
    {found, _state} =
      Enum.reduce_while(lines, {%{}, :before}, fn line, {acc, state} ->
        cond do
          line == "---" and state == :before -> {:cont, {acc, :in}}
          line == "---" and state == :in -> {:halt, {acc, :done}}
          state == :in -> {:cont, {put_kv(acc, line), :in}}
          true -> {:cont, {acc, state}}
        end
      end)

    found
  end

  defp put_kv(acc, line) do
    stripped = String.trim(line)

    cond do
      stripped == "" -> acc
      String.starts_with?(stripped, "#") -> acc
      true ->
        case String.split(stripped, ":", parts: 2) do
          [k, v] -> Map.put(acc, String.trim(k), String.trim(v))
          _ -> acc
        end
    end
  end

  # raw 64-byte PBKDF2 output (the env "master").
  def pbkdf2_okm(pass, salt_hex, iter) do
    :crypto.pbkdf2_hmac(:sha256, pass, Base.decode16!(salt_hex, case: :lower), iter, 64)
  end

  def derive_keys(pass, salt_hex, iter) do
    <<enc::binary-size(32), mac::binary-size(32)>> = pbkdf2_okm(pass, salt_hex, iter)
    {enc, mac}
  end

  # HKDF-SHA256 (RFC 5869), L=64. Matches the tool's construction.
  def hkdf64(ikm, salt) do
    info = "xenv:v5"
    prk = :crypto.mac(:hmac, :sha256, salt, ikm)
    t1 = :crypto.mac(:hmac, :sha256, prk, info <> <<1>>)
    t2 = :crypto.mac(:hmac, :sha256, prk, t1 <> info <> <<2>>)
    t1 <> t2
  end

  defp okm_keys(okm) do
    <<enc::binary-size(32), mac::binary-size(32)>> = okm
    {enc, mac}
  end

  # Dual-read v3/v4/v5. Caller precomputes env_okm = PBKDF2 over the env
  # README salt/iter ONCE; per value it's a slice (v3), a per-value PBKDF2
  # (v4), or a cheap HKDF over the shared master (v5).
  def decrypt_envelope(envelope, passphrase, ctx_salt, ctx_iter, env_okm) do
    parts = envelope |> String.trim() |> String.split(":")
    unless List.first(parts) == "xenv", do: raise("envelope: not xenv")

    {enc_key, mac_key, iv_hex, ct_hex, mac_hex, mac_scope} =
      case Enum.at(parts, 1) do
        "v3" ->
          unless length(parts) == 5, do: raise("envelope: wrong field count")
          [_, _, iv, ct, mac] = parts
          {e, m} = okm_keys(env_okm)
          {e, m, iv, ct, mac, "v3:#{iv}:#{ct}"}

        "v4" ->
          unless length(parts) == 7, do: raise("envelope: wrong field count")
          [_, _, salt, it, iv, ct, mac] = parts
          unless Regex.match?(~r/\A[0-9a-f]{32}\z/, salt), do: raise("envelope: bad salt")
          unless Regex.match?(~r/\A[0-9]+\z/, it), do: raise("envelope: bad iter")
          iter = String.to_integer(it)
          unless iter >= 1 and iter <= 10_000_000, do: raise("envelope: bad iter")
          {e, m} = derive_keys(passphrase, salt, iter)
          {e, m, iv, ct, mac, "v4:#{salt}:#{it}:#{iv}:#{ct}"}

        "v5" ->
          unless length(parts) == 8, do: raise("envelope: wrong field count")
          [_, _, kdf_salt, it, value_salt, iv, ct, mac] = parts
          unless Regex.match?(~r/\A[0-9a-f]{32}\z/, kdf_salt) and Regex.match?(~r/\A[0-9a-f]{32}\z/, value_salt),
            do: raise("envelope: bad salt")
          unless Regex.match?(~r/\A[0-9]+\z/, it), do: raise("envelope: bad iter")
          iter = String.to_integer(it)
          unless iter >= 1 and iter <= 10_000_000, do: raise("envelope: bad iter")
          ikm = if kdf_salt == ctx_salt and iter == ctx_iter, do: env_okm, else: pbkdf2_okm(passphrase, kdf_salt, iter)
          {e, m} = okm_keys(hkdf64(ikm, Base.decode16!(value_salt, case: :lower)))
          {e, m, iv, ct, mac, "v5:#{kdf_salt}:#{it}:#{value_salt}:#{iv}:#{ct}"}

        other ->
          raise("envelope: unsupported version #{other}")
      end

    unless String.length(iv_hex) == 32 and String.length(mac_hex) == 64,
      do: raise("envelope: wrong iv/mac length")
    unless ct_hex != "" and rem(String.length(ct_hex), 32) == 0,
      do: raise("envelope: ct not block-aligned")
    unless Regex.match?(~r/\A[0-9a-f]+\z/, iv_hex <> ct_hex <> mac_hex),
      do: raise("envelope: non-hex content")

    # MAC verify FIRST (encrypt-then-MAC; constant-time compare).
    expected = :crypto.mac(:hmac, :sha256, mac_key, mac_scope)
    provided = Base.decode16!(mac_hex, case: :lower)
    unless secure_compare(expected, provided),
      do: raise("MAC verification failed — wrong key or tampered vault")

    iv = Base.decode16!(iv_hex, case: :lower)
    ct = Base.decode16!(ct_hex, case: :lower)
    :crypto.crypto_one_time(:aes_256_cbc, enc_key, iv, ct, false) |> pkcs7_unpad()
  end

  def encrypt_envelope(plaintext, enc_key, mac_key) do
    iv = :crypto.strong_rand_bytes(16)
    ct = :crypto.crypto_one_time(:aes_256_cbc, enc_key, iv, pkcs7_pad(plaintext), true)
    iv_hex = Base.encode16(iv, case: :lower)
    ct_hex = Base.encode16(ct, case: :lower)
    mac_scope = "#{@vault_version}:#{iv_hex}:#{ct_hex}"
    mac_hex = :crypto.mac(:hmac, :sha256, mac_key, mac_scope) |> Base.encode16(case: :lower)
    "xenv:#{@vault_version}:#{iv_hex}:#{ct_hex}:#{mac_hex}\n"
  end

  # PKCS#7 over a 16-byte block. Always adds 1..16 bytes so the length is
  # unambiguous even when the plaintext is already block-aligned.
  defp pkcs7_pad(data) do
    pad = 16 - rem(byte_size(data), 16)
    data <> :binary.copy(<<pad>>, pad)
  end

  defp pkcs7_unpad(data) do
    size = byte_size(data)
    pad = :binary.last(data)
    if pad < 1 or pad > 16 or pad > size, do: raise("invalid PKCS#7 padding")
    :binary.part(data, 0, size - pad)
  end

  # Constant-time compare: XOR every byte, OR the differences. Time depends
  # only on length, not on where the first mismatch is.
  defp secure_compare(a, b) when byte_size(a) == byte_size(b) do
    :crypto.exor(a, b) |> :binary.bin_to_list() |> Enum.reduce(0, &bor/2) == 0
  end

  defp secure_compare(_, _), do: false

  def get(env, key) do
    {iter, salt} = read_params(env)
    pass = passphrase(env)
    env_okm = pbkdf2_okm(pass, salt, iter)
    file = Path.join([root(), "envs", env, key <> @value_ext])
    unless File.exists?(file), do: raise("no such key: #{key}")
    decrypt_envelope(File.read!(file), pass, salt, iter, env_okm)
  end

  def set(env, key, plaintext) do
    {iter, salt} = read_params(env)
    {enc, mac} = derive_keys(passphrase(env), salt, iter)
    dir = Path.join([root(), "envs", env])
    unless File.dir?(dir), do: raise("no env directory: #{dir}")
    dest = Path.join(dir, key <> @value_ext)
    tmp = dest <> ".tmp"
    File.write!(tmp, encrypt_envelope(plaintext, enc, mac))
    File.chmod!(tmp, 0o600)
    File.rename!(tmp, dest)
  end

  def load(env) do
    {iter, salt} = read_params(env)
    pass = passphrase(env)
    env_okm = pbkdf2_okm(pass, salt, iter)
    dir = Path.join([root(), "envs", env])

    dir
    |> File.ls!()
    |> Enum.sort()
    |> Enum.filter(&String.ends_with?(&1, @value_ext))
    |> Enum.map(fn f ->
      key = String.slice(f, 0, String.length(f) - String.length(@value_ext))
      {key, decrypt_envelope(File.read!(Path.join(dir, f)), pass, salt, iter, env_okm)}
    end)
  end
end

try do
  case System.argv() do
    ["get", env, key] ->
      IO.binwrite(Xenv.get(env, key))

    ["set", env, key, value] ->
      Xenv.set(env, key, value)

    ["load", env] ->
      Enum.each(Xenv.load(env), fn {k, v} ->
        IO.binwrite("#{k}=")
        IO.binwrite(v)
        IO.binwrite("\n")
      end)

    _ ->
      IO.puts(:stderr, "usage: elixir xenv.exs {get|set|load} <env> [<key>] [<value>]")
      System.halt(2)
  end
rescue
  e ->
    IO.puts(:stderr, "xenv: #{Exception.message(e)}")
    System.halt(1)
end
