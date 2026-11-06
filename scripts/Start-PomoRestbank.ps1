param([switch]$Preview, [ValidatePattern('^[A-Za-z0-9_-]{1,48}$')][Alias('Profile')][string]$ClientProfile = 'default')
$ErrorActionPreference = 'Stop'
$binaryDirectory = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $binaryDirectory 'pomo-restbank.exe'))) {
    $binaryDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist'
}
$server = Join-Path $binaryDirectory 'pomo-restbank-server.exe'
$client = Join-Path $binaryDirectory 'pomo-restbank.exe'
if (-not (Test-Path -LiteralPath $server) -or -not (Test-Path -LiteralPath $client)) { throw 'Build the release first with scripts\Build.ps1.' }
$port = if ($Preview) { 4318 } else { 4317 }
$root = Join-Path $env:LOCALAPPDATA 'PomoRestbank'
$serverDirectory = Join-Path $root $(if ($Preview) { 'preview-server' } else { 'server' })
$profileDirectory = Join-Path (Join-Path $root $(if ($Preview) { 'preview-clients' } else { 'clients' })) $ClientProfile
function Test-RestbankServer {
    try { return (Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 1).Content -eq 'Pomo Restbank server: ready' } catch { return $false }
}
if (-not (Test-RestbankServer)) {
    $serverArguments = if ($Preview) { @('--preview') } else { @() }
    if ($serverArguments.Count) { Start-Process -FilePath $server -ArgumentList $serverArguments -WindowStyle Hidden | Out-Null }
    else { Start-Process -FilePath $server -WindowStyle Hidden | Out-Null }
    $deadline = [DateTime]::UtcNow.AddSeconds(12)
    while (-not (Test-RestbankServer)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Server did not start. Run the server executable directly to inspect the error.' }
        Start-Sleep -Milliseconds 150
    }
}
New-Item -ItemType Directory -Path $profileDirectory -Force | Out-Null
$configPath = Join-Path $profileDirectory 'connection.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    $token = [IO.File]::ReadAllText((Join-Path $serverDirectory 'token.txt')).Trim()
    $config = @{ endpoint="ws://127.0.0.1:$port/v1/ws"; token=$token; client_id=[Guid]::NewGuid().ToString() } | ConvertTo-Json
    [IO.File]::WriteAllText($configPath, $config, [Text.UTF8Encoding]::new($false))
}
$clientArguments = @('--profile', $ClientProfile)
if ($Preview) { $clientArguments += '--preview' }
Start-Process -FilePath $client -ArgumentList $clientArguments -WindowStyle Hidden | Out-Null
