"""xenv recipe for Python — minimal but complete (get / set / load).

Reference implementation generated from ../README.md. Reads and writes
the xenv on-disk format. No rotation, no init, no edit — those are the
shell tool's job. This is what an app needs to use xenv at runtime.

Crypto: stdlib hashlib.pbkdf2_hmac + hmac. AES-CBC via openssl(1)
subprocess, because Python's stdlib has no AES. If your project already
depends on `cryptography`, swap the subprocess for
`cryptography.hazmat.primitives.ciphers.Cipher` and stay pure-Python.
"""

import binascii
import hashlib
import hmac
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

VAULT_VERSION = "v3"
VALUE_EXT = ".value.enc"


def _root() -> Path:
    return Path(os.environ.get("XENV_ROOT", "xenv"))


def _env_var_name(env_name: str) -> str:
    return "XENV_KEY_" + env_name.upper().replace("-", "_")


def _passphrase(env_name: str) -> str:
    val = os.environ.get(_env_var_name(env_name)) or os.environ.get("XENV_KEY")
    if not val:
        raise RuntimeError(
            f"no passphrase: set ${_env_var_name(env_name)} or $XENV_KEY"
        )
    return val


def _read_params(env_name: str):
    """Parse the per-env README frontmatter — naive split-on-first-colon."""
    readme = _root() / "envs" / env_name / "README.md"
    if not readme.is_file():
        raise FileNotFoundError(f"no README at {readme}")

    in_block = False
    found = {}
    for line in readme.read_text().splitlines():
        if line == "---":
            if not in_block:
                in_block = True
                continue
            break
        if not in_block:
            continue
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if ":" not in stripped:
            continue
        k, _, v = stripped.partition(":")
        found[k.strip()] = v.strip()

    version = found.get("version")
    if version != VAULT_VERSION:
        raise ValueError(f"params: unsupported or missing version: {version!r}")
    salt = found.get("salt", "")
    if len(salt) != 32 or not re.fullmatch(r"[0-9a-f]+", salt):
        raise ValueError("params: invalid salt")
    iter_str = found.get("iter", "")
    if not iter_str.isdigit():
        raise ValueError("params: invalid iter")
    return int(iter_str), salt


def _pbkdf2_okm(passphrase: str, salt_hex: str, iters: int) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), binascii.unhexlify(salt_hex), iters, 64)


def _derive_keys(passphrase: str, salt_hex: str, iters: int):
    okm = _pbkdf2_okm(passphrase, salt_hex, iters)
    return okm[:32], okm[32:]


def _hkdf64(ikm: bytes, salt: bytes, info: bytes = b"xenv:v5") -> bytes:
    # HKDF-SHA256 (RFC 5869), L=64. Matches the tool's construction.
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    t1 = hmac.new(prk, info + b"\x01", hashlib.sha256).digest()
    t2 = hmac.new(prk, t1 + info + b"\x02", hashlib.sha256).digest()
    return t1 + t2


def _decrypt_envelope(envelope: str, passphrase: str, ctx_salt: str, ctx_iter: int, env_okm: bytes) -> bytes:
    # Dual-read v3/v4/v5. Caller precomputes env_okm = PBKDF2 over the env
    # README salt/iter ONCE; per value it's a slice (v3) or a cheap HKDF (v5).
    parts = envelope.strip().split(":")
    if not parts or parts[0] != "xenv":
        raise ValueError("envelope: not xenv")
    ver = parts[1] if len(parts) > 1 else ""
    if ver == "v3":
        if len(parts) != 5:
            raise ValueError("envelope: wrong field count")
        _, _, iv_hex, ct_hex, mac_hex = parts
        enc_key, mac_key = env_okm[:32], env_okm[32:]
        mac_scope = f"v3:{iv_hex}:{ct_hex}"
    elif ver == "v4":
        if len(parts) != 7:
            raise ValueError("envelope: wrong field count")
        _, _, salt_hex, it, iv_hex, ct_hex, mac_hex = parts
        if not re.fullmatch(r"[0-9a-f]{32}", salt_hex):
            raise ValueError("envelope: bad salt")
        if not re.fullmatch(r"[0-9]+", it) or not (1 <= int(it) <= 10_000_000):
            raise ValueError("envelope: bad iter")
        okm = _pbkdf2_okm(passphrase, salt_hex, int(it))
        enc_key, mac_key = okm[:32], okm[32:]
        mac_scope = f"v4:{salt_hex}:{it}:{iv_hex}:{ct_hex}"
    elif ver == "v5":
        if len(parts) != 8:
            raise ValueError("envelope: wrong field count")
        _, _, kdf_salt, it, value_salt, iv_hex, ct_hex, mac_hex = parts
        if not re.fullmatch(r"[0-9a-f]{32}", kdf_salt) or not re.fullmatch(r"[0-9a-f]{32}", value_salt):
            raise ValueError("envelope: bad salt")
        if not re.fullmatch(r"[0-9]+", it) or not (1 <= int(it) <= 10_000_000):
            raise ValueError("envelope: bad iter")
        ikm = env_okm if (kdf_salt == ctx_salt and int(it) == int(ctx_iter)) else _pbkdf2_okm(passphrase, kdf_salt, int(it))
        okm = _hkdf64(ikm, binascii.unhexlify(value_salt))
        enc_key, mac_key = okm[:32], okm[32:]
        mac_scope = f"v5:{kdf_salt}:{it}:{value_salt}:{iv_hex}:{ct_hex}"
    else:
        raise ValueError(f"envelope: unsupported version {ver}")
    if len(iv_hex) != 32 or len(mac_hex) != 64:
        raise ValueError("envelope: wrong iv/mac length")
    if not ct_hex or len(ct_hex) % 32 != 0:
        raise ValueError("envelope: ct not block-aligned")
    if not re.fullmatch(r"[0-9a-f]+", iv_hex + ct_hex + mac_hex):
        raise ValueError("envelope: non-hex content")

    # MAC verify FIRST (encrypt-then-MAC; constant-time compare)
    expected = hmac.new(mac_key, mac_scope.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, mac_hex):
        raise ValueError("MAC verification failed — wrong key or tampered vault")

    # decrypt via openssl(1) — stdlib has no AES
    ct = binascii.unhexlify(ct_hex)
    proc = subprocess.run(
        ["openssl", "enc", "-d", "-aes-256-cbc", "-K", enc_key.hex(), "-iv", iv_hex],
        input=ct,
        capture_output=True,
        check=True,
    )
    return proc.stdout


def _encrypt_envelope(plaintext: bytes, enc_key: bytes, mac_key: bytes) -> str:
    iv = secrets.token_bytes(16)
    iv_hex = iv.hex()

    # encrypt via openssl(1)
    proc = subprocess.run(
        ["openssl", "enc", "-aes-256-cbc", "-K", enc_key.hex(), "-iv", iv_hex],
        input=plaintext,
        capture_output=True,
        check=True,
    )
    ct_hex = proc.stdout.hex()

    mac_scope = f"{VAULT_VERSION}:{iv_hex}:{ct_hex}".encode("ascii")
    mac_hex = hmac.new(mac_key, mac_scope, hashlib.sha256).hexdigest()

    return f"xenv:{VAULT_VERSION}:{iv_hex}:{ct_hex}:{mac_hex}\n"


def _atomic_write(path: Path, content: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def get(env_name: str, key: str) -> bytes:
    """Decrypt and return the plaintext bytes for one key."""
    iters, salt = _read_params(env_name)
    pw = _passphrase(env_name)
    env_okm = _pbkdf2_okm(pw, salt, iters)
    f = _root() / "envs" / env_name / (key + VALUE_EXT)
    if not f.is_file():
        raise FileNotFoundError(f"no such key: {key}")
    return _decrypt_envelope(f.read_text(), pw, salt, iters, env_okm)


def set(env_name: str, key: str, plaintext: bytes):
    """Encrypt and atomically write one value. Reuses the env's existing
    salt and iter; only a fresh IV is generated."""
    if isinstance(plaintext, str):
        plaintext = plaintext.encode("utf-8")
    iters, salt = _read_params(env_name)
    enc_key, mac_key = _derive_keys(_passphrase(env_name), salt, iters)
    envelope = _encrypt_envelope(plaintext, enc_key, mac_key)
    env_dir = _root() / "envs" / env_name
    if not env_dir.is_dir():
        raise FileNotFoundError(f"no env directory: {env_dir}")
    _atomic_write(env_dir / (key + VALUE_EXT), envelope)


def load(env_name: str) -> dict:
    """Return {KEY: plaintext-bytes} for every value in the named env."""
    iters, salt = _read_params(env_name)
    pw = _passphrase(env_name)
    env_okm = _pbkdf2_okm(pw, salt, iters)
    env_dir = _root() / "envs" / env_name
    out = {}
    for f in sorted(env_dir.iterdir()):
        if not f.name.endswith(VALUE_EXT):
            continue
        key = f.name[: -len(VALUE_EXT)]
        out[key] = _decrypt_envelope(f.read_text(), pw, salt, iters, env_okm)
    return out


def _main(argv):
    if not argv:
        print("usage: xenv.py {get|set|load} <env> [<key>] [<value>]", file=sys.stderr)
        return 2
    verb = argv[0]
    if verb == "get" and len(argv) == 3:
        sys.stdout.buffer.write(get(argv[1], argv[2]))
        return 0
    if verb == "set" and len(argv) == 4:
        set(argv[1], argv[2], argv[3].encode("utf-8"))
        return 0
    if verb == "load" and len(argv) == 2:
        for k, v in load(argv[1]).items():
            sys.stdout.buffer.write(k.encode("ascii") + b"=" + v + b"\n")
        return 0
    print(f"usage: xenv.py {{get|set|load}} <env> [<key>] [<value>]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
