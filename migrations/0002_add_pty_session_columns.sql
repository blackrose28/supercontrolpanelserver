-- Add missing columns to pty_sessions that were added after the initial table creation
ALTER TABLE pty_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE pty_sessions ADD COLUMN serverId TEXT;
ALTER TABLE pty_sessions ADD COLUMN localSessionId TEXT;
ALTER TABLE pty_sessions ADD COLUMN scrollback TEXT NOT NULL DEFAULT '';
