#!/usr/bin/env bun

import { parseArgs } from "./args";
import { resolveEnv } from "./resolve";
import { runEncrypt, runDecrypt, runKeys } from "./vault";
import { run } from "./run";
import { edit_set, edit_delete, edit_list } from "./edit";
import { diff_env, format_diff } from "./diff";
import { print_output } from "./output";

const VERSION = "1.0.0";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(`xenv ${VERSION}`);
    process.exit(0);
  }

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  // vault commands
  if (args.command === "encrypt") {
    await runEncrypt(args.env);
    process.exit(0);
  }

  if (args.command === "decrypt") {
    await runDecrypt(args.env);
    process.exit(0);
  }

  if (args.command === "keys") {
    await runKeys(args.env);
    process.exit(0);
  }

  // edit command
  if (args.command === "edit") {
    await handleEdit(args);
    process.exit(0);
  }

  // diff command
  if (args.command === "diff") {
    const keys_only = !!args.flags["keys-only"];
    const result = await diff_env(args.env, keys_only);
    print_output(result, args.json, format_diff);
    process.exit(0);
  }

  // resolve command
  if (args.command === "resolve") {
    const env = await resolveEnv(args.env);
    print_output(env, args.json, (d) => {
      return Object.entries(d as Record<string, string>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
    });
    process.exit(0);
  }

  // execution mode — must have a command after --
  if (args.exec.length === 0) {
    printUsage();
    process.exit(1);
  }

  const env = await resolveEnv(args.env);
  const code = await run(args.exec, env);
  process.exit(code);
}

async function handleEdit(args: ReturnType<typeof parseArgs>): Promise<void> {
  const { env, subcommand, positional, json } = args;

  if (subcommand === "set") {
    if (positional.length === 0) {
      throw new Error("usage: xenv edit @env set KEY=VALUE");
    }
    const pair = positional[0];
    const eq = pair.indexOf("=");
    if (eq === -1) {
      throw new Error(`invalid format: expected KEY=VALUE, got "${pair}"`);
    }
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    const result = await edit_set(env, key, value);
    print_output(result, json, (d) => `${d.action} ${d.key} in .xenv.${d.env}.enc`);
    return;
  }

  if (subcommand === "delete") {
    if (positional.length === 0) {
      throw new Error("usage: xenv edit @env delete KEY");
    }
    const key = positional[0];
    const result = await edit_delete(env, key);
    print_output(result, json, (d) => `${d.action} ${d.key} from .xenv.${d.env}.enc`);
    return;
  }

  if (subcommand === "list") {
    const keys = await edit_list(env);
    print_output(keys, json, (d) => (d as string[]).join("\n"));
    return;
  }

  throw new Error("usage: xenv edit @env <set|delete|list>");
}

function printUsage(): void {
  const usage = `
xenv — environment runner & secrets manager

usage:
  xenv [@env] -- <command> [args...]
  xenv encrypt  @env
  xenv decrypt  @env
  xenv keys     @env
  xenv edit     @env <set KEY=VALUE | delete KEY | list>
  xenv resolve  @env [--json]
  xenv diff     @env [--keys-only] [--json]
  xenv validate @env [--require KEY,...] [--json]
  xenv audit    [--json]
  xenv mcp

options:
  --help, -h       show this help
  --version, -v    show version
  --json           machine-readable JSON output

examples:
  xenv @production -- ./server
  xenv -- bun run dev
  xenv encrypt @production
  xenv decrypt @production
  xenv keys @production
  xenv edit @production set API_KEY=secret
  xenv edit @production delete OLD_KEY
  xenv edit @production list --json
  xenv resolve @production --json
`.trim();
  console.log(usage);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`xenv: ${message}`);
  process.exit(1);
});
