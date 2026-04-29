#!/bin/bash
# D1 Migration Script for cc-server
# This script helps migrate from SQLite to Cloudflare D1
# Prerequisites: wrangler CLI installed and authenticated

set -e

echo "=== D1 Migration Script ==="
echo ""

# Check if wrangler is available
if ! command -v wrangler &> /dev/null; then
    echo "ERROR: wrangler CLI not found. Install it with: npm install -g wrangler"
    exit 1
fi

# Check if logged in to Cloudflare
echo "Checking Cloudflare authentication..."
if ! wrangler whoami &> /dev/null; then
    echo "ERROR: Not logged in to Cloudflare. Run: wrangler login"
    exit 1
fi

echo "Creating D1 database..."
# Create D1 database and capture the ID
DB_OUTPUT=$(wrangler d1 create cc-server 2>&1)
echo "$DB_OUTPUT"

# Extract database_id from output
DB_ID=$(echo "$DB_OUTPUT" | grep -oP 'database_id = "\K[^"]+' | head -1)

if [ -z "$DB_ID" ]; then
    echo "WARNING: Could not extract database_id automatically."
    echo "Please manually update wrangler.toml with the database_id from the output above."
else
    echo "Updating wrangler.toml with database_id: $DB_ID"
    # Update wrangler.toml with the real database_id
    sed -i.bak "s/database_id = \"00000000-0000-0000-0000-000000000000\"/database_id = \"$DB_ID\"/" wrangler.toml
    echo "Updated wrangler.toml"
fi

echo ""
echo "Applying D1 schema migration..."
wrangler d1 migrations apply cc-server --remote

echo ""
echo "=== Migration setup complete ==="
echo ""
echo "Next steps:"
echo "1. If you have existing SQLite data to import:"
echo "   - Stop cc-server to prevent new writes"
echo "   - Backup: cp data/cc-server.sqlite backups/cc-server-\$(date -u +%Y%m%dT%H%M%SZ).sqlite"
echo "   - Export: sqlite3 data/cc-server.sqlite '.mode insert' '.output backups/cc-server-data.sql' '.dump'"
echo "   - Import: wrangler d1 execute cc-server --remote --file backups/cc-server-data.sql"
echo "2. Start the Worker: wrangler deploy"
echo "3. Or run locally: wrangler dev"
