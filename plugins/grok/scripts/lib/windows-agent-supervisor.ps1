param()

# APIを注入できる境界にし、失敗経路は実プロセスを止めずに検証する。
function Close-GrokOwnedAgent($Api, $State) {
    foreach ($name in @('Thread', 'Process', 'Job', 'Parent')) {
        if ($State[$name] -and $State[$name] -ne [IntPtr]::Zero) {
            & $Api.CloseHandle $State[$name]
            $State[$name] = [IntPtr]::Zero
        }
    }
}

function Start-GrokOwnedAgent($Api, $Config) {
    $state = @{ Parent = [IntPtr]::Zero; Job = [IntPtr]::Zero; Process = [IntPtr]::Zero; Thread = [IntPtr]::Zero; StopConfirmed = $false }
    try {
        $state.Parent = & $Api.PinParent $Config.ParentPid $Config.ParentStartKey
        if (-not (& $Api.ControlOwnerMatches $state.Parent $Config.ControlHandle)) { throw 'Control pipe owner does not match the pinned parent.' }
        $state.Job = & $Api.CreateJob
        & $Api.ConfigureJob $state.Job
        # CreateProcess内のJobList属性で、最初の命令より前から必ずこのJobに所属する。
        $created = & $Api.CreateProcess $state.Job $Config
        $state.Process = $created.Process
        $state.Thread = $created.Thread
        if (-not (& $Api.InJob $state.Process $state.Job)) { throw 'Agent job membership could not be verified.' }
        if (-not (& $Api.ParentAlive $state.Parent)) { throw 'Agent owner exited before startup.' }
        & $Api.Resume $state.Thread
        return $state
    } catch {
        Close-GrokOwnedAgent $Api $state
        throw
    }
}

function Stop-GrokOwnedAgent($Api, $State, [bool]$RequestStop) {
    $State.StopConfirmed = $false
    if ($RequestStop) { $script:GrokSupervisorStage = 'terminate-job'; & $Api.TerminateJob $State.Job }
    $deadline = (& $Api.Now) + 2500
    do {
        $script:GrokSupervisorStage = 'query-job-exit'
        if ((& $Api.ActiveProcesses $State.Job) -eq 0) {
            $State.StopConfirmed = $true
            return
        }
        & $Api.Delay 10
    } while ((& $Api.Now) -lt $deadline)
    throw 'Agent job exit could not be confirmed.'
}

function New-GrokNativeApi {
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName('GrokOwnedAgentNative')), [Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module = $assembly.DefineDynamicModule('Native')
    $builder = $module.DefineType('GrokOwnedAgentNative', 'Public, Sealed, Abstract')
    function Add-NativeMethod([string]$Name, [Type]$Return, [Type[]]$Arguments) {
        $method = $builder.DefinePInvokeMethod($Name, 'kernel32.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $Return, $Arguments, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
        $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
        $constructor = [Runtime.InteropServices.DllImportAttribute].GetConstructor(@([string]))
        # DllImport属性の再設定はDefinePInvokeMethodのCharSetも上書きする。
        $fields = [Reflection.FieldInfo[]]@('SetLastError', 'CharSet', 'CallingConvention', 'ExactSpelling', 'PreserveSig' | ForEach-Object { [Runtime.InteropServices.DllImportAttribute].GetField($_) })
        $attribute = New-Object Reflection.Emit.CustomAttributeBuilder($constructor, @('kernel32.dll'), $fields, @($true, [Runtime.InteropServices.CharSet]::Unicode, [Runtime.InteropServices.CallingConvention]::Winapi, $true, $true))
        $method.SetCustomAttribute($attribute)
    }
    $ptr = [IntPtr]; $ptrRef = $ptr.MakeByRefType(); $uint = [uint32]; $uintRef = $uint.MakeByRefType()
    Add-NativeMethod 'CreateJobObjectW' $ptr @($ptr, [string])
    Add-NativeMethod 'SetInformationJobObject' ([bool]) @($ptr, [int], $ptr, $uint)
    Add-NativeMethod 'QueryInformationJobObject' ([bool]) @($ptr, [int], $ptr, $uint, $ptr)
    Add-NativeMethod 'InitializeProcThreadAttributeList' ([bool]) @($ptr, [int], $uint, $ptrRef)
    Add-NativeMethod 'UpdateProcThreadAttribute' ([bool]) @($ptr, $uint, $ptr, $ptr, $ptr, $ptr, $ptr)
    Add-NativeMethod 'DeleteProcThreadAttributeList' ([void]) @($ptr)
    Add-NativeMethod 'CreateProcessW' ([bool]) @([string], $ptr, $ptr, $ptr, [bool], $uint, $ptr, [string], $ptr, $ptr)
    Add-NativeMethod 'GetStdHandle' $ptr @([int])
    Add-NativeMethod 'GetCurrentProcess' $ptr @()
    Add-NativeMethod 'GetProcessId' $uint @($ptr)
    Add-NativeMethod 'GetNamedPipeServerProcessId' ([bool]) @($ptr, $uintRef)
    Add-NativeMethod 'DuplicateHandle' ([bool]) @($ptr, $ptr, $ptr, $ptrRef, $uint, [bool], $uint)
    Add-NativeMethod 'CloseHandle' ([bool]) @($ptr)
    Add-NativeMethod 'OpenProcess' $ptr @($uint, [bool], $uint)
    Add-NativeMethod 'GetProcessTimes' ([bool]) @($ptr, $ptr, $ptr, $ptr, $ptr)
    Add-NativeMethod 'WaitForSingleObject' $uint @($ptr, $uint)
    Add-NativeMethod 'GetExitCodeProcess' ([bool]) @($ptr, $uintRef)
    Add-NativeMethod 'ResumeThread' $uint @($ptr)
    Add-NativeMethod 'IsProcessInJob' ([bool]) @($ptr, $ptr, ([bool].MakeByRefType()))
    Add-NativeMethod 'TerminateJobObject' ([bool]) @($ptr, $uint)
    $native = $builder.CreateType()
    $marshal = [Runtime.InteropServices.Marshal]
    $pointerSize = [IntPtr]::Size
    $api = @{
        PinParent = {
            param($pidValue, $expected)
            if ($expected -notmatch '^win32-filetime:[0-9]+$') { throw 'A precise parent identity is required.' }
            $handle = $native::OpenProcess(0x101000, $false, [uint32]$pidValue)
            if ($handle -eq [IntPtr]::Zero) { throw 'Agent owner could not be pinned.' }
            $times = $marshal::AllocHGlobal(32)
            try {
                if (-not $native::GetProcessTimes($handle, $times, [IntPtr]::Add($times, 8), [IntPtr]::Add($times, 16), [IntPtr]::Add($times, 24))) { throw 'Agent owner identity is unavailable.' }
                $actual = 'win32-filetime:' + $marshal::ReadInt64($times).ToString([Globalization.CultureInfo]::InvariantCulture)
                if ($actual -cne $expected -or $native::WaitForSingleObject($handle, 0) -ne 258) { throw 'Agent owner identity changed.' }
                return $handle
            } catch {
                $null = $native::CloseHandle($handle)
                throw
            } finally { $marshal::FreeHGlobal($times) }
        }.GetNewClosure()
        ParentAlive = { param($handle) return $native::WaitForSingleObject($handle, 0) -eq 258 }.GetNewClosure()
        ControlOwnerMatches = {
            param($parentHandle, $pipeHandle)
            $serverPid = [uint32]0
            if (-not $native::GetNamedPipeServerProcessId($pipeHandle, [ref]$serverPid)) { throw 'Control pipe ownership is unavailable.' }
            $parentPid = $native::GetProcessId($parentHandle)
            return $parentPid -ne 0 -and $serverPid -eq $parentPid
        }.GetNewClosure()
        CreateJob = {
            $handle = $native::CreateJobObjectW([IntPtr]::Zero, $null)
            if ($handle -eq [IntPtr]::Zero) { throw 'Agent job could not be created.' }
            return $handle
        }.GetNewClosure()
        ConfigureJob = {
            param($job)
            $size = if ($pointerSize -eq 8) { 144 } else { 112 }
            $buffer = $marshal::AllocHGlobal($size)
            try {
                $marshal::Copy((New-Object byte[] $size), 0, $buffer, $size)
                # Jobを継承・breakaway可能にしない。worker/broker自身は所属させない。
                $marshal::WriteInt32($buffer, 16, 0x2000)
                if (-not $native::SetInformationJobObject($job, 9, $buffer, $size)) { throw 'Agent job limits could not be configured.' }
            } finally { $marshal::FreeHGlobal($buffer) }
        }.GetNewClosure()
        CreateProcess = {
            param($job, $configValue)
            $allocated = New-Object 'System.Collections.Generic.List[IntPtr]'
            $duplicates = New-Object 'System.Collections.Generic.List[IntPtr]'
            $attributeList = [IntPtr]::Zero
            $initialized = $false
            try {
                $bytes = [IntPtr]::Zero
                $null = $native::InitializeProcThreadAttributeList([IntPtr]::Zero, 2, 0, [ref]$bytes)
                if ($bytes.ToInt64() -le 0) { throw 'Process attribute lists are unavailable.' }
                $attributeList = $marshal::AllocHGlobal($bytes); $allocated.Add($attributeList)
                if (-not $native::InitializeProcThreadAttributeList($attributeList, 2, 0, [ref]$bytes)) { throw 'Process attributes could not be initialized.' }
                $initialized = $true
                $jobList = $marshal::AllocHGlobal($pointerSize); $allocated.Add($jobList)
                $marshal::WriteIntPtr($jobList, $job)
                # 対応しないOSではCreateProcessより前に失敗し、AssignJobへの代替はしない。
                if (-not $native::UpdateProcThreadAttribute($attributeList, 0, [IntPtr]0x2000D, $jobList, [IntPtr]$pointerSize, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Atomic process job assignment is unavailable on this Windows version.' }
                $current = $native::GetCurrentProcess()
                foreach ($kind in @(-10, -11, -12)) {
                    $copy = [IntPtr]::Zero
                    if (-not $native::DuplicateHandle($current, $native::GetStdHandle($kind), $current, [ref]$copy, 0, $true, 2)) { throw 'Agent standard handles could not be duplicated.' }
                    $duplicates.Add($copy)
                }
                $handleList = $marshal::AllocHGlobal(3 * $pointerSize); $allocated.Add($handleList)
                for ($i = 0; $i -lt 3; $i++) { $marshal::WriteIntPtr($handleList, $i * $pointerSize, $duplicates[$i]) }
                if (-not $native::UpdateProcThreadAttribute($attributeList, 0, [IntPtr]0x20002, $handleList, [IntPtr](3 * $pointerSize), [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Restricted handle inheritance is unavailable.' }
                $startupSize = if ($pointerSize -eq 8) { 112 } else { 72 }
                $startup = $marshal::AllocHGlobal($startupSize); $allocated.Add($startup)
                $marshal::Copy((New-Object byte[] $startupSize), 0, $startup, $startupSize)
                $marshal::WriteInt32($startup, $startupSize)
                $marshal::WriteInt32($startup, $(if ($pointerSize -eq 8) { 60 } else { 44 }), 0x100)
                $stdOffset = if ($pointerSize -eq 8) { 80 } else { 56 }
                for ($i = 0; $i -lt 3; $i++) { $marshal::WriteIntPtr($startup, $stdOffset + $i * $pointerSize, $duplicates[$i]) }
                $marshal::WriteIntPtr($startup, $startupSize - $pointerSize, $attributeList)
                $info = $marshal::AllocHGlobal(2 * $pointerSize + 8); $allocated.Add($info)
                $commandLine = $marshal::StringToHGlobalUni($configValue.CommandLine); $allocated.Add($commandLine)
                if (-not $native::CreateProcessW($configValue.ApplicationName, $commandLine, [IntPtr]::Zero, [IntPtr]::Zero, $true, 0x08080404, [IntPtr]::Zero, $configValue.Cwd, $startup, $info)) { throw 'Owned agent process creation failed.' }
                return @{ Process = $marshal::ReadIntPtr($info); Thread = $marshal::ReadIntPtr($info, $pointerSize) }
            } finally {
                if ($initialized) { $native::DeleteProcThreadAttributeList($attributeList) }
                foreach ($handle in $duplicates) { $null = $native::CloseHandle($handle) }
                foreach ($buffer in $allocated) { $marshal::FreeHGlobal($buffer) }
            }
        }.GetNewClosure()
        InJob = {
            param($processHandle, $job)
            $inside = $false
            if (-not $native::IsProcessInJob($processHandle, $job, [ref]$inside)) { throw 'Agent job membership query failed.' }
            return $inside
        }.GetNewClosure()
        Resume = { param($threadHandle) if ($native::ResumeThread($threadHandle) -eq [uint32]::MaxValue) { throw 'Agent could not be resumed.' } }.GetNewClosure()
        TerminateJob = { param($job) if (-not $native::TerminateJobObject($job, 1)) { throw 'Agent job termination failed.' } }.GetNewClosure()
        ActiveProcesses = {
            param($job)
            $buffer = $marshal::AllocHGlobal(48)
            try {
                if (-not $native::QueryInformationJobObject($job, 1, $buffer, 48, [IntPtr]::Zero)) { throw 'Agent job accounting is unavailable.' }
                return [uint32]$marshal::ReadInt32($buffer, 40)
            } finally { $marshal::FreeHGlobal($buffer) }
        }.GetNewClosure()
        RootExited = { param($handle) $wait = $native::WaitForSingleObject($handle, 0); if ($wait -eq [uint32]::MaxValue) { throw 'Agent process wait failed.' }; return $wait -eq 0 }.GetNewClosure()
        ExitCode = { param($handle) $code = [uint32]0; if (-not $native::GetExitCodeProcess($handle, [ref]$code)) { throw 'Agent exit code is unavailable.' }; return $code }.GetNewClosure()
        CloseHandle = { param($handle) $null = $native::CloseHandle($handle) }.GetNewClosure()
        Delay = { param($ms) Start-Sleep -Milliseconds $ms }
        Now = { return [Diagnostics.Stopwatch]::GetTimestamp() * 1000.0 / [Diagnostics.Stopwatch]::Frequency }
    }
    return $api
}

function Invoke-GrokWindowsSupervisor($Config) {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $script:GrokSupervisorStage = 'native-api'
    $api = New-GrokNativeApi
    $pipe = New-Object IO.Pipes.NamedPipeClientStream('.', $Config.PipeName, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
    $state = $null
    try {
        $script:GrokSupervisorStage = 'control-connect'
        $pipe.Connect(10000)
        $Config | Add-Member -NotePropertyName ControlHandle -NotePropertyValue $pipe.SafePipeHandle.DangerousGetHandle() -Force
        $writer = New-Object IO.StreamWriter($pipe, (New-Object Text.UTF8Encoding($false)), 1024, $true)
        $writer.AutoFlush = $true
        $reader = New-Object IO.StreamReader($pipe, (New-Object Text.UTF8Encoding($false)), $false, 1024, $true)
        $script:GrokSupervisorStage = 'agent-start'
        $state = Start-GrokOwnedAgent $api $Config
        $script:GrokSupervisorStage = 'ready'
        $writer.WriteLine((@{ nonce = $Config.Nonce; state = 'ready' } | ConvertTo-Json -Compress))
        $command = $reader.ReadLineAsync()
        $exitCode = 1
        while ($true) {
            $script:GrokSupervisorStage = 'monitor'
            if (& $api.RootExited $state.Process) {
                $exitCode = & $api.ExitCode $state.Process
                Stop-GrokOwnedAgent $api $state -RequestStop ((& $api.ActiveProcesses $state.Job) -ne 0)
                break
            }
            if (-not (& $api.ParentAlive $state.Parent) -or $command.IsCompleted) {
                # lifelineのEOF・異常・close命令はいずれもこのagent専用Jobだけを閉じる。
                Stop-GrokOwnedAgent $api $state -RequestStop $true
                break
            }
            & $api.Delay 10
        }
        $script:GrokSupervisorStage = 'stop-ack'
        if ($state.StopConfirmed) { $writer.WriteLine((@{ nonce = $Config.Nonce; state = 'stopped'; exitCode = $exitCode } | ConvertTo-Json -Compress)) }
        return $exitCode
    } finally {
        if ($null -ne $state) { Close-GrokOwnedAgent $api $state }
        $pipe.Dispose()
    }
}

function Read-GrokBootstrap {
    # Console.In/StreamReaderの先読みを使わず、長さと本文だけを匿名stdinから読む。
    # 親はready ACKまでACPを書かず、残りの同じhandleをagentへ継承する。
    $stream = [Console]::OpenStandardInput()
    $header = New-Object byte[] 4
    $offset = 0
    while ($offset -lt 4) {
        $count = $stream.Read($header, $offset, 4 - $offset)
        if ($count -le 0) { throw 'Bootstrap ended before its header.' }
        $offset += $count
    }
    $length = [BitConverter]::ToUInt32($header, 0)
    if ($length -eq 0 -or $length -gt 65536) { throw 'Invalid bootstrap length.' }
    $body = New-Object byte[] $length
    $offset = 0
    while ($offset -lt $length) {
        $count = $stream.Read($body, $offset, $length - $offset)
        if ($count -le 0) { throw 'Bootstrap ended before its body.' }
        $offset += $count
    }
    return (New-Object Text.UTF8Encoding($false, $true)).GetString($body) | ConvertFrom-Json
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $script:GrokSupervisorStage = 'bootstrap'
        $config = Read-GrokBootstrap
        $code = Invoke-GrokWindowsSupervisor $config
        exit $code
    } catch {
        # 依頼文や環境変数を診断へ転記しない。ACK欠落は呼出し側で未確認を維持する。
        [Console]::Error.WriteLine('Windows owned Grok agent supervisor failed at ' + $script:GrokSupervisorStage + ' (' + $_.Exception.GetType().FullName + ', HRESULT ' + $_.Exception.HResult + ').')
        exit 1
    }
}
