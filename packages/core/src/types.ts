export interface LoadEnvOptions {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Write resolved vars to process.env (default: false) */
  inject?: boolean;
  /** When inject=true, overwrite existing process.env keys (default: true) */
  override?: boolean;
}

export interface GlobalKeysSection {
  root: string | null;
  keys: Record<string, string>;
}
