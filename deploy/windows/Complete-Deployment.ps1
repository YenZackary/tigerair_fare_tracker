[CmdletBinding()]
param([PSCredential]$Credential)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$local = Join-Path $root '.local'
$config = Get-Content -Raw (Join-Path $local 'config.json') | ConvertFrom-Json
$ps = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
function Git([string[]]$Arguments) {
    & $config.GitPath -C $root -c credential.helper= @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Git failed; local files/commits retained. Resolve the error and rerun.' }
}
try {
    $secret = (Get-Content -Raw (Join-Path $local 'github-token.dpapi')).Trim() | ConvertTo-SecureString
    $env:GITHUB_TOKEN = (New-Object Net.NetworkCredential('', $secret)).Password
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'Never'
    $env:GIT_CONFIG_COUNT = '1'
    $env:GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
    $env:GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('x-access-token:' + $env:GITHUB_TOKEN))
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    # Read-only credential/scope check; never print token or response bodies.
    $headers = @{Authorization=('Bearer ' + $env:GITHUB_TOKEN); Accept='application/vnd.github+json'; 'X-GitHub-Api-Version'='2022-11-28'}
    $repo = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $config.Repository) -Headers $headers -TimeoutSec 30
    if (-not $repo.permissions.push) { throw 'Token cannot push to this repository.' }
    $null = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $config.Repository + '/issues/1') -Headers $headers -TimeoutSec 30
    # Register disabled first. If Windows rejects the chosen logon mode, cloud cron is untouched.
    & (Join-Path $PSScriptRoot 'Install-Task.ps1') -Credential $Credential
    & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Run-Tracker.ps1') -DryRun
    if ($LASTEXITCODE -ne 0) { throw 'Live API dry-run failed; cloud cron was not changed.' }
    Push-Location $root
    try {
        $branch = & $config.GitPath branch --show-current
        if ($branch -ne $config.Branch) { throw 'Wrong Git branch.' }
        $origin = & $config.GitPath remote get-url origin
        if ($origin -ne ('https://github.com/' + $config.Repository + '.git')) { throw 'Unexpected origin URL.' }
        $dirty = & $config.GitPath status --porcelain --untracked-files=no
        if ($dirty) { throw 'Tracked files are modified/staged. Commit or review them before cutover.' }
        Git @('pull','--ff-only','origin',$config.Branch)
        $workflowPath = Join-Path $root '.github/workflows/watch.yml'
        $workflow = [IO.File]::ReadAllText($workflowPath)
        $updated = [regex]::Replace($workflow, '(?m)^  schedule:\r?\n(?:    [^\r\n]*\r?\n)*', '')
        if ($updated -cmatch '(?m)^  schedule\s*:') { throw 'Unrecognized schedule format; inspect workflow manually.' }
        if ($updated -ne $workflow) {
            [IO.File]::WriteAllText($workflowPath, $updated, (New-Object Text.UTF8Encoding($false)))
            $readmePath = Join-Path $root 'README.md'
            $readme = [IO.File]::ReadAllText($readmePath)
            $notice = '> Current scheduler: Windows Task Scheduler (15 minutes). Cloud cron is disabled; the Actions schedule described below is historical. See [Windows deployment guide](deploy/windows/README.zh-TW.md) for setup, logs, credentials, and recovery.'
            $readme = [regex]::Replace($readme, '^(#[^\r\n]*\r?\n)', ('$1' + "`n" + $notice + "`n"))
            [IO.File]::WriteAllText($readmePath, $readme, (New-Object Text.UTF8Encoding($false)))
            Git @('add','--','.github/workflows/watch.yml','README.md','.gitignore','deploy/windows')
            Git @('diff','--cached','--check')
            Git @('diff','--cached','--stat')
            Git @('-c','user.name=tigerair-local[bot]','-c','user.email=tigerair-local@users.noreply.github.com','commit','-m','Move scheduled fare tracking to Windows Task Scheduler')
        }
        Git @('push','origin',('HEAD:refs/heads/' + $config.Branch))
        # Removing cron does not cancel already queued/in-flight runs. Wait for them to finish.
        $runs = Invoke-RestMethod -Uri ('https://api.github.com/repos/' + $config.Repository + '/actions/workflows/watch.yml/runs?per_page=100') -Headers $headers -TimeoutSec 30
        if (@($runs.workflow_runs | Where-Object status -NE 'completed').Count -gt 0) {
            throw 'Cloud cron removed, but an Actions run is still queued/running. Wait for completion and rerun this script; local task remains disabled.'
        }
        # Take the final cloud state after its last run, before the first local write.
        Git @('pull','--ff-only','origin',$config.Branch)
        & (Join-Path $PSScriptRoot 'Install-Task.ps1') -Credential $Credential -Enable
        Start-ScheduledTask -TaskName $config.TaskName
        Write-Host 'Cloud cron removed; local task enabled and started. Inspect task state, last-run.json and logs to confirm the first live result.'
    } finally { Pop-Location }
} finally {
    foreach ($key in @('GITHUB_TOKEN','GIT_CONFIG_VALUE_0')) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
}
