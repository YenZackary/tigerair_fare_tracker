[CmdletBinding()]
param([PSCredential]$Credential, [switch]$Enable)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$local = Join-Path $root '.local'
[IO.Directory]::CreateDirectory($local) | Out-Null
$configPath = Join-Path $local 'config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    $config = Get-Content -Raw (Join-Path $PSScriptRoot 'config.example.json') | ConvertFrom-Json
    $config.NodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $config.GitPath = (Get-Command git.exe -ErrorAction Stop).Source
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
}
$config = Get-Content -Raw $configPath | ConvertFrom-Json
$currentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($Credential -and $Credential.UserName -ne $currentUser) { throw "Use the same Windows account ($currentUser) that saved the DPAPI token." }
if ($Enable) {
    if (-not (Test-Path (Join-Path $local 'github-token.dpapi'))) { throw 'Save a token first.' }
    if ((Get-Content -Raw (Join-Path $root '.github/workflows/watch.yml')) -match '(?m)^\s{2}schedule\s*:') { throw 'Complete cloud cron cutover first.' }
}
$ps = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$runner = Join-Path $PSScriptRoot 'Run-Tracker.ps1'
$action = New-ScheduledTaskAction -Execute $ps -Argument ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $runner + '"') -WorkingDirectory $root
# Repeat in each daily window, anchored to the computer's local 00:00, 00:15, 00:30, 00:45.
$daily = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today)
$repeat = New-ScheduledTaskTrigger -Once -At ([datetime]::Today) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 1)
$daily.Repetition = $repeat.Repetition
$daily.Repetition.StopAtDurationEnd = $false
$logon = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$triggers = @($daily, $logon)
if ($Credential) { $triggers += New-ScheduledTaskTrigger -AtStartup }
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -StartWhenAvailable -WakeToRun -RunOnlyIfNetworkAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# No automatic restart: failure is retried at the next regular 15-minute tick.
if ($Credential) {
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Password -RunLevel Limited
} else {
    $principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
}
$task = New-ScheduledTask -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Description 'Local Tigerair watcher; 15-minute ticks; no resident service.'
$task.Settings.Enabled = [bool]$Enable
$existing = Get-ScheduledTask -TaskName $config.TaskName -ErrorAction SilentlyContinue
if ($existing) {
    if ($existing.Description -ne $task.Description -or $existing.Actions.Execute -ne $ps -or $existing.Actions.Arguments -notlike ('*' + $runner + '*')) { throw 'An unrelated task has this name; choose another TaskName.' }
    if ($existing.State -eq 'Running') { throw 'Task is running; wait until it completes before reinstalling.' }
}
if ($Credential) {
    Register-ScheduledTask -TaskName $config.TaskName -InputObject $task -User $currentUser -Password $Credential.GetNetworkCredential().Password -Force | Out-Null
} else {
    Register-ScheduledTask -TaskName $config.TaskName -InputObject $task -Force | Out-Null
}
Export-ScheduledTask -TaskName $config.TaskName | Set-Content (Join-Path $local 'task.xml') -Encoding Unicode
Get-ScheduledTask -TaskName $config.TaskName | Select-Object TaskName, State
if (-not $Credential) { Write-Host 'Interactive mode: the same Windows user must remain logged on (screen lock is OK). For logged-out execution rerun with -Credential.' }
