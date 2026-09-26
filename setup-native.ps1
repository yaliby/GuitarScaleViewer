param([switch]$SkipRust, [switch]$ChordSyncOnly)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$toolsDir = Join-Path $PSScriptRoot '.tools'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$env:PYINSTALLER_CONFIG_DIR = Join-Path $toolsDir 'pyinstaller-cache'
$env:CARGO_HOME = Join-Path $toolsDir 'cargo'
$env:RUSTUP_HOME = Join-Path $toolsDir 'rustup'
$env:Path = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:Path

function Install-ChordSyncVenv {
    $venvDir = Join-Path $PSScriptRoot 'src-tauri/sidecars/chordsync/.venv'
    $pythonExe = Join-Path $venvDir 'Scripts/python.exe'
    $requirements = Join-Path $PSScriptRoot 'src-tauri/sidecars/chordsync/requirements.txt'
    $stampPath = Join-Path $venvDir '.requirements.sha256'
    if (-not (Test-Path $requirements)) {
        throw "ChordSync requirements not found at $requirements"
    }
    $stamp = (Get-FileHash -Algorithm SHA256 -Path $requirements).Hash
    if ((Test-Path $pythonExe) -and (Test-Path $stampPath)) {
        $recorded = (Get-Content -Raw -Path $stampPath).Trim()
        if ($recorded -eq $stamp) {
            & $pythonExe -c "import rapidfuzz"
            if ($LASTEXITCODE -eq 0) { return }
        }
    }
    if (-not (Test-Path $pythonExe)) {
        $creator = Join-Path $toolsDir 'analyzer-venv/Scripts/python.exe'
        if (Test-Path $creator) {
            & $creator -m venv $venvDir
        } else {
            python -m venv $venvDir
        }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pythonExe)) {
            throw 'ChordSync virtual environment creation failed. Install Python 3.13 for Windows, then retry.'
        }
    }
    & $pythonExe -m pip install --disable-pip-version-check -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'ChordSync dependency installation failed.' }
    & $pythonExe -c "import rapidfuzz"
    if ($LASTEXITCODE -ne 0) { throw 'ChordSync environment is missing rapidfuzz after install.' }
    Set-Content -Path $stampPath -Value $stamp -NoNewline
}

if ($ChordSyncOnly) {
    Install-ChordSyncVenv
    Write-Host 'ChordSync Python environment is ready.'
    $global:LASTEXITCODE = 0
    return
}

if (-not $SkipRust -and -not (Test-Path (Join-Path $env:CARGO_HOME 'bin/cargo.exe'))) {
    $installer = Join-Path $toolsDir 'rustup-init.exe'
    Invoke-WebRequest 'https://win.rustup.rs/x86_64' -OutFile $installer
    & $installer -y --no-modify-path --profile minimal --default-toolchain stable
    if ($LASTEXITCODE -ne 0) { throw 'Rust installation failed.' }
}
$analyzerPython = Join-Path $toolsDir 'analyzer-venv/Scripts/python.exe'
if (-not (Test-Path $analyzerPython)) {
    python -m venv (Join-Path $toolsDir 'analyzer-venv')
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.13 for Windows, then retry.' }
}
& $analyzerPython -m pip install -r src-tauri/sidecars/key_analyzer/requirements-windows.txt
if ($LASTEXITCODE -ne 0) { throw 'Analyzer dependency installation failed.' }
& $analyzerPython -m PyInstaller --noconfirm --clean --onedir --name key_analyzer --distpath src-tauri/sidecars/key_analyzer/dist --workpath .tools/analyzer-build --specpath .tools src-tauri/sidecars/key_analyzer/key_analyzer.py
if ($LASTEXITCODE -ne 0) { throw 'Analyzer packaging failed.' }
Install-ChordSyncVenv
$global:LASTEXITCODE = 0
Write-Host 'Native dependencies, ChordSync environment, and standalone analyzer are ready. Run ./dev.ps1.'
