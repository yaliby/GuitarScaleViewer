# Dev runner: Vite + Tauri + Python analyzer sidecar (Windows).
# - Ensures Node is on PATH for fresh terminals
# - Ensures Python sidecar can run and has required deps
# - Verifies analyzer model health (Essentia) before starting dev
#   By default this is STRICT: if Essentia is unavailable, the script stops.
#   To allow a degraded run (analyzer_unavailable, Apply disabled), set:
#     $env:ALLOW_DEGRADED_ANALYZER = "1"
# - Sets env vars so Rust can consistently find the sidecar
# - Optional analyzer backend switch:
#     $env:KEY_ANALYZER_BACKEND = "current"      # default path (Essentia sidecar)
#     $env:KEY_ANALYZER_BACKEND = "libkeyfinder" # temporary spike backend via WSL CLI

param(
  [switch]$InstallWslOnly
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Write-Host "dev.ps1: starting..."
$hasNativePref = Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue
if ($hasNativePref) { $global:PSNativeCommandUseErrorActionPreference = $false }
$script:PythonSelector = @("-3")
$script:PythonExecutable = "py"
$script:PythonExePath = $null
if (-not $env:ALLOW_DEGRADED_ANALYZER) { $env:ALLOW_DEGRADED_ANALYZER = "0" }
$logDir = Join-Path $PSScriptRoot "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "gsv-dev.log"
Remove-Item -Force -ErrorAction SilentlyContinue $logFile
$env:GSV_LOG_DIR = $logDir
Write-Host "dev.ps1: log file will be written to $logFile (reset each run)"

if ($InstallWslOnly) {
  Write-Host "dev.ps1: installing WSL2/Ubuntu (elevated mode)..."
  & wsl --install -d Ubuntu
  exit $LASTEXITCODE
}

function Add-ToPathIfExists([string]$dir) {
  if (Test-Path $dir) {
    if (-not ($env:Path -split ";" | Where-Object { $_ -ieq $dir })) {
      $env:Path = "$dir;" + $env:Path
    }
  }
}

function Resolve-PythonSelector() {
  # Prefer 3.11 for Essentia compatibility, but avoid invoking `py -3.11` because it can hang
  # (Store prompts / launcher refresh). If we already resolved a direct python.exe path, use it.
  if ($script:PythonExePath -and (Test-Path $script:PythonExePath)) {
    $script:PythonSelector = @()
    return
  }
  $script:PythonSelector = @("-3.11")
}

function Invoke-Python {
  param([string[]]$pyArgs)
  if ($script:PythonExePath -and (Test-Path $script:PythonExePath)) {
    & $script:PythonExePath @pyArgs
  } else {
    & py @($script:PythonSelector) @pyArgs
  }
}

function Ensure-Python311Installed() {
  Write-Host "dev.ps1: checking for Python 3.11..."
  # First, try to locate an existing Python 3.11 install directly (no `py` invocation).
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\\Python\\Python311\\python.exe"),
    "C:\\Program Files\\Python311\\python.exe",
    "C:\\Program Files (x86)\\Python311\\python.exe"
  )
  foreach ($c in $candidates) {
    if (Test-Path $c) {
      Write-Host "dev.ps1: found Python 3.11 at $c"
      $script:PythonExePath = $c
      $script:PythonSelector = @()
      $script:PythonExecutable = $c
      return
    }
  }

  Write-Host "Python 3.11 not found. Attempting automatic install via winget..."
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($null -eq $winget) {
    throw "Python 3.11 is required for Essentia, but winget is not available. Install Python 3.11 (x64) manually, then re-run dev.ps1."
  }

  # Try Microsoft Store/winget package. This is best-effort.
  $oldErr = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  & winget install --id Python.Python.3.11 -e --accept-package-agreements --accept-source-agreements
  $exit = $LASTEXITCODE
  $ErrorActionPreference = $oldErr
  if ($exit -ne 0) {
    throw "Automatic Python 3.11 install failed (winget exit $exit). Install Python 3.11 (x64) manually, then re-run dev.ps1."
  }

  Write-Host "Locating Python 3.11 executable..."
  foreach ($c in $candidates) {
    if (Test-Path $c) {
      $script:PythonExePath = $c
      $script:PythonSelector = @()
      $script:PythonExecutable = $c
      return
    }
  }
  throw "Python 3.11 install completed but python.exe was not found in expected locations. Restart terminal and re-run dev.ps1."
}

function Ensure-Python3() {
  Write-Host "dev.ps1: ensuring Python..."
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($null -eq $py) {
    throw "Python launcher 'py' not found. Install Python 3 (Windows) so 'py -3' works."
  }

  Ensure-Python311Installed
  if (-not $script:PythonExePath) {
    Resolve-PythonSelector
  }

  Write-Host "dev.ps1: validating Python version..."
  $versionStr = (Invoke-Python @("-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')") | Out-String).Trim()
  if ([string]::IsNullOrWhiteSpace($versionStr)) {
    throw "Failed to detect Python version from py launcher."
  }
  $version = [Version]$versionStr
  if ($version -lt [Version]"3.9") {
    throw "Python $versionStr is too old. Install Python 3.9+."
  }
  if ($version -ge [Version]"3.12") {
    throw "Detected Python $versionStr. Essentia wheels are not supported here. Install Python 3.11 and re-run dev.ps1."
  }

  if (-not $script:PythonExePath) {
    $script:PythonExecutable = (Invoke-Python @("-c", "import sys; print(sys.executable)") | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($script:PythonExecutable)) {
      throw "Failed to resolve selected Python executable path."
    }
  }
}

function Ensure-PipDeps() {
  Write-Host "Checking Python deps (numpy + essentia)..."
  $check = @"
import importlib
missing = []
for m in ("numpy","essentia"):
  try:
    importlib.import_module(m)
  except Exception:
    missing.append(m)
if missing:
  raise SystemExit("MISSING:" + ",".join(missing))
print("OK")
"@

  # `py -c` is sensitive to newlines/quoting; write a temp .py file for robustness.
  $tmp = Join-Path $env:TEMP ("gsv_py_check_{0}.py" -f ([guid]::NewGuid().ToString("N")))
  Set-Content -Path $tmp -Value $check -Encoding UTF8
  try {
    # Avoid treating the non-zero exit as a terminating error.
    $oldErr = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
      $global:PSNativeCommandUseErrorActionPreference = $false
    }
    # Capture stderr too since missing-module exits print to stderr.
    $out = (Invoke-Python @($tmp) 2>&1 | Out-String).Trim()
    $exit = $LASTEXITCODE
    $ErrorActionPreference = $oldErr
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  }

  $needsInstall = $false
  if ($exit -ne 0 -and $out -is [string] -and $out -match "MISSING:([A-Za-z0-9_,]+)") {
    $needsInstall = $true
    $missing = $Matches[1].Trim()
    Write-Host "Missing deps detected: $missing"
  }

  # Hard validation: imports must actually work (not just be installed).
  Write-Host "Validating Python imports..."
  $oldErr = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
    $global:PSNativeCommandUseErrorActionPreference = $false
  }
  Invoke-Python @("-c", "import numpy, essentia.standard; print('IMPORT_OK')") *> $null
  $importExit = $LASTEXITCODE
  $ErrorActionPreference = $oldErr

  if ($needsInstall -or $importExit -ne 0) {
    # If WSL is available, prefer WSL analyzer setup immediately instead of repeatedly attempting
    # unsupported Windows Essentia builds.
    $wslCmd = Get-Command wsl -ErrorAction SilentlyContinue
    if ($null -ne $wslCmd -and $env:ALLOW_DEGRADED_ANALYZER -ne "1") {
      Write-Host "Windows Essentia unavailable; preferring WSL analyzer setup..."
      Ensure-WslEssentia
      return
    }

    Write-Host "Installing Python deps (numpy + essentia)..."
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
      $global:PSNativeCommandUseErrorActionPreference = $false
    }
    Invoke-Python @("-m", "pip", "install", "--upgrade", "pip") | Out-Null
    Invoke-Python @("-m", "pip", "install", "--upgrade", "numpy") | Out-Null

    Write-Host "Installing Essentia (best effort)..."
    $oldErr = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
      $global:PSNativeCommandUseErrorActionPreference = $false
    }
    try {
      $essOut = (Invoke-Python @("-m", "pip", "install", "--upgrade", "essentia") 2>&1 | Out-String).Trim()
      $essExit = $LASTEXITCODE
    } catch {
      $essOut = ($_ | Out-String).Trim()
      $essExit = 1
    }
    $ErrorActionPreference = $oldErr
    if ($essExit -ne 0) {
      Write-Host "Essentia install failed."
      if (-not [string]::IsNullOrWhiteSpace($essOut)) { Write-Host $essOut }
      if ($env:ALLOW_DEGRADED_ANALYZER -eq "1") {
        Write-Host "Continuing because ALLOW_DEGRADED_ANALYZER=1"
        return
      }
      Write-Host "Attempting automatic WSL2 fallback for Essentia..."
      Ensure-WslEssentia
      return
    }

    Write-Host "Re-validating Python imports..."
    Invoke-Python @("-c", "import numpy, essentia.standard; print('IMPORT_OK')") | Out-Null
    if ($LASTEXITCODE -ne 0) {
      if ($env:ALLOW_DEGRADED_ANALYZER -eq "1") {
        Write-Host "WARNING: imports still failing; continuing because ALLOW_DEGRADED_ANALYZER=1"
        return
      }
      throw "Python deps still not importable (Essentia required). Set ALLOW_DEGRADED_ANALYZER=1 to run degraded."
    }
  } else {
    Write-Host "Python deps OK."
  }
}

# Installs Essentia inside WSL2/Ubuntu and configures the app to run the analyzer via WSL.
function Ensure-WslEssentia() {
  $sidecarWin = (Join-Path $PSScriptRoot "src-tauri\sidecars\key_analyzer\key_analyzer.py")
  if (-not (Test-Path $sidecarWin)) {
    throw "Analyzer sidecar not found at $sidecarWin"
  }

  $wsl = Get-Command wsl -ErrorAction SilentlyContinue
  if ($null -eq $wsl) {
    throw "wsl.exe not found. WSL2 is required for automatic Essentia install on this machine."
  }

  # Detect "WSL not installed" state (wsl.exe exists but subsystem/features aren't enabled yet).
  $oldErr = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $statusOut = (& wsl --status 2>&1 | Out-String)
  $statusExit = $LASTEXITCODE
  $ErrorActionPreference = $oldErr

  if ($statusExit -ne 0 -or ($statusOut -match "not installed" -or $statusOut -match "is not installed")) {
    Write-Host "WSL2 is not installed/enabled. Attempting automatic install (Ubuntu)..."
    & wsl --install -d Ubuntu
    if ($LASTEXITCODE -ne 0) {
      Write-Host "WSL install needs elevation. Launching elevated installer..."
      $self = $MyInvocation.MyCommand.Path
      $installArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -InstallWslOnly"
      Start-Process -FilePath "powershell" -Verb RunAs -ArgumentList $installArgs | Out-Null
      throw "Please approve the UAC prompt to install WSL2/Ubuntu. After it finishes, reboot if prompted, then re-run dev.ps1."
    }
    Write-Host "WSL2 install was triggered. Windows may require a reboot to finish enabling WSL."
    Write-Host "Reboot now, then re-run dev.ps1 (it will continue automatically)."
    exit 0
  }

  # If WSL is installed but no distributions are installed yet, install Ubuntu.
  $oldErr = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $distros = (& wsl --list --quiet 2>&1 | Out-String).Trim()
  $distrosExit = $LASTEXITCODE
  $ErrorActionPreference = $oldErr
  $hasAnyDistro = ($distrosExit -eq 0 -and -not [string]::IsNullOrWhiteSpace($distros))
  if (-not $hasAnyDistro) {
    Write-Host "WSL is installed but no Linux distributions are installed. Installing Ubuntu..."
    $oldErr = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & wsl --install -d Ubuntu
    $installExit = $LASTEXITCODE
    $ErrorActionPreference = $oldErr
    if ($installExit -ne 0) {
      Write-Host "Ubuntu install needs elevation. Launching elevated installer..."
      $self = $MyInvocation.MyCommand.Path
      $installArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$self`" -InstallWslOnly"
      Start-Process -FilePath "powershell" -Verb RunAs -ArgumentList $installArgs | Out-Null
      throw "Please approve the UAC prompt to install Ubuntu for WSL. After it finishes, re-run dev.ps1."
    }
    Write-Host "Ubuntu install triggered."
    Write-Host "Next steps (automatic continues after this):"
    Write-Host "  - Wait for Ubuntu provisioning to finish (it may open a window)."
    Write-Host "  - If prompted to create a Linux user/password, complete it."
    Write-Host "  - If Windows asks for a reboot, reboot."
    Write-Host "Then re-run dev.ps1."
    exit 0
  }

  Write-Host "Ensuring Ubuntu is initialized..."
  $psiInit = New-Object System.Diagnostics.ProcessStartInfo
  $psiInit.FileName = "wsl.exe"
  $psiInit.Arguments = "-e bash -lc `"echo wsl_ok`""
  $psiInit.UseShellExecute = $false
  $psiInit.RedirectStandardOutput = $true
  $psiInit.RedirectStandardError = $true
  $psiInit.CreateNoWindow = $true
  $pInit = New-Object System.Diagnostics.Process
  $pInit.StartInfo = $psiInit
  [void]$pInit.Start()
  if (-not $pInit.WaitForExit(15000)) {
    try { $pInit.Kill() | Out-Null } catch {}
    Write-Host "Ubuntu appears installed but not initialized yet (first-run setup may be waiting)."
    Write-Host "Please complete the one-time Ubuntu initialization:"
    Write-Host "  - Open Start Menu -> 'Ubuntu' and finish creating the Linux user/password"
    Write-Host "  - Or run: wsl -d Ubuntu"
    Write-Host "Then re-run dev.ps1."
    exit 0
  }
  $initOut = ($pInit.StandardOutput.ReadToEnd() + $pInit.StandardError.ReadToEnd()).Trim()
  $initExit = $pInit.ExitCode
  if ($initExit -ne 0) {
    if ($initOut -match "no installed distributions") {
      Write-Host "WSL reports no installed distributions. Installing Ubuntu..."
      & wsl --install -d Ubuntu
      Write-Host "Ubuntu install triggered. Re-run dev.ps1 after install completes."
      exit 0
    }
    throw "WSL exists but Ubuntu isn't ready yet. Output: $initOut"
  }

  Write-Host "Installing analyzer deps inside WSL (Ubuntu)..."
  # Ubuntu may block system pip installs (PEP 668). Use a dedicated venv for the analyzer.
  $wslUser = $env:USERNAME
  if ([string]::IsNullOrWhiteSpace($wslUser)) { $wslUser = "rdpuser" }
  $venvDir = "/home/$wslUser/.gsv-key-analyzer-venv"
  $venvPy = "$venvDir/bin/python"
  $venvPip = "$venvDir/bin/pip"

  # IMPORTANT: pass a single-line bash script to avoid CRLF (`\r`) issues.
  $installCmd = @(
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update -y",
    "apt-get install -y python3 python3-venv python3-pip",
    "(apt-get install -y python3-essentia || true)",
    "python3 -m venv $venvDir",
    "$venvPip install --upgrade pip",
    "$venvPip install --upgrade numpy",
    "$venvPip install --upgrade essentia",
    "chown -R ${wslUser}:${wslUser} $venvDir"
  ) -join "; "
  & wsl -u root -e bash -lc "$installCmd"
  if ($LASTEXITCODE -ne 0) {
    throw "WSL Essentia install failed."
  }

  function Invoke-WslReadLine([string]$bashCmd, [int]$timeoutMs = 12000) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "wsl.exe"
    $psi.Arguments = "-e bash -lc `"$bashCmd`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    [void]$p.Start()

    try {
      $task = $p.StandardOutput.ReadLineAsync()
      if (-not $task.Wait($timeoutMs)) {
        throw "WSL command timed out while waiting for output: $bashCmd"
      }
      return ($task.Result | Out-String).Trim()
    } finally {
      try { if (-not $p.HasExited) { $p.Kill() | Out-Null } } catch {}
    }
  }

  Write-Host "Converting sidecar path to WSL path..."
  # Avoid `wslpath` here: it can mangle backslashes depending on quoting.
  if ($sidecarWin.Length -lt 3 -or $sidecarWin[1] -ne ":") {
    throw "Unexpected Windows path for sidecar: $sidecarWin"
  }
  $drive = $sidecarWin.Substring(0, 1).ToLower()
  $rest = $sidecarWin.Substring(2) -replace "\\", "/"
  if (-not $rest.StartsWith("/")) { $rest = "/" + $rest }
  $wslPath = "/mnt/$drive$rest"

  Write-Host "Validating sidecar in WSL..."
  $ready = Invoke-WslReadLine "$venvPy '$wslPath' --serve"
  if ([string]::IsNullOrWhiteSpace($ready)) {
    throw "WSL sidecar did not output ready line."
  }
  $readyJson = $ready | ConvertFrom-Json
  if (-not [bool]$readyJson.essentiaAvailable) {
    throw "WSL sidecar still reports essentiaAvailable=false. Error: $($readyJson.essentiaError)"
  }

  # Tell Rust to use WSL sidecar.
  $env:KEY_ANALYZER_WSL_SIDECAR = $wslPath
  $env:KEY_ANALYZER_WSL_PYTHON = $venvPy
  Write-Host "WSL analyzer configured: KEY_ANALYZER_WSL_SIDECAR=$wslPath"
}

function Ensure-LibKeyfinderSpikeWsl() {
  Write-Host "Ensuring libkeyfinder spike CLI in WSL..."
  $rootWin = $PSScriptRoot
  if ($rootWin.Length -lt 3 -or $rootWin[1] -ne ":") {
    throw "Unexpected Windows path for project root: $rootWin"
  }
  $drive = $rootWin.Substring(0, 1).ToLower()
  $rest = $rootWin.Substring(2) -replace "\\", "/"
  if (-not $rest.StartsWith("/")) { $rest = "/" + $rest }
  $rootWsl = "/mnt/$drive$rest"
  $buildCmd = @(
    "set -euo pipefail",
    "BUILD_ROOT=/home/$env:USERNAME/.gsv-libkeyfinder-spike",
    "LIB_REPO=`$BUILD_ROOT/libkeyfinder",
    "CLI_SRC=`"$rootWsl/src-tauri/sidecars/libkeyfinder_cli/main.cpp`"",
    "CLI_BIN=`$BUILD_ROOT/gsv-libkeyfinder-cli",
    "apt-get update -y >/dev/null",
    "apt-get install -y git cmake build-essential pkg-config libfftw3-dev libsndfile1-dev >/dev/null",
    "mkdir -p `$BUILD_ROOT",
    "if [ ! -d `$LIB_REPO ]; then git clone --depth 1 https://github.com/mixxxdj/libkeyfinder.git `$LIB_REPO; else git -C `$LIB_REPO fetch --depth 1 origin >/dev/null && git -C `$LIB_REPO reset --hard origin/master >/dev/null; fi",
    "cmake -S `$LIB_REPO -B `$LIB_REPO/build >/dev/null",
    "cmake --build `$LIB_REPO/build -j`$(nproc) >/dev/null",
    "cmake --install `$LIB_REPO/build >/dev/null",
    "ldconfig",
    "g++ -std=c++17 `$CLI_SRC -o `$CLI_BIN -lkeyfinder -lsndfile",
    "chown -R $env:USERNAME:$env:USERNAME `$BUILD_ROOT"
  ) -join "; "
  & wsl -u root -e bash -lc "$buildCmd"
  if ($LASTEXITCODE -ne 0) {
    throw "WSL libkeyfinder setup failed."
  }
  $env:KEY_ANALYZER_LIBKEYFINDER_WSL_CLI = "/home/$env:USERNAME/.gsv-libkeyfinder-spike/gsv-libkeyfinder-cli"
  Write-Host "libkeyfinder CLI configured (WSL): $env:KEY_ANALYZER_LIBKEYFINDER_WSL_CLI"
}

# Validates that the analyzer sidecar is healthy (Essentia available) before running the app.
function Ensure-AnalyzerModelsHealthy() {
  if ($env:KEY_ANALYZER_WSL_SIDECAR) {
    $wslPath = $env:KEY_ANALYZER_WSL_SIDECAR
    $wslPy = $env:KEY_ANALYZER_WSL_PYTHON
    if ([string]::IsNullOrWhiteSpace($wslPy)) { $wslPy = "python3" }
    Write-Host "Validating analyzer sidecar health via WSL (Essentia required)..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "wsl.exe"
    $psi.Arguments = "-e bash -lc `"$wslPy '$wslPath' --serve`""
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()
    try {
      $task = $proc.StandardOutput.ReadLineAsync()
      if (-not $task.Wait(12000)) {
        throw "WSL sidecar timed out while waiting for ready line."
      }
      $ready = ($task.Result | Out-String).Trim()
    } finally {
      try { if (-not $proc.HasExited) { $proc.Kill() | Out-Null } } catch {}
    }
    if ([string]::IsNullOrWhiteSpace($ready)) {
      throw "WSL sidecar did not output a ready line."
    }
    $readyJson = $ready | ConvertFrom-Json
    Write-Host ("Analyzer ready (WSL): essentiaAvailable={0} numpyAvailable={1}" -f [bool]$readyJson.essentiaAvailable, [bool]$readyJson.numpyAvailable)
    if (-not [bool]$readyJson.essentiaAvailable) {
      throw "Essentia is required but unavailable in WSL. Error: $($readyJson.essentiaError)"
    }
    return
  }

  $sidecar = (Join-Path $PSScriptRoot "src-tauri\sidecars\key_analyzer\key_analyzer.py")
  if (-not (Test-Path $sidecar)) {
    throw "Analyzer sidecar not found at $sidecar"
  }

  for ($attempt = 0; $attempt -lt 2; $attempt++) {
    Write-Host "Validating analyzer sidecar health (Essentia required)..."
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $script:PythonExecutable
    $psi.Arguments = "`"$sidecar`" --serve"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = New-Object System.Diagnostics.Process
    $proc.StartInfo = $psi
    [void]$proc.Start()

    try {
      $readyLine = $proc.StandardOutput.ReadLine()
      if ([string]::IsNullOrWhiteSpace($readyLine)) {
        $err = $proc.StandardError.ReadToEnd()
        throw "Analyzer did not output a ready line. stderr: $err"
      }
      $ready = $readyLine | ConvertFrom-Json
      $ess = $false
      if ($null -ne $ready.essentiaAvailable) { $ess = [bool]$ready.essentiaAvailable }
      $numpyOk = $false
      if ($null -ne $ready.numpyAvailable) { $numpyOk = [bool]$ready.numpyAvailable }
      $essErr = ""
      if ($null -ne $ready.essentiaError) { $essErr = [string]$ready.essentiaError }

      Write-Host ("Analyzer ready: essentiaAvailable={0} numpyAvailable={1}" -f $ess, $numpyOk)
      if (-not $numpyOk) {
        throw "Analyzer numpy backend missing. This should not happen if Ensure-PipDeps passed."
      }
      if ($ess) { return }

      if ($attempt -eq 0) {
        Write-Host ("Essentia missing; attempting auto-install. Error: {0}" -f $essErr)
        Ensure-PipDeps
        continue
      }

      if ($env:ALLOW_DEGRADED_ANALYZER -eq "1") {
        Write-Host ("WARNING: Essentia unavailable; continuing in degraded mode. Error: {0}" -f $essErr)
        return
      }
      throw ("Essentia is required but unavailable. Error: {0}`nSet `$env:ALLOW_DEGRADED_ANALYZER=1 to run without key detection (Apply disabled)." -f $essErr)
    } finally {
      try { if (-not $proc.HasExited) { $proc.Kill() | Out-Null } } catch {}
    }
  }
}

# Ensure Node/npm work in terminals where PATH wasn't refreshed.
Add-ToPathIfExists "C:\Program Files\nodejs"

Set-Location $PSScriptRoot

Ensure-Python3
# Primary analyzer default: libkeyfinder (can be overridden by env before running dev.ps1).
if (-not $env:KEY_ANALYZER_BACKEND) { $env:KEY_ANALYZER_BACKEND = "libkeyfinder" }
# A/B compare: default ON in dev unless explicitly disabled.
if (-not $env:KEY_ANALYZER_AB) { $env:KEY_ANALYZER_AB = "1" }
if ($env:KEY_ANALYZER_BACKEND -eq "libkeyfinder" -or $env:KEY_ANALYZER_AB -eq "1") {
  Ensure-LibKeyfinderSpikeWsl
}
if ($env:KEY_ANALYZER_BACKEND -ne "libkeyfinder") {
  Ensure-PipDeps
  Ensure-AnalyzerModelsHealthy
} elseif ($env:KEY_ANALYZER_AB -eq "1") {
  # In A/B mode while libkeyfinder is primary, also provision the current analyzer path
  # so the comparison panel can run both engines without analyzer_unavailable noise.
  Ensure-WslEssentia
}

# Stable sidecar discovery for Rust.
$env:KEY_ANALYZER_PYTHON = $script:PythonExecutable
$env:KEY_ANALYZER_SIDECAR = (Join-Path $PSScriptRoot "src-tauri\sidecars\key_analyzer\key_analyzer.py")
$env:KEY_ANALYZER_VERBOSE = "1"
$env:RUST_LOG = "app_lib::key_engine=debug,app_lib::audio_capture=debug,app_lib::key_detection=debug,wasapi=warn,wasapi::api=warn"

Write-Host "Starting Tauri dev..."
npx tauri dev
