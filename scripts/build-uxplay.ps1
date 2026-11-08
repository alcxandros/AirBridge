# Runs scripts/build-uxplay.sh inside MSYS2 UCRT64.
# Needs MSYS2 at C:\msys64 (winget install MSYS2.MSYS2) or set $env:MSYS2_ROOT.
$ErrorActionPreference = 'Stop'
$msys = if ($env:MSYS2_ROOT) { $env:MSYS2_ROOT } else { 'C:\msys64' }
$bash = Join-Path $msys 'usr\bin\bash.exe'
if (-not (Test-Path $bash)) {
  Write-Error "MSYS2 not found at $msys. Install it with: winget install MSYS2.MSYS2"
}
$env:MSYSTEM = 'UCRT64'
$env:CHERE_INVOKING = '1'
$win = (Resolve-Path (Join-Path $PSScriptRoot 'build-uxplay.sh')).Path
# C:\path\to\x.sh -> /c/path/to/x.sh
$unix = '/' + $win.Substring(0, 1).ToLower() + ($win.Substring(2) -replace '\\', '/')
& $bash -lc "bash '$unix'"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
