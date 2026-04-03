import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadEnv, parseEnvContent, encryptContent, decryptContent, resolveKey } from "../src/index";

describe("parseEnvContent", () => {
  test("parses KEY=value pairs", () => {
    const result = parseEnvContent('FOO=bar\nBAZ="quoted"');
    expect(result.FOO).toBe("bar");
    expect(result.BAZ).toBe("quoted");
  });

  test("handles comments and blank lines", () => {
    const result = parseEnvContent("# comment\n\nFOO=bar\n");
    expect(result.FOO).toBe("bar");
    expect(Object.keys(result)).toEqual(["FOO"]);
  });

  test("handles export prefix", () => {
    const result = parseEnvContent("export FOO=bar");
    expect(result.FOO).toBe("bar");
  });
});

describe("encrypt / decrypt round-trip", () => {
  test("encrypts and decrypts correctly", async () => {
    const key = "a".repeat(64);
    const plaintext = "DATABASE_URL=postgres://localhost/myapp\nSECRET=hunter2";
    const encrypted = await encryptContent(plaintext, key);
    const decrypted = await decryptContent(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  test("fails with wrong key", async () => {
    const key1 = "a".repeat(64);
    const key2 = "b".repeat(64);
    const encrypted = await encryptContent("test", key1);
    expect(decryptContent(encrypted, key2)).rejects.toThrow("decryption failed");
  });
});

describe("loadEnv", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "xenv-core-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads from .xenv.{env} plaintext", async () => {
    writeFileSync(join(tmpDir, ".xenv.development"), "FOO=bar\nBAZ=42");
    const env = await loadEnv("development", { cwd: tmpDir });
    expect(env.FOO).toBe("bar");
    expect(env.BAZ).toBe("42");
  });

  test("loads from .env base file", async () => {
    writeFileSync(join(tmpDir, ".env"), "BASE=yes");
    writeFileSync(join(tmpDir, ".xenv.development"), "APP=dev");
    const env = await loadEnv("development", { cwd: tmpDir });
    expect(env.BASE).toBe("yes");
    expect(env.APP).toBe("dev");
  });

  test("cascade: later layers override earlier ones", async () => {
    writeFileSync(join(tmpDir, ".env"), "FOO=base");
    writeFileSync(join(tmpDir, ".xenv"), "FOO=modern");
    writeFileSync(join(tmpDir, ".xenv.development"), "FOO=dev");
    const env = await loadEnv("development", { cwd: tmpDir });
    expect(env.FOO).toBe("dev");
  });

  test("decrypts .xenv.{env}.enc vault", async () => {
    const key = "c".repeat(64);
    const plaintext = "SECRET=hunter2\nDB=postgres";
    const encrypted = await encryptContent(plaintext, key);

    writeFileSync(join(tmpDir, ".xenv.production.enc"), encrypted);
    writeFileSync(join(tmpDir, ".xenv.keys"), `XENV_KEY_PRODUCTION="${key}"`);

    const env = await loadEnv("production", { cwd: tmpDir });
    expect(env.SECRET).toBe("hunter2");
    expect(env.DB).toBe("postgres");
  });

  test("vault overrides plaintext (cascade layer 5 > 4)", async () => {
    const key = "d".repeat(64);
    const vaultContent = "FOO=from_vault";
    const encrypted = await encryptContent(vaultContent, key);

    writeFileSync(join(tmpDir, ".xenv.staging"), "FOO=from_plaintext");
    writeFileSync(join(tmpDir, ".xenv.staging.enc"), encrypted);
    writeFileSync(join(tmpDir, ".xenv.keys"), `XENV_KEY_STAGING="${key}"`);

    const env = await loadEnv("staging", { cwd: tmpDir });
    expect(env.FOO).toBe("from_vault");
  });

  test("inject: true writes to process.env", async () => {
    const unique = `XENV_TEST_${Date.now()}`;
    writeFileSync(join(tmpDir, ".xenv.development"), `${unique}=injected`);

    await loadEnv("development", { cwd: tmpDir, inject: true });
    expect(process.env[unique]).toBe("injected");

    // cleanup
    delete process.env[unique];
  });

  test("inject with override: false does not overwrite", async () => {
    const unique = `XENV_TEST_${Date.now()}`;
    process.env[unique] = "original";
    writeFileSync(join(tmpDir, ".xenv.development"), `${unique}=new`);

    await loadEnv("development", { cwd: tmpDir, inject: true, override: false });
    expect(process.env[unique]).toBe("original");

    // cleanup
    delete process.env[unique];
  });

  test("system env overrides cascade keys", async () => {
    const unique = `XENV_TEST_${Date.now()}`;
    process.env[unique] = "from_system";
    writeFileSync(join(tmpDir, ".xenv.development"), `${unique}=from_file`);

    const env = await loadEnv("development", { cwd: tmpDir });
    expect(env[unique]).toBe("from_system");

    // cleanup
    delete process.env[unique];
  });

  test("returns empty object when no files exist", async () => {
    const env = await loadEnv("production", { cwd: tmpDir });
    expect(Object.keys(env).length).toBe(0);
  });
});

describe("resolveKey", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "xenv-core-key-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads from .xenv.keys file", () => {
    const key = "e".repeat(64);
    writeFileSync(join(tmpDir, ".xenv.keys"), `XENV_KEY_PRODUCTION="${key}"`);
    expect(resolveKey("production", tmpDir)).toBe(key);
  });

  test("env var takes precedence over file", () => {
    const fileKey = "e".repeat(64);
    const envKey = "f".repeat(64);
    writeFileSync(join(tmpDir, ".xenv.keys"), `XENV_KEY_TEST="${fileKey}"`);
    process.env.XENV_KEY_TEST = envKey;

    expect(resolveKey("test", tmpDir)).toBe(envKey);

    delete process.env.XENV_KEY_TEST;
  });

  test("returns undefined when no key found", () => {
    expect(resolveKey("nonexistent", tmpDir)).toBeUndefined();
  });
});
