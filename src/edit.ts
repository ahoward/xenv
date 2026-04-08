import { existsSync, mkdtempSync, unlinkSync, rmSync, readFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { parseEnvContent } from "./parse";
import { decryptVault, encrypt_content, resolveKey, keyEnvNames, runKeygen } from "./vault";

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
    throw new Error(`vault not found: .xenv.${env}.enc — run 'xenv encrypt @${env}' to create it, or 'xenv init @${env}' to start fresh`);
  }

  const key = resolveKey(env, cwd);
  if (!key) {
    throw new Error(
      `encryption key not found: ${keyEnvNames(env)}\n` +
      `run 'xenv keygen @${env}' to generate one`
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
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export async function edit_set(env: string, key: string, value: string, cwd: string = process.cwd()): Promise<EditResult> {
  if (!VALID_KEY.test(key)) {
    throw new Error(`invalid key name: "${key}" — must match [A-Za-z_][A-Za-z0-9_]*`);
  }
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
    throw new Error(`key not found in vault: ${key} — run 'xenv edit @${env} list' to see available keys`);
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

/**
 * Open a vault in $EDITOR. Decrypts to a temp file, opens the editor,
 * re-encrypts on save. Secrets never touch the working tree.
 */
export async function edit_interactive(env: string, cwd: string = process.cwd()): Promise<{ changed: boolean }> {
  const editor = process.env.EDITOR || process.env.VISUAL || "vim";
  const enc_path = join(cwd, `.xenv.${env}.enc`);

  let plaintext = "";
  let key: string | undefined;

  if (existsSync(enc_path)) {
    key = resolveKey(env, cwd);
    if (!key) {
      throw new Error(
        `encryption key not found: ${keyEnvNames(env)}\n` +
        `run 'xenv keygen @${env}' to generate one`
      );
    }
    plaintext = await decryptVault(enc_path, key);
  } else {
    // no vault yet — start with a starter template
    plaintext = `# .xenv.${env} — add KEY=value pairs, save and quit to encrypt\n`;
    key = resolveKey(env, cwd);
    if (!key) {
      await runKeygen(env, true);
      key = resolveKey(env, cwd);
    }
  }

  // write to a temp file (mode 600)
  const tmp_dir = mkdtempSync(join(tmpdir(), "xenv-edit-"));
  const tmp_path = join(tmp_dir, `.xenv.${env}`);

  try {
    await Bun.write(tmp_path, plaintext);
    chmodSync(tmp_path, 0o600);

    // hash before editing
    const hash_before = Bun.hash(plaintext);

    // spawn editor — split EDITOR into command + args (e.g. "code --wait")
    const editor_parts = editor.split(/\s+/);
    const proc = Bun.spawn([...editor_parts, tmp_path], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;

    if (proc.exitCode !== 0) {
      throw new Error(`editor exited with code ${proc.exitCode} — vault unchanged`);
    }

    // read back
    const after = readFileSync(tmp_path, "utf-8");
    const hash_after = Bun.hash(after);

    if (hash_before === hash_after) {
      process.stderr.write(`xenv: no changes — vault unchanged\n`);
      return { changed: false };
    }

    // re-encrypt
    const encrypted = await encrypt_content(after, key!);
    await Bun.write(enc_path, encrypted + "\n");
    process.stderr.write(`xenv: encrypted → .xenv.${env}.enc\n`);
    return { changed: true };
  } finally {
    // always clean up temp file
    try { unlinkSync(tmp_path); } catch {}
    try { rmSync(tmp_dir, { recursive: true }); } catch {}
  }
}
