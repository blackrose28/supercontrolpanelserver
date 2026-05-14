# Run npm using the Node.js installation under Program Files (avoids nvm PATH shims).
# Usage (from repo root or cc-server):
#   pwsh -File cc-server/scripts/npm-with-program-files-node.ps1 test
#   pwsh -File cc-server/scripts/npm-with-program-files-node.ps1 rebuild better-sqlite3
$ErrorActionPreference = 'Stop'
$ccServerRoot = Split-Path $PSScriptRoot -Parent
Set-Location $ccServerRoot
$npm = Join-Path ${env:ProgramFiles} 'nodejs\npm.ps1'
if (-not (Test-Path $npm)) {
  throw "npm.ps1 not found at $npm"
}
& $npm @args
exit $LASTEXITCODE
