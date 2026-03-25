import { existsSync, readFileSync, writeFileSync } from "fs";
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

  // 4. print summary
  console.log(`\nxenv initialized for @${env}\n`);

  if (created.length > 0) {
    console.log("created:");
    for (const line of created) console.log(`  ${line}`);
    console.log();
  }

  if (updated.length > 0) {
    console.log("updated:");
    for (const line of updated) console.log(`  ${line}`);
    console.log();
  }

  if (skipped.length > 0) {
    console.log("unchanged:");
    for (const line of skipped) console.log(`  ${line}`);
    console.log();
  }

  console.log("next steps:");
  console.log(`  1. add your env vars to .xenv.${env}`);
  console.log(`  2. xenv encrypt @${env}`);
  console.log(`  3. xenv @${env} -- your-command`);
  console.log(`  4. git add .xenv.${env}.enc .gitignore`);
  console.log();
  console.log("docs: https://github.com/ahoward/xenv");
}

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
