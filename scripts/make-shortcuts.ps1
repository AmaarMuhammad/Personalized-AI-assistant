# Creates "Jarvis" shortcuts in the Start menu and on the desktop.
$dir = Split-Path -Parent $PSScriptRoot
$shell = New-Object -ComObject WScript.Shell
foreach ($place in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $link = $shell.CreateShortcut((Join-Path $place 'Jarvis.lnk'))
  $link.TargetPath = Join-Path $dir 'node_modules\electron\dist\electron.exe'
  $link.Arguments = '"' + $dir + '"'
  $link.WorkingDirectory = $dir
  $link.IconLocation = Join-Path $dir 'app\assets\icon.ico'
  $link.Description = 'Jarvis, your personal assistant'
  $link.Save()
}
