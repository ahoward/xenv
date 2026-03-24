import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./parse";
import { resolveKey } from "./vault";

export interface AuditFinding {
  severity: "error" | "warning" | "info";
  code: string;
  file?: string;
  message: string;
}

export interface AuditResult {
  ok: boolean;
  findings: AuditFinding[];
}

// patterns that suggest a value is a secret
const SECRET_VALUE_PATTERN = /^(sk_|pk_|ghp_|gho_|ghs_|ghr_|glpat-|xox[bpsa]-|AKIA|eyJ|ssh-|-----BEGIN)/;
const HEX_SECRET_PATTERN = /^[a-f0-9]{32,}$/i;

/**
 * Scan the project for common security mistakes.
 */
export async function audit_project(cwd: string = process.cwd()): Promise<AuditResult> {
  const findings: AuditFinding[] = [];
  const gitignore_patterns = load_gitignore(cwd);

  // check: .xenv.keys not in .gitignore
  if (existsSync(join(cwd, ".xenv.keys"))) {
    if (!is_gitignored(".xenv.keys", gitignore_patterns)) {
      findings.push({
        severity: "error",
        code: "keys_not_gitignored",
        file: ".xenv.keys",
        message: ".xenv.keys contains encryption keys but is not in .gitignore",
      });
    }
  }

  // scan directory for env files
  const files = readdirSync(cwd);
  const env_files = files.filter(f =>
    (f.startsWith(".xenv.") || f.startsWith(".env.")) && !f.endsWith(".enc")
  );
  const enc_files = files.filter(f => f.endsWith(".enc") && (f.startsWith(".xenv.") || f.startsWith(".env.")));

  // check: plaintext env files not gitignored
  for (const file of env_files) {
    // skip base files and local files (local files should be gitignored but are less critical)
    if (file === ".xenv" || file === ".env" || file === ".xenv.keys") continue;
    if (file.endsWith(".local")) continue;

    // extract env name and check if it has a vault (meaning it contains secrets worth protecting)
    const env_name = extract_env_name(file);
    if (!env_name) continue;

    const has_vault = enc_files.some(f => f === `.xenv.${env_name}.enc`);
    if (has_vault && !is_gitignored(file, gitignore_patterns)) {
      findings.push({
        severity: "error",
        code: "plaintext_not_gitignored",
        file,
        message: `${file} contains secrets (has matching vault) but is not in .gitignore`,
      });
    }
  }

  // check: orphan vaults (enc files with no key)
  for (const file of enc_files) {
    const env_name = extract_enc_env_name(file);
    if (!env_name) continue;

    const key = resolveKey(env_name, cwd);
    if (!key) {
      findings.push({
        severity: "warning",
        code: "orphan_vault",
        file,
        message: `${file} has no decryption key configured — cannot be decrypted`,
      });
    }
  }

  // check: orphan keys (keys in .xenv.keys with no corresponding vault)
  if (existsSync(join(cwd, ".xenv.keys"))) {
    const keys_content = readFileSync(join(cwd, ".xenv.keys"), "utf-8");
    const keys_data = parseEnvContent(keys_content);

    for (const key_name of Object.keys(keys_data)) {
      if (!key_name.startsWith("XENV_KEY_")) continue;
      if (key_name === "XENV_KEY") continue;

      const env_name = key_name.slice("XENV_KEY_".length).toLowerCase();
      const vault_file = `.xenv.${env_name}.enc`;

      if (!enc_files.includes(vault_file)) {
        findings.push({
          severity: "warning",
          code: "orphan_key",
          file: ".xenv.keys",
          message: `${key_name} exists in .xenv.keys but no ${vault_file} vault found`,
        });
      }
    }
  }

  // check: sensitive values in unencrypted files
  for (const file of env_files) {
    if (file === ".xenv.keys") continue;
    const env_name = extract_env_name(file);
    if (!env_name) continue;

    // only flag if there's no vault for this env (if there IS a vault, they should encrypt)
    const has_vault = enc_files.some(f => f === `.xenv.${env_name}.enc`);
    if (has_vault) continue;

    const content = readFileSync(join(cwd, file), "utf-8");
    const data = parseEnvContent(content);

    for (const [key, value] of Object.entries(data)) {
      if (looks_like_secret(value)) {
        findings.push({
          severity: "warning",
          code: "sensitive_plaintext",
          file,
          message: `${key} in ${file} looks like a secret — consider encrypting with 'xenv encrypt @${env_name}'`,
        });
        break; // one finding per file is enough
      }
    }
  }

  return {
    ok: findings.filter(f => f.severity === "error").length === 0,
    findings,
  };
}

function looks_like_secret(value: string): boolean {
  if (SECRET_VALUE_PATTERN.test(value)) return true;
  if (HEX_SECRET_PATTERN.test(value) && value.length >= 32) return true;
  return false;
}

function extract_env_name(file: string): string | null {
  // .xenv.production → production, .env.staging → staging
  const match = file.match(/^\.(?:x?env)\.(.+?)(?:\.local)?$/);
  return match ? match[1] : null;
}

function extract_enc_env_name(file: string): string | null {
  // .xenv.production.enc → production
  const match = file.match(/^\.xenv\.(.+?)\.enc$/);
  return match ? match[1] : null;
}

function load_gitignore(cwd: string): string[] {
  const path = join(cwd, ".gitignore");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"));
}

function is_gitignored(file: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // exact match
    if (pattern === file) return true;
    // simple wildcard: .xenv.* matches .xenv.production
    if (pattern.includes("*")) {
      const regex_str = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
      if (new RegExp(regex_str).test(file)) return true;
    }
  }
  return false;
}

/**
 * Format an AuditResult as human-readable text.
 */
export function format_audit(result: AuditResult): string {
  const lines: string[] = [];

  if (result.findings.length === 0) {
    lines.push("audit: all checks passed");
    return lines.join("\n");
  }

  for (const finding of result.findings) {
    const icon = finding.severity === "error" ? "ERR"
      : finding.severity === "warning" ? "WRN"
      : "INF";
    const file_str = finding.file ? ` [${finding.file}]` : "";
    lines.push(`${icon} ${finding.code}${file_str}: ${finding.message}`);
  }

  const errors = result.findings.filter(f => f.severity === "error").length;
  const warnings = result.findings.filter(f => f.severity === "warning").length;
  const parts = [];
  if (errors > 0) parts.push(`${errors} error${errors > 1 ? "s" : ""}`);
  if (warnings > 0) parts.push(`${warnings} warning${warnings > 1 ? "s" : ""}`);
  lines.push(`\naudit: ${result.ok ? "ok" : "FAIL"} (${parts.join(", ")})`);

  return lines.join("\n");
}
