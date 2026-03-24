import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveEnv } from "../src/resolve";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("resolveEnv", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xenv-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reads .env base", async () => {
    writeFileSync(join(dir, ".env"), "BASE=one");
    const env = await resolveEnv("development", dir);
    expect(env.BASE).toBe("one");
  });

  test(".xenv overwrites .env at same level", async () => {
    writeFileSync(join(dir, ".env"), "KEY=from-env");
    writeFileSync(join(dir, ".xenv"), "KEY=from-xenv");
    const env = await resolveEnv("development", dir);
    expect(env.KEY).toBe("from-xenv");
  });

  test("env-specific files overwrite base", async () => {
    writeFileSync(join(dir, ".env"), "KEY=base");
    writeFileSync(join(dir, ".xenv.production"), "KEY=prod");
    const env = await resolveEnv("production", dir);
    expect(env.KEY).toBe("prod");
  });

  test("local overrides env-specific", async () => {
    writeFileSync(join(dir, ".xenv.production"), "KEY=prod");
    writeFileSync(join(dir, ".xenv.production.local"), "KEY=local");
    const env = await resolveEnv("production", dir);
    expect(env.KEY).toBe("local");
  });

  test("system ENV wins over all files", async () => {
    process.env.__XENV_TEST_VAR__ = "from-system";
    writeFileSync(join(dir, ".env"), "__XENV_TEST_VAR__=from-file");
    const env = await resolveEnv("development", dir);
    expect(env.__XENV_TEST_VAR__).toBe("from-system");
    delete process.env.__XENV_TEST_VAR__;
  });

  test("cascade merges multiple files", async () => {
    writeFileSync(join(dir, ".env"), "A=1\nB=base");
    writeFileSync(join(dir, ".xenv"), "B=xenv\nC=3");
    writeFileSync(join(dir, ".xenv.staging"), "D=4");
    const env = await resolveEnv("staging", dir);
    expect(env.A).toBe("1");
    expect(env.B).toBe("xenv");
    expect(env.C).toBe("3");
    expect(env.D).toBe("4");
  });

  test("warns when vault exists but key is missing", async () => {
    // write a fake .enc file — doesn't need to be valid crypto, just needs to exist
    writeFileSync(join(dir, ".xenv.production.enc"), "deadbeef");
    delete process.env.XENV_KEY_PRODUCTION;

    const warnings: string[] = [];
    const origErr = console.error;
    console.error = (...args: any[]) => warnings.push(args.join(" "));

    await resolveEnv("production", dir);

    console.error = origErr;
    expect(warnings.some(w => w.includes("XENV_KEY_PRODUCTION") && w.includes("warning"))).toBe(true);
  });

  test(".env.local overrides .env", async () => {
    writeFileSync(join(dir, ".env"), "KEY=base");
    writeFileSync(join(dir, ".env.local"), "KEY=local");
    const env = await resolveEnv("development", dir);
    expect(env.KEY).toBe("local");
  });

  test(".xenv.local overrides .env.local", async () => {
    writeFileSync(join(dir, ".env.local"), "KEY=env-local");
    writeFileSync(join(dir, ".xenv.local"), "KEY=xenv-local");
    const env = await resolveEnv("development", dir);
    expect(env.KEY).toBe("xenv-local");
  });

  test("empty env name resolves base files only", async () => {
    writeFileSync(join(dir, ".env"), "KEY=base");
    const env = await resolveEnv("", dir);
    expect(env.KEY).toBe("base");
  });

  test("rejects env names with path traversal", async () => {
    expect(resolveEnv("../../etc/passwd", dir)).rejects.toThrow("invalid environment name");
    expect(resolveEnv("foo/bar", dir)).rejects.toThrow("invalid environment name");
    expect(resolveEnv("foo\\bar", dir)).rejects.toThrow("invalid environment name");
  });

  test("no files at all still returns system ENV", async () => {
    const env = await resolveEnv("development", dir);
    expect(env.PATH).toBeDefined();
  });
});
