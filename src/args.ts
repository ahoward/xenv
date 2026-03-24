export interface ParsedArgs {
  env: string;
  command: string | null; // "encrypt" | "decrypt" | "keys" | null
  exec: string[];
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let env = "development";
  let command: string | null = null;
  let exec: string[] = [];
  let help = false;
  let version = false;

  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      help = true;
      i++;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      version = true;
      i++;
      continue;
    }

    // @env syntax
    if (arg.startsWith("@")) {
      env = arg.slice(1);
      i++;
      continue;
    }

    // vault commands
    if (arg === "encrypt" || arg === "decrypt" || arg === "keys") {
      command = arg;
      i++;
      continue;
    }

    // -- separator: everything after is the exec command
    if (arg === "--") {
      exec = argv.slice(i + 1);
      break;
    }

    // unknown arg before -- : treat as start of exec
    exec = argv.slice(i);
    break;
  }

  return { env, command, exec, help, version };
}
