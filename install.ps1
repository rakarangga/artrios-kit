# Artrios kit bootstrap for Windows PowerShell:
#   irm https://raw.githubusercontent.com/rakarangga/artrios-kit/kit-v0.2.0/install.ps1 | iex
# Clones the tagged kit to a fixed folder, then runs the wizard (install.py). Overrides for testing or a fork:
# ARTRIOS_KIT_REPO, ARTRIOS_KIT_TAG, ARTRIOS_KIT_DIR, ARTRIOS_KIT_ARGS.
# Runs inside a function and uses no "exit": under iex, exit would close the user's terminal.
function Install-ArtriosKit {
  $ErrorActionPreference = 'Stop'
  $repo = if ($env:ARTRIOS_KIT_REPO) { $env:ARTRIOS_KIT_REPO } else { 'https://github.com/rakarangga/artrios-kit.git' }
  $tag = if ($env:ARTRIOS_KIT_TAG) { $env:ARTRIOS_KIT_TAG } else { 'kit-v0.2.0' }
  $dir = if ($env:ARTRIOS_KIT_DIR) { $env:ARTRIOS_KIT_DIR } else { Join-Path $HOME 'artrios-kit' }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Host 'git is required. Install Git for Windows, open a new terminal, and run this again.'; return }

  # The Microsoft Store stub named python.exe fails this check, so it is never picked by mistake.
  $py = $null
  foreach ($c in @(@('py', '-3'), @('python'), @('python3'))) {
    if (Get-Command $c[0] -ErrorAction SilentlyContinue) {
      & $c[0] @($c | Select-Object -Skip 1) -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>$null
      if ($LASTEXITCODE -eq 0) { $py = $c; break }
    }
  }
  if (-not $py) { Write-Host 'Python 3.9 or newer is required. Install it from python.org, open a new terminal, and run this again.'; return }

  if (Test-Path (Join-Path $dir '.git')) {
    Write-Host "Using the kit in $dir"
    & git -C $dir fetch --tags --quiet
  } elseif ((Test-Path $dir) -and (Get-ChildItem -Force $dir | Select-Object -First 1)) {
    Write-Host "$dir exists and is not a kit clone. Move it, or set ARTRIOS_KIT_DIR."
    return
  } else {
    Write-Host "Cloning the kit to $dir"
    & git clone --quiet $repo $dir
    if ($LASTEXITCODE -ne 0) { Write-Host 'git clone failed; the error is above.'; return }
  }
  # Your own files (profile, registry) may block a tag change: git refuses and nothing is lost.
  & git -C $dir -c advice.detachedHead=false checkout --quiet $tag
  if ($LASTEXITCODE -ne 0) { Write-Host "Could not switch to $tag; the error is above."; return }

  $extra = if ($env:ARTRIOS_KIT_ARGS) { $env:ARTRIOS_KIT_ARGS -split '\s+' } else { @() }
  $pyArgs = @($py | Select-Object -Skip 1) + @((Join-Path $dir 'install.py'), '--wizard') + $extra
  & $py[0] @pyArgs
}

Install-ArtriosKit
Remove-Item Function:\Install-ArtriosKit -ErrorAction SilentlyContinue
