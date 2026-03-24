#!/usr/bin/env bun

/**
 * Cross-platform binary builder for xenv.
 * Compiles standalone binaries for all supported targets.
 *
 * Usage: bun run scripts/build-all.ts
 * Output: dist/xenv-{platform}-{arch}
 */

import { mkdirSync, existsSync } from "fs";
import { join } from "path";

const ENTRY = "./src/cli.ts";
const OUT_DIR = "dist";

const TARGETS = [
  { bun_target: "bun-linux-x64",    name: "xenv-linux-x86_64" },
  { bun_target: "bun-linux-arm64",   name: "xenv-linux-aarch64" },
  { bun_target: "bun-darwin-x64",    name: "xenv-darwin-x86_64" },
  { bun_target: "bun-darwin-arm64",  name: "xenv-darwin-aarch64" },
  { bun_target: "bun-windows-x64",   name: "xenv-windows-x86_64.exe" },
];

async function main() {
  if (!existsSync(OUT_DIR)) {
    mkdirSync(OUT_DIR, { recursive: true });
  }

  console.log(`building ${TARGETS.length} targets → ${OUT_DIR}/\n`);

  let failed = 0;

  for (const target of TARGETS) {
    const outfile = join(OUT_DIR, target.name);
    const args = [
      "bun", "build", ENTRY,
      "--compile", "--minify",
      `--target=${target.bun_target}`,
      `--outfile=${outfile}`,
    ];

    process.stdout.write(`  ${target.name.padEnd(30)}`);

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exit = await proc.exited;

    if (exit === 0) {
      const stat = Bun.file(outfile);
      const size_mb = (stat.size / 1024 / 1024).toFixed(1);
      console.log(`ok  (${size_mb} MB)`);
    } else {
      const stderr = await new Response(proc.stderr).text();
      console.log(`FAIL`);
      console.error(`    ${stderr.trim().split("\n")[0]}`);
      failed++;
    }
  }

  console.log(`\n${TARGETS.length - failed}/${TARGETS.length} targets built`);

  if (failed > 0) {
    process.exit(1);
  }
}

main();
