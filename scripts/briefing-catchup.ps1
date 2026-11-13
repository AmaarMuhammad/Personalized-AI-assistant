# Same-day catch-up for the 5 pm briefing.
#
# Hermes only fires a daily job up to 2 hours late. If the PC comes on later than that, the
# day's briefing is skipped. This runs once at login: it waits for the Hermes gateway, and if
# it is past 5 pm and today's briefing has not run, it triggers it. Never runs it twice.
#
# Started hidden at login by briefing-catchup-hidden.vbs (Startup folder: "Jarvis Briefing Catch-up").

$ErrorActionPreference = 'Stop'
$JobId = 'c169d6801b93'
$BriefingHour = 17
$HermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$Hermes = Join-Path $HermesHome 'bin\hermes.exe'
$OutDir = Join-Path $HermesHome "cron\output\$JobId"
$LogDir = Join-Path $env:LOCALAPPDATA 'Jarvis'
$Log = Join-Path $LogDir 'briefing-catchup.log'

function Write-Log([string]$Text) {
  New-Item -ItemType Directory -Force $LogDir | Out-Null
  Add-Content -Path $Log -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text) -Encoding ascii
}

function Test-RanToday {
  $today = Get-Date -Format 'yyyy-MM-dd'
  return [bool](Get-ChildItem -Path $OutDir -Filter "$today*.md" -ErrorAction SilentlyContinue)
}

try {
  # Wait up to 5 minutes for the gateway to answer.
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    try {
      $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8642/health' -UseBasicParsing -TimeoutSec 4
      if ($r.StatusCode -eq 200) { $up = $true; break }
    } catch { }
    Start-Sleep -Seconds 5
  }
  if (-not $up) { Write-Log 'gateway did not come up in 5 minutes; nothing done'; exit 0 }

  # Give Hermes's own scheduler two minutes to fire a run that is still inside its grace window.
  Start-Sleep -Seconds 120

  if ((Get-Date).Hour -lt $BriefingHour) { Write-Log 'before 5 pm; the normal schedule will run it'; exit 0 }
  if (Test-RanToday) { Write-Log 'already ran today; nothing done'; exit 0 }

  & $Hermes cron run $JobId | Out-Null
  Write-Log "triggered today's briefing (exit code $LASTEXITCODE)"
} catch {
  Write-Log ("error: " + $_.Exception.Message)
}
