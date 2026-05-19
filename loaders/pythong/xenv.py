"""xenv loader for Python — read-only, stdlib + openssl(1).

Reference implementation generated from ../AGENT_PROMPT.md. Reads the
xenv on-disk format and returns decrypted values.

Crypto: stdlib hashlib.pbkdf2_hmac + hmac. AES-CBC via openssl(1)
subprocess, because Python's stdlib has no AES. If your project
already depends on `cryptography`, you could swap the subprocess for
`cryptography.hazmat.primitives.ciphers.Cipher` and stay pure-Python.
"""

import binascii
import hashlib
import hmac
import os
import re
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


def _derive_keys(passphrase: str, salt_hex: str, iters: int):
    salt = binascii.unhexlify(salt_hex)
    derived = hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iters, 64)
    return derived[:32], derived[32:]


def _decrypt_envelope(envelope: str, enc_key: bytes, mac_key: bytes) -> bytes:
    parts = envelope.strip().split(":")
    if len(parts) != 5:
        raise ValueError("envelope: wrong field count")
    tag, ver, iv_hex, ct_hex, mac_hex = parts
    if tag != "xenv" or ver != VAULT_VERSION:
        raise ValueError(f"envelope: unsupported {tag}:{ver}")
    if len(iv_hex) != 32 or len(mac_hex) != 64:
        raise ValueError("envelope: wrong iv/mac length")
    if not ct_hex or len(ct_hex) % 32 != 0:
        raise ValueError("envelope: ct not block-aligned")
    if not re.fullmatch(r"[0-9a-f]+", iv_hex + ct_hex + mac_hex):
        raise ValueError("envelope: non-hex content")

    # MAC verify FIRST (encrypt-then-MAC; constant-time compare)
    mac_scope = f"{VAULT_VERSION}:{iv_hex}:{ct_hex}".encode("ascii")
    expected = hmac.new(mac_key, mac_scope, hashlib.sha256).hexdigest()
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


def load(env_name: str) -> dict:
    """Return {KEY: plaintext-bytes} for every value in the named env."""
    iters, salt = _read_params(env_name)
    enc_key, mac_key = _derive_keys(_passphrase(env_name), salt, iters)
    env_dir = _root() / "envs" / env_name
    out = {}
    for f in sorted(env_dir.iterdir()):
        if not f.name.endswith(VALUE_EXT):
            continue
        key = f.name[: -len(VALUE_EXT)]
        out[key] = _decrypt_envelope(f.read_text(), enc_key, mac_key)
    return out


def decrypt_one(env_name: str, key: str) -> bytes:
    """Decrypt one named value; raises if it doesn't exist."""
    iters, salt = _read_params(env_name)
    enc_key, mac_key = _derive_keys(_passphrase(env_name), salt, iters)
    f = _root() / "envs" / env_name / (key + VALUE_EXT)
    if not f.is_file():
        raise FileNotFoundError(f"no such key: {key}")
    return _decrypt_envelope(f.read_text(), enc_key, mac_key)


def _main(argv):
    if len(argv) == 2:
        sys.stdout.buffer.write(decrypt_one(argv[0], argv[1]))
        return 0
    if len(argv) == 1:
        for k, v in load(argv[0]).items():
            sys.stdout.buffer.write(k.encode("ascii") + b"=" + v + b"\n")
        return 0
    print("usage: xenv.py <env> [<key>]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
