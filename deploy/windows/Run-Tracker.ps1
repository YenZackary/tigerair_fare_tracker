[CmdletBinding()]
param([switch]$DryRun, [string]$Fixture)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$local = Join-Path $root '.local'
$logs = Join-Path $local 'logs'
[IO.Directory]::CreateDirectory($logs) | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$log = Join-Path $logs ($stamp + '-' + $PID + '.log')
$lock = $null
$result = 2
$stage = 'initializing'
$started = [DateTime]::UtcNow
$deadline = $started.AddMinutes(12)
$files = @('index.html','all-routes.html','status.html','status.json','tools/state.json')
$utf8 = New-Object Text.UTF8Encoding($false)
function Write-Log([string]$Text) {
    $line = '[' + (Get-Date -Format o) + '] ' + $Text
    [IO.File]::AppendAllText($log, $line + [Environment]::NewLine, $utf8)
    Write-Host $line
}
function Save-Result([string]$State) {
    $data = [ordered]@{ startedUtc=$started.ToString('o'); updatedUtc=[DateTime]::UtcNow.ToString('o'); state=$State; stage=$stage; exitCode=$result; dryRun=[bool]$DryRun; log=$log }
    $temp = Join-Path $local 'last-run.tmp'
    [IO.File]::WriteAllText($temp, ($data | ConvertTo-Json), $utf8)
    Move-Item -LiteralPath $temp -Destination (Join-Path $local 'last-run.json') -Force
}
# Windows command-line quoting, without cmd.exe or shell interpolation.
function Quote-Argument([string]$Value) {
    return '"' + ([regex]::Replace(([regex]::Replace($Value, '(\\*)"', '$1$1\"')), '(\\+)$', '$1$1')) + '"'
}
function Invoke-Child([string]$Exe, [string[]]$Arguments, [int]$TimeoutSeconds = 60) {
    $remaining = [int][Math]::Floor(($deadline - [DateTime]::UtcNow).TotalSeconds)
    if ($remaining -le 0) { throw 'Overall 12-minute deadline exceeded.' }
    $limit = [Math]::Min($TimeoutSeconds, $remaining)
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Exe
    $info.Arguments = ($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $p = New-Object Diagnostics.Process
    $p.StartInfo = $info
    try {
        if (-not $p.Start()) { throw 'Could not start child process.' }
        $stdout = $p.StandardOutput.ReadToEndAsync()
        $stderr = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($limit * 1000)) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $p.Id /T /F | Out-Null
            if ($LASTEXITCODE -ne 0 -or -not $p.WaitForExit(10000)) { throw 'Could not terminate timed-out process tree. Disable the task and inspect its child processes.' }
            throw "Child process timed out after $limit seconds; process tree terminated."
        }
        $p.WaitForExit()
        $out = $stdout.GetAwaiter().GetResult()
        $err = $stderr.GetAwaiter().GetResult()
        if ($out) { Write-Log $out.TrimEnd() }
        if ($err) { Write-Log $err.TrimEnd() }
        return @{ Code=$p.ExitCode; Output=$out }
    } finally { $p.Dispose() }
}
function Git([string[]]$Arguments, [switch]$AllowFailure) {
    $r = Invoke-Child $script:config.GitPath (@('-c','credential.helper=') + $Arguments)
    if ($r.Code -ne 0 -and -not $AllowFailure) { throw "Git failed (exit $($r.Code)). See log." }
    return $r
}
function Publish-Pending {
    $null = Git (@('add','--') + $files)
    $diff = Git @('diff','--cached','--quiet') -AllowFailure
    if ($diff.Code -gt 1) { throw 'Cannot inspect staged output.' }
    if ($diff.Code -eq 1) {
        $null = Git @('-c','user.name=tigerair-local[bot]','-c','user.email=tigerair-local@users.noreply.github.com','commit','-m',('Local fare update ' + (Get-Date -Format o)))
    }
    # Retry only the push of the same commit, never merge competing state files.
    for ($attempt=1; $attempt -le 3; $attempt++) {
        $push = Git @('push','origin',('HEAD:refs/heads/' + $config.Branch)) -AllowFailure
        if ($push.Code -eq 0) { return }
        Write-Log "Push attempt $attempt failed; local commit retained."
    }
    throw 'Push failed three times. No force push or automatic state merge; inspect divergence/auth/network.'
}
try {
    try { $lock = [IO.File]::Open((Join-Path $local 'run.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
    catch [IO.IOException] { Write-Log 'Another wrapper holds the lock; skipped.'; exit 0 }
    Save-Result 'running'
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $local 'config.json') | ConvertFrom-Json
    if ([int]$config.LogRetentionDays -lt 1) { throw 'LogRetentionDays must be at least 1.' }
    if (-not (Test-Path -LiteralPath $config.NodePath -PathType Leaf)) { throw 'Node executable missing. Update .local/config.json.' }
    $version = Invoke-Child $config.NodePath @('--version')
    if ($version.Code -ne 0 -or [int]($version.Output.Trim().TrimStart('v').Split('.')[0]) -lt 24) { throw 'Node 24+ is required.' }
    Get-ChildItem -LiteralPath $logs -Filter '*.log' -File | Where-Object LastWriteTime -LT (Get-Date).AddDays(-[int]$config.LogRetentionDays) | Remove-Item
    $env:EMAIL_ENABLED = 'false'
    $env:GITHUB_REPOSITORY = $config.Repository
    $nodeArgs = @((Join-Path $root 'tools/watch.mjs'))
    if ($DryRun) { $nodeArgs += '--dry' }
    if ($Fixture) {
        if (-not $DryRun) { throw 'Fixtures are only allowed with -DryRun.' }
        $nodeArgs += '--fixture=' + $Fixture
    }
    if (-not $DryRun) {
        $stage = 'preflight'
        $workflow = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root '.github/workflows/watch.yml')
        if ($workflow -match '(?m)^\s{2}schedule\s*:') { throw 'Cloud cron still exists. Complete the cutover before live execution.' }
        $tokenFile = Join-Path $local 'github-token.dpapi'
        $secret = (Get-Content -Raw -LiteralPath $tokenFile).Trim() | ConvertTo-SecureString
        $env:GITHUB_TOKEN = (New-Object Net.NetworkCredential('', $secret)).Password
        if (-not $env:GITHUB_TOKEN) { throw 'GitHub token is empty.' }
        $env:GIT_TERMINAL_PROMPT = '0'
        $env:GCM_INTERACTIVE = 'Never'
        $env:GIT_CONFIG_COUNT = '1'
        $env:GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader'
        $env:GIT_CONFIG_VALUE_0 = 'AUTHORIZATION: basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('x-access-token:' + $env:GITHUB_TOKEN))
        $branch = Git @('branch','--show-current')
        if ($branch.Output.Trim() -ne $config.Branch) { throw 'Wrong Git branch.' }
        $origin = Git @('remote','get-url','origin')
        if ($origin.Output.Trim() -ne ('https://github.com/' + $config.Repository + '.git')) { throw 'Unexpected origin URL.' }
        $staged = Git @('diff','--cached','--name-only')
        if ($staged.Output.Trim()) { throw 'Staged changes exist. Review and unstage them first.' }
        $changed = Git @('diff','--name-only')
        foreach ($path in ($changed.Output -split '\r?\n')) {
            if ($path -and $path -notin $files) { throw "Tracked source has uncommitted changes: $path" }
        }
        # Flush any previous interrupted run before pulling; preserve its notification acknowledgements.
        $stage = 'publish-recovery'
        Publish-Pending
        $stage = 'sync'
        $null = Git @('pull','--ff-only','origin',$config.Branch)
        if ((Get-Content -Raw -Encoding UTF8 (Join-Path $root '.github/workflows/watch.yml')) -match '(?m)^\s{2}schedule\s*:') { throw 'Remote reintroduced cloud cron; refusing concurrent writers.' }
        # Do not let the entrypoint's fallback silently reset malformed persisted state.
        foreach ($jsonFile in @('tools/state.json','status.json')) {
            try { $null = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $root $jsonFile) | ConvertFrom-Json }
            catch { throw "Invalid persisted JSON: $jsonFile. Inspect backups before retrying." }
        }
        $backup = Join-Path $local ('backup/' + $stamp)
        [IO.Directory]::CreateDirectory($backup) | Out-Null
        foreach ($path in $files) {
            $target = Join-Path $backup $path
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            Copy-Item -LiteralPath (Join-Path $root $path) -Destination $target
        }
        $backupRoot = [IO.Path]::GetFullPath((Join-Path $local 'backup')) + [IO.Path]::DirectorySeparatorChar
        Get-ChildItem -LiteralPath (Join-Path $local 'backup') -Directory | Where-Object LastWriteTime -LT (Get-Date).AddDays(-[int]$config.LogRetentionDays) | ForEach-Object {
            $oldBackup = [IO.Path]::GetFullPath($_.FullName)
            if (-not $oldBackup.StartsWith($backupRoot, [StringComparison]::OrdinalIgnoreCase) -or ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe backup cleanup path.' }
            Remove-Item -LiteralPath $oldBackup -Recurse -Force
        }
    }
    $stage = 'watch'
    Save-Result 'running'
    $watch = Invoke-Child $config.NodePath $nodeArgs 480
    $result = $watch.Code
    if (-not $DryRun) {
        # Existing entrypoint saves retry queue even when notification delivery fails.
        $stage = 'publish'
        Publish-Pending
    }
    $stage = 'complete'
} catch {
    $result = 2
    Write-Log ('ERROR: ' + $_.Exception.Message)
} finally {
    if ($lock) {
        Save-Result $(if ($result -eq 0) { 'success' } else { 'failed' })
        Write-Log "END exit=$result stage=$stage"
        $lock.Dispose()
    }
    foreach ($key in @('GITHUB_TOKEN','GIT_CONFIG_VALUE_0')) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
}
exit $result
