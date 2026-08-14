[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:ServerProcess = $null
$script:LauncherMutex = $null
$script:OwnsMutex = $false
$script:LogPath = $null
$script:RuntimeFile = $null
$script:ReopenRequestFile = $null
$script:ShutdownRequestFile = $null

function Show-LauncherError {
    param([Parameter(Mandatory = $true)][string]$Message)

    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Message, 0, 'Batch Translating', 16)
    } catch {
        # The launcher normally runs without a console. There is no safer
        # fallback when Windows Script Host is unavailable.
    }
}

function Get-LauncherDataDirectory {
    $localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrWhiteSpace($localData)) {
        $localData = [IO.Path]::GetTempPath()
    }
    return [IO.Path]::Combine($localData, 'Batch Translating')
}

function Write-LauncherLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO'
    )

    if ([string]::IsNullOrWhiteSpace($script:LogPath)) {
        return
    }

    $safeMessage = $Message
    $safeMessage = [regex]::Replace(
        $safeMessage,
        '(?i)(#token=)[^\s&]+',
        '$1[redacted]'
    )
    $safeMessage = [regex]::Replace(
        $safeMessage,
        '(?i)(authorization\s*[:=]\s*bearer\s+)[^\s,}]+',
        '$1[redacted]'
    )
    $safeMessage = [regex]::Replace(
        $safeMessage,
        '(?i)("?token"?\s*[:=]\s*"?)[^"\s,}]+',
        '$1[redacted]'
    )

    $stamp = [DateTimeOffset]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff zzz')
    $line = '{0} [{1}] {2}{3}' -f $stamp, $Level, $safeMessage, [Environment]::NewLine
    [IO.File]::AppendAllText($script:LogPath, $line, (New-Object Text.UTF8Encoding($false)))
}

function Quote-NativeArgument {
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    # Paths on Windows cannot contain a literal quote. The launcher only
    # constructs arguments from fixed switches and resolved filesystem paths.
    return '"{0}"' -f $Value.Replace('"', '\"')
}

function Resolve-KimiLaunchCommand {
    $appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $architecture = switch -Regex ([string]$env:PROCESSOR_ARCHITECTURE) {
        'ARM64' { 'arm64'; break }
        '86' { 'x86'; break }
        default { 'x64' }
    }

    $nativeCandidates = New-Object Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($env:BATCH_TRANSLATING_KIMI_EXE)) {
        $nativeCandidates.Add($env:BATCH_TRANSLATING_KIMI_EXE)
    }
    # Batch Translating ships the engine under its own name; `kimi.exe` stays
    # a dev-build fallback.
    $nativeCandidates.Add((Join-Path $PSScriptRoot 'batch-translating-engine.exe'))
    $nativeCandidates.Add((Join-Path $PSScriptRoot 'kimi.exe'))
    $nativeCandidates.Add((Join-Path (Split-Path -Parent $PSScriptRoot) 'kimi.exe'))
    $nativeCandidates.Add((Join-Path $appRoot 'kimi.exe'))
    $nativeCandidates.Add((Join-Path $appRoot ("dist-native\bin\win32-{0}\kimi.exe" -f $architecture)))

    foreach ($candidate in $nativeCandidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        $resolved = [IO.Path]::GetFullPath($candidate)
        if (Test-Path -LiteralPath $resolved -PathType Leaf) {
            return [pscustomobject]@{
                FileName = $resolved
                PrefixArguments = @()
                WorkingDirectory = Split-Path -Parent $resolved
            }
        }
    }

    $distEntry = Join-Path $appRoot 'dist\main.mjs'
    $node = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ((Test-Path -LiteralPath $distEntry -PathType Leaf) -and $null -ne $node) {
        return [pscustomobject]@{
            FileName = $node.Source
            PrefixArguments = @($distEntry)
            WorkingDirectory = $appRoot
        }
    }

    throw @'
The Batch Translating engine was not found.

Keep this launcher beside kimi.exe, install Kimi Code, or build apps/batch-translating-core first.
'@
}

function Start-ServerProcess {
    param([Parameter(Mandatory = $true)]$LaunchCommand)

    $arguments = @($LaunchCommand.PrefixArguments) + @(
        'web',
        '--no-open',
        '--host',
        '127.0.0.1',
        '--port',
        '58627',
        '--log-level',
        'info'
    )

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $LaunchCommand.FileName
    $startInfo.Arguments = (($arguments | ForEach-Object { Quote-NativeArgument ([string]$_) }) -join ' ')
    $startInfo.WorkingDirectory = $LaunchCommand.WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    if (-not $process.Start()) {
        throw 'The Batch Translating engine could not be started.'
    }
    return $process
}

function Find-ChromiumBrowser {
    param([ValidateSet('Auto', 'Edge', 'Chrome', 'Default')][string]$Preference)

    if ($Preference -eq 'Default') {
        return $null
    }

    $edgeCandidates = @()
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $edgeCandidates += Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $edgeCandidates += Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $edgeCandidates += Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'
    }

    $chromeCandidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $chromeCandidates += Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
    }
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $chromeCandidates += Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $chromeCandidates += Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'
    }

    $candidateGroups = if ($Preference -eq 'Chrome') {
        @($chromeCandidates, $edgeCandidates)
    } else {
        @($edgeCandidates, $chromeCandidates)
    }
    foreach ($group in $candidateGroups) {
        foreach ($candidate in $group) {
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }
    return $null
}

function Open-AppWindow {
    param([Parameter(Mandatory = $true)][string]$Url)

    $preference = 'Auto'
    if ($env:BATCH_TRANSLATING_BROWSER -match '^(?i:edge|chrome|default)$') {
        $preference = (Get-Culture).TextInfo.ToTitleCase($env:BATCH_TRANSLATING_BROWSER.ToLowerInvariant())
    }

    $browser = Find-ChromiumBrowser $preference
    if ($null -ne $browser) {
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $browser
        $startInfo.Arguments = Quote-NativeArgument ("--app={0}" -f $Url)
        $startInfo.UseShellExecute = $true
        [void][Diagnostics.Process]::Start($startInfo)
        return
    }

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Url
    $startInfo.UseShellExecute = $true
    [void][Diagnostics.Process]::Start($startInfo)
}

function Get-ReadyUrlFromLine {
    param([AllowNull()][string]$Line)

    if ($null -eq $Line) {
        return $null
    }
    $ansiPattern = [char]27 + '\[[0-9;]*m'
    $plain = [regex]::Replace($Line, $ansiPattern, '')
    $match = [regex]::Match($plain, 'Kimi server:\s+(https?://\S+)', 'IgnoreCase')
    if ($match.Success) {
        return $match.Groups[1].Value
    }
    return $null
}

function Get-SafeOrigin {
    param([Parameter(Mandatory = $true)][string]$Url)

    $uri = [Uri]$Url
    return $uri.GetLeftPart([UriPartial]::Authority)
}

function Get-TokenFromUrl {
    param([Parameter(Mandatory = $true)][string]$Url)

    $fragment = ([Uri]$Url).Fragment.TrimStart('#')
    foreach ($part in $fragment.Split('&')) {
        $pair = $part.Split('=', 2)
        if ($pair.Count -eq 2 -and $pair[0] -eq 'token') {
            return [Uri]::UnescapeDataString($pair[1])
        }
    }
    return $null
}

function Request-GracefulShutdown {
    param([Parameter(Mandatory = $true)][string]$ReadyUrl)

    $origin = Get-SafeOrigin $ReadyUrl
    $token = Get-TokenFromUrl $ReadyUrl
    $headers = @{}
    if (-not [string]::IsNullOrWhiteSpace($token)) {
        $headers['Authorization'] = 'Bearer {0}' -f $token
    }
    $request = @{
        Uri = "{0}/api/v1/shutdown" -f $origin
        Method = 'Post'
        Headers = $headers
        UseBasicParsing = $true
        TimeoutSec = 10
    }
    Invoke-WebRequest @request | Out-Null
}

function Write-RuntimeState {
    param(
        [Parameter(Mandatory = $true)][int]$ServerProcessId,
        [AllowNull()][string]$Origin
    )

    $state = [ordered]@{
        manager_pid = $PID
        server_pid = $ServerProcessId
        origin = $Origin
        started_at = [DateTimeOffset]::Now.ToString('o')
    }
    $json = $state | ConvertTo-Json -Depth 2
    [IO.File]::WriteAllText(
        $script:RuntimeFile,
        $json,
        (New-Object Text.UTF8Encoding($false))
    )
}

function Remove-ExactFile {
    param([AllowNull()][string]$Path)

    if (-not [string]::IsNullOrWhiteSpace($Path) -and (Test-Path -LiteralPath $Path)) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    }
}

try {
    $dataDirectory = Get-LauncherDataDirectory
    $logsDirectory = Join-Path $dataDirectory 'logs'
    [IO.Directory]::CreateDirectory($logsDirectory) | Out-Null
    $script:LogPath = Join-Path $logsDirectory ("launcher-{0}.log" -f [DateTime]::Now.ToString('yyyyMMdd'))
    $script:RuntimeFile = Join-Path $dataDirectory 'runtime.json'
    $script:ReopenRequestFile = Join-Path $dataDirectory 'reopen.request'
    $script:ShutdownRequestFile = Join-Path $dataDirectory 'shutdown.request'

    $script:LauncherMutex = New-Object Threading.Mutex($false, 'Local\BatchTranslating.Launcher')
    try {
        $script:OwnsMutex = $script:LauncherMutex.WaitOne(0, $false)
    } catch [Threading.AbandonedMutexException] {
        $script:OwnsMutex = $true
    }

    if (-not $script:OwnsMutex) {
        [IO.File]::WriteAllText(
            $script:ReopenRequestFile,
            [DateTimeOffset]::Now.ToString('o'),
            (New-Object Text.UTF8Encoding($false))
        )
        exit 0
    }

    Remove-ExactFile $script:ReopenRequestFile
    Remove-ExactFile $script:ShutdownRequestFile

    Write-LauncherLog 'Launcher started.'
    $launchCommand = Resolve-KimiLaunchCommand
    $script:ServerProcess = Start-ServerProcess $launchCommand
    Write-RuntimeState $script:ServerProcess.Id $null
    Write-LauncherLog ("Engine process started (PID {0})." -f $script:ServerProcess.Id)

    $stdoutTask = $script:ServerProcess.StandardOutput.ReadLineAsync()
    $stderrTask = $script:ServerProcess.StandardError.ReadLineAsync()
    $readyUrl = $null
    $openedAt = [DateTimeOffset]::MinValue
    $startupDeadline = [DateTimeOffset]::Now.AddSeconds(90)
    $shutdownRequested = $false

    while (-not $script:ServerProcess.HasExited) {
        if ($null -ne $stdoutTask -and $stdoutTask.IsCompleted) {
            $line = $stdoutTask.GetAwaiter().GetResult()
            if ($null -eq $line) {
                $stdoutTask = $null
            } else {
                $candidateUrl = Get-ReadyUrlFromLine $line
                if ($null -eq $readyUrl -and $null -ne $candidateUrl) {
                    $readyUrl = $candidateUrl
                    $origin = Get-SafeOrigin $readyUrl
                    Write-RuntimeState $script:ServerProcess.Id $origin
                    Write-LauncherLog ("Engine ready at {0}." -f $origin)
                    Open-AppWindow $readyUrl
                    $openedAt = [DateTimeOffset]::Now
                }
                Write-LauncherLog $line
                $stdoutTask = $script:ServerProcess.StandardOutput.ReadLineAsync()
            }
        }

        if ($null -ne $stderrTask -and $stderrTask.IsCompleted) {
            $line = $stderrTask.GetAwaiter().GetResult()
            if ($null -eq $line) {
                $stderrTask = $null
            } else {
                Write-LauncherLog $line 'WARN'
                $stderrTask = $script:ServerProcess.StandardError.ReadLineAsync()
            }
        }

        if (Test-Path -LiteralPath $script:ReopenRequestFile) {
            Remove-ExactFile $script:ReopenRequestFile
            if ($null -ne $readyUrl -and ([DateTimeOffset]::Now - $openedAt).TotalSeconds -ge 3) {
                Open-AppWindow $readyUrl
                $openedAt = [DateTimeOffset]::Now
                Write-LauncherLog 'Existing app window reopened.'
            }
        }

        if (-not $shutdownRequested -and (Test-Path -LiteralPath $script:ShutdownRequestFile)) {
            Remove-ExactFile $script:ShutdownRequestFile
            $shutdownRequested = $true
            Write-LauncherLog 'Graceful shutdown requested.'
            if ($null -ne $readyUrl) {
                try {
                    Request-GracefulShutdown $readyUrl
                } catch {
                    Write-LauncherLog ("Graceful shutdown request failed: {0}" -f $_.Exception.Message) 'WARN'
                }
            }
        }

        if ($null -eq $readyUrl -and [DateTimeOffset]::Now -gt $startupDeadline) {
            throw 'Batch Translating did not become ready within 90 seconds. See the launcher log for details.'
        }

        if ($shutdownRequested -and -not $script:ServerProcess.HasExited) {
            if (-not $script:ServerProcess.WaitForExit(10000)) {
                Write-LauncherLog 'Graceful shutdown timed out; stopping the owned engine process.' 'WARN'
                $script:ServerProcess.Kill()
            }
        }

        Start-Sleep -Milliseconds 50
    }

    Write-LauncherLog ("Engine exited with code {0}." -f $script:ServerProcess.ExitCode)
    # A zero exit code is a graceful shutdown (the workbench's "Exit app"
    # flow shuts the engine down through POST /shutdown); only a crash exit
    # is worth surfacing.
    if (-not $shutdownRequested -and $script:ServerProcess.ExitCode -ne 0) {
        throw ("Batch Translating stopped unexpectedly (exit code {0}). See {1}" -f $script:ServerProcess.ExitCode, $script:LogPath)
    }
} catch {
    $message = $_.Exception.Message
    Write-LauncherLog $message 'ERROR'
    if ($null -ne $script:ServerProcess -and -not $script:ServerProcess.HasExited) {
        try {
            $script:ServerProcess.Kill()
        } catch {
            Write-LauncherLog ("Could not stop the owned engine process: {0}" -f $_.Exception.Message) 'WARN'
        }
    }
    Show-LauncherError $message
    exit 1
} finally {
    Remove-ExactFile $script:RuntimeFile
    Remove-ExactFile $script:ReopenRequestFile
    Remove-ExactFile $script:ShutdownRequestFile
    if ($script:OwnsMutex -and $null -ne $script:LauncherMutex) {
        try {
            $script:LauncherMutex.ReleaseMutex()
        } catch {
            # Best effort during process shutdown.
        }
    }
    if ($null -ne $script:LauncherMutex) {
        $script:LauncherMutex.Dispose()
    }
}
