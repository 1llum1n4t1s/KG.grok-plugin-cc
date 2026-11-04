#[cfg(windows)]
mod git_snapshot;
#[cfg(windows)]
mod windows_agent;

// モジュールのエラーには外部入力が含まれ得るため、境界では固定の診断だけを出す。
fn fail(stage: &str, code: i32) -> i32 {
    eprintln!("grok-windows-helper: {stage} failed ({code})");
    code
}

#[cfg(windows)]
fn run() -> i32 {
    let mut args = std::env::args_os().skip(1);
    let Some(mode) = args.next() else {
        return fail("arguments", 2);
    };
    match mode.to_str() {
        Some("supervisor") if args.next().is_none() => {
            windows_agent::run_supervisor().unwrap_or_else(|error| {
                // supervisor の診断は固定 stage のみで、bootstrap の値を含まない。
                eprintln!("{error}");
                1
            })
        }
        Some("git-snapshot") if args.next().is_none() => match git_snapshot::run() {
            Ok(()) => 0,
            Err(_) => fail("git-snapshot", 1),
        },
        Some("identity") => {
            let Some(pid_arg) = args.next() else {
                return fail("arguments", 2);
            };
            if args.next().is_some() {
                return fail("arguments", 2);
            }
            let pid = pid_arg.to_str().and_then(|value| {
                if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) {
                    value.parse::<u32>().ok().filter(|pid| *pid != 0)
                } else {
                    None
                }
            });
            let Some(pid) = pid else {
                return fail("arguments", 2);
            };
            match windows_agent::identity(pid) {
                Ok(value) if !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()) => {
                    println!("{value}");
                    0
                }
                _ => fail("identity", 1),
            }
        }
        _ => fail("arguments", 2),
    }
}

#[cfg(not(windows))]
fn run() -> i32 {
    fail("platform", 2)
}

fn main() {
    std::process::exit(run());
}
