# Release obsidian-usage-norms (build artifacts -> GitHub Release, BRAT can pull)
#
# Usage, from the project root:
#   $env:GITHUB_TOKEN = 'ghp_...'      # classic token with repo scope
#   pwsh -File .\tools\release.ps1 -Tag 0.1.0 -Notes "first release"
#
# If GITHUB_TOKEN is not set it falls back to the "git:https://github.com"
# credential in Windows Credential Manager (non-interactive). The token is
# never printed and never written to disk by this script.
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes BOM-less .ps1 as ANSI,
# which garbles non-ASCII literals and breaks parsing.

param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Notes = '',
  [string]$Repo = 'night-system/obsidian-usage-norms'
)

$ErrorActionPreference = 'Stop'

$project = Split-Path -Parent $PSScriptRoot
$api     = "https://api.github.com/repos/$Repo"
$upload  = "https://uploads.github.com/repos/$Repo"
$assets  = @('manifest.json', 'main.js', 'styles.css')

# ---- 0. local sanity ----
$mfPath = Join-Path $project 'manifest.json'
$mf = Get-Content $mfPath -Raw | ConvertFrom-Json
if ($mf.version -ne $Tag) {
  throw "manifest.json version is '$($mf.version)' but you asked to release '$Tag'. Bump it first."
}
foreach ($f in $assets) {
  if (-not (Test-Path (Join-Path $project $f))) {
    throw "Missing artifact: $f (run 'npm run build' in the project dir first)"
  }
}
Write-Host "[1/5] artifacts present, manifest version = $Tag"

# ---- 1. token ----
$tok = $env:GITHUB_TOKEN
if (-not $tok) {
  $old = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  try {
    $cred = "protocol=https`nhost=github.com`n" | git credential fill 2>$null
    $tok = ($cred | Select-String '^password=(.*)$').Matches.Groups[1].Value
  } catch {
    $tok = $null
  } finally {
    $env:GIT_TERMINAL_PROMPT = $old
  }
}
if (-not $tok) { throw 'No GitHub token: set $env:GITHUB_TOKEN or store git credentials.' }
Write-Host "[2/5] token loaded (length $($tok.Length))"

$headers = @{
  Authorization = "token $tok"
  Accept        = 'application/vnd.github+json'
  'User-Agent'  = 'release-script'
}

# ---- 2. commit + push main + tag ----
Push-Location $project
try {
  if (-not (Test-Path (Join-Path $project '.git'))) { git init | Out-Null }
  git add -A
  git -c user.name='night-system' -c user.email='nightsystem@163.com' commit -m "release $Tag" 2>$null | Out-Null
  $remote = "https://x-access-token:$tok@github.com/$Repo.git"
  git push -f $remote HEAD:refs/heads/main
  if ($LASTEXITCODE -ne 0) { throw 'git push main failed' }
  git tag -f $Tag
  git push -f $remote "refs/tags/$Tag"
  if ($LASTEXITCODE -ne 0) { throw 'git push tag failed' }
} finally {
  Pop-Location
}
Write-Host "[3/5] pushed main + tag $Tag"

# ---- 3. create the release (or reuse) ----
$rel = $null
try {
  $rel = Invoke-RestMethod -Uri "$api/releases/tags/$Tag" -Headers $headers -Method Get
  Write-Host "[4/5] release $Tag already exists (id=$($rel.id)); uploading assets only"
} catch {
  if ($_.Exception.Response.StatusCode.value__ -ne 404) { throw }
  $payload = @{
    tag_name   = $Tag
    name       = "Release $Tag"
    body       = $Notes
    prerelease = $false
  } | ConvertTo-Json -Compress
  $rel = Invoke-RestMethod -Uri "$api/releases" -Headers $headers -Method Post `
           -Body $payload -ContentType 'application/json'
  Write-Host "[4/5] created release $Tag (id=$($rel.id))"
}

# ---- 4. upload assets (skip existing) ----
$existing = @()
if ($rel.assets) { $existing = $rel.assets | ForEach-Object { $_.name } }
foreach ($f in $assets) {
  if ($existing -contains $f) {
    Write-Host ("{0,-15} already uploaded, skipped" -f $f)
    continue
  }
  $r = Invoke-RestMethod -Uri "$upload/releases/$($rel.id)/assets?name=$f" `
         -Headers $headers -Method Post `
         -InFile (Join-Path $project $f) -ContentType 'application/octet-stream'
  Write-Host ("{0,-15} {1,8} bytes  uploaded" -f $r.name, $r.size)
}

Write-Host ''
Write-Host "[5/5] done -> https://github.com/$Repo/releases/tag/$Tag"
Write-Host 'BRAT can now pull it (Add beta plugin / Check for updates).'
