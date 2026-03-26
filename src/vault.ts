import { existsSync, chmodSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { realpathSync } from "fs";
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
#   3. XENV_KEY_{ENV} in this file (.xenv.keys)
#   4. XENV_KEY in this file (global fallback)
#   5. XENV_KEY_{ENV} in ~/.xenv.keys (root-scoped section)
#   6. XENV_KEY in ~/.xenv.keys (root-scoped section)
#   7. XENV_KEY_{ENV} in ~/.xenv.keys (global fallback)
#   8. XENV_KEY in ~/.xenv.keys (global fallback)
#
# Environment variables always take precedence.
# In CI/production, set the key as an env var in your platform's
# secret store — this file should only exist on dev machines.
# For extra safety, use ~/.xenv.keys with "# root:" directives
# to keep keys outside the repo entirely:
#   xenv keygen @env --global
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

const GLOBAL_KEYS_FILE_HEADER = `\
# ============================================================
# ~/.xenv.keys — GLOBAL ENCRYPTION KEYS FOR XENV VAULTS
# ============================================================
#
# WARNING: THIS FILE CONTAINS SECRET KEYS.
#
# This file lives outside any repository, so it cannot be
# accidentally committed by git or AI agents.
#
# ------------------------------------------------------------
# HOW THIS FILE WORKS
# ------------------------------------------------------------
#
# Use "# root: /absolute/path" directives to scope keys to a
# specific project directory. Keys below a root directive apply
# only when xenv is run from that directory (or a subdirectory).
#
# Keys before any root directive are global fallbacks — they
# apply to any project that doesn't have a more specific match.
#
# Example:
#
#   # root: /home/user/projects/myapp
#   XENV_KEY_PRODUCTION="abc123..."
#   XENV_KEY_STAGING="def456..."
#
#   # root: /home/user/projects/other
#   XENV_KEY_PRODUCTION="ghi789..."
#
#   # global fallback (no root directive above)
#   XENV_KEY="fallback..."
#
# Generate with:
#   xenv keygen @env --global
#
# ============================================================

`;

// ── keys file reading ──────────────────────────────────────────────

/**
 * Read keys from the project-local .xenv.keys file.
 * Returns a parsed key-value map, or empty if the file doesn't exist.
 */
function readKeysFile(cwd: string = process.cwd()): Record<string, string> {
  const path = join(cwd, KEYS_FILE);
  if (!existsSync(path)) return {};
  return parseEnvContent(readFileSync(path, "utf-8"));
}

interface GlobalKeysSection {
  root: string | null; // null = global fallback
  keys: Record<string, string>;
}

/**
 * Parse the content of a global keys file with # root: directives.
 */
export function parseGlobalKeysContent(content: string): GlobalKeysSection[] {
  const sections: GlobalKeysSection[] = [];
  let current_root: string | null = null;
  let current_lines: string[] = [];

  function flush() {
    const text = current_lines.join("\n");
    const keys = parseEnvContent(text);
    if (Object.keys(keys).length > 0) {
      sections.push({ root: current_root, keys });
    }
    current_lines = [];
  }

  for (const line of content.split("\n")) {
    const root_match = line.match(/^#\s*root:\s*(.+)$/);
    if (root_match) {
      flush();
      current_root = root_match[1].trim().replace(/\/+$/, ""); // normalize trailing slash
      continue;
    }
    current_lines.push(line);
  }
  flush();

  return sections;
}

/**
 * Read and parse the global ~/.xenv.keys file.
 */
function readGlobalKeysFile(): GlobalKeysSection[] {
  const path = join(homedir(), KEYS_FILE);
  if (!existsSync(path)) return [];
  return parseGlobalKeysContent(readFileSync(path, "utf-8"));
}

/**
 * Resolve a key from ~/.xenv.keys for a given cwd.
 * Most-specific root match wins. Falls back to global (no-root) section.
 */
function resolveGlobalKey(key_name: string, cwd: string): string | undefined {
  const sections = readGlobalKeysFile();
  let resolved_cwd: string;
  try {
    resolved_cwd = realpathSync(cwd);
  } catch {
    resolved_cwd = cwd;
  }

  // find all root-scoped sections that match cwd, sort by specificity
  const matches = sections
    .filter((s): s is GlobalKeysSection & { root: string } => s.root !== null)
    .filter(s => {
      let resolved_root: string;
      try {
        resolved_root = realpathSync(s.root);
      } catch {
        resolved_root = s.root;
      }
      return resolved_cwd === resolved_root || resolved_cwd.startsWith(resolved_root + "/");
    })
    .sort((a, b) => b.root.length - a.root.length);

  // check most-specific root match
  if (matches.length > 0 && matches[0].keys[key_name]) {
    return matches[0].keys[key_name];
  }

  // check global fallback sections (root === null)
  for (const section of sections) {
    if (section.root === null && section.keys[key_name]) {
      return section.keys[key_name];
    }
  }

  return undefined;
}

/**
 * Resolve the encryption key for an environment.
 *
 * Lookup order:
 *   1. XENV_KEY_{ENV} in process.env
 *   2. XENV_KEY in process.env
 *   3. XENV_KEY_{ENV} in .xenv.keys (project-local)
 *   4. XENV_KEY in .xenv.keys (project-local)
 *   5. XENV_KEY_{ENV} in ~/.xenv.keys (most-specific root match)
 *   6. XENV_KEY in ~/.xenv.keys (most-specific root match)
 *   7. XENV_KEY_{ENV} in ~/.xenv.keys (global fallback)
 *   8. XENV_KEY in ~/.xenv.keys (global fallback)
 */
export function resolveKey(env: string, cwd?: string): string | undefined {
  const specific = `XENV_KEY_${env.toUpperCase()}`;
  const resolved_cwd = cwd ?? process.cwd();

  // 1-2: check process.env
  if (process.env[specific]) return process.env[specific];
  if (process.env.XENV_KEY) return process.env.XENV_KEY;

  // 3-4: check project-local .xenv.keys
  const fileKeys = readKeysFile(resolved_cwd);
  if (fileKeys[specific]) return fileKeys[specific];
  if (fileKeys.XENV_KEY) return fileKeys.XENV_KEY;

  // 5-8: check ~/.xenv.keys (root-scoped then global fallback)
  const global_specific = resolveGlobalKey(specific, resolved_cwd);
  if (global_specific) return global_specific;
  const global_fallback = resolveGlobalKey("XENV_KEY", resolved_cwd);
  if (global_fallback) return global_fallback;

  return undefined;
}

/**
 * Return a description of where keys are looked up. Used in error messages.
 */
export function keyEnvNames(env: string): string {
  return `XENV_KEY_${env.toUpperCase()} or XENV_KEY (in env, .xenv.keys, or ~/.xenv.keys)`;
}

/**
 * Collect all encryption key VALUES from project-local and global keys files.
 * Used by hook and audit to scan for leaked key material.
 * Only returns values that look like hex keys (64-char hex strings).
 */
export function getAllKeyValues(cwd: string = process.cwd()): string[] {
  const values = new Set<string>();
  const HEX_KEY = /^[a-f0-9]{64}$/i;

  // project-local keys
  const local = readKeysFile(cwd);
  for (const v of Object.values(local)) {
    if (HEX_KEY.test(v)) values.add(v);
  }

  // global keys — all sections that match cwd, plus global fallback
  const sections = readGlobalKeysFile();
  let resolved_cwd: string;
  try {
    resolved_cwd = realpathSync(cwd);
  } catch {
    resolved_cwd = cwd;
  }

  for (const section of sections) {
    let include = false;
    if (section.root === null) {
      include = true;
    } else {
      let resolved_root: string;
      try {
        resolved_root = realpathSync(section.root);
      } catch {
        resolved_root = section.root;
      }
      include = resolved_cwd === resolved_root || resolved_cwd.startsWith(resolved_root + "/");
    }
    if (include) {
      for (const v of Object.values(section.keys)) {
        if (HEX_KEY.test(v)) values.add(v);
      }
    }
  }

  return [...values];
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
    // auto-generate a key if none exists (quiet — don't leak key to stderr)
    await runKeygen(env, true);
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
 * CLI: xenv keygen @env [--global]
 *
 * Generates a key and writes it to .xenv.keys (project-local) or
 * ~/.xenv.keys (global, with a # root: directive scoped to cwd).
 * Creates the file with mode 600 if it doesn't exist.
 * If a key for this env already exists in the file, it is replaced.
 */
export async function runKeygen(env: string, quiet: boolean = false, global: boolean = false): Promise<void> {
  const cwd = process.cwd();
  const keyName = `XENV_KEY_${env.toUpperCase()}`;
  const key = generateKey();

  if (global) {
    await writeGlobalKey(cwd, keyName, key);
    if (!quiet) {
      process.stderr.write(`${keyName} → ~/.xenv.keys (root: ${cwd})\n`);
      process.stderr.write(`\nfor CI, set this secret:\n`);
      process.stderr.write(`  ${keyName}="${key}"\n`);
    }
    return;
  }

  const keysPath = join(cwd, KEYS_FILE);

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
 * Write a key to ~/.xenv.keys under a # root: section for the given cwd.
 */
async function writeGlobalKey(cwd: string, keyName: string, key: string): Promise<void> {
  const globalPath = join(homedir(), KEYS_FILE);
  const newLine = `${keyName}="${key}"`;
  const rootDirective = `# root: ${cwd}`;

  if (!existsSync(globalPath)) {
    // create fresh with header + section
    const content = GLOBAL_KEYS_FILE_HEADER + rootDirective + "\n" + newLine + "\n";
    await Bun.write(globalPath, content);
    chmodSync(globalPath, 0o600);
    return;
  }

  const lines = readFileSync(globalPath, "utf-8").split("\n");
  const prefix = `${keyName}=`;

  // find the # root: <cwd> section
  let section_start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#\s*root:\s*(.+)$/);
    if (m && m[1].trim().replace(/\/+$/, "") === cwd) {
      section_start = i;
      break;
    }
  }

  if (section_start >= 0) {
    // find the key within this section (between section_start and next # root: or EOF)
    let key_line = -1;
    for (let i = section_start + 1; i < lines.length; i++) {
      if (lines[i].match(/^#\s*root:/)) break; // next section
      const trimmed = lines[i].trim();
      if (trimmed.startsWith(prefix) || trimmed.startsWith(`export ${prefix}`)) {
        key_line = i;
        break;
      }
    }

    if (key_line >= 0) {
      lines[key_line] = newLine;
    } else {
      // insert after section header
      lines.splice(section_start + 1, 0, newLine);
    }
  } else {
    // no section for this cwd — append one
    // ensure blank line before new section
    const last = lines[lines.length - 1];
    if (last !== undefined && last.trim() !== "") {
      lines.push("");
    }
    lines.push(rootDirective);
    lines.push(newLine);
  }

  const content = lines.join("\n").trimEnd() + "\n";
  await Bun.write(globalPath, content);
  chmodSync(globalPath, 0o600);
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

  return { env };
}
