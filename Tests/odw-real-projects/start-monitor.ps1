param([string]$Provider = "mock", [int]$IntervalMinutes = 15, [int]$DurationHours = 24, [int]$ProjectsPerCycle = 10)
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$logDir = Join-Path $repo "Tests\results\odw-real-projects"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$env:ODW_PROVIDER_MODE = $Provider
$env:ODW_REAL_PROJECT_INTERVAL_MS = [string]($IntervalMinutes * 60 * 1000)
$env:ODW_REAL_PROJECT_DURATION_MS = [string]($DurationHours * 60 * 60 * 1000)
$env:ODW_REAL_PROJECTS_PER_CYCLE = [string]$ProjectsPerCycle
$process = Start-Process -FilePath "node" -ArgumentList "Tests\odw-real-projects\monitor-24h.mjs" -WorkingDirectory $repo -RedirectStandardOutput (Join-Path $logDir "monitor.stdout.log") -RedirectStandardError (Join-Path $logDir "monitor.stderr.log") -PassThru
@{ pid = $process.Id; provider = $Provider; intervalMinutes = $IntervalMinutes; durationHours = $DurationHours; projectsPerCycle = $ProjectsPerCycle; startedAt = (Get-Date).ToUniversalTime().ToString("o"); brief = "Tests\results\odw-real-projects\brief-latest.md"; briefHistory = "Tests\results\odw-real-projects\brief-history.md"; stopCommand = "Stop-Process -Id $($process.Id)" } | ConvertTo-Json | Set-Content -Path (Join-Path $logDir "monitor-process.json") -Encoding UTF8
Write-Output "Started ODW real-project monitor pid=$($process.Id)"
