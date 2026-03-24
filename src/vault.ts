import { existsSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./parse";

const VAULT_VERSION = 1;
const VAULT_HEADER = `xenv:v${VAULT_VERSION}:`;
const IV_LENGTH = 12; // 96-bit IV for GCM
const TAG_LENGTH = 16; // 128-bit auth tag
const KEY_LENGTH = 32; // 256-bit key

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
async function encrypt(plaintext: string, keyHex: string): Promise<string> {
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

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, tagLength: TAG_LENGTH * 8 },
    cryptoKey,
    ciphertext
  );

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
    throw new Error(`source file not found: .xenv.${env}`);
  }

  const keyEnvName = `XENV_KEY_${env.toUpperCase()}`;
  const key = process.env[keyEnvName];
  if (!key) {
    throw new Error(
      `encryption key not found in environment: ${keyEnvName}\n` +
      `run 'xenv keys @${env}' to generate one`
    );
  }

  const plaintext = await Bun.file(sourcePath).text();
  const encrypted = await encrypt(plaintext, key);
  const outPath = join(cwd, `.xenv.${env}.enc`);

  await Bun.write(outPath, encrypted + "\n");
  console.log(`encrypted .xenv.${env} → .xenv.${env}.enc`);
}

/**
 * CLI: xenv decrypt @env
 */
export async function runDecrypt(env: string): Promise<void> {
  const cwd = process.cwd();
  const encPath = join(cwd, `.xenv.${env}.enc`);

  if (!existsSync(encPath)) {
    throw new Error(`vault not found: .xenv.${env}.enc`);
  }

  const keyEnvName = `XENV_KEY_${env.toUpperCase()}`;
  const key = process.env[keyEnvName];
  if (!key) {
    throw new Error(
      `decryption key not found in environment: ${keyEnvName}`
    );
  }

  const plaintext = await decryptVault(encPath, key);
  const outPath = join(cwd, `.xenv.${env}`);

  await Bun.write(outPath, plaintext);
  console.log(`decrypted .xenv.${env}.enc → .xenv.${env}`);
}

/**
 * CLI: xenv keys @env
 */
export async function runKeys(env: string): Promise<void> {
  const key = generateKey();
  const keyEnvName = `XENV_KEY_${env.toUpperCase()}`;
  console.log(`# add this to your shell profile or CI secrets:\nexport ${keyEnvName}="${key}"`);
}
