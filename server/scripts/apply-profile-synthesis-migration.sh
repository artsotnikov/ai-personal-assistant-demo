#!/usr/bin/env bash
# =============================================================================
# Миграция: Profile Synthesis — Living Persona Model
# Добавляет is_current и stability_level в таблицу user_profile
#
# Использование:
#   bash server/scripts/apply-profile-synthesis-migration.sh
#   # или с явным URL:
#   DATABASE_URL="postgresql://..." bash server/scripts/apply-profile-synthesis-migration.sh
# =============================================================================

set -e

if [ -z "$DATABASE_URL" ]; then
    echo "❌ DATABASE_URL не задан."
    echo "   Задайте его: export DATABASE_URL='postgresql://user:pass@host:5432/db'"
    exit 1
fi

echo "🧠 Profile Synthesis — применяю миграцию..."
echo ""

run_sql() {
    local name="$1"
    local query="$2"
    local result
    result=$(psql "$DATABASE_URL" -tAc "$query" 2>&1)
    local code=$?
    if [ $code -eq 0 ]; then
        echo "  ✔ $name"
    else
        echo "  ✘ $name: $result"
        exit 1
    fi
}

# ── 1. Новые колонки ──────────────────────────────────────────────────────────
run_sql "Добавить is_current" \
    "ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS is_current BOOLEAN DEFAULT true NOT NULL"

run_sql "Добавить stability_level" \
    "ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS stability_level TEXT DEFAULT 'dynamic' NOT NULL"

# ── 2. Индексы ────────────────────────────────────────────────────────────────
run_sql "Индекс idx_user_profile_is_current" \
    "CREATE INDEX IF NOT EXISTS idx_user_profile_is_current ON user_profile (is_current)"

run_sql "Индекс idx_user_profile_category_current" \
    "CREATE INDEX IF NOT EXISTS idx_user_profile_category_current ON user_profile (category, is_current)"

# ── 3. Бэкфилл ────────────────────────────────────────────────────────────────
run_sql "Бэкфилл: все существующие записи = активные" \
    "UPDATE user_profile SET is_current = true WHERE is_current IS NULL"

run_sql "Бэкфилл: core для personality и values" \
    "UPDATE user_profile SET stability_level = 'core' WHERE category IN ('personality', 'values')"

# ── 4. Проверка ───────────────────────────────────────────────────────────────
echo ""
echo "📋 Проверка новых колонок:"
psql "$DATABASE_URL" -c "
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'user_profile'
  AND column_name IN ('is_current', 'stability_level')
ORDER BY column_name;
"

echo ""
echo "📊 Статистика таблицы:"
psql "$DATABASE_URL" -c "
SELECT category, is_current, stability_level, COUNT(*) AS cnt
FROM user_profile
GROUP BY category, is_current, stability_level
ORDER BY category, is_current;
"

echo "✅ Миграция Profile Synthesis успешно применена!"
