import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { runKeygen } from "./vault";

const GITIGNORE_ENTRIES = [
  ".xenv.keys",
  ".xenv.*",
  ".env.*",
  ".env.local",
  ".envrc",
  "!.xenv.*.enc",
];

/**
 * Bootstrap xenv in a project.
 * Idempotent — running twice changes nothing.
 */
export async function run_init(env: string = "development", cwd: string = process.cwd()): Promise<void> {
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  // 1. update .gitignore
  const gitignore_path = join(cwd, ".gitignore");
  const gitignore_updated = ensure_gitignore(gitignore_path);
  if (gitignore_updated) {
    updated.push(".gitignore               added xenv ignore patterns");
  } else {
    skipped.push(".gitignore               already configured");
  }

  // 2. generate key (if .xenv.keys doesn't exist)
  const keys_path = join(cwd, ".xenv.keys");
  if (!existsSync(keys_path)) {
    await runKeygen(env, true);
    created.push(".xenv.keys               encryption keys (gitignored, chmod 600)");
  } else {
    skipped.push(".xenv.keys               already exists");
  }

  // 3. create starter env file
  const env_path = join(cwd, `.xenv.${env}`);
  if (!existsSync(env_path)) {
    const starter = `# .xenv.${env} — your ${env} environment\n# add KEY=value pairs, then run: xenv encrypt @${env}\nAPP_ENV=${env}\n`;
    await Bun.write(env_path, starter);
    created.push(`.xenv.${env}${" ".repeat(Math.max(1, 21 - env.length - 6))}starter env file`);
  } else {
    skipped.push(`.xenv.${env}${" ".repeat(Math.max(1, 21 - env.length - 6))}already exists`);
  }

  // 4. agent integration files
  ensure_agent_configs(cwd, created, skipped);

  // 5. print summary
  console.error(`\nxenv initialized for @${env}\n`);

  if (created.length > 0) {
    console.error("created:");
    for (const line of created) console.error(`  ${line}`);
    console.error();
  }

  if (updated.length > 0) {
    console.error("updated:");
    for (const line of updated) console.error(`  ${line}`);
    console.error();
  }

  if (skipped.length > 0) {
    console.error("unchanged:");
    for (const line of skipped) console.error(`  ${line}`);
    console.error();
  }

  console.error("next steps:");
  console.error(`  1. add your env vars to .xenv.${env}`);
  console.error(`  2. xenv encrypt @${env}`);
  console.error(`  3. xenv @${env} -- your-command`);
  console.error(`  4. git add .xenv.${env}.enc .gitignore`);
  console.error();
  console.error("docs: https://github.com/ahoward/xenv");
}

/**
 * Generate agent integration config files.
 */
function ensure_agent_configs(cwd: string, created: string[], skipped: string[]): void {
  // .claude/commands/xenv.md — Claude Code slash command
  const claude_cmd_dir = join(cwd, ".claude", "commands");
  const claude_cmd_path = join(claude_cmd_dir, "xenv.md");
  if (!existsSync(claude_cmd_path)) {
    mkdirSync(claude_cmd_dir, { recursive: true });
    writeFileSync(claude_cmd_path, CLAUDE_COMMAND);
    created.push(".claude/commands/xenv.md  Claude Code /xenv slash command");
  } else {
    skipped.push(".claude/commands/xenv.md  already exists");
  }

  // .cursor/mcp.json — Cursor MCP auto-discovery
  const cursor_dir = join(cwd, ".cursor");
  const cursor_mcp_path = join(cursor_dir, "mcp.json");
  if (!existsSync(cursor_mcp_path)) {
    mkdirSync(cursor_dir, { recursive: true });
    writeFileSync(cursor_mcp_path, CURSOR_MCP);
    created.push(".cursor/mcp.json         Cursor MCP auto-discovery");
  } else {
    skipped.push(".cursor/mcp.json         already exists");
  }

  // .vscode/mcp.json — VS Code / Copilot MCP auto-discovery
  const vscode_dir = join(cwd, ".vscode");
  const vscode_mcp_path = join(vscode_dir, "mcp.json");
  if (!existsSync(vscode_mcp_path)) {
    mkdirSync(vscode_dir, { recursive: true });
    writeFileSync(vscode_mcp_path, VSCODE_MCP);
    created.push(".vscode/mcp.json         VS Code / Copilot MCP auto-discovery");
  } else {
    skipped.push(".vscode/mcp.json         already exists");
  }
}

const CLAUDE_COMMAND = `---
description: Manage secrets and encrypted environment variables with xenv
allowed-tools: Bash(xenv:*)
---

You have xenv available — an encrypted secrets manager with a built-in MCP server.

Start by running \`xenv doctor\` to check project health, then use the appropriate command:

## Commands

- \`xenv doctor\` — check project health and agent integration status
- \`xenv init\` — bootstrap xenv in a project (gitignore, key, starter env file)
- \`xenv @<env> -- <command>\` — run a command with the resolved environment
- \`xenv encrypt @<env>\` — encrypt .xenv.{env} to .xenv.{env}.enc
- \`xenv decrypt @<env>\` — decrypt .xenv.{env}.enc to .xenv.{env}
- \`xenv edit @<env> set KEY=VALUE\` — set a secret without decrypting to disk
- \`xenv edit @<env> delete KEY\` — remove a secret
- \`xenv edit @<env> list\` — list secret key names (not values)
- \`xenv resolve @<env> --json\` — dump the merged 7-layer cascade
- \`xenv diff @<env>\` — compare plaintext vs encrypted vault (keys only by default, \`--values\` to show secrets)
- \`xenv validate @<env>\` — pre-flight check for missing/empty keys
- \`xenv rotate @<env>\` — rotate encryption key
- \`xenv audit --json\` — scan project for security mistakes

## Security rules

- NEVER commit .xenv.keys (contains encryption keys)
- NEVER include key values in output, logs, or messages
- NEVER use \`git add .\` or \`git add -A\` — always add specific files
- Encrypted vaults (.xenv.*.enc) are SAFE to commit

## Workflow

1. \`xenv doctor\` — see what needs attention
2. \`xenv init\` — if not yet bootstrapped
3. \`xenv edit @<env> set KEY=VALUE\` — add secrets
4. \`xenv audit --json\` — verify nothing is leaking
5. \`git add .xenv.<env>.enc\` — commit only the encrypted vault

$ARGUMENTS
`;

const CURSOR_MCP = JSON.stringify({
  mcpServers: {
    xenv: {
      command: "xenv",
      args: ["mcp"],
    },
  },
}, null, 2) + "\n";

const VSCODE_MCP = JSON.stringify({
  servers: {
    xenv: {
      command: "xenv",
      args: ["mcp"],
    },
  },
}, null, 2) + "\n";

/**
 * Ensure .gitignore has all xenv entries. Returns true if file was modified.
 */
function ensure_gitignore(path: string): boolean {
  let content = "";
  if (existsSync(path)) {
    content = readFileSync(path, "utf-8");
  }

  const lines = content.split("\n");
  const missing = GITIGNORE_ENTRIES.filter(entry => !lines.some(l => l.trim() === entry));

  if (missing.length === 0) return false;

  const addition = (content.length > 0 && !content.endsWith("\n") ? "\n" : "") +
    "\n# xenv\n" +
    missing.join("\n") +
    "\n";

  writeFileSync(path, content + addition);
  return true;
}
