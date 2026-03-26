#!/usr/bin/env bun

import { parseArgs } from "./args";
import { resolveEnv, resolveCascadeOnly } from "./resolve";
import { runEncrypt, runDecrypt, runKeygen, rotate_vault_key } from "./vault";
import { run } from "./run";
import { edit_set, edit_delete, edit_list } from "./edit";
import { diff_env, format_diff } from "./diff";
import { validate_env, format_validation } from "./validate";
import { audit_project, format_audit } from "./audit";
import { run_mcp_server } from "./mcp";
import { run_init } from "./init";
import { run_doctor, format_doctor } from "./doctor";
import { hook_install, hook_uninstall, hook_check, format_hook_check } from "./hook";
import { print_output } from "./output";
import pkg from "../package.json";

const VERSION = pkg.version;

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

  // doctor command
  if (args.command === "doctor") {
    const result = await run_doctor();
    print_output(result, args.json, format_doctor);
    process.exit(result.ok ? 0 : 1);
  }

  // init command
  if (args.command === "init") {
    await run_init(args.env);
    if (args.json) console.log(JSON.stringify({ ok: true, env: args.env }));
    process.exit(0);
  }

  // vault commands
  if (args.command === "encrypt") {
    await runEncrypt(args.env);
    if (args.json) console.log(JSON.stringify({ ok: true, env: args.env, file: `.xenv.${args.env}.enc` }));
    process.exit(0);
  }

  if (args.command === "decrypt") {
    await runDecrypt(args.env);
    if (args.json) console.log(JSON.stringify({ ok: true, env: args.env, file: `.xenv.${args.env}` }));
    process.exit(0);
  }

  if (args.command === "keygen") {
    const global = !!args.flags["global"];
    await runKeygen(args.env, false, global);
    if (args.json) console.log(JSON.stringify({ ok: true, env: args.env, key_name: `XENV_KEY_${args.env.toUpperCase()}`, global }));
    process.exit(0);
  }

  // rotate command
  if (args.command === "rotate") {
    await rotate_vault_key(args.env);
    const result = { ok: true, env: args.env, message: `key rotated for @${args.env} — new key saved to .xenv.keys` };
    print_output(result, args.json, (d) => d.message);
    process.exit(0);
  }

  // edit command
  if (args.command === "edit") {
    await handleEdit(args);
    process.exit(0);
  }

  // diff command (keys-only by default for safety; --values to show secret content)
  if (args.command === "diff") {
    const show_values = !!args.flags["values"];
    const keys_only = !show_values;
    const result = await diff_env(args.env, keys_only);
    print_output(result, args.json, format_diff);
    process.exit(0);
  }

  // mcp server
  if (args.command === "mcp") {
    await run_mcp_server();
    process.exit(0);
  }

  // hook command
  if (args.command === "hook") {
    await handleHook(args);
    process.exit(0);
  }

  // audit command
  if (args.command === "audit") {
    const result = await audit_project();
    print_output(result, args.json, format_audit);
    process.exit(result.ok ? 0 : 1);
  }

  // validate command
  if (args.command === "validate") {
    const require_flag = args.flags["require"];
    const required_keys = typeof require_flag === "string"
      ? require_flag.split(",").map(k => k.trim()).filter(Boolean)
      : [];
    const result = await validate_env(args.env, required_keys);
    print_output(result, args.json, format_validation);
    process.exit(result.ok ? 0 : 1);
  }

  // resolve command
  if (args.command === "resolve") {
    const env = await resolveCascadeOnly(args.env);
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
      throw new Error(`invalid format: expected KEY=VALUE, got "${pair}" — example: xenv edit @${args.env} set MY_KEY=my_value`);
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

async function handleHook(args: ReturnType<typeof parseArgs>): Promise<void> {
  const { subcommand, json } = args;

  if (subcommand === "install") {
    const result = hook_install();
    print_output(result, json, (d) => d.message);
    return;
  }

  if (subcommand === "uninstall") {
    const result = hook_uninstall();
    print_output(result, json, (d) => d.message);
    return;
  }

  if (subcommand === "check") {
    const result = await hook_check();
    print_output(result, json, format_hook_check);
    if (!result.ok) process.exit(1);
    return;
  }

  throw new Error("usage: xenv hook <install|uninstall|check>");
}

function printUsage(): void {
  const usage = `
xenv — environment runner & secrets manager

commands:
  xenv [@env] -- <command>              run a command (defaults to @development)
  xenv init     [@env]                  bootstrap xenv in a project
  xenv encrypt  @env                    encrypt .xenv.{env} to .xenv.{env}.enc
  xenv decrypt  @env                    decrypt .xenv.{env}.enc to .xenv.{env}
  xenv keygen   @env [--global]          generate a 256-bit encryption key
  xenv edit     @env <set|delete|list>  edit secrets without decrypting to disk
  xenv resolve  @env [--json]           dump the merged 7-layer cascade
  xenv diff     @env [--values]         compare plaintext vs vault (keys-only by default)
  xenv validate @env [--require K,...]  pre-flight check for missing/empty keys
  xenv rotate   @env                    rotate encryption key (re-encrypts vault)
  xenv hook     <install|uninstall|check>  git pre-commit hook (blocks secret leaks)
  xenv doctor   [--json]                check project health & agent integration
  xenv audit    [--json]                scan project for security mistakes
  xenv mcp                              start MCP server (JSON-RPC 2.0 stdio)

options:
  --help, -h       show this help
  --version, -v    show version
  --json           machine-readable JSON output

getting started:
  xenv init                             set up xenv in your project
  xenv @production -- ./server          run with production environment

docs: https://github.com/ahoward/xenv
`.trim();
  console.log(usage);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`xenv: ${message}`);
  process.exit(1);
});
