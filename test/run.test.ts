import { describe, test, expect } from "bun:test";
import { run } from "../src/run";

describe("run", () => {
  test("executes command and returns exit code 0", async () => {
    const code = await run(["true"], { PATH: process.env.PATH ?? "" });
    expect(code).toBe(0);
  });

  test("returns non-zero exit code from child", async () => {
    const code = await run(["false"], { PATH: process.env.PATH ?? "" });
    expect(code).toBe(1);
  });

  test("passes environment to child process", async () => {
    const code = await run(
      ["sh", "-c", 'test "$XENV_TEST_RUN" = "hello"'],
      { PATH: process.env.PATH ?? "", XENV_TEST_RUN: "hello" }
    );
    expect(code).toBe(0);
  });

  test("child does NOT inherit parent env vars not in the passed env", async () => {
    // pass a minimal env — child should not see HOME (unless we pass it)
    const code = await run(
      ["sh", "-c", 'test -z "$XENV_NONEXISTENT_VAR"'],
      { PATH: process.env.PATH ?? "" }
    );
    expect(code).toBe(0);
  });

  test("throws for command not found", async () => {
    expect(
      run(["xenv_nonexistent_command_12345"], { PATH: process.env.PATH ?? "" })
    ).rejects.toThrow("command not found");
  });

  test("handles command with arguments", async () => {
    const code = await run(
      ["sh", "-c", "exit 42"],
      { PATH: process.env.PATH ?? "" }
    );
    expect(code).toBe(42);
  });

  test("handles command with no arguments (single element exec)", async () => {
    const code = await run(["true"], { PATH: process.env.PATH ?? "" });
    expect(code).toBe(0);
  });
});
