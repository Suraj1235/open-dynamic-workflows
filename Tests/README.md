# Tests

External smoke tests for validating Open Dynamic Workflows against an Azure-hosted OpenAI-compatible model endpoint.

## Azure Kimi Smoke Test

Run from the repository root with credentials supplied as environment variables:

```powershell
$env:AZURE_OPENAI_ENDPOINT="https://<your-resource>.cognitiveservices.azure.com"
$env:AZURE_OPENAI_API_KEY="<your key>"
$env:AZURE_OPENAI_MODEL="Kimi-K2.6"
node --test Tests/azure-kimi-smoke.test.mjs
```

Optional:

```powershell
$env:AZURE_OPENAI_API_VERSION="2024-05-01-preview"
```

The test writes a redacted diagnostic report to `Tests/results/azure-kimi-smoke-result.json`. Do not commit API keys or raw provider responses that contain secrets.

## Continuous Monitor

Run one probe and write `Tests/results/monitor-status.json`:

```powershell
node Tests/monitor-azure-kimi.mjs --once
```

Run continuously, once per minute by default:

```powershell
node Tests/monitor-azure-kimi.mjs
```

Change the interval:

```powershell
$env:MONITOR_INTERVAL_MS="300000"
node Tests/monitor-azure-kimi.mjs
```

## ODW Endurance Campaign

Run 100 deterministic embedded ODW swarm scenarios without live model spend:

```powershell
node Tests/odw-endurance/run-campaign.mjs --target=100 --provider=mock
```

Run against the live Azure Kimi endpoint instead:

```powershell
$env:AZURE_OPENAI_ENDPOINT="https://<your-resource>.cognitiveservices.azure.com"
$env:AZURE_OPENAI_API_KEY="<your key>"
$env:AZURE_OPENAI_MODEL="Kimi-K2.6"
$env:ODW_PROVIDER_MODE="live"
node Tests/odw-endurance/run-campaign.mjs --target=100 --provider=live
```

Start the 24-hour monitor loop that repeats every 15 minutes:

```powershell
powershell -ExecutionPolicy Bypass -File Tests/odw-endurance/start-monitor.ps1 -Target 100 -Provider mock -IntervalMinutes 15 -DurationHours 24
```

Reports are written to `Tests/results/odw-endurance/latest.json` and `Tests/results/odw-endurance/latest.md`.

Check the detached monitor status:

```powershell
node Tests/odw-endurance/status.mjs

# PowerShell alternative:
powershell -ExecutionPolicy Bypass -File Tests/odw-endurance/status.ps1
```

Stop the detached monitor using the command recorded in `Tests/results/odw-endurance/monitor-process.json`.
