# D1 Migration Script for cc-server
# This script helps migrate from SQLite to Cloudflare D1
# Prerequisites: wrangler CLI installed and authenticated

$ErrorActionPreference = "Stop"

Write-Host "=== D1 Migration Script ===" -ForegroundColor Cyan
Write-Host ""

# Check if wrangler is available
if (-not (Get-Command wrangler -ErrorAction SilentlyContinue)) {
    Write-Error "ERROR: wrangler CLI not found. Install it with: npm install -g wrangler"
    exit 1
}

# Check if logged in to Cloudflare
Write-Host "Checking Cloudflare authentication..."
$whoami = & wrangler whoami 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host $whoami -ForegroundColor Red
    Write-Error "ERROR: Not logged in to Cloudflare. Run: wrangler login"
    exit 1
}

Write-Host "Creating D1 database..."
# Create D1 database and capture the output
# Redirect stderr to stdout to capture everything
$dbOutput = & wrangler d1 create cc-server 2>&1 | Out-String
Write-Host $dbOutput

# Extract database_id from output using regex
if ($dbOutput -match 'database_id\s*=\s*"([^"]+)"') {
    $dbId = $Matches[1]
    Write-Host "Updating wrangler.toml with database_id: $dbId" -ForegroundColor Green
    
    $tomlPath = "wrangler.toml"
    if (Test-Path $tomlPath) {
        # Create a backup first like sed -i.bak does
        Copy-Item $tomlPath "$tomlPath.bak" -Force
        
        $content = Get-Content $tomlPath -Raw
        # Perform the replacement using regex to be flexible with spacing
        $newContent = $content -replace 'database_id\s*=\s*"00000000-0000-0000-0000-000000000000"', "database_id = `"$dbId`""
        
        $newContent | Set-Content $tomlPath
        Write-Host "Updated wrangler.toml" -ForegroundColor Green
    } else {
        Write-Warning "wrangler.toml not found in current directory."
    }
} else {
    Write-Warning "Could not extract database_id automatically."
    Write-Host "Please manually update wrangler.toml with the database_id from the output above."
}

Write-Host ""
Write-Host "Applying D1 schema migration (remote)..." -ForegroundColor Cyan
& wrangler d1 migrations apply cc-server --remote

Write-Host "Applying D1 schema migration (local development)..." -ForegroundColor Cyan
& wrangler d1 migrations apply cc-server

Write-Host ""
Write-Host "=== Migration setup complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. If you have existing SQLite data to import:"
Write-Host "   - Stop cc-server to prevent new writes"
$timestamp = Get-Date -Format "yyyyMMddTHHmmssZ"
Write-Host "   - Backup: Copy-Item data/cc-server.sqlite backups/cc-server-$timestamp.sqlite"
Write-Host "   - Export: .\export-sqlite-for-d1.ps1 data/cc-server.sqlite backups/cc-server-data.sql"
Write-Host "   - Import: wrangler d1 execute cc-server --remote --file backups/cc-server-data.sql"
Write-Host "2. Start the Worker: wrangler deploy"
Write-Host "3. Or run locally: wrangler dev"
