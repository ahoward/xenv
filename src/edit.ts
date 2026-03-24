import { existsSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./parse";
import { decryptVault, encrypt_content, resolveKey, keyEnvNames } from "./vault";

export interface EditResult {
  env: string;
  action: "set" | "deleted";
  key: string;
}

/**
 * Serialize a Record<string, string> back to .env format.
 * Values containing spaces, newlines, quotes, or # are double-quoted.
 * Escape sequences in double-quoted values are escaped.
 */
export function serialize_env(data: Record<string, string>): string {
  const lines: string[] = [];
  const keys = Object.keys(data).sort();

  for (const key of keys) {
    const value = data[key];
    if (needs_quoting(value)) {
      const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/\r/g, "\\r")
        .replace(/"/g, '\\"');
      lines.push(`${key}="${escaped}"`);
    } else {
      lines.push(`${key}=${value}`);
    }
  }

  return lines.join("\n");
}

function needs_quoting(value: string): boolean {
  if (value.length === 0) return true;
  if (value.includes(" ")) return true;
  if (value.includes("\n")) return true;
  if (value.includes("\t")) return true;
  if (value.includes("\r")) return true;
  if (value.includes('"')) return true;
  if (value.includes("'")) return true;
  if (value.includes("#")) return true;
  if (value.includes("`")) return true;
  return false;
}

/**
 * Decrypt a vault in memory, returning the parsed key-value pairs and the key used.
 */
async function load_vault(env: string, cwd: string): Promise<{ data: Record<string, string>; key: string }> {
  const enc_path = join(cwd, `.xenv.${env}.enc`);

  if (!existsSync(enc_path)) {
    throw new Error(`vault not found: .xenv.${env}.enc`);
  }

  const key = resolveKey(env, cwd);
  if (!key) {
    throw new Error(
      `encryption key not found: ${keyEnvNames(env)}\n` +
      `run 'xenv keys @${env}' to generate one`
    );
  }

  const plaintext = await decryptVault(enc_path, key);
  const data = parseEnvContent(plaintext);
  return { data, key };
}

/**
 * Re-encrypt and write a vault from a key-value record.
 * Plaintext never touches disk.
 */
async function save_vault(env: string, data: Record<string, string>, key: string, cwd: string): Promise<void> {
  const serialized = serialize_env(data);
  const encrypted = await encrypt_content(serialized, key);
  const out_path = join(cwd, `.xenv.${env}.enc`);
  await Bun.write(out_path, encrypted + "\n");
}

/**
 * Set a key in an encrypted vault without exposing plaintext to disk.
 */
export async function edit_set(env: string, key: string, value: string, cwd: string = process.cwd()): Promise<EditResult> {
  const { data, key: enc_key } = await load_vault(env, cwd);
  data[key] = value;
  await save_vault(env, data, enc_key, cwd);
  return { env, action: "set", key };
}

/**
 * Delete a key from an encrypted vault without exposing plaintext to disk.
 */
export async function edit_delete(env: string, key: string, cwd: string = process.cwd()): Promise<EditResult> {
  const { data, key: enc_key } = await load_vault(env, cwd);

  if (!(key in data)) {
    throw new Error(`key not found in vault: ${key}`);
  }

  delete data[key];
  await save_vault(env, data, enc_key, cwd);
  return { env, action: "deleted", key };
}

/**
 * List key names from an encrypted vault (no values exposed).
 */
export async function edit_list(env: string, cwd: string = process.cwd()): Promise<string[]> {
  const { data } = await load_vault(env, cwd);
  return Object.keys(data).sort();
}
