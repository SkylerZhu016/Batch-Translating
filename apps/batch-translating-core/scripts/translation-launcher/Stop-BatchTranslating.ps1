[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Show-Status {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [int]$Icon = 64
    )

    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Message, 5, 'Batch Translating', $Icon)
    } catch {
        # The stop helper normally runs without a console.
    }
}

$localData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($localData)) {
    $localData = [IO.Path]::GetTempPath()
}
$dataDirectory = [IO.Path]::Combine($localData, 'Batch Translating')
$runtimeFile = Join-Path $dataDirectory 'runtime.json'
$shutdownRequestFile = Join-Path $dataDirectory 'shutdown.request'

if (-not (Test-Path -LiteralPath $runtimeFile -PathType Leaf)) {
    Show-Status 'Batch Translating is not running.'
    exit 0
}

try {
    $state = Get-Content -LiteralPath $runtimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $manager = Get-Process -Id ([int]$state.manager_pid) -ErrorAction SilentlyContinue
    if ($null -eq $manager) {
        Show-Status 'Batch Translating is not running.'
        exit 0
    }

    [IO.Directory]::CreateDirectory($dataDirectory) | Out-Null
    [IO.File]::WriteAllText(
        $shutdownRequestFile,
        [DateTimeOffset]::Now.ToString('o'),
        (New-Object Text.UTF8Encoding($false))
    )
} catch {
    Show-Status ("Could not request shutdown: {0}" -f $_.Exception.Message) 16
    exit 1
}
