import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { formatCommandFailure, runCommand } from "./process.mjs";

const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;
const MAX_REPO_LISTING_ENTRIES = 2000;
const MAX_FINGERPRINT_TOTAL_BYTES = 8 * 1024 * 1024;

// 作業ツリー snapshot の境界。Git の filter を使わず、検証した同一 handle から読む。
// Windows 標準 PowerShell の Reflection.Emit だけを使い、compiler / temp を使わない。
const WINDOWS_SNAPSHOT_READER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$rootHandle = $null
$directoryHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
$fileHandles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
$protectedDirectories = [System.Collections.Generic.Dictionary[string,Microsoft.Win32.SafeHandles.SafeFileHandle]]::new([System.StringComparer]::Ordinal)
$openStreams = [System.Collections.Generic.List[System.IO.FileStream]]::new()
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    [Reflection.AssemblyName]::new('GrokSnapshotNative'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('Native')
  $infoBuilder = $module.DefineType('GrokFileInformation',
    [Reflection.TypeAttributes]'Public,Sealed,SequentialLayout', [ValueType])
  foreach ($field in @('dwFileAttributes', 'creationLow', 'creationHigh', 'accessLow', 'accessHigh',
    'writeLow', 'writeHigh', 'dwVolumeSerialNumber', 'nFileSizeHigh', 'nFileSizeLow',
    'nNumberOfLinks', 'nFileIndexHigh', 'nFileIndexLow')) {
    $null = $infoBuilder.DefineField($field, [uint32], [Reflection.FieldAttributes]::Public)
  }
  $infoType = $infoBuilder.CreateType()
  if ([Runtime.InteropServices.Marshal]::SizeOf([type]$infoType) -ne 52) { throw 'Unsupported structure layout' }
  $builder = $module.DefineType('GrokSnapshotKernel', [Reflection.TypeAttributes]'Public,Abstract,Sealed')
  $specifications = @(
    @{ Name = 'NtCreateFile'; Library = 'ntdll.dll'; Return = [int];
       Args = [type[]]@([IntPtr].MakeByRefType(), [uint32], [IntPtr], [IntPtr], [IntPtr],
         [uint32], [uint32], [uint32], [uint32], [IntPtr], [uint32]) },
    @{ Name = 'GetDriveTypeW'; Return = [uint32]; Args = [type[]]@([string]) },
    @{ Name = 'CreateFileW'; Return = [Microsoft.Win32.SafeHandles.SafeFileHandle];
       Args = [type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]) },
    @{ Name = 'GetFinalPathNameByHandleW'; Return = [uint32];
       Args = [type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle], [Text.StringBuilder], [uint32], [uint32]) },
    @{ Name = 'GetFileInformationByHandle'; Return = [bool];
       Args = [type[]]@([Microsoft.Win32.SafeHandles.SafeFileHandle], $infoType.MakeByRefType()) }
  )
  foreach ($specification in $specifications) {
    $method = $builder.DefineMethod($specification.Name,
      [Reflection.MethodAttributes]'Public,Static,PinvokeImpl', $specification.Return, $specification.Args)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    # invalid handle の理由を欠落と共有/権限エラーに区別するため、Win32 error を保存する。
    $attributeType = [Runtime.InteropServices.DllImportAttribute]
    $library = 'kernel32.dll'
    if ($specification.Library) { $library = $specification.Library }
    $attribute = [Reflection.Emit.CustomAttributeBuilder]::new(
      $attributeType.GetConstructor([type[]]@([string])), [object[]]@($library),
      [Reflection.FieldInfo[]]@($attributeType.GetField('SetLastError'), $attributeType.GetField('CharSet'),
        $attributeType.GetField('CallingConvention'), $attributeType.GetField('ExactSpelling')),
      [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode,
        [Runtime.InteropServices.CallingConvention]::Winapi, $true))
    $method.SetCustomAttribute($attribute)
    if ($specification.Name -eq 'CreateFileW') { $createNative = $method }
  }
  # Reflection.Invoke/PowerShell 自身が last-error を変更する前に、同じ IL 呼出しで保存する。
  $openWrapper = $builder.DefineMethod('OpenFile', [Reflection.MethodAttributes]'Public,Static',
    [Microsoft.Win32.SafeHandles.SafeFileHandle], [type[]]@([string], [uint32], [uint32], [IntPtr],
      [uint32], [uint32], [IntPtr], [int].MakeByRefType()))
  $il = $openWrapper.GetILGenerator()
  $null = $il.DeclareLocal([Microsoft.Win32.SafeHandles.SafeFileHandle])
  for ($argument = 0; $argument -lt 7; $argument++) { $il.Emit([Reflection.Emit.OpCodes]::Ldarg, [int16]$argument) }
  $il.Emit([Reflection.Emit.OpCodes]::Call, $createNative)
  $il.Emit([Reflection.Emit.OpCodes]::Stloc_0)
  $il.Emit([Reflection.Emit.OpCodes]::Ldarg, [int16]7)
  $il.Emit([Reflection.Emit.OpCodes]::Call, [Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error', [type[]]@()))
  $il.Emit([Reflection.Emit.OpCodes]::Stind_I4)
  $il.Emit([Reflection.Emit.OpCodes]::Ldloc_0)
  $il.Emit([Reflection.Emit.OpCodes]::Ret)
  $native = $builder.CreateType()
  $create = $native.GetMethod('CreateFileW')
  $finalMethod = $native.GetMethod('GetFinalPathNameByHandleW')
  $infoMethod = $native.GetMethod('GetFileInformationByHandle')
  $finalPathBuffer = [Text.StringBuilder]::new(32768)
  function FinalPath($handle) {
    $null = $finalPathBuffer.Clear()
    $length = $finalMethod.Invoke($null, @($handle, $finalPathBuffer, [uint32]32768, [uint32]0))
    if ($length -eq 0 -or $length -ge 32768) { throw 'Unavailable final path' }
    $value = $finalPathBuffer.ToString()
    if ($value -notmatch '^\\\\\?\\[A-Za-z]:\\') { throw 'Unsupported filesystem location' }
    return $value
  }
  function FileInformation($handle) {
    $arguments = [object[]]@($handle, [Activator]::CreateInstance($infoType))
    if (-not $infoMethod.Invoke($null, $arguments)) { throw 'Unavailable file information' }
    return $arguments[1]
  }
  function InfoField($info, $name) {
    $field = $infoType.GetField($name, [System.Reflection.BindingFlags]'Instance,Public,NonPublic')
    if ($null -eq $field) { throw 'Unsupported runtime' }
    return $field.GetValue($info)
  }
  function OpenRelativeDirectory($parentHandle, [string]$component) {
    # OBJECT_ATTRIBUTES.RootDirectory に保持済み parent handle を渡し、単一成分だけを開く。
    # 既存pathの再解決を介さず、NAME_NOT_FOUND をアクセス失敗と厳密に区別する。
    if ($component.Length -eq 0 -or $component.Length -gt 255 -or $component.Contains('\')) { throw 'Invalid component' }
    $namePointer = [IntPtr]::Zero
    $unicodePointer = [IntPtr]::Zero
    $attributesPointer = [IntPtr]::Zero
    $ioPointer = [IntPtr]::Zero
    try {
      $pointerSize = [IntPtr]::Size
      $unicodeBufferOffset = 4
      $attributesSize = 24
      if ($pointerSize -eq 8) { $unicodeBufferOffset = 8; $attributesSize = 48 }
      $unicodeSize = $unicodeBufferOffset + $pointerSize
      $namePointer = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($component)
      $unicodePointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($unicodeSize)
      $attributesPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($attributesSize)
      $ioPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($pointerSize * 2)
      $zeros = [byte[]]::new($attributesSize)
      [Runtime.InteropServices.Marshal]::Copy($zeros, 0, $unicodePointer, $unicodeSize)
      [Runtime.InteropServices.Marshal]::Copy($zeros, 0, $attributesPointer, $attributesSize)
      [Runtime.InteropServices.Marshal]::Copy($zeros, 0, $ioPointer, $pointerSize * 2)
      [Runtime.InteropServices.Marshal]::WriteInt16($unicodePointer, 0, [int16]($component.Length * 2))
      [Runtime.InteropServices.Marshal]::WriteInt16($unicodePointer, 2, [int16]($component.Length * 2 + 2))
      [Runtime.InteropServices.Marshal]::WriteIntPtr($unicodePointer, $unicodeBufferOffset, $namePointer)
      [Runtime.InteropServices.Marshal]::WriteInt32($attributesPointer, 0, $attributesSize)
      [Runtime.InteropServices.Marshal]::WriteIntPtr($attributesPointer, $pointerSize, $parentHandle.DangerousGetHandle())
      [Runtime.InteropServices.Marshal]::WriteIntPtr($attributesPointer, $pointerSize * 2, $unicodePointer)
      $arguments = [object[]]@([IntPtr]::Zero, [uint32]2147483648, $attributesPointer, $ioPointer,
        [IntPtr]::Zero, [uint32]0, [uint32]1, [uint32]1, [uint32]2097153, [IntPtr]::Zero, [uint32]0)
      $status = [int]$native.GetMethod('NtCreateFile').Invoke($null, $arguments)
      $handle = $null
      if ($arguments[0] -ne [IntPtr]::Zero) { $handle = [Microsoft.Win32.SafeHandles.SafeFileHandle]::new($arguments[0], $true) }
      if ($status -ne 0 -and $null -ne $handle) { $handle.Dispose(); $handle = $null }
      return @{ status = $status; handle = $handle }
    } finally {
      foreach ($pointer in @($namePointer, $unicodePointer, $attributesPointer, $ioPointer)) {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer) }
      }
    }
  }
  function ProtectDirectory([string]$location, $parentHandle, [string]$component, [bool]$allowMissing) {
    # OPEN_REPARSE_POINT で最終成分も追跡せず、属性検証を先に行う。
    if ($null -eq $parentHandle) {
      $handle = $create.Invoke($null, @($location, [uint32]2147483648, [uint32]1,
        [IntPtr]::Zero, [uint32]3, [uint32]35651584, [IntPtr]::Zero))
    } else {
      $opened = OpenRelativeDirectory $parentHandle $component
      # STATUS_OBJECT_NAME_NOT_FOUND のみ欠落。PATH_NOT_FOUND、ACCESS_DENIED、SHARING_VIOLATION は中止する。
      if ($opened.status -eq -1073741772 -and $allowMissing) { return $null }
      if ($opened.status -ne 0 -or $null -eq $opened.handle) { throw 'Unavailable relative directory handle' }
      $handle = $opened.handle
    }
    $directoryHandles.Add($handle)
    if ($handle.IsInvalid) { throw 'Unavailable directory handle' }
    $attributes = InfoField (FileInformation $handle) 'dwFileAttributes'
    if (($attributes -band 0x410) -ne 16) { throw 'Unsupported directory kind' }
    $expected = '\\?\' + $location.TrimEnd([char]92)
    $actual = (FinalPath $handle).TrimEnd([char]92)
    if (-not $actual.Equals($expected, [System.StringComparison]::Ordinal)) { throw 'Directory alias' }
    $protectedDirectories.Add($location, $handle)
    return $handle
  }
  # drive root から全祖先を順に保持し、祖先ごとの rename/reparse ABA も共有しない。
  # BACKUP_SEMANTICS で directory を開き、共有違反・権限不足なら snapshot 全体を中止する。
  $requestedRoot = [System.IO.Path]::GetFullPath([string]$request.root)
  if ($requestedRoot -notmatch '^[A-Za-z]:\\') { throw 'Unsupported root location' }
  if ($native.GetMethod('GetDriveTypeW').Invoke($null, @($requestedRoot.Substring(0, 3))) -ne 3) { throw 'Unsupported drive type' }
  $locations = [System.Collections.Generic.List[string]]::new()
  $location = $requestedRoot.Substring(0, 3)
  $locations.Add($location)
  foreach ($component in $requestedRoot.Substring(3).Split([char]92)) {
    if ($component.Length -eq 0) { continue }
    $location = [System.IO.Path]::Combine($location, $component)
    $locations.Add($location)
  }
  $previousHandle = $null
  foreach ($location in $locations) {
    $rootHandle = ProtectDirectory $location $previousHandle ([System.IO.Path]::GetFileName($location.TrimEnd([char]92))) $false
    $previousHandle = $rootHandle
  }
  $root = (FinalPath $rootHandle).TrimEnd([char]92)
  $prefix = $root + '\'
  $files = [System.Collections.Generic.List[object]]::new()
  [long]$total = 0
  foreach ($relative in $request.paths) {
      $parent = $requestedRoot
      $parentHandle = $rootHandle
      $parentMissing = $false
      $components = ([string]$relative).Split([char]47)
      for ($index = 0; $index -lt $components.Length - 1; $index++) {
        $parent = [System.IO.Path]::Combine($parent, $components[$index])
        if ($protectedDirectories.ContainsKey($parent)) { $parentHandle = $protectedDirectories[$parent] }
        else { $parentHandle = ProtectDirectory $parent $parentHandle $components[$index] $true }
        if ($null -eq $parentHandle) { $parentMissing = $true; break }
      }
      if ($parentMissing) { $files.Add(@{ path = [string]$relative; missing = $true }); continue }
      $filename = $prefix + ([string]$relative).Replace('/', '\')
      $openArguments = [object[]]@($filename, [uint32]2147483648, [uint32]1,
        [IntPtr]::Zero, [uint32]3, [uint32]2097152, [IntPtr]::Zero, [int]0)
      $fileHandle = $native.GetMethod('OpenFile').Invoke($null, $openArguments)
      $openError = [int]$openArguments[7]
      $fileHandles.Add($fileHandle)
      if ($fileHandle.IsInvalid) {
        if ($openError -eq 2) { $files.Add(@{ path = [string]$relative; missing = $true }); continue }
        throw 'Unavailable file handle'
      }
      $info = FileInformation $fileHandle
      $attributes = InfoField $info 'dwFileAttributes'
      if (($attributes -band 0x450) -ne 0 -or (InfoField $info 'nNumberOfLinks') -ne 1) { throw 'Unsupported file kind' }
      $final = FinalPath $fileHandle
      # case-sensitive directory の別名を受け入れないよう Ordinal で厳密に比較する。
      if (-not $final.StartsWith($prefix, [System.StringComparison]::Ordinal)) { throw 'File escaped root' }
      if (-not $final.Equals($filename, [System.StringComparison]::Ordinal)) { throw 'File alias or reparse point' }
      # FileShare.Read は既存 writer と両立せず、読取中の新規 writer/delete も拒否する。
      $stream = [System.IO.FileStream]::new($fileHandle, [System.IO.FileAccess]::Read)
      $openStreams.Add($stream)
      $length = $stream.Length
      $total += $length
      if ($length -gt 8388608 -or $total -gt 8388608) { throw 'Snapshot size limit' }
      $bytes = [byte[]]::new([int]$length)
      [int]$offset = 0
      while ($offset -lt $length) {
        $count = $stream.Read($bytes, $offset, [int]$length - $offset)
        if ($count -le 0) { throw 'Incomplete file read' }
        $offset += $count
      }
      if ($stream.ReadByte() -ne -1 -or $stream.Length -ne $length) { throw 'File changed during read' }
      if (-not (FinalPath $stream.SafeFileHandle).Equals($final, [System.StringComparison]::Ordinal)) { throw 'File moved during read' }
      $files.Add(@{ path = [string]$relative; content = [Convert]::ToBase64String($bytes) })
  }
  @{ version = 1; files = @($files.ToArray()) } | ConvertTo-Json -Compress -Depth 4
} catch {
  [Console]::Error.WriteLine('Working tree snapshot reader could not establish a complete safe snapshot.')
  exit 1
} finally {
  foreach ($stream in $openStreams) { $stream.Dispose() }
  foreach ($handle in $fileHandles) { $handle.Dispose() }
  foreach ($handle in $directoryHandles) { $handle.Dispose() }
}
`;

function validateSnapshotPaths(relativePaths) {
  const incomplete = () => incompleteSnapshot("cannot safely read the working tree snapshot.");
  if (!Array.isArray(relativePaths) || relativePaths.length > MAX_REPO_LISTING_ENTRIES) throw incomplete();
  const names = new Set();
  for (const name of relativePaths) {
    if (typeof name !== "string" || !name || name.length > 30000 || /[\\:\x00-\x1f\x7f]/.test(name)) throw incomplete();
    if (name.split("/").some((part) => !part || part === "." || part === ".." ||
      /[. ]$/.test(part) || /^\.git$/i.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw incomplete();
    const key = name.toLowerCase();
    if (names.has(key)) throw incomplete();
    names.add(key);
  }
}

export function readWindowsWorkingTreeFiles(repoRoot, relativePaths, options = {}) {
  validateSnapshotPaths(relativePaths);
  const incomplete = () => incompleteSnapshot("cannot safely read the working tree snapshot.");
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw incomplete();
  const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = runCommand(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_SNAPSHOT_READER], {
    shell: false, input: JSON.stringify({ root: path.resolve(repoRoot), paths: relativePaths }),
    timeout: gitLookupTimeout(options, 15000), maxBuffer: 12 * 1024 * 1024
  });
  if (result.error || result.signal || result.status !== 0) throw incomplete();
  let response;
  try { response = JSON.parse(result.stdout); } catch { throw incomplete(); }
  if (response?.version !== 1 || !Array.isArray(response.files) || response.files.length !== relativePaths.length) throw incomplete();
  const files = new Map();
  let total = 0;
  for (let index = 0; index < relativePaths.length; index += 1) {
    const entry = response.files[index];
    if (entry?.path !== relativePaths[index]) throw incomplete();
    if (entry.missing === true && entry.content === undefined) { files.set(entry.path, null); continue; }
    if (typeof entry.content !== "string" || entry.missing !== undefined) throw incomplete();
    const bytes = Buffer.from(entry.content, "base64");
    total += bytes.length;
    if (bytes.toString("base64") !== entry.content || total > MAX_FINGERPRINT_TOTAL_BYTES) throw incomplete();
    files.set(entry.path, bytes);
  }
  return files;
}

// spawnSync の maxBuffer 既定は 1MiB しかなく、数万ファイルのリポジトリでは
// `git ls-files` の出力がそれを超えて ENOBUFS で監査ごと落ちる。
// 一覧は表示前に MAX_REPO_LISTING_ENTRIES で切るので、取得側は広めに取る。
const MAX_FILE_LISTING_BYTES = 64 * 1024 * 1024;

// 子 Git にも継承される -c と環境フラグで、設定由来の外部実行を抑える。
// --submodule=diff の子 diff は表示フラグを継承しないため、別途扱う必要がある。
export const READ_ONLY_GIT_GLOBAL_ARGS = Object.freeze([
  "--no-pager", "--no-optional-locks", "--no-lazy-fetch",
  "-c", "core.fsmonitor=false", "-c", "log.showSignature=false",
  "-c", "format.pretty=medium", "-c", "log.diffMerges=off", "-c", "diff.submodule=short"
]);

function readOnlyGitArgs(args) {
  const [command, ...rest] = args;
  // status と作業ツリー比較は --no-textconv でも clean/process filter を実行する。
  // 設定の事前検査は TOCTOU を防げないため、危険な呼出し自体を開始しない。
  if (command === "status" || (command === "diff" &&
      !rest.includes("--cached") && !rest.some((arg) => /^[a-f0-9]{40,64}\.\.[a-f0-9]{40,64}$/.test(arg)))) {
    throw new Error("Review incomplete: cannot safely inspect the working tree because Git clean/process filters may execute external commands. Use an explicit branch comparison or repository scope.");
  }
  if (rest.includes("--submodule=diff")) {
    throw new Error("Review incomplete: inline submodule diffs may execute child Git textconv commands.");
  }
  // object 間 / cached の比較は oid_valid な内容を読む。Git の
  // reuse_worktree_file(..., want_file=0) は would_convert_to_git 時に再利用を拒否する。
  // want_file=1 側へ進ませないため、外部 diff と textconv は常に無効にする。
  const diffFlags = ["diff", "show", "log", "whatchanged"].includes(command)
    ? ["--no-ext-diff", "--no-textconv"] : [];
  return [...READ_ONLY_GIT_GLOBAL_ARGS, command, ...diffFlags, ...rest];
}

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  const result = runCommand("git", readOnlyGitArgs(args), {
    cwd, ...options, timeout: gitLookupTimeout(options), env: { ...process.env, ...options.env, LC_ALL: "C" }, shell: false
  });
  assertGitStarted(result, cwd);
  if (result.status !== 0 && /unknown option[^\r\n]*--no-lazy-fetch/.test(result.stderr)) {
    assertReadOnlyGitSupport(cwd, options);
  }
  return result;
}

function gitChecked(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(formatCommandFailure(result));
  return result;
}

function assertGitStarted(result, cwd) {
  if (result.error) {
    const code = "code" in result.error ? result.error.code : null;
    // 出力上限は呼出し元が軽量コンテキストへ切り替えるため、起動失敗にしない。
    if (code === "ENOBUFS") return;
    if (code === "ENOENT") {
      try {
        if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
      } catch {
        throw new Error("Unable to start Git: the working directory is unavailable.");
      }
      throw new Error("git is not installed. Install Git and retry.");
    }
    throw new Error(`Unable to start Git${code ? ` (${code})` : ""}: ${result.error.message}`);
  }
  if (result.signal) throw new Error(`Git was terminated by ${result.signal}.`);
}

function gitLookupTimeout(options, fallback = options.timeout) {
  if (options.deadline === undefined) return fallback;
  if (!Number.isFinite(options.deadline)) throw new TypeError("Git lookup deadline must be finite");
  const remaining = options.deadline - performance.now();
  if (remaining <= 0) throw new Error("Git lookup deadline expired");
  return Math.min(fallback ?? Infinity, Math.max(1, Math.ceil(remaining)));
}

function assertReadOnlyGitSupport(cwd, options = {}) {
  // 成功経路の追加 spawn と PATH/cwd をまたぐ能力キャッシュを避け、失敗時だけ
  // 同じ探索環境で実機能を調べる。repo/object を読まないため取得処理は起きない。
  const probe = runCommand("git", ["--no-pager", "--no-lazy-fetch", "--version"], {
    cwd, env: { ...process.env, ...options.env, LC_ALL: "C" }, shell: false, timeout: gitLookupTimeout(options, 10000)
  });
  assertGitStarted(probe, cwd);
  if (probe.status !== 0 && /unknown option[^\r\n]*--no-lazy-fetch/.test(probe.stderr)) {
    throw new Error("Git 2.45 or newer with --no-lazy-fetch support is required for read-only operations. Update Git and retry; automatic fetching remains disabled.");
  }
  if (probe.error || probe.status !== 0 || !/^git version \S+/m.test(probe.stdout)) {
    throw new Error(`Git capability check failed: ${formatCommandFailure(probe)}`);
  }
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function collectBoundedGitOutput(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOBUFS") {
    // 途中で切れた出力は再利用せず、強制インライン時だけ従来の取得へ戻す。
    return { bytes: maxBytes + 1, stdout: null };
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return { bytes: Buffer.byteLength(result.stdout, "utf8"), stdout: result.stdout };
}

function buildBranchComparison(cwd, baseRef) {
  const head = gitChecked(cwd, ["rev-parse", "--verify", "HEAD^{commit}"]).stdout.trim();
  const mergeBase = gitChecked(cwd, ["merge-base", head, baseRef]).stdout.trim();
  if (!/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(mergeBase)) {
    throw new Error("Review incomplete: unable to resolve immutable branch comparison objects.");
  }
  return {
    mergeBase,
    commitRange: `${mergeBase}..${head}`,
    reviewRange: `${baseRef}...HEAD`
  };
}

function assertCompleteBranchComparison(cwd, comparison) {
  // raw の object 比較は内容変換を行わない。モード変更・削除も両側で検査する。
  const result = gitChecked(cwd, ["diff", "--raw", "--no-renames", "-z", comparison.commitRange], {
    maxBuffer: MAX_FILE_LISTING_BYTES
  });
  const records = result.stdout.split("\0");
  for (let index = 0; index < records.length; index += 2) {
    const record = records[index];
    if (!record) continue;
    const match = /^:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [A-Z][0-9]*$/.exec(record);
    if (!match || records[index + 1] === undefined || !records[index + 1]) {
      throw new Error("Review incomplete: unable to validate the branch comparison file modes.");
    }
    if (match[1] === "160000" || match[2] === "160000") {
      throw new Error("Review incomplete: changed submodule contents cannot be safely collected without child Git textconv execution.");
    }
  }
}

/** @param {{ deadline?: number }} options */
export function ensureGitRepository(cwd, options = {}) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"], options);
  if (options.deadline !== undefined && performance.now() >= options.deadline) throw new Error("Git lookup deadline expired");
  if (result.error) throw new Error(`Git repository lookup failed: ${formatCommandFailure(result)}`);
  if (result.status !== 0) {
    assertReadOnlyGitSupport(cwd, options);
    if (options.deadline !== undefined && performance.now() >= options.deadline) throw new Error("Git lookup deadline expired");
    if (/^fatal: not a git repository(?:[ (:]|$)/m.test(result.stderr)) {
      throw Object.assign(new Error("This command must run inside a Git repository."), { code: "GROK_NOT_GIT_REPOSITORY" });
    }
    throw new Error(`Git repository lookup failed: ${formatCommandFailure(result)}`);
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return ensureGitRepository(cwd);
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  return collectWorkingTreeSnapshot(cwd).state;
}

function incompleteSnapshot(reason) {
  const guidance = process.platform === "win32" ? "" : " Working-tree reviews are unavailable on this platform. Use --scope branch or --base to review committed changes; uncommitted changes are excluded.";
  return new Error(`Review incomplete: ${reason}${guidance}`);
}

function nulRecords(output) {
  if (output && (!output.endsWith("\0") || output.includes("\ufffd"))) throw incompleteSnapshot("invalid or truncated path metadata.");
  return output ? output.slice(0, -1).split("\0") : [];
}

function workingTreeMetadata(repoRoot, options = {}) {
  const listing = { ...options, maxBuffer: MAX_FILE_LISTING_BYTES };
  const head = git(repoRoot, ["rev-parse", "--verify", "HEAD"], options);
  if (head.status !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head.stdout.trim())) throw incompleteSnapshot("unborn or unavailable HEAD is unsupported.");
  const objectFormat = gitChecked(repoRoot, ["rev-parse", "--show-object-format"], options).stdout.trim();
  if (!["sha1", "sha256"].includes(objectFormat)) throw incompleteSnapshot("unsupported object format.");
  const indexText = gitChecked(repoRoot, ["ls-files", "--stage", "-v", "-z"], listing).stdout;
  const headText = gitChecked(repoRoot, ["ls-tree", "-r", "-z", "HEAD"], listing).stdout;
  const untrackedText = gitChecked(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], listing).stdout;
  const config = git(repoRoot, ["config", "--null", "--get-regexp", "^core\\.(autocrlf|eol|filemode|symlinks|ignorestat)$"], listing);
  if (config.status !== 0 && !(config.status === 1 && !config.stdout && !config.stderr)) throw incompleteSnapshot("configuration metadata lookup failed.");
  let fileModeDisabled = false;
  let autoCrlf = false;
  for (const record of nulRecords(config.stdout)) {
    const [key, value, extra] = record.split("\n");
    if (extra !== undefined || value === undefined || !["core.autocrlf", "core.eol", "core.filemode", "core.symlinks", "core.ignorestat"].includes(key)) throw incompleteSnapshot("invalid configuration metadata.");
    if ((key === "core.autocrlf" && !["false", "true", "input"].includes(value)) ||
      (key === "core.eol" && value !== "lf") ||
      (["core.filemode", "core.ignorestat"].includes(key) && value !== "false")) throw incompleteSnapshot("unsupported working tree normalization or stat configuration.");
    if (key === "core.filemode" && value === "false") fileModeDisabled = true;
    if (key === "core.autocrlf") autoCrlf = value !== "false";
  }
  if (!fileModeDisabled) throw incompleteSnapshot("core.filemode must be explicitly false because executable mode cannot be observed safely.");
  const index = new Map();
  for (const record of nulRecords(indexText)) {
    const match = /^H (100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/.exec(record);
    if (!match || /^0+$/.test(match[2])) throw incompleteSnapshot("unsupported, unmerged, sparse, skip-worktree or submodule index entry.");
    if (index.has(match[3])) throw incompleteSnapshot("duplicate index path.");
    index.set(match[3], { mode: match[1], oid: match[2] });
  }
  const headFiles = new Map();
  for (const record of nulRecords(headText)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(record);
    if (!match || headFiles.has(match[3])) throw incompleteSnapshot("unsupported HEAD entry or submodule.");
    headFiles.set(match[3], { mode: match[1], oid: match[2] });
  }
  const untracked = nulRecords(untrackedText);
  const paths = listUniqueFiles([...index.keys()], untracked);
  validateSnapshotPaths(listUniqueFiles([...headFiles.keys()], paths));
  if (paths.length > MAX_REPO_LISTING_ENTRIES || new Set(untracked).size !== untracked.length || untracked.some((name) => index.has(name))) throw incompleteSnapshot("incomplete file inventory.");
  const attributes = gitChecked(repoRoot, ["check-attr", "--all", "-z", "--stdin"], {
    ...listing, input: paths.length ? `${paths.join("\0")}\0` : ""
  }).stdout;
  const attributeRecords = nulRecords(attributes);
  const rawPaths = new Set();
  if (attributeRecords.length % 3 !== 0) throw incompleteSnapshot("invalid attributes metadata.");
  for (let offset = 0; offset < attributeRecords.length; offset += 3) {
    if (["text", "crlf"].includes(attributeRecords[offset + 1]) && attributeRecords[offset + 2] === "unset") rawPaths.add(attributeRecords[offset]);
    if (["filter", "diff", "text", "eol", "crlf", "ident", "working-tree-encoding"].includes(attributeRecords[offset + 1]) &&
      !["unspecified", "unset"].includes(attributeRecords[offset + 2])) throw incompleteSnapshot("unsupported external conversion or normalization attribute.");
  }
  return { head: head.stdout.trim(), objectFormat, index, headFiles, untracked, paths, autoCrlf, rawPaths,
    indexIdentity: JSON.stringify([head.stdout, objectFormat, indexText, headText, config.stdout, attributes]),
    identity: JSON.stringify([head.stdout, objectFormat, indexText, headText, untrackedText, config.stdout, attributes]) };
}

function immutableBlob(repoRoot, oid, objectFormat, cache, options = {}) {
  if (cache.entries.has(oid)) return cache.entries.get(oid);
  const content = Buffer.from(gitChecked(repoRoot, ["cat-file", "blob", oid], {
    ...options, maxBuffer: MAX_FINGERPRINT_TOTAL_BYTES + 1024
  }).stdout, "utf8");
  const actual = createHash(objectFormat).update(`blob ${content.length}\0`).update(content).digest("hex");
  if (actual !== oid) throw incompleteSnapshot("blob content is not complete lossless UTF-8.");
  if (cache.totalBytes + content.length > MAX_FINGERPRINT_TOTAL_BYTES) throw incompleteSnapshot("immutable blob evidence exceeds the snapshot size limit.");
  cache.entries.set(oid, content);
  cache.totalBytes += content.length;
  return content;
}

function cleanOrdinaryAutoCrlf(bytes, indexedBytes) {
  // Git v2.55.0 convert.c: convert_attrs の AUTO、crlf_to_git、has_crlf_in_index。
  // UTF-8 の通常テキストだけを扱う。この範囲は gather_stats の nonprintable=0 なので
  // convert_is_binary=false と証明できる。混在改行・bare CR・index CRLF は未対応にする。
  const ordinaryText = (content) => {
    const text = content.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw incompleteSnapshot("unsupported binary or non-UTF-8 automatic line conversion.");
    return text;
  };
  const indexedText = ordinaryText(indexedBytes);
  if (indexedText.includes("\r")) throw incompleteSnapshot("unsupported CR or CRLF content in the existing index blob.");
  const text = ordinaryText(bytes);
  const withoutPairs = text.replace(/\r\n/g, "");
  if (withoutPairs.includes("\r") || (text.includes("\r\n") && withoutPairs.includes("\n"))) throw incompleteSnapshot("unsupported mixed or bare-CR automatic line conversion.");
  return text.includes("\r\n") ? Buffer.from(text.replace(/\r\n/g, "\n"), "utf8") : bytes;
}

function replacementPatch(name, before, after, oldMode = "100644", newMode = "100644") {
  if (before !== null && after !== null && before.equals(after) && oldMode === newMode) return "";
  for (const bytes of [before, after]) {
    if (bytes && (bytes.includes(0) || !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))) throw incompleteSnapshot("changed binary or non-UTF-8 content cannot be reviewed completely.");
  }
  const a = JSON.stringify(`a/${name}`);
  const b = JSON.stringify(`b/${name}`);
  const lines = [`diff --git ${a} ${b}`];
  if (before === null) lines.push(`new file mode ${newMode}`);
  else if (after === null) lines.push(`deleted file mode ${oldMode}`);
  else if (oldMode !== newMode) lines.push(`old mode ${oldMode}`, `new mode ${newMode}`);
  if (before !== null && after !== null && before.equals(after)) return `${lines.join("\n")}\n`;
  lines.push(`--- ${before === null ? "/dev/null" : a}`, `+++ ${after === null ? "/dev/null" : b}`);
  const contentLines = (bytes) => !bytes?.length ? [] : bytes.toString("utf8").replace(/\n$/, "").split("\n");
  const oldLines = contentLines(before);
  const newLines = contentLines(after);
  if (!oldLines.length && !newLines.length) return `${lines.slice(0, -2).join("\n")}\n`;
  lines.push(`@@ -${oldLines.length ? 1 : 0},${oldLines.length} +${newLines.length ? 1 : 0},${newLines.length} @@`);
  for (const [prefix, contents, bytes] of [["-", oldLines, before], ["+", newLines, after]]) {
    for (const line of contents) lines.push(`${prefix}${line}`);
    if (contents.length && bytes.at(-1) !== 10) lines.push("\\ No newline at end of file");
  }
  return `${lines.join("\n")}\n`;
}

export function collectWorkingTreeSnapshot(cwd, options = {}) {
  const checkDeadline = () => { if (options.deadline !== undefined) gitLookupTimeout(options); };
  const repoRoot = ensureGitRepository(cwd, options);
  const metadata = workingTreeMetadata(repoRoot, options);
  const files = readWindowsWorkingTreeFiles(repoRoot, metadata.paths, options);
  const confirmation = readWindowsWorkingTreeFiles(repoRoot, metadata.paths, options);
  if (metadata.paths.some((name) => files.get(name) === null ? confirmation.get(name) !== null :
    confirmation.get(name) === null || !files.get(name).equals(confirmation.get(name))) || metadata.untracked.some((name) => files.get(name) === null) ||
    workingTreeMetadata(repoRoot, options).identity !== metadata.identity) throw incompleteSnapshot("working tree or metadata changed during collection.");
  const staged = [];
  const unstaged = [];
  const blobs = { entries: new Map(), totalBytes: 0 };
  const cleanFiles = new Map(files);
  for (const name of listUniqueFiles([...metadata.headFiles.keys()], [...metadata.index.keys()])) {
    checkDeadline();
    const previous = metadata.headFiles.get(name);
    const indexed = metadata.index.get(name);
    if (previous?.oid !== indexed?.oid || previous?.mode !== indexed?.mode) staged.push(name);
    if (indexed) {
      let bytes = files.get(name);
      const blobOid = (content) => content === null ? null : createHash(metadata.objectFormat).update(`blob ${content.length}\0`).update(content).digest("hex");
      let actual = blobOid(bytes);
      // AUTO では binary は変換されず、index に同じ CRLF があれば変換も抑止される。
      // raw OID の一致は全ての accepted AUTO 属性で clean と証明でき、blob の UTF-8 解釈も不要。
      if (actual !== indexed.oid && bytes !== null && metadata.autoCrlf && !metadata.rawPaths.has(name)) {
        bytes = cleanOrdinaryAutoCrlf(bytes, immutableBlob(repoRoot, indexed.oid, metadata.objectFormat, blobs, options));
        cleanFiles.set(name, bytes);
        actual = blobOid(bytes);
      }
      if (actual !== indexed.oid) unstaged.push(name);
    }
  }
  const state = { staged, unstaged, untracked: metadata.untracked, isDirty: Boolean(staged.length || unstaged.length || metadata.untracked.length) };
  const fingerprint = createHash("sha256").update(metadata.identity);
  const entries = metadata.paths.flatMap((name) => {
    checkDeadline();
    const bytes = files.get(name);
    if (bytes === null) { fingerprint.update(`\0${name}\0missing\0`); return []; }
    fingerprint.update(`\0${name}\0${bytes.length}\0`).update(bytes);
    return [{ path: name, mode: metadata.index.get(name)?.mode ?? "100644", content: bytes.toString("base64") }];
  });
  // state/fingerprint は binary を含め全 byte を観測する。patch は必要な呼出元だけが生成する。
  const buildDiffs = () => {
    let stagedDiff = "";
    let unstagedDiff = "";
    for (const name of staged) {
      const previous = metadata.headFiles.get(name);
      const indexed = metadata.index.get(name);
      stagedDiff += replacementPatch(name, previous ? immutableBlob(repoRoot, previous.oid, metadata.objectFormat, blobs, options) : null,
        indexed ? immutableBlob(repoRoot, indexed.oid, metadata.objectFormat, blobs, options) : null, previous?.mode, indexed?.mode);
    }
    for (const name of unstaged) {
      const indexed = metadata.index.get(name);
      unstagedDiff += replacementPatch(name, immutableBlob(repoRoot, indexed.oid, metadata.objectFormat, blobs, options), cleanFiles.get(name), indexed.mode, indexed.mode);
    }
    return { stagedDiff, unstagedDiff };
  };
  checkDeadline();
  return { version: 1, fingerprint: fingerprint.digest("hex"),
    indexFingerprint: createHash("sha256").update(metadata.indexIdentity).digest("hex"),
    head: metadata.head, files: entries, state, buildDiffs };
}

export function captureWorkingTreeReviewSnapshot(cwd, options = {}) {
  const snapshot = collectWorkingTreeSnapshot(cwd);
  const { stagedDiff, unstagedDiff } = snapshot.buildDiffs();
  const untrackedPaths = new Set(snapshot.state.untracked);
  const untracked = snapshot.files.filter((file) => untrackedPaths.has(file.path)).map((file) =>
    replacementPatch(file.path, null, Buffer.from(file.content, "base64"), "100644", file.mode)).join("\n");
  const context = [formatSection("Staged Diff", stagedDiff), formatSection("Unstaged Diff", unstagedDiff),
    formatSection("Untracked Files", untracked)].join("\n");
  if (Buffer.byteLength(context) > normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes)) throw incompleteSnapshot("complete working tree evidence exceeds the inline size limit.");
  return { fingerprint: snapshot.fingerprint, context, complete: true, state: snapshot.state, files: snapshot.files };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const supportedScopes = new Set(["auto", "working-tree", "branch", "repo"]);

  if (requestedScope === "repo") {
    if (baseRef) {
      throw new Error("--base does not apply to --scope repo. A repository audit reviews the whole source, not a diff.");
    }
    return {
      mode: "repo",
      label: "full repository",
      explicit: true
    };
  }

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, repo, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (getWorkingTreeState(cwd).isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body : "(none)", ""].join("\n");
}

function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = options.changedFiles ?? gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            options.diffOutput ?? gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=short", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

function formatCappedListing(entries) {
  if (entries.length <= MAX_REPO_LISTING_ENTRIES) {
    return entries.join("\n");
  }
  const shown = entries.slice(0, MAX_REPO_LISTING_ENTRIES);
  return [...shown, `(+${entries.length - shown.length} more files - run \`git ls-files\` for the full list)`].join("\n");
}

// リポジトリ監査は差分を渡さない。棚卸し（ファイル一覧と直近ログ）だけを渡し、
// 中身は Grok が read-only コマンドで自分で読む前提にする。
function collectRepoContext(cwd) {
  const listingOptions = { maxBuffer: MAX_FILE_LISTING_BYTES };
  const trackedFiles = gitChecked(cwd, ["ls-files"], listingOptions).stdout.trim().split("\n").filter(Boolean);
  const untrackedFiles = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"], listingOptions)
    .stdout.trim()
    .split("\n")
    .filter(Boolean);
  const logOutput = git(cwd, ["log", "--oneline", "--decorate", "-n", "15"]).stdout.trim();

  return {
    mode: "repo",
    summary: `Auditing the full repository: ${trackedFiles.length} tracked and ${untrackedFiles.length} untracked file(s).`,
    content: [
      formatSection("Tracked Files", formatCappedListing(trackedFiles)),
      formatSection("Untracked Files", formatCappedListing(untrackedFiles)),
      formatSection("Recent Commits", logOutput)
    ].join("\n"),
    changedFiles: trackedFiles
  };
}

function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  const range = options.comparison?.commitRange;
  const command = range
    ? `git ${READ_ONLY_GIT_GLOBAL_ARGS.join(" ")} diff --no-ext-diff --no-textconv ${range}`
    : null;
  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings." +
    (command ? ` Use this fixed object comparison: ${command}. Put optional display flags after the range, and paths only after --. Do not substitute HEAD, branch names or extra revisions.` : "");
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "repo") {
    const repoDetails = collectRepoContext(repoRoot);
    return {
      cwd: repoRoot,
      repoRoot,
      branch: currentBranch,
      target,
      fileCount: repoDetails.changedFiles.length,
      diffBytes: 0,
      inputMode: "self-collect",
      collectionGuidance:
        "The repository context below is only a file inventory. Ignore the current uncommitted diff entirely and audit the source as it exists on disk, reading files yourself with read-only commands.",
      ...repoDetails
    };
  }

  if (target.mode === "working-tree") {
    const snapshot = captureWorkingTreeReviewSnapshot(repoRoot, { maxInlineDiffBytes });
    const state = snapshot.state;
    diffBytes = Buffer.byteLength(snapshot.context);
    includeDiff = true;
    details = {
      mode: "working-tree", fingerprint: snapshot.fingerprint,
      summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
      content: snapshot.context, changedFiles: listUniqueFiles(state.staged, state.unstaged, state.untracked)
    };
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    assertCompleteBranchComparison(repoRoot, comparison);
    const changedFiles = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
    const diffOutput = collectBoundedGitOutput(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=short", comparison.commitRange],
      maxInlineDiffBytes
    );
    diffBytes = diffOutput.bytes;
    includeDiff = options.includeDiff ?? (changedFiles.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison, changedFiles, diffOutput: diffOutput.stdout });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff, comparison: details.comparison }),
    ...details
  };
}
