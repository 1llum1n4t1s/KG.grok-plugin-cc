use std::process::{Command, Stdio};

fn run() -> i32 {
    let Some(node) = std::env::var_os("GROK_TEST_NODE").filter(|value| !value.is_empty()) else {
        eprintln!("grok-test-shim: node configuration failed");
        return 2;
    };
    let Some(script) = std::env::var_os("GROK_TEST_SCRIPT").filter(|value| !value.is_empty()) else {
        eprintln!("grok-test-shim: script configuration failed");
        return 2;
    };
    let mut command = Command::new(node);
    command
        .arg(script)
        .args(std::env::args_os().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _ = command.exec();
        eprintln!("grok-test-shim: exec failed");
        1
    }
    #[cfg(not(unix))]
    {
        match command.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(_) => {
                eprintln!("grok-test-shim: spawn failed");
                1
            }
        }
    }
}

fn main() {
    std::process::exit(run());
}
