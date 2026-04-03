import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvContent } from "./parse";
import { decryptVault, resolveKey, keyEnvNames } from "./vault";

/**
 * Resolve environment variables via the 7-layer cascade:
 *
 *  1. .env                         (legacy base)
 *  2. .xenv                        (modern base)
 *  3. .env.local / .xenv.local     (local overrides)
 *  4. .env.[env] / .xenv.[env]     (env-specific plaintext)
 *  5. .xenv.[env].enc              (encrypted vault)
 *  6. .env.[env].local / .xenv.[env].local  (env-specific local)
 *  7. System ENV                   (process.env — always wins)
 */
export async function resolveCascade(
  env: string,
  cwd: string = process.cwd()
): Promise<Record<string, string>> {
  if (env.includes("/") || env.includes("\\") || env.includes("..")) {
    throw new Error(`invalid environment name: ${env}`);
  }

  const merged: Record<string, string> = Object.create(null);

  const cascadeFiles = [
    [".env"],
    [".xenv"],
    [".env.local", ".xenv.local"],
    [`.env.${env}`, `.xenv.${env}`],
    [], // slot 5: encrypted vault, handled below
    [`.env.${env}.local`, `.xenv.${env}.local`],
  ];

  for (const group of cascadeFiles) {
    for (const file of group) {
      const path = join(cwd, file);
      if (existsSync(path)) {
        const content = await readFile(path, "utf-8");
        const parsed = parseEnvContent(content);
        Object.assign(merged, parsed);
      }
    }
  }

  // 5. encrypted vault
  const encPath = join(cwd, `.xenv.${env}.enc`);
  if (existsSync(encPath)) {
    const key = resolveKey(env, cwd);
    if (key) {
      try {
        const decrypted = await decryptVault(encPath, key);
        const parsed = parseEnvContent(decrypted);
        Object.assign(merged, parsed);
      } catch {
        throw new Error(`vault decryption failed for @${env} — check that ${keyEnvNames(env)} is correct`);
      }
    }
    // silently skip if no key — matches CLI behavior for SDK use
  }

  return merged;
}
