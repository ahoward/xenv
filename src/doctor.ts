/**
 * xenv doctor — diagnose project health and agent integration status.
 *
 * Single entry point for agents and humans to understand what's working,
 * what's broken, and what to run next.
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { resolveKey } from "./vault";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
  fix?: string;
}

export interface DoctorResult {
  ok: boolean;
  checks: DoctorCheck[];
}

export async function run_doctor(cwd: string = process.cwd()): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];

  // 1. gitignore exists and has xenv entries
  const gitignore_path = join(cwd, ".gitignore");
  if (existsSync(gitignore_path)) {
    const content = readFileSync(gitignore_path, "utf-8");
    const has_keys = content.includes(".xenv.keys");
    const has_enc_negation = content.includes("!.xenv.*.enc");
    if (has_keys && has_enc_negation) {
      checks.push({ name: "gitignore", ok: true, message: ".gitignore has xenv patterns" });
    } else {
      checks.push({ name: "gitignore", ok: false, message: ".gitignore missing xenv patterns", fix: "xenv init" });
    }
  } else {
    checks.push({ name: "gitignore", ok: false, message: "no .gitignore found", fix: "xenv init" });
  }

  // 2. .xenv.keys exists
  const keys_path = join(cwd, ".xenv.keys");
  if (existsSync(keys_path)) {
    checks.push({ name: "keys", ok: true, message: ".xenv.keys exists" });
  } else {
    checks.push({ name: "keys", ok: false, message: "no .xenv.keys found", fix: "xenv init" });
  }

  // 3. check for env files and vaults
  const files = readdirSync(cwd);
  const enc_files = files.filter(f => f.endsWith(".enc") && f.startsWith(".xenv."));
  const env_files = files.filter(f =>
    (f.startsWith(".xenv.") || f.startsWith(".env.")) &&
    !f.endsWith(".enc") && f !== ".xenv.keys"
  );

  if (enc_files.length > 0) {
    // check each vault has a key
    for (const file of enc_files) {
      const match = file.match(/^\.xenv\.(.+?)\.enc$/);
      if (!match) continue;
      const env_name = match[1];
      const key = resolveKey(env_name, cwd);
      if (key) {
        checks.push({ name: `vault:${env_name}`, ok: true, message: `${file} — key found` });
      } else {
        checks.push({ name: `vault:${env_name}`, ok: false, message: `${file} — no decryption key`, fix: `xenv keygen @${env_name}` });
      }
    }
  } else if (env_files.length > 0) {
    checks.push({ name: "vaults", ok: false, message: "env files found but no encrypted vaults", fix: "xenv encrypt @<env>" });
  } else {
    checks.push({ name: "vaults", ok: true, message: "no env files yet (run xenv init to get started)" });
  }

  // 4. agent integration: .claude/commands/xenv.md
  if (existsSync(join(cwd, ".claude", "commands", "xenv.md"))) {
    checks.push({ name: "claude", ok: true, message: ".claude/commands/xenv.md exists" });
  } else {
    checks.push({ name: "claude", ok: false, message: "no Claude Code slash command", fix: "xenv init" });
  }

  // 5. agent integration: .cursor/mcp.json
  if (existsSync(join(cwd, ".cursor", "mcp.json"))) {
    checks.push({ name: "cursor", ok: true, message: ".cursor/mcp.json exists" });
  } else {
    checks.push({ name: "cursor", ok: false, message: "no Cursor MCP config", fix: "xenv init" });
  }

  // 6. agent integration: .vscode/mcp.json
  if (existsSync(join(cwd, ".vscode", "mcp.json"))) {
    checks.push({ name: "vscode", ok: true, message: ".vscode/mcp.json exists" });
  } else {
    checks.push({ name: "vscode", ok: false, message: "no VS Code MCP config", fix: "xenv init" });
  }

  return {
    ok: checks.every(c => c.ok),
    checks,
  };
}

export function format_doctor(result: DoctorResult): string {
  const lines: string[] = [];

  for (const check of result.checks) {
    const icon = check.ok ? "ok " : "ERR";
    lines.push(`${icon} ${check.name}: ${check.message}${check.fix ? ` — run '${check.fix}'` : ""}`);
  }

  const failing = result.checks.filter(c => !c.ok).length;
  if (failing === 0) {
    lines.push("\ndoctor: everything looks good");
  } else {
    lines.push(`\ndoctor: ${failing} issue${failing > 1 ? "s" : ""} found`);
  }

  return lines.join("\n");
}
