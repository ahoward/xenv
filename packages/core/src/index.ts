/**
 * @xenv/core — programmatic xenv for Node.js, Bun, and Deno.
 *
 * Load encrypted .xenv vaults and resolve the 7-layer cascade
 * without the CLI binary. Zero dependencies.
 *
 * @example
 * ```typescript
 * import { loadEnv } from "@xenv/core";
 *
 * const env = await loadEnv("production");
 * console.log(env.DATABASE_URL);
 * ```
 *
 * @example
 * ```typescript
 * // inject into process.env (like dotenv)
 * import { loadEnv } from "@xenv/core";
 *
 * await loadEnv("production", { inject: true });
 * // process.env.DATABASE_URL is now set
 * ```
 */

import { resolveCascade } from "./resolve";
import type { LoadEnvOptions } from "./types";

export { parseEnvContent } from "./parse";
export { decryptContent, encryptContent, decryptVault, resolveKey, keyEnvNames, parseGlobalKeysContent } from "./vault";
export { resolveCascade } from "./resolve";
export type { LoadEnvOptions, GlobalKeysSection } from "./types";

/**
 * Load and resolve environment variables for a named environment.
 *
 * Reads `.xenv.*`, `.env.*`, and encrypted `.xenv.*.enc` vault files,
 * merges them through the 7-layer cascade, and returns the result.
 *
 * @param env - Environment name (default: "development")
 * @param opts - Options (cwd, inject, override)
 * @returns Resolved environment variables
 */
export async function loadEnv(
  env: string = "development",
  opts: LoadEnvOptions = {}
): Promise<Record<string, string>> {
  const { cwd = process.cwd(), inject = false, override = true } = opts;

  // resolve the cascade (layers 1-6)
  const cascade = await resolveCascade(env, cwd);

  // layer 7: system env overrides cascade keys
  const merged: Record<string, string> = Object.create(null);
  Object.assign(merged, cascade);
  for (const key of Object.keys(cascade)) {
    if (process.env[key] !== undefined && !key.startsWith("XENV_KEY")) {
      merged[key] = process.env[key]!;
    }
  }

  // optionally inject into process.env
  if (inject) {
    for (const [k, v] of Object.entries(merged)) {
      if (override || process.env[k] === undefined) {
        process.env[k] = v;
      }
    }
  }

  return merged;
}
