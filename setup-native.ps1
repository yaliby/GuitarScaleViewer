param([switch]$SkipRust)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$toolsDir = Join-Path $PSScriptRoot '.tools'
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$env:PYINSTALLER_CONFIG_DIR = Join-Path $toolsDir 'pyinstaller-cache'
$env:CARGO_HOME = Join-Path $toolsDir 'cargo'
$env:RUSTUP_HOME = Join-Path $toolsDir 'rustup'
$env:Path = (Join-Path $env:CARGO_HOME 'bin') + ';' + $env:Path
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
Write-Host 'Native dependencies and standalone analyzer are ready. Run ./dev.ps1.'
