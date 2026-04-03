import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseEnvContent } from "./parse";
import type { GlobalKeysSection } from "./types";

const VAULT_VERSION = 1;
const VAULT_HEADER = `xenv:v${VAULT_VERSION}:`;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const KEYS_FILE = ".xenv.keys";

// crypto.subtle — works in Node 19+, Bun, Deno natively.
// for Node 18, fall back to node:crypto webcrypto.
function getSubtle(): SubtleCrypto {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle;
  // Node 18 fallback
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = require("node:crypto");
    return (nodeCrypto as any).webcrypto.subtle;
  } catch {
    throw new Error("crypto.subtle not available — requires Node 18+, Bun, or Deno");
  }
}

// ── decryption ─────────────────────────────────────────────────────

/**
 * Decrypt AES-256-GCM ciphertext.
 */
export async function decryptContent(raw: string, keyHex: string): Promise<string> {
  let ciphertextHex = raw;

  if (raw.startsWith(VAULT_HEADER)) {
    ciphertextHex = raw.slice(VAULT_HEADER.length);
  } else if (raw.startsWith("xenv:v")) {
    const colon = raw.indexOf(":", 6);
    const version = raw.slice(6, colon);
    throw new Error(`unsupported vault version: v${version} (this xenv supports v${VAULT_VERSION})`);
  }

  const key = Buffer.from(keyHex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(`invalid key length: expected ${KEY_LENGTH * 2} hex chars`);
  }

  const data = Buffer.from(ciphertextHex, "hex");
  const iv = data.subarray(0, IV_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH);

  const s = getSubtle();
  const cryptoKey = await s.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  let decrypted: ArrayBuffer;
  try {
    decrypted = await s.decrypt(
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
 * Encrypt plaintext with AES-256-GCM.
 */
export async function encryptContent(plaintext: string, keyHex: string): Promise<string> {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== KEY_LENGTH) {
    throw new Error(`invalid key length: expected ${KEY_LENGTH * 2} hex chars`);
  }

  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const s = getSubtle();
  const cryptoKey = await s.importKey(
    "raw",
    key,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await s.encrypt(
    { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
    cryptoKey,
    encoded
  );

  const result = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(encrypted), IV_LENGTH);

  return VAULT_HEADER + Buffer.from(result).toString("hex");
}

/**
 * Decrypt a vault file, return plaintext content.
 */
export async function decryptVault(path: string, keyHex: string): Promise<string> {
  const content = await readFile(path, "utf-8");
  return decryptContent(content.trim(), keyHex);
}

// ── key resolution ─────────────────────────────────────────────────

/**
 * Read keys from a project-local .xenv.keys file.
 */
function readKeysFile(cwd: string): Record<string, string> {
  const path = join(cwd, KEYS_FILE);
  if (!existsSync(path)) return {};
  return parseEnvContent(readFileSync(path, "utf-8"));
}

/**
 * Parse global keys file content with # root: directives.
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
      current_root = root_match[1].trim().replace(/\/+$/, "");
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
 */
function resolveGlobalKey(key_name: string, cwd: string): string | undefined {
  const sections = readGlobalKeysFile();
  let resolved_cwd: string;
  try { resolved_cwd = realpathSync(cwd); } catch { resolved_cwd = cwd; }

  const matches = sections
    .filter((s): s is GlobalKeysSection & { root: string } => s.root !== null)
    .filter(s => {
      let resolved_root: string;
      try { resolved_root = realpathSync(s.root); } catch { resolved_root = s.root; }
      return resolved_cwd === resolved_root || resolved_cwd.startsWith(resolved_root + "/");
    })
    .sort((a, b) => b.root.length - a.root.length);

  if (matches.length > 0 && matches[0].keys[key_name]) {
    return matches[0].keys[key_name];
  }

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
 * Lookup order (8 steps, first match wins):
 *   1. XENV_KEY_{ENV} in process.env
 *   2. XENV_KEY in process.env
 *   3. XENV_KEY_{ENV} in .xenv.keys (project-local)
 *   4. XENV_KEY in .xenv.keys (project-local)
 *   5. XENV_KEY_{ENV} in ~/.xenv.keys (root-scoped match)
 *   6. XENV_KEY in ~/.xenv.keys (root-scoped match)
 *   7. XENV_KEY_{ENV} in ~/.xenv.keys (global fallback)
 *   8. XENV_KEY in ~/.xenv.keys (global fallback)
 */
export function resolveKey(env: string, cwd?: string): string | undefined {
  const specific = `XENV_KEY_${env.toUpperCase()}`;
  const resolved_cwd = cwd ?? process.cwd();

  if (process.env[specific]) return process.env[specific];
  if (process.env.XENV_KEY) return process.env.XENV_KEY;

  const fileKeys = readKeysFile(resolved_cwd);
  if (fileKeys[specific]) return fileKeys[specific];
  if (fileKeys.XENV_KEY) return fileKeys.XENV_KEY;

  const global_specific = resolveGlobalKey(specific, resolved_cwd);
  if (global_specific) return global_specific;
  const global_fallback = resolveGlobalKey("XENV_KEY", resolved_cwd);
  if (global_fallback) return global_fallback;

  return undefined;
}

/**
 * Human-readable description of key lookup locations. Used in error messages.
 */
export function keyEnvNames(env: string): string {
  return `XENV_KEY_${env.toUpperCase()} or XENV_KEY (in env, .xenv.keys, or ~/.xenv.keys)`;
}
