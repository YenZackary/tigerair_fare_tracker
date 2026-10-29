[CmdletBinding()]
param([switch]$FromGh)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$local = Join-Path $root '.local'
[IO.Directory]::CreateDirectory($local) | Out-Null
if ($FromGh) {
    $plain = & gh.exe auth token --hostname github.com
    if ($LASTEXITCODE -ne 0 -or -not $plain) { throw 'GitHub CLI login unavailable. Run gh auth login --web first.' }
    $token = ConvertTo-SecureString -String $plain -AsPlainText -Force
    $plain = $null
} else {
    $token = Read-Host 'GitHub fine-grained PAT (Contents read/write, Issues read/write; selected repository only)' -AsSecureString
}
if ($token.Length -eq 0) { throw 'Token is empty.' }
$token | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $local 'github-token.dpapi') -Encoding ASCII
Write-Host 'Saved using Windows DPAPI. Only the same Windows account on this computer can decrypt it.'
