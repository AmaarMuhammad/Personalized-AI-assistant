<#
  Game-mode watcher (Phase 6).

  Detects ANY game dynamically, no per-game list:
    A. A running process whose exe lives in an installed game library
       (Steam libraries from libraryfolders.vdf, Epic manifests, common store folders).
    B. Windows reports an exclusive full-screen Direct3D app (SHQueryUserNotificationState = 3).
    C. The foreground app is using >= GpuThreshold % of the GPU's 3D engine for two polls in a row
       (catches standalone games, emulators, browser games).

  Game starts  -> stop llama-server: VRAM goes back to the game, and Hermes side jobs
                  automatically fall back to the main cloud model.
  Game ends    -> after ExitGraceSec with no signal, start the local model router again.

  State: %LOCALAPPDATA%\Jarvis\game-mode.json   Log: %LOCALAPPDATA%\Jarvis\game-mode.log
  Usage: game-mode.ps1            (loop, normally started hidden at login)
         game-mode.ps1 -Once      (print one detection result and exit; changes nothing)
#>
param(
  [switch]$Once,
  [int]$PollSec = 10,
  [int]$ExitGraceSec = 120,
  [int]$GpuThreshold = 35,
  [string]$LlamaStart = 'D:\AI\start-llama-hidden.vbs'
)

$ErrorActionPreference = 'Continue'
$dir = Join-Path $env:LOCALAPPDATA 'Jarvis'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$StateFile = Join-Path $dir 'game-mode.json'
$LogFile = Join-Path $dir 'game-mode.log'

Add-Type -Namespace GM -Name Native -MemberDefinition @'
[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[DllImport("kernel32.dll", SetLastError=true)] public static extern System.IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
public static extern bool QueryFullProcessImageName(System.IntPtr h, uint flags, System.Text.StringBuilder buf, ref uint size);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);
'@

function Log($msg) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $msg
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
  if ($Once) { Write-Output $line }
}

# Full exe path even for anti-cheat-protected games (limited-query access is usually allowed).
function Get-ExePath([uint32]$procId) {
  $h = [GM.Native]::OpenProcess(0x1000, $false, $procId)  # PROCESS_QUERY_LIMITED_INFORMATION
  if ($h -eq [IntPtr]::Zero) { return $null }
  try {
    $sb = New-Object System.Text.StringBuilder 1024
    [uint32]$n = 1024
    if ([GM.Native]::QueryFullProcessImageName($h, 0, $sb, [ref]$n)) { return $sb.ToString() }
    return $null
  } finally { [void][GM.Native]::CloseHandle($h) }
}

# Folders that hold games but are NOT games themselves (wallpaper engine runs all day).
$ExcludeDirs = @('wallpaper_engine', 'Steamworks Shared', 'Steam Controller Configs', 'SteamVR',
                 'DirectXRedist', 'Launcher', '_CommonRedist', 'CommonRedist',
                 'Riot Vanguard', 'Riot Client')  # anti-cheat + launcher stay resident after games close
$ExcludeExe = '(?i)(crash|report|redist|setup|unins|dxsetup|helper|launcher|updater|vgc|vgtray|riotclient|easyanticheat)'

function Get-GameRoots {
  $roots = New-Object System.Collections.Generic.List[string]
  # Steam: every library folder listed by Steam itself.
  $steam = (Get-ItemProperty 'HKCU:\Software\Valve\Steam' -ErrorAction SilentlyContinue).SteamPath
  if ($steam) {
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    $paths = @($steam)
    if (Test-Path $vdf) {
      $paths += Select-String -Path $vdf -Pattern '"path"\s+"([^"]+)"' -AllMatches |
        ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value -replace '\\\\', '\' }
    }
    $paths | Sort-Object -Unique | ForEach-Object {
      $c = Join-Path $_ 'steamapps\common'
      if (Test-Path $c) { $roots.Add($c) }
    }
  }
  # Epic: install locations from the launcher's manifests.
  $man = 'C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests'
  if (Test-Path $man) {
    Get-ChildItem $man -Filter *.item -ErrorAction SilentlyContinue | ForEach-Object {
      try { $loc = (Get-Content $_.FullName -Raw | ConvertFrom-Json).InstallLocation; if ($loc) { $roots.Add($loc) } } catch {}
    }
  }
  # Other stores' default game folders on every fixed drive.
  $sub = @('XboxGames', 'Riot Games', 'GOG Games', 'EA Games', 'Program Files\EA Games',
           'Program Files (x86)\Ubisoft\Ubisoft Game Launcher\games', 'Program Files\Epic Games',
           'Epic Games', 'Games')
  Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | Where-Object { $_.Free -ne $null } | ForEach-Object {
    foreach ($s in $sub) { $p = Join-Path $_.Root $s; if (Test-Path $p) { $roots.Add($p) } }
  }
  $roots | ForEach-Object { $_.TrimEnd('\') + '\' } | Sort-Object -Unique
}

function Test-IsGamePath([string]$path, [string[]]$roots) {
  if (-not $path) { return $false }
  $leaf = [IO.Path]::GetFileNameWithoutExtension($path)
  if ($leaf -match $ExcludeExe) { return $false }
  foreach ($r in $roots) {
    if ($path.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)) {
      $segs = $path.Substring($r.Length) -split '\\'
      foreach ($seg in $segs) { if ($ExcludeDirs -contains $seg) { return $false } }
      return $true
    }
  }
  return $false
}

# Never treat these as games even if they light up the GPU.
$GpuIgnore = '(?i)^(dwm|explorer|llama-server|obs64|obs32|nvcontainer|nvidia overlay|wallpaper32|wallpaper64|webwallpaper32|steamwebhelper|code|windowsterminal|searchhost|shellexperiencehost|applicationframehost)$'

function Get-ForegroundGpu {
  $hwnd = [GM.Native]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return $null }
  [uint32]$fgPid = 0
  [void][GM.Native]::GetWindowThreadProcessId($hwnd, [ref]$fgPid)
  if ($fgPid -eq 0) { return $null }
  $p = Get-Process -Id $fgPid -ErrorAction SilentlyContinue
  if (-not $p -or $p.ProcessName -match $GpuIgnore) { return $null }
  try {
    $samples = (Get-Counter "\GPU Engine(pid_$($fgPid)_*engtype_3D)\Utilization Percentage" -ErrorAction Stop).CounterSamples
  } catch { return $null }
  $util = ($samples | Measure-Object CookedValue -Sum).Sum
  [pscustomobject]@{ Pid = $fgPid; Name = $p.ProcessName; Util = [math]::Round($util, 1) }
}

function Detect([string[]]$roots) {
  # A: a process from a game library.
  foreach ($p in Get-Process) {
    if ($p.Id -le 4) { continue }
    $path = Get-ExePath ([uint32]$p.Id)
    if (Test-IsGamePath $path $roots) { return @{ Signal = 'library'; Game = "$($p.ProcessName).exe"; Path = $path } }
  }
  # B: exclusive full-screen Direct3D.
  [int]$q = 0
  if ([GM.Native]::SHQueryUserNotificationState([ref]$q) -eq 0 -and $q -eq 3) {
    return @{ Signal = 'fullscreen-d3d'; Game = 'full-screen app'; Path = $null }
  }
  # C: heavy 3D load in the foreground (needs two polls; the caller tracks that).
  $g = Get-ForegroundGpu
  if ($g -and $g.Util -ge $GpuThreshold) {
    return @{ Signal = 'gpu'; Game = "$($g.Name).exe"; Path = $null; Util = $g.Util }
  }
  return $null
}

function Set-State($gaming, $info) {
  $s = [ordered]@{
    gaming = $gaming
    game   = if ($info) { $info.Game } else { $null }
    signal = if ($info) { $info.Signal } else { $null }
    since  = (Get-Date).ToString('o')
  }
  $s | ConvertTo-Json | Set-Content -Path $StateFile -Encoding UTF8
}

function Stop-LocalModel {
  $procs = Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue
  if ($procs) { $procs | Stop-Process -Force -ErrorAction SilentlyContinue; Log "local model stopped ($($procs.Count) process(es))" }
}

function Start-LocalModel {
  if (Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue) { return }
  if (Test-Path $LlamaStart) { Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$LlamaStart`"" -WindowStyle Hidden; Log 'local model started' }
  else { Log "local model start script missing: $LlamaStart" }
}

$roots = Get-GameRoots

if ($Once) {
  Write-Output "Game roots:"; $roots | ForEach-Object { Write-Output "  $_" }
  $fg = Get-ForegroundGpu
  if ($fg) { Write-Output ("Foreground: {0}.exe pid {1}, 3D {2}%" -f $fg.Name, $fg.Pid, $fg.Util) }
  $d = Detect $roots
  if ($d) { Write-Output ("GAME: {0} via {1} {2}" -f $d.Game, $d.Signal, $d.Path) } else { Write-Output 'No game detected.' }
  return
}

# Single instance.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\JarvisGameModeWatcher', [ref]$created)
if (-not $created) { exit 0 }

Log "watcher started; roots: $($roots -join '; ')"
$gaming = $false
$lastSeen = [datetime]::MinValue
$gpuHits = 0
$rootsAt = Get-Date
Set-State $false $null

while ($true) {
  try {
    if (((Get-Date) - $rootsAt).TotalMinutes -ge 10) { $roots = Get-GameRoots; $rootsAt = Get-Date }
    $d = Detect $roots
    if ($d -and $d.Signal -eq 'gpu') {
      $gpuHits++
      if ($gpuHits -lt 2) { $d = $null }
    } elseif (-not $d) { $gpuHits = 0 }

    if ($d) {
      $lastSeen = Get-Date
      if (-not $gaming) {
        $gaming = $true
        Log "GAME ON: $($d.Game) via $($d.Signal)"
        Set-State $true $d
        Stop-LocalModel
      } else {
        # Keep the model down if something (autostart, a manual start) brought it back mid-game.
        Stop-LocalModel
      }
    } elseif ($gaming -and ((Get-Date) - $lastSeen).TotalSeconds -ge $ExitGraceSec) {
      $gaming = $false
      Log 'GAME OFF'
      Set-State $false $null
      Start-LocalModel
    }
  } catch {
    Log "error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $PollSec
}
