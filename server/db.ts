import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from "@shared/schema";
import path from 'path';
import { fileURLToPath } from 'url';

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Стандартный PostgreSQL драйвер для Amvera (не Neon Serverless)
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * Запуск Drizzle-миграций (CREATE TABLE и т.д.) из папки migrations/.
 * Идемпотентно — Drizzle отслеживает выполненные миграции в таблице __drizzle_migrations.
 */
export async function runDrizzleMigrations(): Promise<void> {
  try {
    // Активируем расширение pgvector (необходимо для столбцов vector(1536))
    const client = await pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      console.log('[DrizzleMigrate] ✅ Расширение pgvector активировано');
    } finally {
      client.release();
    }

    // Определяем путь к миграциям относительно текущего файла
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const migrationsFolder = path.resolve(currentDir, '..', 'migrations');
    
    console.log(`[DrizzleMigrate] 🔄 Запуск миграций из ${migrationsFolder}...`);
    await migrate(db, { migrationsFolder });
    console.log('[DrizzleMigrate] ✅ Миграции выполнены успешно');
  } catch (err: any) {
    console.error('[DrizzleMigrate] ❌ Ошибка миграций:', err?.message || err);
    throw err; // Критическая ошибка — не запускать приложение без схемы
  }
}

/**
 * Автоматические миграции при старте приложения.
 * 
 * Каждая миграция идемпотентна (IF NOT EXISTS / IF EXISTS),
 * поэтому безопасно выполнять при каждом запуске.
 * 
 * Добавляйте новые миграции В КОНЕЦ массива.
 */
const AUTO_MIGRATIONS: string[] = [
  // 2026-03-22: contextWindow для динамического управления контекстным окном AI-моделей
  `ALTER TABLE ai_model_configs ADD COLUMN IF NOT EXISTS context_window integer`,
  // 2026-03-27: Profile Synthesis — Living Persona Model (архивация и уровни стабильности)
  `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT true NOT NULL`,
  `ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS stability_level TEXT DEFAULT 'dynamic' NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_user_profile_is_current ON user_profile (is_current)`,
  `CREATE INDEX IF NOT EXISTS idx_user_profile_category_current ON user_profile (category, is_current)`,
  // Бэкфилл для существующих Core-категорий
  `UPDATE user_profile SET stability_level = 'core' WHERE category IN ('personality', 'values')`,
  // 2026-04-02: LLM Call Logs для полноценного мониторинга ошибок генерации
  `CREATE TABLE IF NOT EXISTS llm_call_logs (
    id SERIAL PRIMARY KEY,
    task_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    messages JSONB NOT NULL,
    response TEXT,
    error TEXT,
    duration_ms INTEGER DEFAULT 0 NOT NULL,
    tokens_used INTEGER DEFAULT 0,
    cached_tokens_used INTEGER DEFAULT 0,
    status TEXT NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL
  )`,
  // 2026-04-06: System Diagnostics — логирование инициализации сервисов и сетевых ошибок для удалённой диагностики
  `CREATE TABLE IF NOT EXISTS system_diagnostics (
    id SERIAL PRIMARY KEY,
    service TEXT NOT NULL,
    event TEXT NOT NULL,
    level TEXT DEFAULT 'info' NOT NULL,
    message TEXT NOT NULL,
    details JSONB,
    environment TEXT,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_system_diagnostics_service ON system_diagnostics(service)`,
  `CREATE INDEX IF NOT EXISTS idx_system_diagnostics_created ON system_diagnostics(created_at DESC)`,
  // 2026-04-13: Advisor Feedback — обратная связь на стратегические советы (feedback loop)
  `CREATE TABLE IF NOT EXISTS advisor_feedback (
    id SERIAL PRIMARY KEY,
    proactive_message_id INTEGER,
    advice_type TEXT NOT NULL,
    advice_title TEXT,
    advice_content TEXT,
    reaction TEXT NOT NULL,
    response_notes TEXT,
    profile_basis JSONB,
    related_goal_ids JSONB,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW() NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_advisor_feedback_created ON advisor_feedback(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_advisor_feedback_reaction ON advisor_feedback(reaction)`,
  `CREATE INDEX IF NOT EXISTS idx_advisor_feedback_type ON advisor_feedback(advice_type)`,
  // 2026-04-23: Goal Lifecycle — resume_date для deferred целей + адаптивный review_frequency
  `ALTER TABLE goals ADD COLUMN IF NOT EXISTS resume_date TIMESTAMP WITHOUT TIME ZONE`,
  `ALTER TABLE goals ADD COLUMN IF NOT EXISTS blocked_reason TEXT`,
  `ALTER TABLE goals ADD COLUMN IF NOT EXISTS blocked_by_goal_id INTEGER`,
  // Адаптивный review_frequency по приоритету (вместо weekly для всех)
  `UPDATE goals SET review_frequency = 'daily' WHERE priority = 'focus' AND review_frequency = 'weekly'`,
  `UPDATE goals SET review_frequency = 'monthly' WHERE priority IN ('low', 'someday') AND review_frequency = 'weekly'`,
];

export async function runAutoMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    for (const sql of AUTO_MIGRATIONS) {
      try {
        await client.query(sql);
      } catch (err: any) {
        // Не ломаем запуск приложения из-за миграции
        console.error(`[AutoMigrate] ❌ Ошибка: ${err?.message || err}`);
      }
    }
    if (AUTO_MIGRATIONS.length > 0) {
      console.log(`[AutoMigrate] ✅ Выполнено ${AUTO_MIGRATIONS.length} миграций`);
    }
  } finally {
    client.release();
  }
}