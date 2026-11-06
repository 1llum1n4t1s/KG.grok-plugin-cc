//! Windows 作業ツリーを、固定したディレクトリと同一ファイルハンドルから読む。
use std::collections::HashSet;
use std::io::{Read, Write};

use serde_json::{json, Value};

const ERROR: &str = "Working tree snapshot reader could not establish a complete safe snapshot.";
const MAX_FILES: usize = 2000;
const MAX_BYTES: usize = 8 * 1024 * 1024;
// JSON エスケープを含む最大 2000 * 30000 UTF-16 単位の要求を収容する。
const MAX_REQUEST: u64 = 360_100_000;

fn invalid<T>() -> Result<T, String> {
    Err(ERROR.to_owned())
}

fn validate_paths(value: &Value) -> Result<Vec<String>, String> {
    let values = value.as_array().ok_or(ERROR)?;
    if values.len() > MAX_FILES {
        return invalid();
    }
    let mut names = HashSet::new();
    let mut paths = Vec::with_capacity(values.len());
    for value in values {
        let name = value.as_str().ok_or(ERROR)?;
        if name.is_empty()
            || name.encode_utf16().count() > 30000
            || name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}' || "\\:".contains(c))
            || name.split('/').any(|part| !valid_component(part, true))
            || !names.insert(name.to_lowercase())
        {
            return invalid();
        }
        paths.push(name.to_owned());
    }
    Ok(paths)
}

fn valid_component(part: &str, reject_git: bool) -> bool {
    if part.is_empty()
        || part.encode_utf16().count() > 255
        || part == "."
        || part == ".."
        || part.ends_with(['.', ' '])
        || part.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}' || "\\/:<>\"|?*".contains(c))
        || (reject_git && part.eq_ignore_ascii_case(".git"))
    {
        return false;
    }
    let stem = part.split('.').next().unwrap_or("").to_ascii_lowercase();
    !(matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9')))
}

/// 一つの UTF-8 JSON 要求を読み、成功時だけ完全な応答を出力する。
pub fn run() -> Result<(), String> {
    let mut input = Vec::new();
    std::io::stdin().lock().take(MAX_REQUEST + 1).read_to_end(&mut input).map_err(|_| ERROR)?;
    if input.len() as u64 > MAX_REQUEST {
        return invalid();
    }
    let request: Value = serde_json::from_slice(&input).map_err(|_| ERROR)?;
    let root = request.get("root").and_then(Value::as_str).ok_or(ERROR)?;
    let paths = validate_paths(request.get("paths").ok_or(ERROR)?)?;
    #[cfg(windows)]
    {
        let snapshot = windows::snapshot(root, &paths)?;
        let response = json!({ "version": 1, "files": snapshot.entries });
        let mut stdout = std::io::stdout().lock();
        serde_json::to_writer(&mut stdout, &response).map_err(|_| ERROR)?;
        stdout.write_all(b"\n").map_err(|_| ERROR)?;
        stdout.flush().map_err(|_| ERROR)?;
        // snapshot のハンドルは JSON の出力が終了するまで保持する。
        drop(snapshot);
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (root, paths);
        invalid()
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use base64::Engine;
    use std::collections::HashMap;
    use std::fs::File;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::ptr::{null, null_mut};
    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::NtCreateFile;
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE, UNICODE_STRING};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetDriveTypeW, GetFileInformationByHandle, GetFileType,
        GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_TYPE_DISK, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    const READ: u32 = 0x8000_0000;
    const NAME_NOT_FOUND: i32 = 0xc000_0034u32 as i32;
    const OPEN_REPARSE: u32 = 0x0020_0000;
    const DIRECTORY: u32 = 1;
    const SYNCHRONOUS_NONALERT: u32 = 0x20;
    const SYNCHRONIZE: u32 = 0x0010_0000;

    pub(super) struct Snapshot {
        pub entries: Vec<Value>,
        _directories: Vec<OwnedHandle>,
        _files: Vec<File>,
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    fn information(handle: HANDLE) -> Result<BY_HANDLE_FILE_INFORMATION, String> {
        let mut info = unsafe { zeroed() };
        if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0 {
            return invalid();
        }
        Ok(info)
    }

    fn final_path(handle: HANDLE, buffer: &mut [u16]) -> Result<&[u16], String> {
        let length = unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) };
        if length == 0 || length as usize >= buffer.len() {
            return invalid();
        }
        let buffer = &buffer[..length as usize];
        if buffer.len() < 7 || buffer[..4] != [92, 92, 63, 92]
            || !matches!(buffer[4], 65..=90 | 97..=122) || buffer[5..7] != [58, 92]
        {
            return invalid();
        }
        Ok(buffer)
    }

    // OBJ_CASE_INSENSITIVE を付けず、単一成分を固定した親から解決する。
    fn open_relative(parent: HANDLE, component: &str, directory: bool) -> Result<Option<OwnedHandle>, String> {
        if !valid_component(component, false) {
            return invalid();
        }
        let mut name = wide(component);
        let unicode = UNICODE_STRING {
            Length: ((name.len() - 1) * 2) as u16,
            MaximumLength: (name.len() * 2) as u16,
            Buffer: name.as_mut_ptr(),
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: parent,
            ObjectName: &unicode,
            Attributes: 0,
            SecurityDescriptor: null_mut(),
            SecurityQualityOfService: null_mut(),
        };
        let mut io: IO_STATUS_BLOCK = unsafe { zeroed() };
        let mut raw: HANDLE = null_mut();
        let options = OPEN_REPARSE | if directory { DIRECTORY } else { SYNCHRONOUS_NONALERT };
        // 同期 I/O は GENERIC_READ に加え SYNCHRONIZE の明示指定が必要。
        let access = READ | if directory { 0 } else { SYNCHRONIZE };
        let status = unsafe { NtCreateFile(&mut raw, access, &attributes, &mut io, null(), 0, FILE_SHARE_READ, 1, options, null(), 0) };
        let handle = if raw.is_null() || raw == INVALID_HANDLE_VALUE { None } else {
            Some(unsafe { OwnedHandle::from_raw_handle(raw) })
        };
        if status == NAME_NOT_FOUND {
            drop(handle);
            return Ok(None);
        }
        if status != 0 || handle.is_none() {
            return invalid();
        }
        Ok(handle)
    }

    fn check_directory(handle: HANDLE, expected: &str, scratch: &mut [u16]) -> Result<(), String> {
        let info = information(handle)?;
        if info.dwFileAttributes & 0x410 != 0x10 {
            return invalid();
        }
        let mut actual = final_path(handle, scratch)?;
        while actual.last() == Some(&92) { actual = &actual[..actual.len() - 1]; }
        let expected: Vec<u16> = format!("\\\\?\\{}", expected.trim_end_matches('\\')).encode_utf16().collect();
        if actual != expected { return invalid(); }
        Ok(())
    }

    pub(super) fn snapshot(requested_root: &str, paths: &[String]) -> Result<Snapshot, String> {
        let root = requested_root.trim_end_matches('\\');
        let bytes = root.as_bytes();
        if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':'
            || (bytes.len() != 2 && bytes.get(2) != Some(&b'\\'))
            || requested_root.encode_utf16().count() > 30000
        {
            return invalid();
        }
        // C: は drive-relative なので、元の要求が C:\ であることも確認する。
        if requested_root.as_bytes().get(2) != Some(&b'\\') { return invalid(); }
        let drive = format!("{}\\", &root[..2]);
        if unsafe { GetDriveTypeW(wide(&drive).as_ptr()) } != 3 { return invalid(); }
        let raw = unsafe { CreateFileW(wide(&drive).as_ptr(), READ, FILE_SHARE_READ, null(), OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, null_mut()) };
        if raw.is_null() || raw == INVALID_HANDLE_VALUE { return invalid(); }
        let first = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut scratch = vec![0; 32768];
        check_directory(first.as_raw_handle(), &drive, &mut scratch)?;
        let mut directories = vec![first];
        let mut location = drive.trim_end_matches('\\').to_owned();
        if root.len() > 2 {
            for component in root[3..].split('\\') {
                if !valid_component(component, false) { return invalid(); }
                let parent = directories.last().ok_or(ERROR)?.as_raw_handle();
                let handle = open_relative(parent, component, true)?.ok_or(ERROR)?;
                location.push('\\');
                location.push_str(component);
                check_directory(handle.as_raw_handle(), &location, &mut scratch)?;
                directories.push(handle);
            }
        }
        let root_index = directories.len() - 1;
        let prefix = format!("\\\\?\\{}\\", location);
        let mut cache = HashMap::new();
        cache.insert(location.clone(), root_index);
        let mut entries = Vec::with_capacity(paths.len());
        let mut files = Vec::new();
        let mut total = 0usize;
        for relative in paths {
            let components: Vec<_> = relative.split('/').collect();
            let mut parent = location.clone();
            let mut parent_index = root_index;
            let mut missing = false;
            for component in &components[..components.len() - 1] {
                parent.push('\\');
                parent.push_str(component);
                if let Some(index) = cache.get(&parent) {
                    parent_index = *index;
                    continue;
                }
                let Some(handle) = open_relative(directories[parent_index].as_raw_handle(), component, true)? else {
                    missing = true;
                    break;
                };
                check_directory(handle.as_raw_handle(), &parent, &mut scratch)?;
                parent_index = directories.len();
                directories.push(handle);
                cache.insert(parent.clone(), parent_index);
            }
            if missing {
                entries.push(json!({"path": relative, "missing": true}));
                continue;
            }
            let handle = open_relative(directories[parent_index].as_raw_handle(), components.last().ok_or(ERROR)?, false)?;
            let Some(handle) = handle else {
                entries.push(json!({"path": relative, "missing": true}));
                continue;
            };
            let info = information(handle.as_raw_handle())?;
            if info.dwFileAttributes & 0x450 != 0 || info.nNumberOfLinks != 1
                || unsafe { GetFileType(handle.as_raw_handle()) } != FILE_TYPE_DISK
            { return invalid(); }
            let expected: Vec<u16> = format!("{}{}", prefix, relative.replace('/', "\\")).encode_utf16().collect();
            if final_path(handle.as_raw_handle(), &mut scratch)? != expected { return invalid(); }
            let length = ((info.nFileSizeHigh as u64) << 32) | info.nFileSizeLow as u64;
            if length > MAX_BYTES as u64 || total + length as usize > MAX_BYTES { return invalid(); }
            total += length as usize;
            let mut file = File::from(handle);
            let mut content = vec![0; length as usize];
            file.read_exact(&mut content).map_err(|_| ERROR)?;
            let mut extra = [0];
            if file.read(&mut extra).map_err(|_| ERROR)? != 0 { return invalid(); }
            let after = information(file.as_raw_handle())?;
            if after.nFileSizeHigh != info.nFileSizeHigh || after.nFileSizeLow != info.nFileSizeLow
                || final_path(file.as_raw_handle(), &mut scratch)? != expected
            { return invalid(); }
            entries.push(json!({"path": relative, "content": base64::engine::general_purpose::STANDARD.encode(content)}));
            files.push(file);
        }
        Ok(Snapshot { entries, _directories: directories, _files: files })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_hidden_git_ads_aliases_and_case_duplicates() {
        for paths in [json!(["a/.GiT/config"]), json!(["file:stream"]), json!(["dir./file"]),
            json!(["NUL.txt"]), json!(["a/../b"]), json!(["a", "A"]), json!(["a\\b"])] {
            assert!(validate_paths(&paths).is_err());
        }
        assert!(validate_paths(&json!(["src/file.txt", "missing/file.txt"])).is_ok());
        assert!(validate_paths(&json!(vec!["a"; MAX_FILES + 1])).is_err());
    }
}
