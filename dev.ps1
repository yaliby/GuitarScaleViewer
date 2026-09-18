param([switch]$Build, [switch]$Test)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$env:CARGO_HOME = Join-Path $PSScriptRoot '.tools/cargo'
$env:RUSTUP_HOME = Join-Path $PSScriptRoot '.tools/rustup'
$env:Path = (Join-Path $env:CARGO_HOME 'bin') + ';C:/Program Files/nodejs;' + $env:Path
$analyzer = Join-Path $PSScriptRoot 'src-tauri/sidecars/key_analyzer/dist/key_analyzer/key_analyzer.exe'
if (-not (Test-Path $analyzer) -or -not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    & (Join-Path $PSScriptRoot 'setup-native.ps1')
} elseif ($Build) {
    # Always include current analyzer sources in a release package.
    & (Join-Path $PSScriptRoot 'setup-native.ps1') -SkipRust
}
if (-not (Test-Path 'node_modules')) {
    npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
}
$env:KEY_ANALYZER_SIDECAR = $analyzer
$env:KEY_ANALYZER_PYTHON = Join-Path $PSScriptRoot '.tools/analyzer-venv/Scripts/python.exe'
if (-not $env:KEY_ANALYZER_BACKEND) { $env:KEY_ANALYZER_BACKEND = 'current' }
if (-not $env:KEY_ANALYZER_AB) { $env:KEY_ANALYZER_AB = '0' }
if ($Test) {
    $env:RUN_KEY_FIXTURES = '1'
    cargo test --manifest-path src-tauri/Cargo.toml
    if ($LASTEXITCODE -ne 0) { throw 'Native tests failed.' }
    & $env:KEY_ANALYZER_PYTHON -m unittest discover -s src-tauri/sidecars/key_analyzer -p 'test_*.py'
} elseif ($Build) {
    & node_modules/.bin/tauri.cmd build
} else {
    & node_modules/.bin/tauri.cmd dev
}
if ($LASTEXITCODE -ne 0) { throw 'Native command failed; see output above.' }
