CREATE TABLE "advisor_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"proactive_message_id" integer,
	"advice_type" text NOT NULL,
	"advice_title" text,
	"advice_content" text,
	"reaction" text NOT NULL,
	"response_notes" text,
	"profile_basis" jsonb,
	"related_goal_ids" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"system_prompt" text NOT NULL,
	"trigger_keywords" text,
	"related_topics" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agents_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "ai_model_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text,
	"temperature" text DEFAULT '0.3',
	"max_tokens" integer DEFAULT 500,
	"context_window" integer,
	"reasoning_effort" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_configs_task_type_unique" UNIQUE("task_type")
);
--> statement-breakpoint
CREATE TABLE "ai_prompts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"content" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ai_prompts_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "ai_scheduled_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'Europe/Moscow' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_run_at" timestamp,
	"next_run_at" timestamp,
	"run_count" integer DEFAULT 0 NOT NULL,
	"max_runs" integer,
	"created_by_ai" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"consecutive_errors" integer DEFAULT 0 NOT NULL,
	"last_error_at" timestamp,
	"backoff_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "competitor_attributes" (
	"id" serial PRIMARY KEY NOT NULL,
	"competitor_id" integer NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"category" text,
	"source_document_id" integer,
	"valid_from" timestamp DEFAULT now() NOT NULL,
	"valid_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"aliases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"website" text,
	"summary" text,
	"embedding_vector" vector(1536),
	"is_active" boolean DEFAULT true NOT NULL,
	"last_updated" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "competitors_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text,
	"last_message" text,
	"last_message_time" timestamp DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_execution_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"status" text NOT NULL,
	"response" text,
	"agent_used" text,
	"agent_name" text,
	"tokens_used" integer DEFAULT 0,
	"tool_calls" jsonb,
	"duration_ms" integer,
	"error" text,
	"executed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_type" text NOT NULL,
	"document_type" text NOT NULL,
	"summary" text,
	"embedding_vector" vector(1536),
	"metadata" jsonb,
	"source_message_id" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_type" text NOT NULL,
	"sub_type" text,
	"role" text,
	"description" text,
	"embedding" text,
	"embedding_vector" vector(1536),
	"metadata" jsonb,
	"cluster_id" integer,
	"source_fact_id" integer,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"mention_count" integer DEFAULT 1 NOT NULL,
	"last_mentioned" timestamp DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expertises" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"prompt_template" text NOT NULL,
	"tool_packs" jsonb DEFAULT '["core"]'::jsonb NOT NULL,
	"trigger_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context_preferences" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "expertises_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "fact_relations" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_fact_id" integer NOT NULL,
	"target_fact_id" integer NOT NULL,
	"relation_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"topic_id" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" text,
	"embedding_vector" vector(1536),
	"confidence" text DEFAULT 'medium' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"source_message_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"goal_id" integer NOT NULL,
	"activity_type" text NOT NULL,
	"description" text NOT NULL,
	"metadata" jsonb,
	"source_message_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_key_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"goal_id" integer NOT NULL,
	"title" text NOT NULL,
	"metric" text,
	"target_value" integer,
	"current_value" integer DEFAULT 0,
	"unit" text,
	"auto_query" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_milestones" (
	"id" serial PRIMARY KEY NOT NULL,
	"goal_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"deadline" timestamp,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp,
	"progress" integer DEFAULT 0 NOT NULL,
	"sync_tag" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goal_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"milestone_id" integer NOT NULL,
	"goal_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'medium',
	"due_date" timestamp,
	"completed_at" timestamp,
	"ticktick_task_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goals" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"smart_description" text,
	"category" text,
	"priority" text DEFAULT 'medium',
	"parent_goal_id" integer,
	"review_frequency" text DEFAULT 'weekly',
	"target_review_date" timestamp,
	"deadline" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"embedding" text,
	"embedding_vector" vector(1536),
	"sync_tag" text,
	"resume_date" timestamp,
	"blocked_reason" text,
	"blocked_by_goal_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insight_memory" (
	"id" serial PRIMARY KEY NOT NULL,
	"insight_type" text NOT NULL,
	"related_entity_id" integer,
	"related_entity_type" text,
	"content_hash" text,
	"content" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"persistence_level" integer DEFAULT 1 NOT NULL,
	"last_mentioned_at" timestamp,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"next_remind_at" timestamp,
	"user_reaction" text,
	"usefulness_score" integer DEFAULT 50,
	"dismissal_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_relations" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_id" integer NOT NULL,
	"relation_type" text NOT NULL,
	"object_id" integer NOT NULL,
	"relation_category" text,
	"attributes" jsonb,
	"context" text,
	"source_fact_id" integer,
	"source_message_id" integer,
	"importance" text DEFAULT 'normal' NOT NULL,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"valid_from" timestamp DEFAULT now() NOT NULL,
	"valid_until" timestamp,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_call_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_type" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"messages" jsonb NOT NULL,
	"response" text,
	"error" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0,
	"cached_tokens_used" integer DEFAULT 0,
	"status" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_processing_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"total_duration_ms" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"error_message" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_used" text,
	"tokens_used" integer,
	"facts_count" integer,
	"context_summary" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"type" text NOT NULL,
	"sender" text NOT NULL,
	"exclude_from_context" boolean DEFAULT false NOT NULL,
	"file_url" text,
	"file_name" text,
	"file_size" integer,
	"timestamp" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"period_type" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"raw_content" text,
	"changes" jsonb,
	"summary" text,
	"source_message_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"type" text DEFAULT 'note' NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb,
	"content" text,
	"items" jsonb DEFAULT '[]'::jsonb,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"is_archived" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_immutable" boolean DEFAULT false NOT NULL,
	"source_message_id" integer,
	"source_url" text,
	"embedding" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"morning_briefing_hour" integer DEFAULT 9 NOT NULL,
	"morning_briefing_minute" integer DEFAULT 0 NOT NULL,
	"evening_recap_hour" integer DEFAULT 21 NOT NULL,
	"evening_recap_minute" integer DEFAULT 0 NOT NULL,
	"check_interval_minutes" integer DEFAULT 15 NOT NULL,
	"max_daily_reminders" integer DEFAULT 5 NOT NULL,
	"cooldown_hours" integer DEFAULT 4 NOT NULL,
	"enable_morning_briefing" boolean DEFAULT true NOT NULL,
	"enable_evening_recap" boolean DEFAULT true NOT NULL,
	"enable_deadline_alerts" boolean DEFAULT true NOT NULL,
	"enable_goal_reminders" boolean DEFAULT true NOT NULL,
	"enable_topic_reminders" boolean DEFAULT true NOT NULL,
	"goal_stalled_days" integer DEFAULT 14 NOT NULL,
	"topic_abandoned_days" integer DEFAULT 21 NOT NULL,
	"telegram_enabled" boolean DEFAULT false NOT NULL,
	"telegram_bot_token" text,
	"telegram_chat_id" text,
	"quiet_hours_enabled" boolean DEFAULT false NOT NULL,
	"quiet_hours_start" integer DEFAULT 22 NOT NULL,
	"quiet_hours_end" integer DEFAULT 8 NOT NULL,
	"quiet_hours_weekend_only" boolean DEFAULT false NOT NULL,
	"browser_push_enabled" boolean DEFAULT true NOT NULL,
	"browser_sound_enabled" boolean DEFAULT true NOT NULL,
	"browser_sound_type" text DEFAULT 'soft' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"related_entity_id" integer,
	"related_entity_type" text,
	"delivered" boolean DEFAULT false NOT NULL,
	"delivered_at" timestamp,
	"dismissed" boolean DEFAULT false NOT NULL,
	"dismissed_at" timestamp,
	"clicked_action" boolean DEFAULT false,
	"sent_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"remind_at" timestamp NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'medium',
	"source_message_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"sent_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "session_compactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"summary" text NOT NULL,
	"compacted_message_ids" jsonb,
	"original_tokens" integer,
	"compacted_tokens" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_context" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"current_topics" text,
	"mood" text,
	"active_agent_slug" text,
	"open_questions" text,
	"mentioned_entities" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"category" text DEFAULT 'custom' NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"trigger_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"icon" text DEFAULT '🧩',
	"embedding" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skills_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "subagent_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"parent_message_id" integer NOT NULL,
	"task_type" text NOT NULL,
	"task_prompt" text NOT NULL,
	"system_prompt" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" text,
	"error" text,
	"duration_ms" integer,
	"tokens_used" integer,
	"metadata" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"message_count" integer NOT NULL,
	"start_message_id" integer,
	"end_message_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticktick_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"title" text NOT NULL,
	"content" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" integer DEFAULT 0 NOT NULL,
	"due_date" timestamp,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"embedding" text,
	"embedding_vector" vector(1536),
	"last_modified" timestamp,
	"synced_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ticktick_tasks_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "tool_call_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text,
	"message_id" integer,
	"agent_slug" text NOT NULL,
	"tool_name" text NOT NULL,
	"input" jsonb NOT NULL,
	"success" boolean NOT NULL,
	"result_data" jsonb,
	"error" text,
	"display_text" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"iteration" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_summaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"topic_id" integer NOT NULL,
	"summary" text NOT NULL,
	"fact_ids" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" integer,
	"embedding" text,
	"embedding_vector" vector(1536),
	"fact_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"category" text,
	"confidence" integer DEFAULT 50 NOT NULL,
	"mention_count" integer DEFAULT 1 NOT NULL,
	"source" text DEFAULT 'auto',
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"category" text,
	"previous_value" text,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text DEFAULT 'agent',
	"embedding" text,
	"embedding_vector" vector(1536),
	"is_current" boolean DEFAULT true NOT NULL,
	"stability_level" text DEFAULT 'dynamic' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_profile_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "user_skill_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"skill_id" integer NOT NULL,
	"is_enabled" boolean NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
