import { describe, test, expect } from "bun:test";
import { parseEnvContent } from "../src/parse";

describe("parseEnvContent", () => {
  test("simple key=value", () => {
    expect(parseEnvContent("FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("multiple keys", () => {
    expect(parseEnvContent("A=1\nB=2\nC=3")).toEqual({ A: "1", B: "2", C: "3" });
  });

  test("double-quoted value", () => {
    expect(parseEnvContent('FOO="hello world"')).toEqual({ FOO: "hello world" });
  });

  test("single-quoted value", () => {
    expect(parseEnvContent("FOO='hello world'")).toEqual({ FOO: "hello world" });
  });

  test("export prefix", () => {
    expect(parseEnvContent("export FOO=bar")).toEqual({ FOO: "bar" });
  });

  test("comments and blank lines", () => {
    const input = "# comment\nFOO=bar\n\n# another\nBAZ=qux";
    expect(parseEnvContent(input)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("inline comments (unquoted)", () => {
    expect(parseEnvContent("FOO=bar # a comment")).toEqual({ FOO: "bar" });
  });

  test("escape sequences in double quotes", () => {
    expect(parseEnvContent('FOO="line1\\nline2"')).toEqual({ FOO: "line1\nline2" });
  });

  test("no escape in single quotes", () => {
    expect(parseEnvContent("FOO='line1\\nline2'")).toEqual({ FOO: "line1\\nline2" });
  });

  test("multiline double-quoted value", () => {
    const input = 'KEY="line1\nline2\nline3"';
    expect(parseEnvContent(input)).toEqual({ KEY: "line1\nline2\nline3" });
  });

  test("value with equals sign", () => {
    expect(parseEnvContent("URL=https://example.com?a=1&b=2")).toEqual({
      URL: "https://example.com?a=1&b=2",
    });
  });

  test("empty value", () => {
    expect(parseEnvContent("FOO=")).toEqual({ FOO: "" });
  });

  test("later values overwrite earlier", () => {
    expect(parseEnvContent("FOO=one\nFOO=two")).toEqual({ FOO: "two" });
  });

  test("multiline single-quoted value", () => {
    const input = "KEY='line1\nline2\nline3'";
    expect(parseEnvContent(input)).toEqual({ KEY: "line1\nline2\nline3" });
  });

  test("backtick-quoted value", () => {
    expect(parseEnvContent("FOO=`hello world`")).toEqual({ FOO: "hello world" });
  });

  test("value that is just a quoted empty string", () => {
    expect(parseEnvContent('FOO=""')).toEqual({ FOO: "" });
    expect(parseEnvContent("FOO=''")).toEqual({ FOO: "" });
  });

  test("double-quoted value with escaped backslash", () => {
    expect(parseEnvContent('FOO="path\\\\to\\\\file"')).toEqual({ FOO: "path\\to\\file" });
  });

  test("value with leading/trailing whitespace unquoted is trimmed", () => {
    expect(parseEnvContent("FOO=  bar  ")).toEqual({ FOO: "bar" });
  });

  test("value with leading/trailing whitespace in quotes is preserved", () => {
    expect(parseEnvContent('FOO="  bar  "')).toEqual({ FOO: "  bar  " });
  });

  test("line with no equals sign is skipped", () => {
    expect(parseEnvContent("NOEQUALS\nFOO=bar")).toEqual({ FOO: "bar" });
  });

  test("key with spaces around equals", () => {
    // key is trimmed, value starts after =
    expect(parseEnvContent("FOO =bar")).toEqual({ "FOO": "bar" });
  });

  test("multiline value preserves internal blank lines", () => {
    const input = 'KEY="line1\n\nline3"';
    expect(parseEnvContent(input)).toEqual({ KEY: "line1\n\nline3" });
  });

  test("hash inside double-quoted value is not a comment", () => {
    expect(parseEnvContent('FOO="bar # not a comment"')).toEqual({ FOO: "bar # not a comment" });
  });

  test("hash inside single-quoted value is not a comment", () => {
    expect(parseEnvContent("FOO='bar # not a comment'")).toEqual({ FOO: "bar # not a comment" });
  });

  test("export with double-quoted value", () => {
    expect(parseEnvContent('export FOO="hello world"')).toEqual({ FOO: "hello world" });
  });

  test("tab escape in double quotes", () => {
    expect(parseEnvContent('FOO="col1\\tcol2"')).toEqual({ FOO: "col1\tcol2" });
  });

  test("carriage return escape in double quotes", () => {
    expect(parseEnvContent('FOO="line1\\rline2"')).toEqual({ FOO: "line1\rline2" });
  });

  test("CRLF line endings", () => {
    const input = "FOO=bar\r\nBAZ=qux\r\n";
    expect(parseEnvContent(input)).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("CRLF in multiline quoted value", () => {
    const input = 'KEY="line1\r\nline2\r\nline3"';
    expect(parseEnvContent(input)).toEqual({ KEY: "line1\nline2\nline3" });
  });

  test("bare CR line endings", () => {
    const input = "A=1\rB=2\r";
    expect(parseEnvContent(input)).toEqual({ A: "1", B: "2" });
  });

  test("__proto__ key is rejected (prototype pollution)", () => {
    const input = "__proto__=polluted\nFOO=bar";
    const result = parseEnvContent(input);
    expect(result.FOO).toBe("bar");
    expect(result.__proto__).toBeUndefined();
    // verify no actual prototype pollution
    expect(({} as any).polluted).toBeUndefined();
  });

  test("constructor key is rejected", () => {
    const result = parseEnvContent("constructor=bad");
    expect(result.constructor).toBeUndefined();
  });

  test("escaped quotes in double-quoted value", () => {
    expect(parseEnvContent('KEY="value with \\"escaped\\""')).toEqual({ KEY: 'value with "escaped"' });
  });

  test("escaped backslash in double-quoted value", () => {
    expect(parseEnvContent('KEY="path\\\\to\\\\file"')).toEqual({ KEY: "path\\to\\file" });
  });

  test("single-quoted value does not expand escaped quotes", () => {
    expect(parseEnvContent("KEY='no \\\"escapes\\\" here'")).toEqual({ KEY: 'no \\"escapes\\" here' });
  });

  test("empty input returns empty object", () => {
    expect(parseEnvContent("")).toEqual({});
  });

  test("whitespace-only input returns empty object", () => {
    expect(parseEnvContent("   \n  \n  ")).toEqual({});
  });

  test("comments-only input returns empty object", () => {
    expect(parseEnvContent("# just a comment\n# another")).toEqual({});
  });

  test("file with BOM is handled", () => {
    const input = "\uFEFFFOO=bar";
    expect(parseEnvContent(input)).toEqual({ FOO: "bar" });
  });
});
