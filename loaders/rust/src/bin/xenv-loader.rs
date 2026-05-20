//! CLI wrapper for the xenv loader, for use by `loaders/test.sh`.
//!
//! Usage:
//!   xenv-loader <env>           # prints KEY=value lines
//!   xenv-loader <env> <key>     # prints just that value

use std::io::Write;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: xenv-loader <env> [<key>]");
        return ExitCode::from(2);
    }
    let env_name = &args[0];

    if let Some(key) = args.get(1) {
        match xenv::decrypt_one(env_name, key) {
            Ok(bytes) => {
                std::io::stdout().write_all(&bytes).ok();
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("xenv: {e}");
                ExitCode::FAILURE
            }
        }
    } else {
        match xenv::load(env_name) {
            Ok(map) => {
                let mut out = std::io::stdout().lock();
                for (k, v) in map {
                    write!(out, "{k}=").ok();
                    out.write_all(&v).ok();
                    writeln!(out).ok();
                }
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("xenv: {e}");
                ExitCode::FAILURE
            }
        }
    }
}
