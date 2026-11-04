//! Windows の専用 Job supervisor。診断には bootstrap の値を含めない。
use serde_json::{json, Value};
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::*,
    System::{Console::*, JobObjects::*, Pipes::*, Threading::*},
};

type Result<T> = std::result::Result<T, String>;
fn error(stage: &str) -> String {
    format!("Windows owned Grok agent supervisor failed at {stage}.")
}
fn checked(ok: i32, stage: &'static str) -> Result<()> {
    if ok == 0 {
        // エラー文字列の構築や別 API より先に、呼出し元の失敗コードを回収する。
        let code = unsafe { GetLastError() };
        Err(format!(
            "Windows owned Grok agent supervisor failed at {stage} (Win32 {code})."
        ))
    } else {
        Ok(())
    }
}
fn wide(text: &str) -> Result<Vec<u16>> {
    if text.contains('\0') {
        return Err(error("bootstrap-fields"));
    }
    Ok(text.encode_utf16().chain(Some(0)).collect())
}

struct Handle(HANDLE);
impl Handle {
    fn new(handle: HANDLE, stage: &str) -> Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(error(stage))
        } else {
            Ok(Self(handle))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

fn creation(handle: HANDLE) -> Result<u64> {
    unsafe {
        let (mut created, mut exited, mut kernel, mut user) =
            (zeroed(), zeroed(), zeroed(), zeroed());
        checked(
            GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user),
            "parent-identity",
        )?;
        Ok(((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64)
    }
}
fn alive(handle: HANDLE) -> bool {
    unsafe { WaitForSingleObject(handle, 0) == WAIT_TIMEOUT }
}
fn pin(pid: u32) -> Result<Handle> {
    let handle = Handle::new(
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid) },
        "parent-pin",
    )?;
    if !alive(handle.0) {
        return Err(error("parent-exited"));
    }
    Ok(handle)
}
/// GetProcessTimes の正確な creation FILETIME の十進数。接頭辞は呼出し側が付ける。
pub fn identity(pid: u32) -> Result<String> {
    let parent = pin(pid)?;
    let value = creation(parent.0)?;
    if !alive(parent.0) {
        return Err(error("parent-exited"));
    }
    Ok(value.to_string())
}

struct Config {
    parent_pid: u32,
    parent_key: String,
    cwd: Vec<u16>,
    application: Vec<u16>,
    command: Vec<u16>,
    pipe: Vec<u16>,
    nonce: String,
}
impl Config {
    fn parse(body: &[u8]) -> Result<Self> {
        let text = std::str::from_utf8(body).map_err(|_| error("bootstrap-utf8"))?;
        let value: Value = serde_json::from_str(text).map_err(|_| error("bootstrap-json"))?;
        let field = |key| {
            value
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| error("bootstrap-fields"))
        };
        let parent_pid = value
            .get("ParentPid")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
            .filter(|n| *n > 0)
            .ok_or_else(|| error("bootstrap-fields"))?;
        let parent_key = field("ParentStartKey")?.to_owned();
        let digits = parent_key
            .strip_prefix("win32-filetime:")
            .ok_or_else(|| error("parent-identity"))?;
        if digits.is_empty() || !digits.bytes().all(|n| n.is_ascii_digit()) {
            return Err(error("parent-identity"));
        }
        let name = field("PipeName")?;
        if name.is_empty() || name.contains(['\\', '/', '\0']) {
            return Err(error("bootstrap-fields"));
        }
        let nonce = field("Nonce")?.to_owned();
        if nonce.is_empty() {
            return Err(error("bootstrap-fields"));
        }
        Ok(Self {
            parent_pid,
            parent_key,
            cwd: wide(field("Cwd")?)?,
            application: wide(field("ApplicationName")?)?,
            command: wide(field("CommandLine")?)?,
            pipe: wide(&format!("\\\\.\\pipe\\{name}"))?,
            nonce,
        })
    }
}

// ReadFile に要求した長さより先は決して読まない。残りの ACP stdin はそのまま継承する。
fn read_exact(handle: HANDLE, bytes: &mut [u8]) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        let mut count = 0;
        unsafe {
            checked(
                ReadFile(
                    handle,
                    bytes[offset..].as_mut_ptr(),
                    (bytes.len() - offset) as u32,
                    &mut count,
                    null_mut(),
                ),
                "bootstrap-read",
            )?;
        }
        if count == 0 {
            return Err(error("bootstrap-eof"));
        }
        offset += count as usize;
    }
    Ok(())
}
fn bootstrap() -> Result<Config> {
    let stdin = unsafe { GetStdHandle(STD_INPUT_HANDLE) };
    let mut header = [0; 4];
    read_exact(stdin, &mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > 65536 {
        return Err(error("bootstrap-length"));
    }
    let mut body = vec![0; length];
    read_exact(stdin, &mut body)?;
    Config::parse(&body)
}

trait Api {
    fn pin_parent(&mut self, config: &Config) -> Result<usize>;
    fn control_owner(&mut self, parent: usize) -> Result<bool>;
    fn create_job(&mut self) -> Result<usize>;
    fn configure_job(&mut self, job: usize) -> Result<()>;
    fn create_process(&mut self, job: usize, config: &Config) -> Result<(usize, usize)>;
    fn in_job(&mut self, process: usize, job: usize) -> Result<bool>;
    fn parent_alive(&mut self, parent: usize) -> bool;
    fn resume(&mut self, thread: usize) -> Result<()>;
    fn terminate(&mut self, job: usize) -> Result<()>;
    fn active(&mut self, job: usize) -> Result<u32>;
    fn close(&mut self, handle: usize);
    fn now(&mut self) -> u64;
    fn delay(&mut self);
}
#[derive(Default)]
struct State {
    parent: usize,
    job: usize,
    process: usize,
    thread: usize,
    stop_confirmed: bool,
}
fn close(api: &mut impl Api, state: &mut State) {
    for handle in [
        &mut state.thread,
        &mut state.process,
        &mut state.job,
        &mut state.parent,
    ] {
        if *handle != 0 {
            api.close(*handle);
            *handle = 0;
        }
    }
}
fn start(api: &mut impl Api, config: &Config) -> Result<State> {
    let mut state = State::default();
    let result = (|| {
        state.parent = api.pin_parent(config)?;
        if !api.control_owner(state.parent)? {
            return Err(error("control-owner"));
        }
        state.job = api.create_job()?;
        api.configure_job(state.job)?;
        (state.process, state.thread) = api.create_process(state.job, config)?;
        if !api.in_job(state.process, state.job)? {
            return Err(error("job-membership"));
        }
        if !api.parent_alive(state.parent) {
            return Err(error("parent-exited"));
        }
        api.resume(state.thread)?;
        Ok(())
    })();
    if let Err(err) = result {
        close(api, &mut state);
        return Err(err);
    }
    Ok(state)
}
fn stop(api: &mut impl Api, state: &mut State, request_stop: bool) -> Result<()> {
    state.stop_confirmed = false;
    if request_stop {
        api.terminate(state.job)?;
    }
    let deadline = api.now().saturating_add(2500);
    loop {
        if api.active(state.job)? == 0 {
            state.stop_confirmed = true;
            return Ok(());
        }
        api.delay();
        if api.now() >= deadline {
            return Err(error("query-job-exit"));
        }
    }
}

struct Native {
    pipe: Handle,
    clock: Instant,
}
impl Api for Native {
    fn pin_parent(&mut self, config: &Config) -> Result<usize> {
        let parent = pin(config.parent_pid)?;
        if format!("win32-filetime:{}", creation(parent.0)?) != config.parent_key
            || !alive(parent.0)
        {
            return Err(error("parent-identity"));
        }
        let raw = parent.0 as usize;
        std::mem::forget(parent);
        Ok(raw)
    }
    fn control_owner(&mut self, parent: usize) -> Result<bool> {
        let mut server = 0;
        unsafe {
            checked(
                GetNamedPipeServerProcessId(self.pipe.0, &mut server),
                "control-owner",
            )?;
            let pid = GetProcessId(parent as HANDLE);
            Ok(pid != 0 && pid == server && alive(parent as HANDLE))
        }
    }
    fn create_job(&mut self) -> Result<usize> {
        let job = Handle::new(unsafe { CreateJobObjectW(null(), null()) }, "create-job")?;
        let raw = job.0 as usize;
        std::mem::forget(job);
        Ok(raw)
    }
    fn configure_job(&mut self, job: usize) -> Result<()> {
        unsafe {
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            checked(
                SetInformationJobObject(
                    job as HANDLE,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const c_void,
                    size_of_val(&limits) as u32,
                ),
                "configure-job",
            )
        }
    }
    fn create_process(&mut self, job: usize, config: &Config) -> Result<(usize, usize)> {
        unsafe {
            let current = GetCurrentProcess();
            let mut duplicates = Vec::new();
            for kind in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
                let mut copy = null_mut();
                checked(
                    DuplicateHandle(
                        current,
                        GetStdHandle(kind),
                        current,
                        &mut copy,
                        0,
                        1,
                        DUPLICATE_SAME_ACCESS,
                    ),
                    "stdio-duplicate",
                )?;
                duplicates.push(Handle::new(copy, "stdio-duplicate")?);
            }
            // usize 配列で attribute list のアラインメントも確保する。
            let mut bytes = 0;
            InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut bytes);
            if bytes == 0 {
                return Err(error("process-attributes"));
            }
            let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
            let list = storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
            checked(
                InitializeProcThreadAttributeList(list, 2, 0, &mut bytes),
                "process-attributes",
            )?;
            struct Attributes(LPPROC_THREAD_ATTRIBUTE_LIST);
            impl Drop for Attributes {
                fn drop(&mut self) {
                    unsafe {
                        DeleteProcThreadAttributeList(self.0);
                    }
                }
            }
            let _attributes = Attributes(list);
            let jobs = [job as HANDLE];
            checked(
                UpdateProcThreadAttribute(
                    list,
                    0,
                    PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                    jobs.as_ptr() as *const c_void,
                    size_of_val(&jobs),
                    null_mut(),
                    null(),
                ),
                "atomic-job-list",
            )?;
            let handles: Vec<HANDLE> = duplicates.iter().map(|handle| handle.0).collect();
            checked(
                UpdateProcThreadAttribute(
                    list,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    handles.as_ptr() as *const c_void,
                    size_of_val(handles.as_slice()),
                    null_mut(),
                    null(),
                ),
                "handle-list",
            )?;
            let mut startup: STARTUPINFOEXW = zeroed();
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.hStdInput = handles[0];
            startup.StartupInfo.hStdOutput = handles[1];
            startup.StartupInfo.hStdError = handles[2];
            startup.lpAttributeList = list;
            let mut info: PROCESS_INFORMATION = zeroed();
            let mut command = config.command.clone();
            checked(
                CreateProcessW(
                    config.application.as_ptr(),
                    command.as_mut_ptr(),
                    null(),
                    null(),
                    1,
                    CREATE_NO_WINDOW
                        | EXTENDED_STARTUPINFO_PRESENT
                        | CREATE_UNICODE_ENVIRONMENT
                        | CREATE_SUSPENDED,
                    null(),
                    config.cwd.as_ptr(),
                    &startup.StartupInfo,
                    &mut info,
                ),
                "create-process",
            )?;
            Ok((info.hProcess as usize, info.hThread as usize))
        }
    }
    fn in_job(&mut self, process: usize, job: usize) -> Result<bool> {
        let mut inside = 0;
        unsafe {
            checked(
                IsProcessInJob(process as HANDLE, job as HANDLE, &mut inside),
                "job-membership",
            )?;
        }
        Ok(inside != 0)
    }
    fn parent_alive(&mut self, parent: usize) -> bool {
        alive(parent as HANDLE)
    }
    fn resume(&mut self, thread: usize) -> Result<()> {
        if unsafe { ResumeThread(thread as HANDLE) } == u32::MAX {
            Err(error("resume"))
        } else {
            Ok(())
        }
    }
    fn terminate(&mut self, job: usize) -> Result<()> {
        unsafe { checked(TerminateJobObject(job as HANDLE, 1), "terminate-job") }
    }
    fn active(&mut self, job: usize) -> Result<u32> {
        unsafe {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = zeroed();
            checked(
                QueryInformationJobObject(
                    job as HANDLE,
                    JobObjectBasicAccountingInformation,
                    &mut accounting as *mut _ as *mut c_void,
                    size_of_val(&accounting) as u32,
                    null_mut(),
                ),
                "query-job-exit",
            )?;
            Ok(accounting.ActiveProcesses)
        }
    }
    fn close(&mut self, handle: usize) {
        unsafe {
            CloseHandle(handle as HANDLE);
        }
    }
    fn now(&mut self) -> u64 {
        self.clock.elapsed().as_millis() as u64
    }
    fn delay(&mut self) {
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn connect(config: &Config) -> Result<Handle> {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let handle = unsafe {
            CreateFileW(
                config.pipe.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                0,
                null_mut(),
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            return Handle::new(handle, "control-connect");
        }
        let code = unsafe { GetLastError() };
        if ![ERROR_PIPE_BUSY, ERROR_FILE_NOT_FOUND].contains(&code) || Instant::now() >= deadline {
            return Err(error("control-connect"));
        }
        // WaitNamedPipe は pipe 未作成時に直ちに返るため、再試行の間隔を制限する。
        unsafe {
            WaitNamedPipeW(config.pipe.as_ptr(), 100);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn send(pipe: HANDLE, value: Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(&value).map_err(|_| error("control-write"))?;
    bytes.push(b'\n');
    let mut offset = 0;
    while offset < bytes.len() {
        let mut count = 0;
        unsafe {
            checked(
                WriteFile(
                    pipe,
                    bytes[offset..].as_ptr(),
                    (bytes.len() - offset) as u32,
                    &mut count,
                    null_mut(),
                ),
                "control-write",
            )?;
        }
        if count == 0 {
            return Err(error("control-write"));
        }
        offset += count as usize;
    }
    Ok(())
}
// 親の最初の行・EOF・異常はすべて停止要求。未完の行では待機する。
fn control_closed(pipe: HANDLE) -> bool {
    unsafe {
        let mut available = 0;
        if PeekNamedPipe(pipe, null_mut(), 0, null_mut(), &mut available, null_mut()) == 0 {
            return true;
        }
        if available == 0 {
            return false;
        }
        let mut bytes = [0u8; 1024];
        let mut count = 0;
        let length = available.min(bytes.len() as u32);
        if ReadFile(pipe, bytes.as_mut_ptr(), length, &mut count, null_mut()) == 0 || count == 0 {
            return true;
        }
        bytes[..count as usize].contains(&b'\n')
    }
}
pub fn run_supervisor() -> Result<i32> {
    let config = bootstrap()?;
    let mut api = Native {
        pipe: connect(&config)?,
        clock: Instant::now(),
    };
    let mut state = start(&mut api, &config)?;
    let result = (|| {
        send(api.pipe.0, json!({"nonce": config.nonce, "state": "ready"}))?;
        let mut exit_code = 1u32;
        loop {
            let waited = unsafe { WaitForSingleObject(state.process as HANDLE, 0) };
            if waited == WAIT_FAILED {
                return Err(error("process-wait"));
            }
            if waited == WAIT_OBJECT_0 {
                unsafe {
                    checked(
                        GetExitCodeProcess(state.process as HANDLE, &mut exit_code),
                        "exit-code",
                    )?;
                }
                let remaining = api.active(state.job)? != 0;
                stop(&mut api, &mut state, remaining)?;
                break;
            }
            if !api.parent_alive(state.parent) || control_closed(api.pipe.0) {
                stop(&mut api, &mut state, true)?;
                break;
            }
            api.delay();
        }
        if state.stop_confirmed {
            send(
                api.pipe.0,
                json!({"nonce": config.nonce, "state": "stopped", "exitCode": exit_code}),
            )?;
        }
        Ok(exit_code as i32)
    })();
    close(&mut api, &mut state);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct Fake {
        fail: &'static str,
        events: Vec<String>,
        clock: u64,
    }
    impl Fake {
        fn event(&mut self, name: &str, handle: usize) {
            self.events.push(format!("{name}:{handle}"));
        }
        fn check(&self, name: &str) -> Result<()> {
            if self.fail == name {
                Err(error(name))
            } else {
                Ok(())
            }
        }
    }
    impl Api for Fake {
        fn pin_parent(&mut self, _: &Config) -> Result<usize> {
            self.check("parent-identity")?;
            Ok(101)
        }
        fn control_owner(&mut self, parent: usize) -> Result<bool> {
            self.event("control-owner", parent);
            Ok(self.fail != "control-owner")
        }
        fn create_job(&mut self) -> Result<usize> {
            Ok(202)
        }
        fn configure_job(&mut self, job: usize) -> Result<()> {
            self.event("configure-job", job);
            self.check("job-configuration")
        }
        fn create_process(&mut self, job: usize, _: &Config) -> Result<(usize, usize)> {
            self.event("create-atomic", job);
            self.check("atomic-create")?;
            Ok((303, 404))
        }
        fn in_job(&mut self, _: usize, job: usize) -> Result<bool> {
            self.event("in-job", job);
            Ok(self.fail != "membership")
        }
        fn parent_alive(&mut self, parent: usize) -> bool {
            self.event("parent-alive", parent);
            self.fail != "parent-exited"
        }
        fn resume(&mut self, thread: usize) -> Result<()> {
            self.check("resume")?;
            self.event("resume", thread);
            Ok(())
        }
        fn terminate(&mut self, job: usize) -> Result<()> {
            self.event("terminate-job", job);
            self.check("termination-failed")
        }
        fn active(&mut self, job: usize) -> Result<u32> {
            self.event("query-active", job);
            self.check("query-failed")?;
            Ok(u32::from(self.fail == "still-active"))
        }
        fn close(&mut self, handle: usize) {
            self.event("close", handle);
        }
        fn now(&mut self) -> u64 {
            self.clock += 1000;
            self.clock
        }
        fn delay(&mut self) {}
    }
    fn config() -> Config {
        Config::parse(br#"{"ParentPid":123,"ParentStartKey":"win32-filetime:456","ApplicationName":"fake","CommandLine":"fake","Cwd":"C:\\mock","PipeName":"fake","Nonce":"secret"}"#).unwrap()
    }
    #[test]
    fn startup_boundaries_fail_closed() {
        for boundary in [
            "parent-identity",
            "control-owner",
            "job-configuration",
            "atomic-create",
            "membership",
            "parent-exited",
            "resume",
        ] {
            let mut api = Fake {
                fail: boundary,
                ..Fake::default()
            };
            assert!(start(&mut api, &config()).is_err(), "{boundary}");
            assert!(
                !api.events.iter().any(|event| event.starts_with("resume:")),
                "{boundary}"
            );
            if ["parent-identity", "control-owner", "job-configuration"].contains(&boundary) {
                assert!(!api
                    .events
                    .iter()
                    .any(|event| event.starts_with("create-atomic:")));
            }
            if !["parent-identity", "control-owner"].contains(&boundary) {
                assert!(api.events.contains(&"close:202".into()));
            }
            if ["membership", "parent-exited", "resume"].contains(&boundary) {
                assert!(api.events.ends_with(&[
                    "close:404".into(),
                    "close:303".into(),
                    "close:202".into(),
                    "close:101".into()
                ]));
            }
        }
    }
    #[test]
    fn resumes_after_checks_and_confirms_same_job_empty() {
        let mut api = Fake::default();
        let mut state = start(&mut api, &config()).unwrap();
        stop(&mut api, &mut state, true).unwrap();
        assert!(state.stop_confirmed);
        close(&mut api, &mut state);
        let position = |name| api.events.iter().position(|event| event == name).unwrap();
        assert!(position("create-atomic:202") < position("in-job:202"));
        assert!(position("in-job:202") < position("parent-alive:101"));
        assert!(position("parent-alive:101") < position("resume:404"));
        assert!(position("terminate-job:202") < position("query-active:202"));
        assert!(api.events.contains(&"close:202".into()));
    }
    #[test]
    fn stop_failure_never_confirms() {
        for boundary in ["query-failed", "still-active", "termination-failed"] {
            let mut api = Fake::default();
            let mut state = start(&mut api, &config()).unwrap();
            state.stop_confirmed = true;
            api.fail = boundary;
            assert!(stop(&mut api, &mut state, true).is_err());
            assert!(!state.stop_confirmed);
            close(&mut api, &mut state);
        }
    }
    #[test]
    fn malformed_bootstrap_has_no_secret_diagnostics() {
        for bytes in [
            b"secret".as_slice(),
            b"\xffsecret".as_slice(),
            br#"{"Nonce":"secret"}"#.as_slice(),
        ] {
            assert!(!Config::parse(bytes).err().unwrap().contains("secret"));
        }
    }
    #[test]
    fn api_failure_reports_numeric_error_but_validation_does_not() {
        let mut time: FILETIME = unsafe { zeroed() };
        let mut exited: FILETIME = unsafe { zeroed() };
        let mut kernel: FILETIME = unsafe { zeroed() };
        let mut user: FILETIME = unsafe { zeroed() };
        let failure = checked(
            unsafe { GetProcessTimes(null_mut(), &mut time, &mut exited, &mut kernel, &mut user) },
            "parent-identity",
        )
        .unwrap_err();
        assert_eq!(failure, format!(
            "Windows owned Grok agent supervisor failed at parent-identity (Win32 {ERROR_INVALID_HANDLE})."
        ));
        // 直前の OS エラーを、入力検証の失敗へ誤って付加しない。
        assert_eq!(
            wide("secret\0").unwrap_err(),
            "Windows owned Grok agent supervisor failed at bootstrap-fields."
        );
        assert!(checked(1, "parent-identity").is_ok());
    }
}
