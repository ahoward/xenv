//! Read-only loader for the xenv encrypted-environment format.
//!
//! Reference implementation generated from `../AGENT_PROMPT.md`. Reads
//! the on-disk format and returns decrypted values. No write side.
//!
//! Crypto: RustCrypto crates — `aes` + `cbc` + `hmac` + `sha2` + `pbkdf2`.
//! Rust has no stdlib crypto, but these are the universally-accepted
//! choice for the primitives we need (PBKDF2-SHA256, HMAC-SHA256,
//! AES-256-CBC). All pure Rust, all well-audited.
//!
//! Usage as a library:
//!
//! ```no_run
//! let env = xenv::load("production").unwrap();
//! let api_key: &Vec<u8> = env.get("API_KEY").unwrap();
//! ```

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, KeyIvInit};
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;
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

fn derive_keys(pass: &str, salt: &[u8], iter: u32) -> ([u8; 32], [u8; 32]) {
    let mut out = [0u8; 64];
    pbkdf2_hmac::<Sha256>(pass.as_bytes(), salt, iter, &mut out);
    let mut enc = [0u8; 32];
    let mut mac = [0u8; 32];
    enc.copy_from_slice(&out[..32]);
    mac.copy_from_slice(&out[32..]);
    (enc, mac)
}

fn decrypt_envelope(
    envelope: &str,
    enc_key: &[u8; 32],
    mac_key: &[u8; 32],
) -> Result<Vec<u8>, Error> {
    let parts: Vec<&str> = envelope.trim().split(':').collect();
    if parts.len() != 5 {
        return Err(Error::Format("envelope: wrong field count".into()));
    }
    let (tag, ver, iv_hex, ct_hex, mac_hex) =
        (parts[0], parts[1], parts[2], parts[3], parts[4]);
    if tag != "xenv" || ver != VAULT_VERSION {
        return Err(Error::Format(format!(
            "envelope: unsupported {tag}:{ver}"
        )));
    }
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
    let mac_scope = format!("{VAULT_VERSION}:{iv_hex}:{ct_hex}");
    let mut hmac = <HmacSha256 as Mac>::new_from_slice(mac_key)
        .map_err(|e| Error::Crypto(e.to_string()))?;
    hmac.update(mac_scope.as_bytes());
    hmac.verify_slice(&provided_mac).map_err(|_| Error::Mac)?;

    // AES-256-CBC decrypt with PKCS#7 padding.
    let iv_arr: [u8; 16] = iv
        .as_slice()
        .try_into()
        .map_err(|_| Error::Format("iv not 16 bytes".into()))?;
    let cipher = Aes256CbcDec::new(enc_key.into(), &iv_arr.into());
    let mut buf = ct.clone();
    let plain = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|e| Error::Crypto(e.to_string()))?;
    Ok(plain.to_vec())
}

/// Return a map of every variable in the named env to its decrypted bytes.
pub fn load(env_name: &str) -> Result<BTreeMap<String, Vec<u8>>, Error> {
    let p = read_params(env_name)?;
    let (enc_key, mac_key) = derive_keys(&passphrase(env_name)?, &p.salt, p.iter);

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
        out.insert(key, decrypt_envelope(&envelope, &enc_key, &mac_key)?);
    }
    Ok(out)
}

/// Decrypt one named value; errors if it doesn't exist.
pub fn decrypt_one(env_name: &str, key: &str) -> Result<Vec<u8>, Error> {
    let p = read_params(env_name)?;
    let (enc_key, mac_key) = derive_keys(&passphrase(env_name)?, &p.salt, p.iter);

    let file = root()
        .join("envs")
        .join(env_name)
        .join(format!("{key}{VALUE_EXT}"));
    if !Path::new(&file).is_file() {
        return Err(Error::NotFound(format!("no such key: {key}")));
    }
    let envelope = fs::read_to_string(&file)?;
    decrypt_envelope(&envelope, &enc_key, &mac_key)
}
