#!/usr/bin/env bun

import { parseArgs } from "./args";
import { resolveEnv } from "./resolve";
import { runEncrypt, runDecrypt, runKeys } from "./vault";
import { run } from "./run";

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

  // execution mode — must have a command after --
  if (args.exec.length === 0) {
    printUsage();
    process.exit(1);
  }

  const env = await resolveEnv(args.env);
  const code = await run(args.exec, env);
  process.exit(code);
}

function printUsage(): void {
  const usage = `
xenv — environment runner & secrets manager

usage:
  xenv [@env] -- <command> [args...]
  xenv encrypt @env
  xenv decrypt @env
  xenv keys   @env

options:
  --help, -h       show this help
  --version, -v    show version

examples:
  xenv @production -- ./server
  xenv -- bun run dev
  xenv encrypt @production
  xenv decrypt @production
  xenv keys @production
`.trim();
  console.log(usage);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`xenv: ${message}`);
  process.exit(1);
});
