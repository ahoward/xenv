import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./parse";
import { resolveKey, getAllKeyValues } from "./vault";

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
const HEX_SECRET_PATTERN = /^[a-f0-9]{40,}$/i;

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
        message: ".xenv.keys contains encryption keys but is not in .gitignore — add '.xenv.keys' to .gitignore, or run 'xenv init' to fix automatically",
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
        message: `${file} contains secrets (has matching vault) but is not in .gitignore — add '${file}' to .gitignore or delete the plaintext file`,
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
        message: `${file} has no decryption key configured — run 'xenv keygen @${env_name}' to generate one, or set ${`XENV_KEY_${env_name!.toUpperCase()}`} in your environment`,
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
          message: `${key_name} exists in .xenv.keys but no ${vault_file} vault found — run 'xenv encrypt @${env_name}' to create the vault, or remove the unused key`,
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

  // check: encryption key values leaked into tracked files
  const key_values = getAllKeyValues(cwd);
  if (key_values.length > 0) {
    const tracked = get_tracked_files(cwd);
    for (const file of tracked) {
      if (file === ".xenv.keys") continue; // obviously contains its own keys
      if (is_binary_extension(file)) continue;
      try {
        const content = readFileSync(join(cwd, file), "utf-8");
        for (const kv of key_values) {
          if (content.includes(kv)) {
            findings.push({
              severity: "error",
              code: "key_value_in_tracked_file",
              file,
              message: `${file} contains an encryption key value — this key must be rotated immediately`,
            });
            break; // one finding per file
          }
        }
      } catch {
        // can't read file — skip
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
  if (HEX_SECRET_PATTERN.test(value) && value.length >= 40) return true;
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
  let ignored = false;
  // process patterns in order — later patterns override earlier ones (including negation)
  for (const pattern of patterns) {
    // negation pattern: !pattern un-ignores a file
    if (pattern.startsWith("!")) {
      const negated = pattern.slice(1);
      if (pattern_matches(file, negated)) {
        ignored = false;
      }
      continue;
    }
    if (pattern_matches(file, pattern)) {
      ignored = true;
    }
  }
  return ignored;
}

function pattern_matches(file: string, pattern: string): boolean {
  // exact match
  if (pattern === file) return true;
  // wildcard match
  if (pattern.includes("*")) {
    const regex_str = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
    if (new RegExp(regex_str).test(file)) return true;
  }
  return false;
}

function get_tracked_files(cwd: string): string[] {
  try {
    const proc = Bun.spawnSync(["git", "ls-files"], { cwd });
    return proc.stdout.toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const BINARY_EXTENSIONS = new Set([
  ".enc", ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".pdf", ".exe", ".dll", ".so", ".dylib",
  ".mp3", ".mp4", ".wav", ".avi", ".mov",
]);

function is_binary_extension(file: string): boolean {
  const dot = file.lastIndexOf(".");
  if (dot === -1) return false;
  return BINARY_EXTENSIONS.has(file.slice(dot).toLowerCase());
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
