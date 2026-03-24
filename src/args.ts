export interface ParsedArgs {
  env: string;
  command: string | null; // "encrypt" | "decrypt" | "keys" | "edit" | "diff" | "validate" | "audit" | "resolve" | "mcp"
  subcommand: string | null; // "set" | "delete" | "list" (for edit)
  exec: string[];
  positional: string[]; // KEY=VALUE for edit set, KEY for edit delete
  help: boolean;
  version: boolean;
  json: boolean;
  flags: Record<string, string | boolean>;
}

const COMMANDS = new Set([
  "encrypt", "decrypt", "keys",
  "edit", "diff", "validate", "audit", "resolve", "mcp",
]);

const SUBCOMMANDS = new Set(["set", "delete", "list"]);

export function parseArgs(argv: string[]): ParsedArgs {
  let env = "development";
  let command: string | null = null;
  let subcommand: string | null = null;
  let exec: string[] = [];
  let positional: string[] = [];
  let help = false;
  let version = false;
  let json = false;
  const flags: Record<string, string | boolean> = Object.create(null);

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

    if (arg === "--json") {
      json = true;
      i++;
      continue;
    }

    // --keys-only, --require VALUE style flags
    if (arg.startsWith("--") && arg !== "--") {
      const flag_name = arg.slice(2);
      // check if next arg is a value (not another flag, not a command)
      if (i + 1 < argv.length && !argv[i + 1].startsWith("-") && !argv[i + 1].startsWith("@")) {
        flags[flag_name] = argv[i + 1];
        i += 2;
      } else {
        flags[flag_name] = true;
        i++;
      }
      continue;
    }

    // @env syntax
    if (arg.startsWith("@")) {
      env = arg.slice(1);
      i++;
      continue;
    }

    // commands
    if (COMMANDS.has(arg) && command === null) {
      command = arg;
      i++;

      // for commands with subcommands (edit), consume subcommand + positional args
      if (command === "edit") {
        while (i < argv.length) {
          const next = argv[i];
          if (next === "--") break;
          if (next === "--json") { json = true; i++; continue; }
          if (next.startsWith("--")) {
            const flag_name = next.slice(2);
            if (i + 1 < argv.length && !argv[i + 1].startsWith("-") && !argv[i + 1].startsWith("@")) {
              flags[flag_name] = argv[i + 1];
              i += 2;
            } else {
              flags[flag_name] = true;
              i++;
            }
            continue;
          }
          if (next.startsWith("@")) { env = next.slice(1); i++; continue; }
          if (subcommand === null && SUBCOMMANDS.has(next)) {
            subcommand = next;
          } else {
            positional.push(next);
          }
          i++;
        }
      }
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

  return { env, command, subcommand, exec, positional, help, version, json, flags };
}
