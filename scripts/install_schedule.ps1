# Sets up (or removes) the automatic dashboard update in Windows Task Scheduler.
#
# Usage (PowerShell, from anywhere; no administrator rights needed):
#   powershell -ExecutionPolicy Bypass -File scripts\install_schedule.ps1
#   ... -EveryHours 2 -From 08:00 -ForHours 10     different times: runs at 08:00, 10:00, ... 18:00
#   ... -Remove                                    delete the scheduled task
#
# Default: every hour from 07:00 to 19:00, every day. A run that finds nothing new publishes
# nothing, so frequent runs are harmless.
#
# The task runs as you, only while you are logged in (it needs your git credentials and the
# OneDrive/Dropbox files), starts hidden, doesn't need the PC to be plugged in, needs a network
# connection, and a run missed because the PC was off or asleep is made up once when it is back.
# See run_scheduled_update.ps1 for what each run does; the log is
# %LOCALAPPDATA%\scale_dash\update_dashboard.log.
param(
  [int]$EveryHours = 1,
  [string]$From = "07:00",
  [int]$ForHours = 12,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"
$taskName = "scale_dash dashboard update"
$root = Join-Path $env:LOCALAPPDATA "scale_dash"

if ($Remove) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed the scheduled task '$taskName'. (The log and the clone in $root were left in place.)"
  } else {
    Write-Host "There is no scheduled task '$taskName'."
  }
  return
}

$mainRepo = Split-Path -Parent $PSScriptRoot
$remote = (& git -C $mainRepo remote get-url origin).Trim()
$workbooksDir = Join-Path $mainRepo "data"
foreach ($f in "d_1SW_top15.xlsx", "d_2SW_top15.xlsx") {
  if (-not (Test-Path (Join-Path $workbooksDir $f))) { throw "Missing $f in $workbooksDir -- the update needs the two top-15 workbooks there." }
}

# Install the runner where the repo (which you edit, and which lives in Dropbox) can't break it.
New-Item -ItemType Directory -Force -Path $root | Out-Null
$runner = Join-Path $root "run_scheduled_update.ps1"
Copy-Item (Join-Path $PSScriptRoot "run_scheduled_update.ps1") $runner -Force
@{ mainRepo = $mainRepo; remote = $remote; workbooksDir = $workbooksDir } |
  ConvertTo-Json | Set-Content (Join-Path $root "config.json") -Encoding UTF8

# conhost --headless keeps the console window from flashing up every hour.
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Daily -At $From
$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At $From `
    -RepetitionInterval (New-TimeSpan -Hours $EveryHours) `
    -RepetitionDuration (New-TimeSpan -Hours $ForHours)).Repetition
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Merges the Skjell_lister imaging lists and publishes the scale_dash dashboard (scripts/update_dashboard.R)." `
  -Force | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host "Scheduled '$taskName' as ${user}: every $EveryHours h from $From for $ForHours h, every day."
Write-Host "Next run: $($info.NextRunTime)"
Write-Host "Log:      $(Join-Path $root 'update_dashboard.log')"
Write-Host "Check:    Get-ScheduledTaskInfo -TaskName '$taskName'   (LastTaskResult 0 = last run succeeded)"
