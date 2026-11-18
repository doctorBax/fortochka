param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path $Executable).Path
if (!(Test-Path $exe)) { throw "Packaged Electron executable missing: $exe" }

# Never attach smoke to a real Telegram session/profile on the CI runner.
$profile = Join-Path $env:RUNNER_TEMP ("fortochka-smoke-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile -Force | Out-Null
$env:FORTOCHKA_USER_DATA = $profile
$out = Join-Path $profile 'stdout.log'
$err = Join-Path $profile 'stderr.log'
Write-Host "Packaged smoke: $exe"
$p = Start-Process -FilePath $exe -ArgumentList '--smoke-offline' -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
try {
  if (-not $p.WaitForExit(180000)) {
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    throw 'Packaged Windows smoke timed out after 180 seconds'
  }
  $stdout = Get-Content -Raw -Path $out -ErrorAction SilentlyContinue
  $stderr = Get-Content -Raw -Path $err -ErrorAction SilentlyContinue
  Write-Host $stdout
  if ($stderr) { Write-Host "stderr: $stderr" }
  if ($p.ExitCode -ne 0) { throw "Packaged Windows smoke exited $($p.ExitCode)" }
  if ($stdout -notmatch '(?m)^SMOKE_OK\s+(.+)$') { throw 'No SMOKE_OK result in packaged application output' }
  $result = $Matches[1] | ConvertFrom-Json
  if ($result.version -ne $ExpectedVersion) {
    throw "Expected version $ExpectedVersion, got $($result.version)"
  }
  if (!$result.webapp.hasPageChats -or $result.sw.count -lt 1 -or !$result.fronts.ok) {
    throw 'Packaged webapp, service worker, or fronts endpoint failed'
  }
  if (!$result.tgwsRunning) { throw 'Packaged native tg-ws-proxy did not start' }
  Write-Host "PACKAGED_WINDOWS_OK $ExpectedVersion"
} finally {
  Remove-Item Env:FORTOCHKA_USER_DATA -ErrorAction SilentlyContinue
}
