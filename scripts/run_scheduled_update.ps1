# One scheduled dashboard update. Task Scheduler starts this; you normally never run it yourself
# (the one-command way is `Rscript scripts/update_dashboard.R`, see the README).
#
# scripts/install_schedule.ps1 copies this file to %LOCALAPPDATA%\scale_dash\ and registers the task,
# so the scheduled job keeps working however the repo in Dropbox is changed. Each run:
#   1. uses its OWN clone of the repo (%LOCALAPPDATA%\scale_dash\repo), refreshed from GitHub every
#      time. The scheduled job therefore never touches your working copy: it can't commit or push
#      work in progress, doesn't care which branch you are on, and can't collide with a git lock.
#   2. runs that clone's scripts\update_dashboard.R, pointing it at your working copy's data\ folder
#      for the two top-15 workbooks (they are git-ignored, so they only exist there).
#      That merges the Skjell_lister files, rebuilds the data, and commits + pushes if the numbers
#      changed -- or says "nothing to publish".
#   3. appends everything to %LOCALAPPDATA%\scale_dash\update_dashboard.log (kept to ~1 MB + one
#      .old copy) and exits with the update's exit code, so Task Scheduler's "Last Run Result" is
#      0 for success and 1 for a failure (details in the log).
#
#   -SelfTest   check that the clone can reach and authenticate to GitHub (git push --dry-run),
#               without publishing anything.
param([switch]$SelfTest)

$ErrorActionPreference = "Continue"
$root = Join-Path $env:LOCALAPPDATA "scale_dash"
$log = Join-Path $root "update_dashboard.log"
$clone = Join-Path $root "repo"

function Write-Log([string]$text) { Add-Content -Path $log -Value $text -Encoding UTF8 }

# Runs a program, appends its output to the log, returns its exit code.
function Invoke-Logged([string]$exe, [string[]]$arguments) {
  $output = & $exe @arguments 2>&1
  $code = $LASTEXITCODE
  foreach ($line in $output) {
    $text = "$line"
    if ($text -match "built under R version" -or $text -match "^Warning messages?:\s*$") { continue }
    Write-Log ("    " + $text)
  }
  return $code
}

New-Item -ItemType Directory -Force -Path $root | Out-Null
if ((Test-Path $log) -and ((Get-Item $log).Length -gt 1MB)) { Move-Item $log "$log.old" -Force }
Write-Log ("==== {0:yyyy-MM-dd HH:mm:ss} ====" -f (Get-Date))

try {
  $config = Get-Content (Join-Path $root "config.json") -Raw -ErrorAction Stop | ConvertFrom-Json
} catch {
  Write-Log "ERROR: $root\config.json is missing or unreadable; run scripts\install_schedule.ps1 again."
  exit 1
}

$git = (Get-Command git -ErrorAction SilentlyContinue).Source
$rscript = (Get-Command Rscript -ErrorAction SilentlyContinue).Source
if (-not $rscript) {
  $rscript = Get-ChildItem "$env:ProgramFiles\R\R-*\bin\Rscript.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $git) { Write-Log "ERROR: git was not found."; exit 1 }
if (-not $rscript) { Write-Log "ERROR: Rscript was not found."; exit 1 }

# The clone: created once, then forced to match GitHub on every run (it is only ever used by this job).
if (-not (Test-Path (Join-Path $clone ".git"))) {
  Write-Log "Cloning $($config.remote) ..."
  if ((Invoke-Logged $git @("clone", "--quiet", $config.remote, $clone)) -ne 0) { Write-Log "ERROR: git clone failed."; exit 1 }
}
if ((Invoke-Logged $git @("-C", $clone, "fetch", "--quiet", "origin", "master")) -ne 0) {
  Write-Log "ERROR: could not fetch from GitHub (offline? credentials?)."
  exit 1
}
if ((Invoke-Logged $git @("-C", $clone, "checkout", "--quiet", "--force", "-B", "master", "origin/master")) -ne 0) {
  Write-Log "ERROR: could not update the clone to origin/master."
  exit 1
}

if ($SelfTest) {
  # What a publishing run needs: an identity to commit as, and access to push (nothing is pushed).
  $name = (& $git -C $clone config user.name 2>$null)
  $email = (& $git -C $clone config user.email 2>$null)
  Write-Log "self-test: commits would be made as '$name' <$email>"
  $code = Invoke-Logged $git @("-C", $clone, "push", "--dry-run", "origin", "master")
  Write-Log "self-test: git push --dry-run exit code $code"
  if (-not $name -or -not $email) { Write-Log "self-test: ERROR no git identity (git config --global user.name / user.email)"; $code = 1 }
  exit $code
}

$code = Invoke-Logged $rscript @(
  (Join-Path $clone "scripts\update_dashboard.R"),
  "--workbooks-dir=$($config.workbooksDir)"
)
Write-Log "exit code $code"
exit $code
