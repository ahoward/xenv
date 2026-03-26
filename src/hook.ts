/**
 * xenv hook — git pre-commit hook that blocks commits containing known secrets.
 *
 * Decrypts all vaults in memory, extracts secret values, and scans the staged
 * diff for exact matches. Also runs pattern-based detection for common secret
 * formats. This is real enforcement, not heuristics.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync, readdirSync } from "fs";
import { join } from "path";
import { resolveKey, decryptVault, getAllKeyValues } from "./vault";
import { parseEnvContent } from "./parse";

// same patterns as audit.ts
const SECRET_VALUE_PATTERN = /^(sk_|pk_|ghp_|gho_|ghs_|ghr_|glpat-|xox[bpsa]-|AKIA|eyJ|ssh-|-----BEGIN)/;
const HEX_SECRET_PATTERN = /^[a-f0-9]{40,}$/i;

export interface HookCheckResult {
  ok: boolean;
  leaks: HookLeak[];
}

export interface HookLeak {
  file: string;
  line: number;
  reason: string;
}

const HOOK_MARKER = "# xenv-hook";

const HOOK_SCRIPT = `#!/bin/sh
${HOOK_MARKER}
# installed by: xenv hook install
# checks staged commits for leaked secrets against encrypted vaults
# remove with: xenv hook uninstall

xenv hook check
`;

/**
 * Install the pre-commit hook.
 */
export function hook_install(cwd: string = process.cwd()): { installed: boolean; message: string } {
  const git_dir = find_git_dir(cwd);
  if (!git_dir) {
    throw new Error("not a git repository — run 'git init' first");
  }

  const hooks_dir = join(git_dir, "hooks");
  if (!existsSync(hooks_dir)) {
    const { mkdirSync } = require("fs");
    mkdirSync(hooks_dir, { recursive: true });
  }

  const hook_path = join(hooks_dir, "pre-commit");

  if (existsSync(hook_path)) {
    const existing = readFileSync(hook_path, "utf-8");
    if (existing.includes(HOOK_MARKER)) {
      return { installed: false, message: "xenv pre-commit hook already installed" };
    }
    // append to existing hook
    const addition = `\n${HOOK_MARKER}\nxenv hook check\n`;
    writeFileSync(hook_path, existing + addition);
    chmodSync(hook_path, 0o755);
    return { installed: true, message: "xenv pre-commit hook appended to existing hook" };
  }

  writeFileSync(hook_path, HOOK_SCRIPT);
  chmodSync(hook_path, 0o755);
  return { installed: true, message: "xenv pre-commit hook installed" };
}

/**
 * Uninstall the pre-commit hook.
 */
export function hook_uninstall(cwd: string = process.cwd()): { removed: boolean; message: string } {
  const git_dir = find_git_dir(cwd);
  if (!git_dir) {
    throw new Error("not a git repository");
  }

  const hook_path = join(git_dir, "hooks", "pre-commit");

  if (!existsSync(hook_path)) {
    return { removed: false, message: "no pre-commit hook found" };
  }

  const content = readFileSync(hook_path, "utf-8");
  if (!content.includes(HOOK_MARKER)) {
    return { removed: false, message: "pre-commit hook exists but was not installed by xenv" };
  }

  // if the entire file is our hook, remove it
  const lines = content.split("\n");
  const filtered = lines.filter(l => l !== HOOK_MARKER && l !== "xenv hook check" && !l.includes("installed by: xenv hook install") && !l.includes("remove with: xenv hook uninstall") && !l.includes("checks staged commits for leaked secrets"));
  const remaining = filtered.filter(l => l.trim().length > 0 && l !== "#!/bin/sh").join("\n").trim();

  if (remaining.length === 0) {
    const { unlinkSync } = require("fs");
    unlinkSync(hook_path);
    return { removed: true, message: "xenv pre-commit hook removed" };
  }

  // other hook content exists — just remove our lines
  writeFileSync(hook_path, filtered.join("\n") + "\n");
  return { removed: true, message: "xenv pre-commit hook removed (other hooks preserved)" };
}

/**
 * Check staged files for leaked secrets. Called by the pre-commit hook.
 */
export async function hook_check(cwd: string = process.cwd()): Promise<HookCheckResult> {
  const leaks: HookLeak[] = [];

  // 1. get staged diff
  const diff = get_staged_diff(cwd);
  if (!diff) return { ok: true, leaks };

  // 2. check for staged forbidden files
  const staged_files = get_staged_files(cwd);
  for (const file of staged_files) {
    if (file === ".xenv.keys") {
      leaks.push({ file, line: 0, reason: ".xenv.keys contains encryption keys — must never be committed" });
    }
    if ((file.startsWith(".xenv.") || file.startsWith(".env.")) && !file.endsWith(".enc")) {
      leaks.push({ file, line: 0, reason: `${file} is a plaintext env file — commit the .enc vault instead` });
    }
  }

  // 3. collect known secret values from all vaults
  const known_secrets = await collect_vault_secrets(cwd);

  // 3.5: collect encryption key values from .xenv.keys and ~/.xenv.keys
  const key_values = getAllKeyValues(cwd);

  // 4. scan each added line in the diff
  const diff_entries = parse_diff(diff);
  for (const entry of diff_entries) {
    for (const added of entry.added_lines) {
      const line_content = added.content;

      // check against known vault secrets (exact substring match)
      for (const secret of known_secrets) {
        if (secret.length >= 8 && line_content.includes(secret)) {
          leaks.push({
            file: entry.file,
            line: added.line_number,
            reason: "contains a secret value from an encrypted vault",
          });
          break; // one match per line is enough
        }
      }

      // check against encryption key values
      for (const kv of key_values) {
        if (line_content.includes(kv)) {
          const already = leaks.some(l => l.file === entry.file && l.line === added.line_number);
          if (!already) {
            leaks.push({
              file: entry.file,
              line: added.line_number,
              reason: "contains an encryption key value from .xenv.keys",
            });
          }
          break;
        }
      }

      // check against common secret patterns (for secrets not yet in vaults)
      const value = extract_value_from_line(line_content);
      if (value && looks_like_secret(value)) {
        // don't double-report if already caught by vault or key match
        const already = leaks.some(l => l.file === entry.file && l.line === added.line_number);
        if (!already) {
          leaks.push({
            file: entry.file,
            line: added.line_number,
            reason: `value looks like a secret (matches known secret pattern)`,
          });
        }
      }
    }
  }

  return { ok: leaks.length === 0, leaks };
}

export function format_hook_check(result: HookCheckResult): string {
  if (result.ok) {
    return "xenv: no secrets found in staged changes";
  }

  const lines: string[] = ["xenv: secrets detected in staged changes — commit blocked\n"];
  for (const leak of result.leaks) {
    const loc = leak.line > 0 ? `:${leak.line}` : "";
    lines.push(`  ${leak.file}${loc} — ${leak.reason}`);
  }
  lines.push(`\n${result.leaks.length} leak${result.leaks.length > 1 ? "s" : ""} found. fix the issues above, then try again.`);
  return lines.join("\n");
}

// ── helpers ──────────────────────────────────────────────────────────

function find_git_dir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const dot_git = join(dir, ".git");
    if (existsSync(dot_git)) return dot_git;
    const parent = join(dir, "..");
    if (parent === dir) return null; // reached root
    dir = parent;
  }
}

function get_staged_diff(cwd: string): string | null {
  try {
    const proc = Bun.spawnSync(["git", "diff", "--cached", "--diff-filter=ACMR", "-U0"], { cwd });
    const output = proc.stdout.toString().trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function get_staged_files(cwd: string): string[] {
  try {
    const proc = Bun.spawnSync(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], { cwd });
    return proc.stdout.toString().trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

interface DiffEntry {
  file: string;
  added_lines: { line_number: number; content: string }[];
}

function parse_diff(diff: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  let current: DiffEntry | null = null;
  let current_line = 0;

  for (const line of diff.split("\n")) {
    // new file
    if (line.startsWith("+++ b/")) {
      current = { file: line.slice(6), added_lines: [] };
      entries.push(current);
      continue;
    }
    // hunk header: @@ -old,count +new,count @@
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      current_line = parseInt(hunk[1], 10);
      continue;
    }
    // added line
    if (line.startsWith("+") && !line.startsWith("+++") && current) {
      current.added_lines.push({ line_number: current_line, content: line.slice(1) });
      current_line++;
      continue;
    }
    // context line (not removed, not a "no newline" marker)
    if (!line.startsWith("-") && !line.startsWith("\\ ")) {
      current_line++;
    }
  }

  return entries;
}

async function collect_vault_secrets(cwd: string): Promise<Set<string>> {
  const secrets = new Set<string>();
  const files = readdirSync(cwd);
  const enc_files = files.filter(f => f.endsWith(".enc") && f.startsWith(".xenv."));

  for (const file of enc_files) {
    const match = file.match(/^\.xenv\.(.+?)\.enc$/);
    if (!match) continue;
    const env_name = match[1];
    const key = resolveKey(env_name, cwd);
    if (!key) continue;

    try {
      const plaintext = await decryptVault(join(cwd, file), key);
      const data = parseEnvContent(plaintext);
      for (const value of Object.values(data)) {
        if (value.length >= 8) {
          secrets.add(value);
        }
      }
    } catch {
      // can't decrypt — skip silently
    }
  }

  return secrets;
}

function extract_value_from_line(line: string): string | null {
  // KEY=VALUE or KEY="VALUE" patterns
  const match = line.match(/^\s*\+?\s*\w+=["']?(.+?)["']?\s*$/);
  return match ? match[1] : null;
}

function looks_like_secret(value: string): boolean {
  if (SECRET_VALUE_PATTERN.test(value)) return true;
  if (HEX_SECRET_PATTERN.test(value) && value.length >= 40) return true;
  return false;
}
