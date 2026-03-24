import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./parse";
import { resolveKey, keyEnvNames, decryptVault } from "./vault";
import { resolveEnv } from "./resolve";

export interface ValidationCheck {
  severity: "error" | "warning";
  code: string;
  key?: string;
  message: string;
}

export interface ValidationResult {
  env: string;
  ok: boolean;
  checks: ValidationCheck[];
}

const SENSITIVE_PATTERNS = /KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|AUTH/i;

/**
 * Validate an environment configuration for common problems.
 */
export async function validate_env(
  env: string,
  required_keys: string[] = [],
  cwd: string = process.cwd()
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];

  // load required keys from .xenv.required if it exists
  const required_path = join(cwd, ".xenv.required");
  if (existsSync(required_path)) {
    const content = readFileSync(required_path, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0 && !trimmed.startsWith("#")) {
        if (!required_keys.includes(trimmed)) {
          required_keys.push(trimmed);
        }
      }
    }
  }

  // check: vault exists but key is missing
  const enc_path = join(cwd, `.xenv.${env}.enc`);
  if (existsSync(enc_path)) {
    const key = resolveKey(env, cwd);
    if (!key) {
      checks.push({
        severity: "error",
        code: "no_key",
        message: `vault .xenv.${env}.enc exists but ${keyEnvNames(env)} is not set`,
      });
    }
  }

  // check: vault and plaintext out of sync
  const plaintext_path = join(cwd, `.xenv.${env}`);
  if (existsSync(plaintext_path) && existsSync(enc_path)) {
    const key = resolveKey(env, cwd);
    if (key) {
      const plaintext_content = readFileSync(plaintext_path, "utf-8");
      const plaintext_data = parseEnvContent(plaintext_content);
      const vault_content = await decryptVault(enc_path, key);
      const vault_data = parseEnvContent(vault_content);

      const all_keys = new Set([...Object.keys(plaintext_data), ...Object.keys(vault_data)]);
      let differs = false;
      for (const k of all_keys) {
        if (plaintext_data[k] !== vault_data[k]) { differs = true; break; }
      }

      if (differs) {
        checks.push({
          severity: "warning",
          code: "out_of_sync",
          message: `plaintext .xenv.${env} differs from vault .xenv.${env}.enc — run 'xenv encrypt @${env}' to sync`,
        });
      }
    }
  }

  // resolve the full cascade for required key and empty value checks
  let resolved: Record<string, string> = Object.create(null);
  try {
    resolved = await resolveEnv(env, cwd);
  } catch {
    // if cascade resolution fails, we can still report other findings
  }

  // check: missing required keys
  for (const key of required_keys) {
    if (!(key in resolved) || resolved[key] === undefined) {
      checks.push({
        severity: "error",
        code: "missing_required",
        key,
        message: `required key ${key} is not set in the resolved environment`,
      });
    }
  }

  // check: empty values for sensitive-looking keys
  for (const [key, value] of Object.entries(resolved)) {
    if (value === "" && SENSITIVE_PATTERNS.test(key)) {
      checks.push({
        severity: "warning",
        code: "empty_value",
        key,
        message: `${key} is empty but looks like it should contain a secret`,
      });
    }
  }

  return {
    env,
    ok: checks.filter(c => c.severity === "error").length === 0,
    checks,
  };
}

/**
 * Format a ValidationResult as human-readable text.
 */
export function format_validation(result: ValidationResult): string {
  const lines: string[] = [];

  if (result.checks.length === 0) {
    lines.push(`@${result.env}: all checks passed`);
    return lines.join("\n");
  }

  for (const check of result.checks) {
    const icon = check.severity === "error" ? "ERR" : "WRN";
    const key_str = check.key ? ` [${check.key}]` : "";
    lines.push(`${icon} ${check.code}${key_str}: ${check.message}`);
  }

  const errors = result.checks.filter(c => c.severity === "error").length;
  const warnings = result.checks.filter(c => c.severity === "warning").length;
  const parts = [];
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
  lines.push(`\n@${result.env}: ${result.ok ? "ok" : "FAIL"} (${parts.join(", ")})`);

  return lines.join("\n");
}
