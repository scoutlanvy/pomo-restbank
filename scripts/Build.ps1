param([string]$OutputDirectory, [string]$BuildDirectory)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist' }
if (-not $BuildDirectory) { $BuildDirectory = Join-Path $env:TEMP 'pomo-restbank-build-20261107' }
$env:CARGO_TARGET_DIR = [IO.Path]::GetFullPath($BuildDirectory)
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
function Copy-BuildExecutable {
    param([string]$Source, [string]$DestinationDirectory)
    $destination = Join-Path $DestinationDirectory (Split-Path $Source -Leaf)
    if ((Test-Path -LiteralPath $destination -PathType Leaf) -and
        ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -eq
         (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash)) {
        Write-Host "Already current: $destination"
        return
    }
    try {
        Copy-Item -LiteralPath $Source -Destination $destination -ErrorAction Stop
    } catch {
        throw "Cannot replace '$destination'. Close the client or server using this exact file, then rerun Build.ps1. No running process was stopped. $($_.Exception.Message)"
    }
}
Push-Location $projectRoot
try {
    & cargo build --release -p pomo-restbank-server
    if ($LASTEXITCODE -ne 0) { throw 'Server build failed.' }
    Push-Location (Join-Path $projectRoot 'desktop')
    try {
        & npm.cmd run tauri -- build
        if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed.' }
    } finally { Pop-Location }
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    Copy-BuildExecutable -Source (Join-Path $env:CARGO_TARGET_DIR 'release\pomo-restbank.exe') -DestinationDirectory $OutputDirectory
    Copy-BuildExecutable -Source (Join-Path $env:CARGO_TARGET_DIR 'release\pomo-restbank-server.exe') -DestinationDirectory $OutputDirectory
    Get-ChildItem -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\bundle\nsis') -Filter '*-setup.exe' -File | Copy-Item -Destination $OutputDirectory
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Start-PomoRestbank.ps1') -Destination $OutputDirectory
    Copy-Item -LiteralPath (Join-Path $projectRoot 'README.id.md') -Destination (Join-Path $OutputDirectory 'PETUNJUK.md')
    Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination $OutputDirectory
    Copy-Item -LiteralPath (Join-Path $projectRoot 'VALIDATION.md') -Destination $OutputDirectory
    $portableNames = @('pomo-restbank.exe','pomo-restbank-server.exe','Start-PomoRestbank.ps1','PETUNJUK.md','LICENSE','VALIDATION.md')
    $portablePaths = $portableNames | ForEach-Object { Join-Path $OutputDirectory $_ }
    Compress-Archive -LiteralPath $portablePaths -DestinationPath (Join-Path $OutputDirectory 'Pomo-Restbank-0.1.0-windows-x64.zip') -Force
    $hashFiles = Get-ChildItem -LiteralPath $OutputDirectory -File | Where-Object { $_.Extension -in @('.exe','.zip','.ps1') }
    $hashLines = foreach ($file in $hashFiles) {
        $hash = Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256
        '{0}  {1}' -f $hash.Hash.ToLowerInvariant(), $file.Name
    }
    [IO.File]::WriteAllLines((Join-Path $OutputDirectory 'SHA256SUMS.txt'), $hashLines, [Text.UTF8Encoding]::new($false))
    Write-Host "Release files: $OutputDirectory"
} finally { Pop-Location }
