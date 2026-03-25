/**
 * xenv MCP (Model Context Protocol) server.
 *
 * Zero-dependency JSON-RPC 2.0 server over stdio.
 * Exposes xenv operations as MCP tools for Claude Code, Cursor, etc.
 */

import { resolveCascadeOnly } from "./resolve";
import { edit_set, edit_delete, edit_list } from "./edit";
import { rotate_vault_key, runEncrypt } from "./vault";
import { audit_project } from "./audit";
import { validate_env } from "./validate";
import { diff_env } from "./diff";
import { run_init } from "./init";
import { run_doctor } from "./doctor";
import { hook_install, hook_check } from "./hook";
import pkg from "../package.json";

const MCP_VERSION = "2024-11-05";
const SERVER_NAME = "xenv";
const SERVER_VERSION = pkg.version;

// ── JSON-RPC 2.0 types ──────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ── MCP tool definitions ─────────────────────────────────────────────

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpTool[] = [
  {
    name: "init",
    description: "Bootstrap xenv in a project: creates .gitignore entries, generates an encryption key, and creates a starter .xenv.{env} file. Idempotent — safe to call multiple times. Call this first if the project has no .xenv.keys file.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name to initialize. Defaults to 'development'." },
      },
      required: [],
    },
  },
  {
    name: "resolve_env",
    description: "Resolve the 7-layer environment cascade for a given environment. Returns merged key-value pairs from cascade files only (system env vars are excluded for safety). Common env names: production, staging, development.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name (e.g. production, staging, development). Defaults to 'development' if omitted." },
      },
      required: [],
    },
  },
  {
    name: "set_secret",
    description: "Set or update a secret in an encrypted vault. Creates the key if it doesn't exist in the vault. The vault (.xenv.{env}.enc) must already exist — use 'init' to bootstrap, then 'encrypt' to create the vault. Plaintext never touches disk.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name" },
        key: { type: "string", description: "The variable name to set" },
        value: { type: "string", description: "The value to set" },
      },
      required: ["env", "key", "value"],
    },
  },
  {
    name: "delete_secret",
    description: "Remove a secret from an encrypted vault without exposing plaintext to disk. Use 'list_secrets' first to see available keys.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name" },
        key: { type: "string", description: "The variable name to remove" },
      },
      required: ["env", "key"],
    },
  },
  {
    name: "list_secrets",
    description: "List the key names (not values) stored in an encrypted vault. Safe to display — no secret values are exposed. Returns { env, keys: string[] }.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name" },
      },
      required: ["env"],
    },
  },
  {
    name: "encrypt",
    description: "Encrypt a plaintext .xenv.{env} file into .xenv.{env}.enc vault. The plaintext file and encryption key must exist. Use after creating or editing a plaintext env file.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name" },
      },
      required: ["env"],
    },
  },
  {
    name: "diff",
    description: "Compare the plaintext .xenv.{env} file against the encrypted .xenv.{env}.enc vault. Returns added, removed, and changed keys. keys_only defaults to true (safe — no secret values in response). Set keys_only=false only if you need actual values.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name" },
        keys_only: { type: "boolean", description: "If true, omit secret values from the diff. Defaults to true for safety." },
      },
      required: ["env"],
    },
  },
  {
    name: "rotate_key",
    description: "Generate a new encryption key, re-encrypt the vault with it, and update .xenv.keys. The old key is replaced. You must re-distribute the new key to CI/production after rotation.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name" },
      },
      required: ["env"],
    },
  },
  {
    name: "audit",
    description: "Scan the project for security mistakes: missing .gitignore entries, orphan vaults/keys, sensitive values in unencrypted files. Returns { ok, findings }. ok=false means errors were found. Findings have severity 'error' or 'warning'.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "validate",
    description: "Validate an environment configuration: missing required keys, empty secrets, vault/key mismatches. Required keys can be passed via the 'required' parameter or listed in a .xenv.required file (one key per line). Returns { env, ok, checks }.",
    inputSchema: {
      type: "object",
      properties: {
        env: { type: "string", description: "Environment name" },
        required: {
          type: "array",
          items: { type: "string" },
          description: "List of required key names to check",
        },
      },
      required: ["env"],
    },
  },
  {
    name: "doctor",
    description: "Check project health and agent integration status. Returns { ok, checks } where each check has name, ok, message, and optional fix command. Call this FIRST to understand the project state before using other tools.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "hook_install",
    description: "Install a git pre-commit hook that blocks commits containing leaked secrets. The hook decrypts all vaults in memory and scans staged changes for exact matches against known secret values. Opt-in only — not installed automatically.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "hook_check",
    description: "Scan staged git changes for leaked secrets. Decrypts all vaults in memory and checks if any staged line contains a known secret value (exact match, not heuristic). Also detects common secret patterns (API keys, tokens). Returns { ok, leaks }.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── Tool dispatch ────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  init: async (args) => {
    const env = String(args.env ?? "development");
    await run_init(env);
    return { ok: true, env, message: `xenv initialized for @${env}` };
  },
  resolve_env: async (args) => {
    const env = String(args.env ?? "development");
    return await resolveCascadeOnly(env);
  },
  set_secret: async (args) => {
    const env = String(args.env);
    const key = String(args.key);
    const value = String(args.value);
    return await edit_set(env, key, value);
  },
  delete_secret: async (args) => {
    const env = String(args.env);
    const key = String(args.key);
    return await edit_delete(env, key);
  },
  list_secrets: async (args) => {
    const env = String(args.env);
    const keys = await edit_list(env);
    return { env, keys };
  },
  encrypt: async (args) => {
    const env = String(args.env);
    await runEncrypt(env);
    return { ok: true, env, file: `.xenv.${env}.enc` };
  },
  diff: async (args) => {
    const env = String(args.env);
    const keys_only = Boolean(args.keys_only ?? true);
    return await diff_env(env, keys_only);
  },
  rotate_key: async (args) => {
    const env = String(args.env);
    await rotate_vault_key(env);
    return { ok: true, env, message: `key rotated for @${env} — new key saved to .xenv.keys. re-distribute to CI/production.` };
  },
  audit: async () => {
    return await audit_project();
  },
  validate: async (args) => {
    const env = String(args.env);
    const required = Array.isArray(args.required)
      ? args.required.map(String)
      : [];
    return await validate_env(env, required);
  },
  doctor: async () => {
    return await run_doctor();
  },
  hook_install: async () => {
    return hook_install();
  },
  hook_check: async () => {
    return await hook_check();
  },
};

// ── JSON-RPC 2.0 message handling ────────────────────────────────────

let initialized = false;

function make_response(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function make_error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handle_initialize(params: Record<string, unknown>): Promise<unknown> {
  return {
    protocolVersion: MCP_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
  };
}

function handle_tools_list(): unknown {
  return { tools: TOOLS };
}

async function handle_tools_call(params: Record<string, unknown>): Promise<unknown> {
  const name = String(params.name ?? "");
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  // validate env name if present (prevent path traversal)
  if (args.env !== undefined && args.env !== null) {
    const env_str = String(args.env);
    if (env_str.includes("/") || env_str.includes("\\") || env_str.includes("..") || env_str.includes("\0")) {
      return {
        content: [{ type: "text", text: `invalid environment name: ${env_str} — use alphanumeric names like 'production', 'staging', 'test'` }],
        isError: true,
      };
    }
  }

  // validate required parameters
  const tool_def = TOOLS.find(t => t.name === name);
  if (tool_def) {
    const required = (tool_def.inputSchema as { required?: string[] }).required ?? [];
    for (const param of required) {
      if (args[param] === undefined || args[param] === null || args[param] === "") {
        return {
          content: [{ type: "text", text: `missing required parameter: ${param}` }],
          isError: true,
        };
      }
    }
  }

  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    const available = TOOLS.map(t => t.name).join(", ");
    return {
      content: [{ type: "text", text: `unknown tool: ${name}. Available tools: ${available}` }],
      isError: true,
    };
  }

  try {
    const result = await handler(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: message }],
      isError: true,
    };
  }
}

/**
 * Process a single JSON-RPC message and return the response (or null for notifications).
 * Exported for testability.
 */
export async function handle_jsonrpc_message(raw: string): Promise<string | null> {
  let msg: JsonRpcRequest;

  try {
    msg = JSON.parse(raw);
  } catch {
    return JSON.stringify(make_error(null, -32700, "parse error"));
  }

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    const id = msg.id ?? null;
    return JSON.stringify(make_error(id, -32600, "invalid request"));
  }

  const { method, params, id } = msg;
  const is_notification = id === undefined;

  // handle notifications (no response)
  if (method === "notifications/initialized") {
    initialized = true;
    return null;
  }

  if (method === "notifications/cancelled") {
    return null;
  }

  // requests require an id
  if (is_notification) {
    return null;
  }

  // before initialization, only allow initialize and ping
  if (!initialized && method !== "initialize" && method !== "ping") {
    return JSON.stringify(make_error(id!, -32600, "server not initialized"));
  }

  try {
    let result: unknown;

    switch (method) {
      case "initialize":
        result = await handle_initialize(params ?? {});
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = handle_tools_list();
        break;
      case "tools/call":
        result = await handle_tools_call(params ?? {});
        break;
      default:
        return JSON.stringify(make_error(id!, -32601, `method not found: ${method}`));
    }

    return JSON.stringify(make_response(id!, result));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify(make_error(id!, -32603, message));
  }
}

// ── stdio transport ──────────────────────────────────────────────────

function send(line: string): void {
  process.stdout.write(line + "\n");
}

function log(message: string): void {
  process.stderr.write(`[xenv-mcp] ${message}\n`);
}

/**
 * Start the MCP server on stdio.
 */
export async function run_mcp_server(): Promise<void> {
  log("starting xenv MCP server");

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline_idx: number;
    while ((newline_idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline_idx).trim();
      buffer = buffer.slice(newline_idx + 1);

      if (line.length === 0) continue;

      const response = await handle_jsonrpc_message(line);
      if (response !== null) {
        send(response);
      }
    }
  }

  log("stdin closed, shutting down");
}
