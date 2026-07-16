//! Minimal-but-complete recipe for the xenv encrypted-environment format.
//!
//! Three operations: `get`, `set`, `load`. Reads from and writes to the
//! on-disk format. No rotation, no init — those are the shell tool's job.
//!
//! Crypto: RustCrypto crates — `aes` + `cbc` + `hmac` + `sha2` + `pbkdf2`.
//! Rust has no stdlib crypto, but these are the universally-accepted
//! choice. Random IVs via `/dev/urandom` (POSIX) to avoid adding `rand`.
//!
//! Usage as a library:
//!
//! ```no_run
//! let v = xenv::get("production", "API_KEY").unwrap();
//! xenv::set("production", "NEW_KEY", b"hello").unwrap();
//! let all = xenv::load("production").unwrap();
//! ```

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type HmacSha256 = Hmac<Sha256>;

const VAULT_VERSION: &str = "v3";
const VALUE_EXT: &str = ".value.enc";

#[derive(Debug)]
pub enum Error {
    Io(std::io::Error),
    Format(String),
    Mac,
    Crypto(String),
    NoPass(String),
    NotFound(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Io(e) => write!(f, "io: {e}"),
            Error::Format(s) => write!(f, "format: {s}"),
            Error::Mac => write!(f, "MAC verification failed — wrong key or tampered vault"),
            Error::Crypto(s) => write!(f, "crypto: {s}"),
            Error::NoPass(s) => write!(f, "no passphrase: {s}"),
            Error::NotFound(s) => write!(f, "not found: {s}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

fn root() -> PathBuf {
    env::var("XENV_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("xenv"))
}

fn env_var_name(env_name: &str) -> String {
    format!(
        "XENV_KEY_{}",
        env_name.to_ascii_uppercase().replace('-', "_")
    )
}

fn passphrase(env_name: &str) -> Result<String, Error> {
    let name = env_var_name(env_name);
    if let Ok(v) = env::var(&name) {
        if !v.is_empty() {
            return Ok(v);
        }
    }
    if let Ok(v) = env::var("XENV_KEY") {
        if !v.is_empty() {
            return Ok(v);
        }
    }
    Err(Error::NoPass(format!("set ${name} or $XENV_KEY")))
}

struct Params {
    iter: u32,
    salt: Vec<u8>,
}

/// Parse the per-env README frontmatter — naive split-on-first-colon.
fn read_params(env_name: &str) -> Result<Params, Error> {
    let path = root().join("envs").join(env_name).join("README.md");
    let text = fs::read_to_string(&path)?;

    let mut found: BTreeMap<String, String> = BTreeMap::new();
    let mut in_block = false;
    for line in text.lines() {
        if line == "---" {
            if !in_block {
                in_block = true;
                continue;
            }
            break;
        }
        if !in_block {
            continue;
        }
        let stripped = line.trim();
        if stripped.is_empty() || stripped.starts_with('#') {
            continue;
        }
        if let Some(colon) = stripped.find(':') {
            let k = stripped[..colon].trim().to_string();
            let v = stripped[colon + 1..].trim().to_string();
            found.insert(k, v);
        }
    }

    let version = found.get("version").map(|s| s.as_str()).unwrap_or("");
    if version != VAULT_VERSION {
        return Err(Error::Format(format!(
            "unsupported or missing version: {version:?}"
        )));
    }
    let salt_hex = found
        .get("salt")
        .ok_or_else(|| Error::Format("missing salt".into()))?;
    if salt_hex.len() != 32 {
        return Err(Error::Format("invalid salt length".into()));
    }
    let salt = hex_decode(salt_hex).ok_or_else(|| Error::Format("non-hex salt".into()))?;
    let iter: u32 = found
        .get("iter")
        .ok_or_else(|| Error::Format("missing iter".into()))?
        .parse()
        .map_err(|_| Error::Format("invalid iter".into()))?;
    Ok(Params { iter, salt })
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for i in (0..bytes.len()).step_by(2) {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn random_bytes(n: usize) -> Result<Vec<u8>, Error> {
    let mut buf = vec![0u8; n];
    let mut f = fs::File::open("/dev/urandom")?;
    f.read_exact(&mut buf)?;
    Ok(buf)
}

// raw 64-byte PBKDF2 output (the env "master").
fn pbkdf2_okm(pass: &str, salt: &[u8], iter: u32) -> [u8; 64] {
    let mut out = [0u8; 64];
    pbkdf2_hmac::<Sha256>(pass.as_bytes(), salt, iter, &mut out);
    out
}

fn derive_keys(pass: &str, salt: &[u8], iter: u32) -> ([u8; 32], [u8; 32]) {
    let out = pbkdf2_okm(pass, salt, iter);
    let mut enc = [0u8; 32];
    let mut mac = [0u8; 32];
    enc.copy_from_slice(&out[..32]);
    mac.copy_from_slice(&out[32..]);
    (enc, mac)
}

// HKDF-SHA256 (RFC 5869), L=64. Matches the tool's construction.
fn hkdf64(ikm: &[u8], salt: &[u8]) -> [u8; 64] {
    let info = b"xenv:v5";
    let mut e = <HmacSha256 as Mac>::new_from_slice(salt).unwrap();
    e.update(ikm);
    let prk = e.finalize().into_bytes();
    let mut m1 = <HmacSha256 as Mac>::new_from_slice(&prk).unwrap();
    m1.update(info);
    m1.update(&[0x01]);
    let t1 = m1.finalize().into_bytes();
    let mut m2 = <HmacSha256 as Mac>::new_from_slice(&prk).unwrap();
    m2.update(&t1);
    m2.update(info);
    m2.update(&[0x02]);
    let t2 = m2.finalize().into_bytes();
    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&t1);
    out[32..].copy_from_slice(&t2);
    out
}

fn okm_keys(okm: &[u8; 64]) -> ([u8; 32], [u8; 32]) {
    let mut e = [0u8; 32];
    let mut m = [0u8; 32];
    e.copy_from_slice(&okm[..32]);
    m.copy_from_slice(&okm[32..]);
    (e, m)
}

// Dual-read: v3 uses the caller's README-derived keys; v4 is
// self-contained — salt/iter come from the envelope.
fn decrypt_envelope(
    envelope: &str,
    passphrase: &str,
    ctx_salt: &str,
    ctx_iter: u32,
    env_okm: &[u8; 64],
) -> Result<Vec<u8>, Error> {
    let parts: Vec<&str> = envelope.trim().split(':').collect();
    if parts.len() < 2 || parts[0] != "xenv" {
        return Err(Error::Format("envelope: not xenv".into()));
    }

    #[allow(clippy::type_complexity)]
    let (enc_key, mac_key, iv_hex, ct_hex, mac_hex, mac_scope): (
        [u8; 32],
        [u8; 32],
        &str,
        &str,
        &str,
        String,
    ) = match parts[1] {
        "v3" => {
            if parts.len() != 5 {
                return Err(Error::Format("envelope: wrong field count".into()));
            }
            let (e, m) = okm_keys(env_okm);
            (
                e,
                m,
                parts[2],
                parts[3],
                parts[4],
                format!("v3:{}:{}", parts[2], parts[3]),
            )
        }
        "v4" => {
            if parts.len() != 7 {
                return Err(Error::Format("envelope: wrong field count".into()));
            }
            let salt_hex = parts[2];
            if salt_hex.len() != 32 {
                return Err(Error::Format("envelope: bad salt".into()));
            }
            // iter is attacker-controllable in v4 → bound it before PBKDF2 (DoS guard)
            let iter: u32 = parts[3]
                .parse()
                .map_err(|_| Error::Format("envelope: bad iter".into()))?;
            if !(1..=10_000_000).contains(&iter) {
                return Err(Error::Format("envelope: bad iter".into()));
            }
            let salt =
                hex_decode(salt_hex).ok_or_else(|| Error::Format("non-hex salt".into()))?;
            let (e, m) = derive_keys(passphrase, &salt, iter);
            (
                e,
                m,
                parts[4],
                parts[5],
                parts[6],
                format!("v4:{}:{}:{}:{}", salt_hex, parts[3], parts[4], parts[5]),
            )
        }
        "v5" => {
            if parts.len() != 8 {
                return Err(Error::Format("envelope: wrong field count".into()));
            }
            let kdf_salt = parts[2];
            let value_salt = parts[4];
            if kdf_salt.len() != 32 || value_salt.len() != 32 {
                return Err(Error::Format("envelope: bad salt".into()));
            }
            let iter: u32 = parts[3]
                .parse()
                .map_err(|_| Error::Format("envelope: bad iter".into()))?;
            if !(1..=10_000_000).contains(&iter) {
                return Err(Error::Format("envelope: bad iter".into()));
            }
            let derived;
            let ikm: &[u8] = if kdf_salt == ctx_salt && iter == ctx_iter {
                &env_okm[..]
            } else {
                let ks = hex_decode(kdf_salt)
                    .ok_or_else(|| Error::Format("non-hex salt".into()))?;
                derived = pbkdf2_okm(passphrase, &ks, iter);
                &derived[..]
            };
            let vs = hex_decode(value_salt)
                .ok_or_else(|| Error::Format("non-hex salt".into()))?;
            let (e, m) = okm_keys(&hkdf64(ikm, &vs));
            (
                e,
                m,
                parts[5],
                parts[6],
                parts[7],
                format!("v5:{}:{}:{}:{}:{}", kdf_salt, parts[3], value_salt, parts[5], parts[6]),
            )
        }
        other => {
            return Err(Error::Format(format!(
                "envelope: unsupported version {other}"
            )))
        }
    };

    if iv_hex.len() != 32 || mac_hex.len() != 64 {
        return Err(Error::Format("envelope: wrong iv/mac length".into()));
    }
    if ct_hex.is_empty() || ct_hex.len() % 32 != 0 {
        return Err(Error::Format("envelope: ct not block-aligned".into()));
    }

    let iv = hex_decode(iv_hex).ok_or_else(|| Error::Format("non-hex iv".into()))?;
    let ct = hex_decode(ct_hex).ok_or_else(|| Error::Format("non-hex ct".into()))?;
    let provided_mac =
        hex_decode(mac_hex).ok_or_else(|| Error::Format("non-hex mac".into()))?;

    // MAC verify FIRST (encrypt-then-MAC; HMAC's verify is constant-time).
    let mut hmac = <HmacSha256 as Mac>::new_from_slice(&mac_key)
        .map_err(|e| Error::Crypto(e.to_string()))?;
    hmac.update(mac_scope.as_bytes());
    hmac.verify_slice(&provided_mac).map_err(|_| Error::Mac)?;

    // AES-256-CBC decrypt with PKCS#7 padding.
    let iv_arr: [u8; 16] = iv
        .as_slice()
        .try_into()
        .map_err(|_| Error::Format("iv not 16 bytes".into()))?;
    let cipher = Aes256CbcDec::new((&enc_key).into(), &iv_arr.into());
    let mut buf = ct.clone();
    let plain = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| Error::Crypto(e.to_string()))?;
    Ok(plain.to_vec())
}

fn encrypt_envelope(
    plaintext: &[u8],
    enc_key: &[u8; 32],
    mac_key: &[u8; 32],
) -> Result<String, Error> {
    let iv_vec = random_bytes(16)?;
    let iv: [u8; 16] = iv_vec.as_slice().try_into().unwrap();
    let iv_hex = hex_encode(&iv);

    // AES-256-CBC encrypt with PKCS#7 padding.
    let cipher = Aes256CbcEnc::new(enc_key.into(), &iv.into());
    let mut buf = vec![0u8; plaintext.len() + 16]; // room for padding
    let ct = cipher
        .encrypt_padded_b2b_mut::<Pkcs7>(plaintext, &mut buf)
        .map_err(|e| Error::Crypto(e.to_string()))?;
    let ct_hex = hex_encode(ct);

    let mac_scope = format!("{VAULT_VERSION}:{iv_hex}:{ct_hex}");
    let mut hmac = <HmacSha256 as Mac>::new_from_slice(mac_key)
        .map_err(|e| Error::Crypto(e.to_string()))?;
    hmac.update(mac_scope.as_bytes());
    let mac_hex = hex_encode(&hmac.finalize().into_bytes());

    Ok(format!(
        "xenv:{VAULT_VERSION}:{iv_hex}:{ct_hex}:{mac_hex}\n"
    ))
}

fn atomic_write(dest: &Path, content: &str) -> Result<(), Error> {
    let tmp = dest.with_extension("enc.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
    }
    // Best-effort mode 600 — POSIX only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    }
    fs::rename(&tmp, dest)?;
    Ok(())
}

/// Decrypt and return the plaintext bytes for one key.
pub fn get(env_name: &str, key: &str) -> Result<Vec<u8>, Error> {
    let p = read_params(env_name)?;
    let pass = passphrase(env_name)?;
    let salt_hex = hex_encode(&p.salt);
    let env_okm = pbkdf2_okm(&pass, &p.salt, p.iter);

    let file = root()
        .join("envs")
        .join(env_name)
        .join(format!("{key}{VALUE_EXT}"));
    if !Path::new(&file).is_file() {
        return Err(Error::NotFound(format!("no such key: {key}")));
    }
    let envelope = fs::read_to_string(&file)?;
    decrypt_envelope(&envelope, &pass, &salt_hex, p.iter, &env_okm)
}

/// Encrypt plaintext and atomically write it.
/// Reuses the env's existing salt and iter; only a fresh IV is generated.
pub fn set(env_name: &str, key: &str, plaintext: &[u8]) -> Result<(), Error> {
    let p = read_params(env_name)?;
    let (enc_key, mac_key) = derive_keys(&passphrase(env_name)?, &p.salt, p.iter);
    let env_dir = root().join("envs").join(env_name);
    if !env_dir.is_dir() {
        return Err(Error::NotFound(format!(
            "no env directory: {}",
            env_dir.display()
        )));
    }
    let envelope = encrypt_envelope(plaintext, &enc_key, &mac_key)?;
    let dest = env_dir.join(format!("{key}{VALUE_EXT}"));
    atomic_write(&dest, &envelope)
}

/// Return a map of every variable in the named env to its decrypted bytes.
pub fn load(env_name: &str) -> Result<BTreeMap<String, Vec<u8>>, Error> {
    let p = read_params(env_name)?;
    let pass = passphrase(env_name)?;
    let salt_hex = hex_encode(&p.salt);
    let env_okm = pbkdf2_okm(&pass, &p.salt, p.iter); // ONE PBKDF2 for the env

    let env_dir = root().join("envs").join(env_name);
    let mut out = BTreeMap::new();
    for entry in fs::read_dir(&env_dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(VALUE_EXT) {
            continue;
        }
        let key = name[..name.len() - VALUE_EXT.len()].to_string();
        let envelope = fs::read_to_string(entry.path())?;
        out.insert(key, decrypt_envelope(&envelope, &pass, &salt_hex, p.iter, &env_okm)?);
    }
    Ok(out)
}
