import { existsSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./parse";
import { decryptVault } from "./vault";

/**
 * Resolve environment variables via the cascade:
 *
 *  1. .env                         (legacy base)
 *  2. .xenv                        (modern base)
 *  3. .env.local / .xenv.local     (local overrides)
 *  4. .env.[env] / .xenv.[env]     (env-specific plaintext)
 *  5. .xenv.[env].enc              (encrypted vault)
 *  6. .env.[env].local / .xenv.[env].local  (env-specific local)
 *  7. System ENV                   (process.env)
 */
export async function resolveEnv(
  env: string,
  cwd: string = process.cwd()
): Promise<Record<string, string>> {
  // reject env names with path traversal or slashes
  if (env.includes("/") || env.includes("\\") || env.includes("..")) {
    throw new Error(`invalid environment name: ${env}`);
  }
  const merged: Record<string, string> = Object.create(null);

  const cascadeFiles = [
    // 1. legacy base
    [".env"],
    // 2. modern base
    [".xenv"],
    // 3. local overrides (.env.local then .xenv.local — xenv wins)
    [".env.local", ".xenv.local"],
    // 4. env-specific plaintext
    [`.env.${env}`, `.xenv.${env}`],
    // 5. encrypted vault (handled separately below)
    [],
    // 6. env-specific local overrides
    [`.env.${env}.local`, `.xenv.${env}.local`],
  ];

  for (const group of cascadeFiles) {
    for (const file of group) {
      const path = join(cwd, file);
      if (existsSync(path)) {
        const content = await Bun.file(path).text();
        const parsed = parseEnvContent(content);
        Object.assign(merged, parsed);
      }
    }
  }

  // 5. encrypted vault
  const encPath = join(cwd, `.xenv.${env}.enc`);
  if (existsSync(encPath)) {
    const keyEnvName = `XENV_KEY_${env.toUpperCase()}`;
    const key = process.env[keyEnvName];
    if (key) {
      const decrypted = await decryptVault(encPath, key);
      const parsed = parseEnvContent(decrypted);
      Object.assign(merged, parsed);
    } else {
      console.error(`xenv: warning: vault .xenv.${env}.enc exists but ${keyEnvName} is not set — skipping`);
    }
  }

  // 7. system ENV wins last
  Object.assign(merged, process.env);

  return merged;
}
