-- Migration: Add embedding column to notes table for semantic search
-- Date: 2026-02-28

ALTER TABLE notes ADD COLUMN IF NOT EXISTS embedding TEXT;

-- Optional: Index on isActive + isArchived for faster searches
CREATE INDEX IF NOT EXISTS idx_notes_active_archived ON notes(is_active, is_archived);
