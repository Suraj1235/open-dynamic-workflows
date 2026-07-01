$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$statusPath = Join-Path $repo "Tests\results\odw-endurance\monitor-process.json"
$latestPath = Join-Path $repo "Tests\results\odw-endurance\monitor-latest.json"

if (!(Test-Path -LiteralPath $statusPath)) {
  Write-Output "No monitor-process.json found. The endurance monitor has not been started from this checkout."
  exit 1
}

$processStatus = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
$process = Get-Process -Id $processStatus.pid -ErrorAction SilentlyContinue
$latest = $null
if (Test-Path -LiteralPath $latestPath) {
  $latest = Get-Content -LiteralPath $latestPath -Raw | ConvertFrom-Json
}

[pscustomobject]@{
  pid = $processStatus.pid
  running = [bool]$process
  provider = $processStatus.provider
  target = $processStatus.target
  intervalMinutes = $processStatus.intervalMinutes
  startedAt = $processStatus.startedAt
  latestIteration = $latest.iteration
  latestOk = $latest.ok
  latestFinishedAt = $latest.finishedAt
  nextRunAt = $latest.nextRunAt
  stopCommand = $processStatus.stopCommand
} | ConvertTo-Json
