import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { runEncrypt, runDecrypt, runKeys, decryptVault, resolveKey } from "../src/vault";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("vault", () => {
  let dir: string;
  let origCwd: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "xenv-vault-"));
    origCwd = process.cwd();
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("encrypt → decrypt roundtrip", async () => {
    const plaintext = "SECRET_KEY=abc123\nDB_PASS=hunter2";
    writeFileSync(join(dir, ".xenv.production"), plaintext);

    // generate a key
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    process.env.XENV_KEY_PRODUCTION = key;

    await runEncrypt("production");

    const encPath = join(dir, ".xenv.production.enc");
    expect(existsSync(encPath)).toBe(true);

    // decrypt and verify
    const decrypted = await decryptVault(encPath, key);
    expect(decrypted).toBe(plaintext);

    delete process.env.XENV_KEY_PRODUCTION;
  });

  test("decrypt command writes plaintext file", async () => {
    const plaintext = "API_KEY=secret";
    writeFileSync(join(dir, ".xenv.staging"), plaintext);

    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    process.env.XENV_KEY_STAGING = key;

    await runEncrypt("staging");

    // remove the plaintext source
    rmSync(join(dir, ".xenv.staging"));
    expect(existsSync(join(dir, ".xenv.staging"))).toBe(false);

    // decrypt should recreate it
    await runDecrypt("staging");
    const restored = readFileSync(join(dir, ".xenv.staging"), "utf-8");
    expect(restored).toBe(plaintext);

    delete process.env.XENV_KEY_STAGING;
  });

  test("encrypt fails without key", async () => {
    writeFileSync(join(dir, ".xenv.test"), "A=1");
    delete process.env.XENV_KEY_TEST;
    expect(runEncrypt("test")).rejects.toThrow("encryption key not found");
  });

  test("decrypt fails without vault", async () => {
    delete process.env.XENV_KEY_TEST;
    expect(runDecrypt("test")).rejects.toThrow("vault not found");
  });

  test("decrypt fails with corrupted ciphertext", async () => {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    writeFileSync(join(dir, ".xenv.bad.enc"), "not_valid_hex_data_at_all!!!");
    process.env.XENV_KEY_BAD = key;
    expect(decryptVault(join(dir, ".xenv.bad.enc"), key)).rejects.toThrow();
    delete process.env.XENV_KEY_BAD;
  });

  test("decrypt fails with wrong key", async () => {
    const plaintext = "SECRET=value";
    writeFileSync(join(dir, ".xenv.wrongkey"), plaintext);

    const realKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    process.env.XENV_KEY_WRONGKEY = realKey;
    await runEncrypt("wrongkey");

    const wrongKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    expect(decryptVault(join(dir, ".xenv.wrongkey.enc"), wrongKey)).rejects.toThrow();
    delete process.env.XENV_KEY_WRONGKEY;
  });

  test("encrypt fails with invalid key length", async () => {
    writeFileSync(join(dir, ".xenv.short"), "A=1");
    process.env.XENV_KEY_SHORT = "tooshort";
    expect(runEncrypt("short")).rejects.toThrow("invalid key length");
    delete process.env.XENV_KEY_SHORT;
  });

  test("encrypted vault has version header", async () => {
    writeFileSync(join(dir, ".xenv.versioned"), "A=1");
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    process.env.XENV_KEY_VERSIONED = key;

    await runEncrypt("versioned");

    const content = readFileSync(join(dir, ".xenv.versioned.enc"), "utf-8").trim();
    expect(content.startsWith("xenv:v1:")).toBe(true);

    // roundtrip still works
    const decrypted = await decryptVault(join(dir, ".xenv.versioned.enc"), key);
    expect(decrypted).toBe("A=1");

    delete process.env.XENV_KEY_VERSIONED;
  });

  test("XENV_KEY fallback: encrypt uses global key when specific is missing", async () => {
    const plaintext = "FALLBACK=yes";
    writeFileSync(join(dir, ".xenv.myenv"), plaintext);

    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    delete process.env.XENV_KEY_MYENV;
    process.env.XENV_KEY = key;

    await runEncrypt("myenv");

    const encPath = join(dir, ".xenv.myenv.enc");
    expect(existsSync(encPath)).toBe(true);

    const decrypted = await decryptVault(encPath, key);
    expect(decrypted).toBe(plaintext);

    delete process.env.XENV_KEY;
  });

  test("XENV_KEY fallback: decrypt uses global key when specific is missing", async () => {
    const plaintext = "GLOBAL=works";
    writeFileSync(join(dir, ".xenv.globaltest"), plaintext);

    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    process.env.XENV_KEY = key;
    delete process.env.XENV_KEY_GLOBALTEST;

    await runEncrypt("globaltest");
    rmSync(join(dir, ".xenv.globaltest"));

    await runDecrypt("globaltest");
    const restored = readFileSync(join(dir, ".xenv.globaltest"), "utf-8");
    expect(restored).toBe(plaintext);

    delete process.env.XENV_KEY;
  });

  test("specific key takes precedence over XENV_KEY", async () => {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const globalKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

    process.env.XENV_KEY_PRECTEST = key;
    process.env.XENV_KEY = globalKey;

    // resolveKey should return the specific key, not the global one
    expect(resolveKey("prectest")).toBe(key);

    delete process.env.XENV_KEY_PRECTEST;
    delete process.env.XENV_KEY;
  });

  test("resolveKey returns undefined when no key is set", () => {
    delete process.env.XENV_KEY_NOKEY;
    delete process.env.XENV_KEY;
    expect(resolveKey("nokey")).toBeUndefined();
  });

  test("encrypt fails when neither specific nor global key is set", async () => {
    writeFileSync(join(dir, ".xenv.nokey"), "A=1");
    delete process.env.XENV_KEY_NOKEY;
    delete process.env.XENV_KEY;
    expect(runEncrypt("nokey")).rejects.toThrow("encryption key not found");
  });

  test("keys writes key to .xenv.keys file", async () => {
    await runKeys("production");

    const keysPath = join(dir, ".xenv.keys");
    expect(existsSync(keysPath)).toBe(true);

    const content = readFileSync(keysPath, "utf-8");
    expect(content).toContain("XENV_KEY_PRODUCTION=");
    expect(content).toContain("DO NOT COMMIT");

    // key should be 64 hex chars in the file
    const match = content.match(/XENV_KEY_PRODUCTION="([a-f0-9]{64})"/);
    expect(match).not.toBeNull();

    // file should be mode 600
    const { statSync } = require("fs");
    const mode = statSync(keysPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("keys replaces existing key for same env", async () => {
    await runKeys("staging");
    const first = readFileSync(join(dir, ".xenv.keys"), "utf-8");
    const firstMatch = first.match(/XENV_KEY_STAGING="([a-f0-9]{64})"/);

    await runKeys("staging");
    const second = readFileSync(join(dir, ".xenv.keys"), "utf-8");
    const secondMatch = second.match(/XENV_KEY_STAGING="([a-f0-9]{64})"/);

    // key was regenerated (different value)
    expect(firstMatch![1]).not.toBe(secondMatch![1]);
    // only one XENV_KEY_STAGING line in the file
    const count = (second.match(/XENV_KEY_STAGING/g) || []).length;
    expect(count).toBe(1);
  });

  test("keys appends multiple envs to same file", async () => {
    await runKeys("production");
    await runKeys("staging");

    const content = readFileSync(join(dir, ".xenv.keys"), "utf-8");
    expect(content).toContain("XENV_KEY_PRODUCTION=");
    expect(content).toContain("XENV_KEY_STAGING=");
  });

  test("resolveKey reads from .xenv.keys file", async () => {
    delete process.env.XENV_KEY_FILETEST;
    delete process.env.XENV_KEY;

    // write a key directly to .xenv.keys
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    writeFileSync(join(dir, ".xenv.keys"), `XENV_KEY_FILETEST="${key}"\n`);

    expect(resolveKey("filetest", dir)).toBe(key);
  });

  test("resolveKey reads XENV_KEY fallback from .xenv.keys", async () => {
    delete process.env.XENV_KEY_SOMETHING;
    delete process.env.XENV_KEY;

    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    writeFileSync(join(dir, ".xenv.keys"), `XENV_KEY="${key}"\n`);

    expect(resolveKey("something", dir)).toBe(key);
  });

  test("process.env key takes precedence over .xenv.keys", async () => {
    const envKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
    const fileKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

    process.env.XENV_KEY_PREC = envKey;
    writeFileSync(join(dir, ".xenv.keys"), `XENV_KEY_PREC="${fileKey}"\n`);

    expect(resolveKey("prec", dir)).toBe(envKey);

    delete process.env.XENV_KEY_PREC;
  });

  test("encrypt/decrypt roundtrip using .xenv.keys", async () => {
    delete process.env.XENV_KEY_ROUNDTRIP;
    delete process.env.XENV_KEY;

    // generate key into .xenv.keys
    await runKeys("roundtrip");

    // write plaintext
    writeFileSync(join(dir, ".xenv.roundtrip"), "SECRET=fromfile");

    // encrypt should find the key in .xenv.keys
    await runEncrypt("roundtrip");
    expect(existsSync(join(dir, ".xenv.roundtrip.enc"))).toBe(true);

    // remove plaintext, decrypt should also find the key
    rmSync(join(dir, ".xenv.roundtrip"));
    await runDecrypt("roundtrip");
    expect(readFileSync(join(dir, ".xenv.roundtrip"), "utf-8")).toBe("SECRET=fromfile");
  });
});
