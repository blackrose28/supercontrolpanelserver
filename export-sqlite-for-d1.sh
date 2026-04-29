#!/bin/bash
# Export SQLite data for D1 import (without transaction statements)

set -e

SQLITE_DB="${1:-data/cc-server.sqlite}"
OUTPUT_FILE="${2:-backups/cc-server-data-for-d1.sql}"

if [ ! -f "$SQLITE_DB" ]; then
    echo "ERROR: SQLite database not found: $SQLITE_DB"
    echo "Usage: $0 [sqlite_db_path] [output_sql_file]"
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

echo "Exporting data from $SQLITE_DB to $OUTPUT_FILE..."

# Export in INSERT mode, then clean up incompatible statements
sqlite3 "$SQLITE_DB" <<'EOF' | \
  grep -v '^BEGIN TRANSACTION' | \
  grep -v '^COMMIT' | \
  grep -v '^SAVEPOINT' | \
  grep -v '^RELEASE ' | \
  grep -v '^ROLLBACK' | \
  grep -v '^PRAGMA' | \
  grep -v '^CREATE TABLE' | \
  grep -v '^CREATE INDEX' | \
  grep -v 'INSERT INTO sqlite_sequence' | \
  grep -v '^ANALYZE' \
  > "$OUTPUT_FILE"
.mode insert
.dump
EOF

echo "Done! Cleaned SQL written to: $OUTPUT_FILE"
echo ""
echo "Now import with:"
echo "  npx wrangler d1 execute cc-server --remote --file $OUTPUT_FILE"
