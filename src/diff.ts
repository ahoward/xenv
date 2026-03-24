import { existsSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./parse";
import { decryptVault, resolveKey, keyEnvNames } from "./vault";

export interface DiffEntry {
  key: string;
  plaintext_value?: string;
  vault_value?: string;
}

export interface DiffResult {
  env: string;
  added: DiffEntry[];   // in vault but not in plaintext
  removed: DiffEntry[];  // in plaintext but not in vault
  changed: DiffEntry[];  // in both but different values
  unchanged: number;     // count of identical keys
}

/**
 * Compare the plaintext .xenv.{env} file against the encrypted .xenv.{env}.enc vault.
 * Returns structured diff showing added, removed, and changed keys.
 */
export async function diff_env(
  env: string,
  keys_only: boolean = false,
  cwd: string = process.cwd()
): Promise<DiffResult> {
  const plaintext_path = join(cwd, `.xenv.${env}`);
  const enc_path = join(cwd, `.xenv.${env}.enc`);

  const has_plaintext = existsSync(plaintext_path);
  const has_vault = existsSync(enc_path);

  if (!has_plaintext && !has_vault) {
    throw new Error(`neither .xenv.${env} nor .xenv.${env}.enc found — run 'xenv init @${env}' to get started`);
  }

  // parse plaintext if it exists
  let plaintext_data: Record<string, string> = Object.create(null);
  if (has_plaintext) {
    const content = await Bun.file(plaintext_path).text();
    plaintext_data = parseEnvContent(content);
  }

  // decrypt vault if it exists
  let vault_data: Record<string, string> = Object.create(null);
  if (has_vault) {
    const key = resolveKey(env, cwd);
    if (!key) {
      throw new Error(
        `vault exists but decryption key not found: ${keyEnvNames(env)} — run 'xenv keys @${env}' to generate one`
      );
    }
    const decrypted = await decryptVault(enc_path, key);
    vault_data = parseEnvContent(decrypted);
  }

  const all_keys = new Set([
    ...Object.keys(plaintext_data),
    ...Object.keys(vault_data),
  ]);

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  let unchanged = 0;

  for (const key of [...all_keys].sort()) {
    const in_plaintext = key in plaintext_data;
    const in_vault = key in vault_data;

    if (in_vault && !in_plaintext) {
      const entry: DiffEntry = { key };
      if (!keys_only) entry.vault_value = vault_data[key];
      added.push(entry);
    } else if (in_plaintext && !in_vault) {
      const entry: DiffEntry = { key };
      if (!keys_only) entry.plaintext_value = plaintext_data[key];
      removed.push(entry);
    } else if (plaintext_data[key] !== vault_data[key]) {
      const entry: DiffEntry = { key };
      if (!keys_only) {
        entry.plaintext_value = plaintext_data[key];
        entry.vault_value = vault_data[key];
      }
      changed.push(entry);
    } else {
      unchanged++;
    }
  }

  return { env, added, removed, changed, unchanged };
}

/**
 * Format a DiffResult as human-readable text.
 */
export function format_diff(result: DiffResult): string {
  const lines: string[] = [];
  const { added, removed, changed, unchanged } = result;

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    lines.push(`no differences (${unchanged} keys match)`);
    return lines.join("\n");
  }

  for (const entry of added) {
    if (entry.vault_value !== undefined) {
      lines.push(`+ ${entry.key}=${entry.vault_value}`);
    } else {
      lines.push(`+ ${entry.key}`);
    }
  }

  for (const entry of removed) {
    if (entry.plaintext_value !== undefined) {
      lines.push(`- ${entry.key}=${entry.plaintext_value}`);
    } else {
      lines.push(`- ${entry.key}`);
    }
  }

  for (const entry of changed) {
    if (entry.plaintext_value !== undefined) {
      lines.push(`~ ${entry.key}: "${entry.plaintext_value}" → "${entry.vault_value}"`);
    } else {
      lines.push(`~ ${entry.key}`);
    }
  }

  const summary = [];
  if (added.length > 0) summary.push(`${added.length} added`);
  if (removed.length > 0) summary.push(`${removed.length} removed`);
  if (changed.length > 0) summary.push(`${changed.length} changed`);
  if (unchanged > 0) summary.push(`${unchanged} unchanged`);
  lines.push(`\n${summary.join(", ")}`);

  return lines.join("\n");
}
