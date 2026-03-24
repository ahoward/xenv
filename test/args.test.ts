import { describe, test, expect } from "bun:test";
import { parseArgs } from "../src/args";

describe("parseArgs", () => {
  test("bare -- with command", () => {
    const r = parseArgs(["--", "echo", "hi"]);
    expect(r.env).toBe("development");
    expect(r.exec).toEqual(["echo", "hi"]);
    expect(r.command).toBeNull();
  });

  test("@env -- command", () => {
    const r = parseArgs(["@production", "--", "./server"]);
    expect(r.env).toBe("production");
    expect(r.exec).toEqual(["./server"]);
  });

  test("encrypt command with @env", () => {
    const r = parseArgs(["encrypt", "@production"]);
    expect(r.command).toBe("encrypt");
    expect(r.env).toBe("production");
  });

  test("decrypt command with @env", () => {
    const r = parseArgs(["decrypt", "@staging"]);
    expect(r.command).toBe("decrypt");
    expect(r.env).toBe("staging");
  });

  test("keys command", () => {
    const r = parseArgs(["keys", "@production"]);
    expect(r.command).toBe("keys");
    expect(r.env).toBe("production");
  });

  test("--help flag", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  test("--version flag", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  test("defaults to development env", () => {
    expect(parseArgs(["--", "cmd"]).env).toBe("development");
  });

  test("@env without -- treats next arg as exec", () => {
    const r = parseArgs(["@production", "./server"]);
    expect(r.env).toBe("production");
    expect(r.exec).toEqual(["./server"]);
  });

  test("empty args", () => {
    const r = parseArgs([]);
    expect(r.env).toBe("development");
    expect(r.exec).toEqual([]);
    expect(r.command).toBeNull();
    expect(r.help).toBe(false);
    expect(r.version).toBe(false);
  });

  test("@env before vault command", () => {
    const r = parseArgs(["@staging", "encrypt"]);
    expect(r.env).toBe("staging");
    expect(r.command).toBe("encrypt");
  });

  test("exec with multiple args after --", () => {
    const r = parseArgs(["@test", "--", "node", "app.js", "--port", "3000"]);
    expect(r.exec).toEqual(["node", "app.js", "--port", "3000"]);
  });

  test("bare @ produces empty env name", () => {
    const r = parseArgs(["@", "--", "cmd"]);
    expect(r.env).toBe("");
  });

  test("-- with no command after it", () => {
    const r = parseArgs(["@production", "--"]);
    expect(r.exec).toEqual([]);
  });
});
