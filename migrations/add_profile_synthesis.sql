-- Profile Synthesis: Living Persona Model
-- Adds archiving support and stability levels to user_profile

ALTER TABLE user_profile
    ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT true NOT NULL;

ALTER TABLE user_profile
    ADD COLUMN IF NOT EXISTS stability_level TEXT DEFAULT 'dynamic' NOT NULL;

-- Index for fast filtering of active entries
CREATE INDEX IF NOT EXISTS idx_user_profile_is_current ON user_profile (is_current);
CREATE INDEX IF NOT EXISTS idx_user_profile_category_current ON user_profile (category, is_current);

-- Backfill: all existing records are active
UPDATE user_profile SET is_current = true WHERE is_current IS NULL;

-- Set stability for existing core categories
UPDATE user_profile SET stability_level = 'core'
WHERE category IN ('personality', 'values');
