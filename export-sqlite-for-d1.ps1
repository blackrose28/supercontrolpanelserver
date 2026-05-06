# Export SQLite data for D1 import (without transaction statements)
# Usage: .\export-sqlite-for-d1.ps1 [sqlite_db_path] [output_sql_file]

$ErrorActionPreference = "Stop"

$sqliteDb = if ($args[0]) { $args[0] } else { "data/cc-server.sqlite" }
$outputFile = if ($args[1]) { $args[1] } else { "backups/cc-server-data-for-d1.sql" }

if (-not (Test-Path $sqliteDb)) {
    Write-Error "ERROR: SQLite database not found: $sqliteDb"
    Write-Host "Usage: .\export-sqlite-for-d1.ps1 [sqlite_db_path] [output_sql_file]"
    exit 1
}

$outputDir = [System.IO.Path]::GetDirectoryName($outputFile)
if ($outputDir -and -not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
}

Write-Host "Exporting data from $sqliteDb to $outputFile..."

# Check if sqlite3 is available
if (-not (Get-Command sqlite3 -ErrorAction SilentlyContinue)) {
    Write-Error "ERROR: sqlite3 CLI not found. Please install sqlite3."
    exit 1
}

# Run sqlite3 and filter the output
# The original script uses multiple greps to exclude certain lines
& sqlite3 "$sqliteDb" ".mode insert" ".dump" | Where-Object {
    $_ -notmatch '^BEGIN TRANSACTION' -and
    $_ -notmatch '^COMMIT' -and
    $_ -notmatch '^SAVEPOINT' -and
    $_ -notmatch '^RELEASE ' -and
    $_ -notmatch '^ROLLBACK' -and
    $_ -notmatch '^PRAGMA' -and
    $_ -notmatch '^CREATE TABLE' -and
    $_ -notmatch '^CREATE INDEX' -and
    $_ -notmatch 'INSERT INTO sqlite_sequence' -and
    $_ -notmatch '^ANALYZE'
} | Set-Content "$outputFile"

Write-Host "Done! Cleaned SQL written to: $outputFile" -ForegroundColor Green
Write-Host ""
Write-Host "Now import with:"
Write-Host "  npx wrangler d1 execute cc-server --remote --file $outputFile"
