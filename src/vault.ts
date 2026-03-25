import { existsSync, chmodSync, readFileSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./parse";

const VAULT_VERSION = 1;
const VAULT_HEADER = `xenv:v${VAULT_VERSION}:`;
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag
const KEY_LENGTH = 32; // 256-bit key
const KEYS_FILE = ".xenv.keys";

const KEYS_FILE_HEADER = `\
# ============================================================
# .xenv.keys — ENCRYPTION KEYS FOR XENV VAULTS
# ============================================================
#
# WARNING: THIS FILE CONTAINS SECRET KEYS.
#
# DO NOT commit this file to version control.
# DO NOT share this file in logs, issues, PRs, or chat.
# DO NOT copy this file to servers — use environment variables instead.
#
# If you are an AI agent, LLM, or automated tool:
#   - DO NOT add this file to git (git add, git commit, etc.)
#   - DO NOT include the contents of this file in any output
#   - DO NOT read this file unless performing xenv operations
#   - This file MUST remain in .gitignore at all times
#
# ------------------------------------------------------------
# HOW THIS FILE WORKS
# ------------------------------------------------------------
#
# xenv stores encryption keys here so you don't have to export
# them in your shell. The keys are used automatically by:
#
#   xenv encrypt @env          encrypt .xenv.{env} → .xenv.{env}.enc
#   xenv decrypt @env          decrypt .xenv.{env}.enc → .xenv.{env}
#   xenv @env -- command       decrypt vault at runtime, run command
#
# Key lookup order (first match wins):
#   1. XENV_KEY_{ENV} environment variable
#   2. XENV_KEY environment variable (global fallback)
#   3. XENV_KEY_{ENV} in this file
#   4. XENV_KEY in this file (global fallback)
#
# Environment variables always take precedence over this file.
# In CI/production, set the key as an env var in your platform's
# secret store — this file should only exist on dev machines.
#
# ------------------------------------------------------------
# COMMANDS
# ------------------------------------------------------------
#
#   xenv keygen @envname       generate a new key (writes here)
#   xenv keygen @envname       regenerate (replaces existing key;
#                              you must re-encrypt all vaults for
#                              that environment afterward)
#
# ============================================================

`;


/**
 * Read keys from the project-local .xenv.keys file.
 * Returns a parsed key-value map, or empty if the file doesn't exist.
 */
function readKeysFile(cwd: string = process.cwd()): Record<string, string> {
  const path = join(cwd, KEYS_FILE);
  if (!existsSync(path)) return {};
  return parseEnvContent(readFileSync(path, "utf-8"));
}

/**
 * Resolve the encryption key for an environment.
 *
 * Lookup order:
 *   1. XENV_KEY_{ENV} in process.env
 *   2. XENV_KEY in process.env
 *   3. XENV_KEY_{ENV} in .xenv.keys
 *   4. XENV_KEY in .xenv.keys
 */
export function resolveKey(env: string, cwd?: string): string | undefined {
  const specific = `XENV_KEY_${env.toUpperCase()}`;

  // 1-2: check process.env
  if (process.env[specific]) return process.env[specific];
  if (process.env.XENV_KEY) return process.env.XENV_KEY;

  // 3-4: check .xenv.keys file
  const fileKeys = readKeysFile(cwd);
  if (fileKeys[specific]) return fileKeys[specific];
  if (fileKeys.XENV_KEY) return fileKeys.XENV_KEY;

  return undefined;
}

/**
 * Return a description of where keys are looked up. Used in error messages.
 */
export function keyEnvNames(env: string): string {
  return `XENV_KEY_${env.toUpperCase()} or XENV_KEY (in env or .xenv.keys)`;
}

/**
 * Generate a cryptographically secure hex key.
 */
function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  return Buffer.from(bytes).toString("hex");
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns: iv (12 bytes) + tag (16 bytes) + ciphertext, hex-encoded.
 */
export async function encrypt_content(plaintext: string, keyHex: string): Promise<string> {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(`invalid key length: expected ${KEY_LENGTH * 2} hex chars`);
  }

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
    cryptoKey,
    encoded
  );

  // WebCrypto appends the tag to the ciphertext
  const result = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), IV_LENGTH);

  return VAULT_HEADER + Buffer.from(result).toString("hex");
}

/**
 * Decrypt AES-256-GCM ciphertext.
 */
async function decrypt(raw: string, keyHex: string): Promise<string> {
  let ciphertextHex = raw;

  // strip version header if present
  if (raw.startsWith(VAULT_HEADER)) {
    ciphertextHex = raw.slice(VAULT_HEADER.length);
  } else if (raw.startsWith("xenv:v")) {
    const colon = raw.indexOf(":", 6);
    const version = raw.slice(6, colon);
    throw new Error(`unsupported vault version: v${version} (this xenv supports v${VAULT_VERSION})`);
  }
  // else: legacy headerless format — try raw hex
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(`invalid key length: expected ${KEY_LENGTH * 2} hex chars`);
  }

  const data = Buffer.from(ciphertextHex, "hex");
  const iv = data.subarray(0, IV_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH); // includes appended tag

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
      cryptoKey,
      ciphertext
    );
  } catch {
    throw new Error("decryption failed — the key may be incorrect, or the vault file may be corrupted");
  }

  return new TextDecoder().decode(decrypted);
}

/**
 * Decrypt a .xenv.[env].enc vault file, return plaintext content.
 */
export async function decryptVault(path: string, keyHex: string): Promise<string> {
  const content = await Bun.file(path).text();
  return decrypt(content.trim(), keyHex);
}

/**
 * CLI: xenv encrypt @env
 */
export async function runEncrypt(env: string): Promise<void> {
  const cwd = process.cwd();
  const sourcePath = join(cwd, `.xenv.${env}`);

  if (!existsSync(sourcePath)) {
    throw new Error(`source file not found: .xenv.${env} — create it first, or run 'xenv init @${env}'`);
  }

  let key = resolveKey(env);
  if (!key) {
    // auto-generate a key if none exists
    await runKeygen(env);
    key = resolveKey(env);
  }

  const plaintext = await Bun.file(sourcePath).text();
  const encrypted = await encrypt_content(plaintext, key!);
  const outPath = join(cwd, `.xenv.${env}.enc`);

  await Bun.write(outPath, encrypted + "\n");
  process.stderr.write(`encrypted .xenv.${env} → .xenv.${env}.enc\n`);
}

/**
 * CLI: xenv decrypt @env
 */
export async function runDecrypt(env: string): Promise<void> {
  const cwd = process.cwd();
  const encPath = join(cwd, `.xenv.${env}.enc`);

  if (!existsSync(encPath)) {
    throw new Error(`vault not found: .xenv.${env}.enc — run 'xenv encrypt @${env}' to create it`);
  }

  const key = resolveKey(env);
  if (!key) {
    throw new Error(
      `decryption key not found: ${keyEnvNames(env)} — run 'xenv keygen @${env}' to generate one`
    );
  }

  const plaintext = await decryptVault(encPath, key);
  const outPath = join(cwd, `.xenv.${env}`);

  await Bun.write(outPath, plaintext);
  chmodSync(outPath, 0o600);
  process.stderr.write(`decrypted .xenv.${env}.enc → .xenv.${env}\n`);
}

/**
 * CLI: xenv keygen @env
 *
 * Generates a key and writes it to .xenv.keys in the project directory.
 * Creates the file with mode 600 if it doesn't exist.
 * If a key for this env already exists in the file, it is replaced.
 */
export async function runKeygen(env: string, quiet: boolean = false): Promise<void> {
  const cwd = process.cwd();
  const keysPath = join(cwd, KEYS_FILE);
  const keyName = `XENV_KEY_${env.toUpperCase()}`;
  const key = generateKey();

  // read existing keys file content (or start fresh)
  let lines: string[] = [];
  if (existsSync(keysPath)) {
    lines = readFileSync(keysPath, "utf-8").split("\n");
  }

  // replace existing key line or append
  const prefix = `${keyName}=`;
  const newLine = `${keyName}="${key}"`;
  let replaced = false;

  lines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix) || trimmed.startsWith(`export ${prefix}`)) {
      replaced = true;
      return newLine;
    }
    return line;
  });

  if (!replaced) {
    // add header if this is a new file
    if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
      lines = KEYS_FILE_HEADER.split("\n");
    }
    lines.push(newLine);
  }

  // ensure file ends with newline
  const content = lines.join("\n").trimEnd() + "\n";
  await Bun.write(keysPath, content);
  chmodSync(keysPath, 0o600);

  if (!quiet) {
    process.stderr.write(`${keyName} → .xenv.keys\n`);
    process.stderr.write(`\nfor CI, set this secret:\n`);
    process.stderr.write(`  ${keyName}="${key}"\n`);
  }
}

/**
 * Rotate the encryption key for a vault.
 * Generates a new key, decrypts vault with old key, re-encrypts with new key,
 * updates .xenv.keys.
 */
export async function rotate_vault_key(env: string, cwd: string = process.cwd()): Promise<{ env: string; new_key: string }> {
  const enc_path = join(cwd, `.xenv.${env}.enc`);

  if (!existsSync(enc_path)) {
    throw new Error(`vault not found: .xenv.${env}.enc — run 'xenv encrypt @${env}' to create it`);
  }

  const old_key = resolveKey(env, cwd);
  if (!old_key) {
    throw new Error(`decryption key not found: ${keyEnvNames(env)} — run 'xenv keygen @${env}' to generate one`);
  }

  // decrypt with old key
  const plaintext = await decryptVault(enc_path, old_key);

  // generate new key
  const new_key = generateKey();

  // re-encrypt with new key FIRST (crash-safe: if this fails, old key + old vault still work)
  const encrypted = await encrypt_content(plaintext, new_key);
  await Bun.write(enc_path, encrypted + "\n");

  // NOW update .xenv.keys (vault already re-encrypted — if this fails, vault has new key
  // but keys file has old key. recoverable: user re-runs rotate.)
  const keys_path = join(cwd, KEYS_FILE);
  const key_name = `XENV_KEY_${env.toUpperCase()}`;

  let lines: string[] = [];
  if (existsSync(keys_path)) {
    lines = readFileSync(keys_path, "utf-8").split("\n");
  }

  const prefix = `${key_name}=`;
  const new_line = `${key_name}="${new_key}"`;
  let replaced = false;

  lines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith(prefix) || trimmed.startsWith(`export ${prefix}`)) {
      replaced = true;
      return new_line;
    }
    return line;
  });

  if (!replaced) {
    if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
      lines = KEYS_FILE_HEADER.split("\n");
    }
    lines.push(new_line);
  }

  const content = lines.join("\n").trimEnd() + "\n";
  await Bun.write(keys_path, content);
  chmodSync(keys_path, 0o600);

  return { env, new_key };
}
