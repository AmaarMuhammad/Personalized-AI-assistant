# Run once, yourself, in PowerShell:  powershell -ExecutionPolicy Bypass -File "D:\PERSONALISED AI ASSISTANT\Jarvis\scripts\install-system-hooks.ps1"
# It changes things outside this folder, so Claude Code is not allowed to run it for you:
#  1. adds the health check to the briefing pre-run script (backup kept beside it)
#  2. makes the local model log append instead of being overwritten (backup kept)
#  3. removes the duplicate local-model autostart (restore note written to D:AI)
#  4. adds the briefing catch-up check to your Startup folder
# Safe to run twice.

$ErrorActionPreference = 'Stop'

# 1. Briefing pre-run script: append the health check (backup first).
$bd = Join-Path $env:LOCALAPPDATA 'hermes\scripts\briefing_data.py'
$text = [IO.File]::ReadAllText($bd)
if ($text -notmatch 'health-check\.mjs') {
  Copy-Item $bd "$bd.bak-health"
  $add = @'


# Health: anything broken heads the briefing. No model involved (Jarvis/scripts/health-check.mjs).
try:
    import subprocess

    r = subprocess.run(
        ["node", r"D:\PERSONALISED AI ASSISTANT\Jarvis\scripts\health-check.mjs"],
        capture_output=True, text=True, timeout=40, encoding="utf-8",
    )
    if r.stdout.strip():
        print("SYSTEM PROBLEMS (start the briefing with these, in plain words, before anything else):")
        print(r.stdout.strip())
except Exception as e:  # noqa: BLE001
    print(f"SYSTEM PROBLEMS: the health check itself could not run ({type(e).__name__}).")
'@
  [IO.File]::WriteAllText($bd, $text.TrimEnd() + $add.Replace("`r`n", "`n") + "`n", (New-Object Text.UTF8Encoding $false))
  'briefing_data.py: health check appended'
} else { 'briefing_data.py: already has it' }

# 2. Local model: keep the log across restarts (was overwritten on every start), capped at ~20 MB.
$cmd = 'D:\AI\start-llama.cmd'
$c = [IO.File]::ReadAllText($cmd)
if ($c -match '> "D:\\AI\\llama-server\.log" 2>&1' -and $c -notmatch '>> "D:\\AI\\llama-server\.log"') {
  Copy-Item $cmd "$cmd.bak-log"
  $c = $c.Replace('"D:\AI\llama.cpp\llama-server.exe"', "for %%F in (`"D:\AI\llama-server.log`") do if %%~zF GTR 20000000 move /y `"D:\AI\llama-server.log`" `"D:\AI\llama-server.old.log`" >nul`r`necho ==== started %DATE% %TIME% ==== >> `"D:\AI\llama-server.log`"`r`n`"D:\AI\llama.cpp\llama-server.exe`"")
  $c = $c.Replace('> "D:\AI\llama-server.log" 2>&1', '>> "D:\AI\llama-server.log" 2>&1')
  [IO.File]::WriteAllText($cmd, $c, [Text.Encoding]::ASCII)
  'start-llama.cmd: log now appends'
} else { 'start-llama.cmd: unchanged' }

# 3. Local model: one autostart, not two. Keep the Startup-folder one (it checks for a running server).
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$val = (Get-ItemProperty $run -ErrorAction SilentlyContinue).LocalLLM
if ($val) {
  Set-Content -Path 'D:\AI\LocalLLM-run-key-restore.txt' -Encoding ascii -Value "Removed 2026-11-11 (duplicate of Startup\Llama_Server.vbs). To restore: reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v LocalLLM /d `"$($val.Replace('"','\"'))`""
  Remove-ItemProperty -Path $run -Name LocalLLM
  'Run key LocalLLM: removed (restore note in D:\AI)'
} else { 'Run key LocalLLM: not present' }

# 4. Briefing catch-up at login.
$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'Jarvis Briefing Catch-up.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = 'wscript.exe'
$s.Arguments = '"D:\PERSONALISED AI ASSISTANT\Jarvis\scripts\briefing-catchup-hidden.vbs"'
$s.Save()
"Startup shortcut: $lnk"
