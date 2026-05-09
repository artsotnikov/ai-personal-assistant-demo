-- Migration: Add message_processing_runs table for workflow logging
-- This table stores the complete workflow of message processing for analysis and debugging

CREATE TABLE IF NOT EXISTS message_processing_runs (
  id SERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL,
  
  -- Timing
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMP,
  total_duration_ms INTEGER,
  
  -- Result
  status TEXT NOT NULL DEFAULT 'running', -- 'running', 'completed', 'error'
  error_message TEXT,
  
  -- Full workflow data (JSONB for querying)
  steps JSONB NOT NULL DEFAULT '[]',
  
  -- Summary for quick overview
  agent_used TEXT,
  tokens_used INTEGER,
  facts_count INTEGER,
  context_summary JSONB,
  
  -- Metadata
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_processing_runs_message_id ON message_processing_runs(message_id);
CREATE INDEX IF NOT EXISTS idx_processing_runs_status ON message_processing_runs(status);
CREATE INDEX IF NOT EXISTS idx_processing_runs_created_at ON message_processing_runs(created_at);

-- Comment for documentation
COMMENT ON TABLE message_processing_runs IS 'Stores complete workflow of message processing for analysis and debugging';
COMMENT ON COLUMN message_processing_runs.steps IS 'JSONB array of ProcessingStepRecord objects with full input/output data';
