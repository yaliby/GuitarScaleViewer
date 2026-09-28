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

function Install-HarmoniaVenv {
    # Whole-song chord analysis. harmonia_recognition.rs looks for harmonia/ml/.venv/Scripts/python.exe.
    $venvDir = Join-Path $PSScriptRoot 'harmonia/ml/.venv'
    $pythonExe = Join-Path $venvDir 'Scripts/python.exe'
    $requirements = Join-Path $PSScriptRoot 'harmonia/ml/requirements-windows.txt'
    $stampPath = Join-Path $venvDir '.requirements.sha256'
    $stamp = (Get-FileHash -Algorithm SHA256 -Path $requirements).Hash
    if ((Test-Path $pythonExe) -and (Test-Path $stampPath) -and
        ((Get-Content -Raw -Path $stampPath).Trim() -eq $stamp)) {
        return
    }
    Write-Host 'Installing the whole-song chord analysis environment (downloads PyTorch once)...'
    if (-not (Test-Path $pythonExe)) {
        python -m venv $venvDir
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pythonExe)) { throw 'Harmonia virtual environment creation failed.' }
    }
    & $pythonExe -m pip install --disable-pip-version-check -r $requirements
    if ($LASTEXITCODE -ne 0) { throw 'Harmonia dependency installation failed.' }
    & $pythonExe -c "import lv_chordia, torch, librosa"
    if ($LASTEXITCODE -ne 0) { throw 'Harmonia environment cannot import lv_chordia.' }
    Set-Content -Path $stampPath -Value $stamp -NoNewline
}

function Install-HarmoniaVenvOrWarn {
    # Chord analysis is optional; the app still starts without it.
    try { Install-HarmoniaVenv } catch { Write-Warning "Whole-song chord analysis stays unavailable: $_" }
}

function Install-BundledFfmpeg {
    $binDir = Join-Path $toolsDir 'ffmpeg/bin'
    $ffmpeg = Join-Path $binDir 'ffmpeg.exe'
    $ffprobe = Join-Path $binDir 'ffprobe.exe'
    if ((Test-Path $ffmpeg) -and (Test-Path $ffprobe)) {
        return
    }
    $systemFfmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
    $systemProbe = Get-Command ffprobe -ErrorAction SilentlyContinue
    if ($systemFfmpeg -and $systemProbe) {
        $encoders = & $systemFfmpeg.Source -hide_banner -encoders 2>&1 | Out-String
        if ($encoders -match 'libmp3lame') { return }
    }
    # GPL shared build: libmp3lame is required to save captures as MP3. Not committed; .tools is gitignored.
    $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip'
    $zip = Join-Path $toolsDir 'ffmpeg-win64-gpl.zip'
    $extract = Join-Path $toolsDir 'ffmpeg-extract'
    Write-Host 'Downloading FFmpeg so saved songs can be encoded to MP3...'
    if (Test-Path $zip) { Remove-Item -Force $zip }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & curl.exe -L --fail --retry 3 -o $zip $url
        if ($LASTEXITCODE -ne 0) { throw 'FFmpeg download failed.' }
    } else {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    }
    if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
    Expand-Archive -Path $zip -DestinationPath $extract -Force
    $found = Get-ChildItem -Path $extract -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if (-not $found) { throw 'FFmpeg archive did not contain ffmpeg.exe.' }
    if (Test-Path $binDir) { Remove-Item -Recurse -Force $binDir }
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item -Path (Join-Path $found.DirectoryName '*') -Destination $binDir -Force
    Remove-Item -Force $zip -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
    if (-not (Test-Path $ffmpeg) -or -not (Test-Path $ffprobe)) {
        throw 'FFmpeg setup did not produce ffmpeg.exe and ffprobe.exe.'
    }
    $encoders = & $ffmpeg -hide_banner -encoders 2>&1 | Out-String
    if ($encoders -notmatch 'libmp3lame') {
        throw 'Downloaded FFmpeg cannot encode MP3 (libmp3lame missing).'
    }
}

Install-BundledFfmpeg

if ($ChordSyncOnly) {
    Install-ChordSyncVenv
    Install-HarmoniaVenvOrWarn
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
Install-HarmoniaVenvOrWarn
$global:LASTEXITCODE = 0
Write-Host 'Native dependencies, ChordSync environment, and standalone analyzer are ready. Run ./dev.ps1.'
