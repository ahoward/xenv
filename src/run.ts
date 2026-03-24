import { which } from "bun";

/**
 * Execute a child process with the resolved environment.
 * Transparent stdin/stdout/stderr and exit code forwarding.
 */
export async function run(
  exec: string[],
  env: Record<string, string>
): Promise<number> {
  const [cmd, ...args] = exec;

  // check if the command exists before spawning
  const resolved = which(cmd, { PATH: env.PATH ?? process.env.PATH ?? "" });
  if (!resolved && !cmd.startsWith("/") && !cmd.startsWith("./") && !cmd.startsWith("../")) {
    throw new Error(`command not found: ${cmd} — check that it exists on PATH or use an absolute/relative path`);
  }

  const proc = Bun.spawn([cmd, ...args], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  // forward signals to child and clean up after exit
  const handlers: Array<[string, () => void]> = [];

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => { proc.kill(signal); };
    process.on(signal, handler);
    handlers.push([signal, handler]);
  }

  const exitCode = await proc.exited;

  // remove signal handlers to avoid listener leaks
  for (const [signal, handler] of handlers) {
    process.removeListener(signal, handler);
  }

  return exitCode;
}
