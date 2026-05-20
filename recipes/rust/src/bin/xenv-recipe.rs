//! CLI wrapper for the xenv recipe, for use by recipes/try and recipes/test.
//!
//! Usage:
//!   xenv-recipe get  <env> <key>           # prints plaintext
//!   xenv-recipe set  <env> <key> <value>   # writes encrypted value
//!   xenv-recipe load <env>                 # prints KEY=value lines

use std::io::Write;
use std::process::ExitCode;

fn usage() -> ExitCode {
    eprintln!("usage: xenv-recipe {{get|set|load}} <env> [<key>] [<value>]");
    ExitCode::from(2)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        return usage();
    }
    let verb = args[0].as_str();

    match (verb, args.len()) {
        ("get", 3) => match xenv::get(&args[1], &args[2]) {
            Ok(bytes) => {
                std::io::stdout().write_all(&bytes).ok();
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("xenv: {e}");
                ExitCode::FAILURE
            }
        },
        ("set", 4) => match xenv::set(&args[1], &args[2], args[3].as_bytes()) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("xenv: {e}");
                ExitCode::FAILURE
            }
        },
        ("load", 2) => match xenv::load(&args[1]) {
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
        },
        _ => usage(),
    }
}
