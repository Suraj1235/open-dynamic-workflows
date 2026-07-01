param(
  [int]$Target = 100,
  [string]$Provider = "mock",
  [int]$IntervalMinutes = 15,
  [int]$DurationHours = 24
)

$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$logDir = Join-Path $repo "Tests\results\odw-endurance"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$env:ODW_ENDURANCE_TARGET = [string]$Target
$env:ODW_PROVIDER_MODE = $Provider
$env:ODW_MONITOR_INTERVAL_MS = [string]($IntervalMinutes * 60 * 1000)
$env:ODW_MONITOR_DURATION_MS = [string]($DurationHours * 60 * 60 * 1000)

$process = Start-Process -FilePath "node" -ArgumentList "Tests\odw-endurance\monitor-24h.mjs" -WorkingDirectory $repo -RedirectStandardOutput (Join-Path $logDir "monitor.stdout.log") -RedirectStandardError (Join-Path $logDir "monitor.stderr.log") -PassThru
$status = @{
  pid = $process.Id
  target = $Target
  provider = $Provider
  intervalMinutes = $IntervalMinutes
  durationHours = $DurationHours
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  stopCommand = "Stop-Process -Id $($process.Id)"
}
$status | ConvertTo-Json | Set-Content -Path (Join-Path $logDir "monitor-process.json") -Encoding UTF8
Write-Output "Started ODW endurance monitor pid=$($process.Id). Status: Tests\results\odw-endurance\monitor-process.json"
