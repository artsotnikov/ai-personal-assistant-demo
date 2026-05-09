# 🚀 Руководство по развёртыванию AI Personal Assistant

## Быстрый старт (5 шагов)

### 1. Установить зависимости
```bash
npm install
```

### 2. Создать базу данных PostgreSQL

Нужен PostgreSQL 15+ **с расширением pgvector**.

**Вариант А — Neon.tech (облако, бесплатно):**
- Зарегистрироваться на https://neon.tech
- Создать проект → получить `DATABASE_URL`
- pgvector уже предустановлен ✅

**Вариант Б — Supabase (облако, бесплатно):**
- Зарегистрироваться на https://supabase.com
- Создать проект → Settings → Database → Connection string
- pgvector уже предустановлен ✅

**Вариант В — Локальный PostgreSQL:**
```bash
# Установить pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;
```

> **Примечание:** pgvector **рекомендуется**, но не обязателен. Без него семантический поиск фактов будет работать через fallback (cosine similarity в JS), что медленнее, но функционально.

### 3. Настроить переменные окружения
```bash
cp .env.example .env
```

Заполнить **обязательные** переменные:

| Переменная | Что это | Где взять |
|:---|:---|:---|
| `DATABASE_URL` | Строка подключения к PostgreSQL | Из шага 2 |
| `SESSION_SECRET` | Случайная строка для сессий | `openssl rand -base64 64` |
| `BASE_URL` | Публичный URL приложения | `http://localhost:5000` для локальной разработки |

И **хотя бы один** AI-провайдер:

| Провайдер | Переменные | Где взять |
|:---|:---|:---|
| OpenRouter (рекомендуется) | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/api-keys |
| DeepSeek | `DEEPSEEK_API_KEY` | https://platform.deepseek.com |

### 4. Создать таблицы в базе данных
```bash
npm run db:push
```

Эта команда использует `drizzle-kit push` — читает схему из `shared/schema.ts` и **автоматически создаёт все таблицы** в подключённой базе данных. Миграционные файлы не нужны.

> При последующих запусках приложения дополнительные миграции (ALTER TABLE, CREATE INDEX) выполняются **автоматически** при старте сервера через `runAutoMigrations()` в `server/db.ts`.

### 5. Запустить
```bash
# Режим разработки (с hot-reload)
npm run dev

# Или production
npm run build && npm start
```

Приложение будет доступно на `http://localhost:5000`.

---

## Опциональные интеграции

### TickTick (задачи)
Для интеграции с менеджером задач TickTick:
1. Зарегистрировать OAuth-приложение на https://developer.ticktick.com
2. Добавить `TICKTICK_CLIENT_ID` и `TICKTICK_CLIENT_SECRET` в `.env`
3. Авторизация происходит через UI приложения (Настройки → TickTick)

### Google Calendar
1. Создать OAuth 2.0 credentials в Google Cloud Console
2. Сохранить как `google-credentials.json` в корне проекта
3. Запустить авторизацию: `npx tsx server/mcp/googleCalendarAuth.ts`
4. Добавить `MCP_GOOGLE_CALENDAR_ENABLED=true` в `.env`

### Web Push уведомления
```bash
npx web-push generate-vapid-keys
```
Добавить полученные ключи как `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` и `VAPID_SUBJECT` в `.env`.

### Telegram (уведомления)
Telegram настраивается **через UI приложения**, а не через `.env`.

1. Создать бота через [@BotFather](https://t.me/BotFather) → получить **Bot Token** (формат: `123456:ABC-DEF...`)
2. Узнать свой **Chat ID**:
   - Написать любое сообщение боту
   - Открыть `https://api.telegram.org/bot<TOKEN>/getUpdates`
   - Найти `"chat":{"id": 123456789}` — это ваш Chat ID
3. В приложении перейти в **Настройки → Уведомления → Telegram**
4. Ввести Bot Token и Chat ID, нажать «Проверить»
5. Включить тумблер «Telegram уведомления»

> Токен и Chat ID хранятся в базе данных (таблица `app_settings`), а не в `.env`.

### Web Search (Tavily / Jina)
Для инструментов веб-поиска AI-агента:
- `TAVILY_API_KEY` — https://app.tavily.com
- `JINA_API_KEY` — https://jina.ai

### Perplexity (AI-поиск)
Продвинутый AI-поиск с цитированием источников (используется как инструмент агента):
- `PERPLEXITY_API_KEY` — https://www.perplexity.ai/settings/api

### Groq (быстрый inference)
Используется для транскрибации голосовых сообщений (Whisper) и быстрых LLM-запросов:
- `GROQ_API_KEY` — https://console.groq.com/keys

### Yandex Disk / Obsidian Bridge
Синхронизация заметок из Obsidian (хранятся на Yandex Disk) с памятью ассистента.

Настраивается **через UI приложения** (Настройки → Obsidian Bridge), а не через `.env`.
Токен Yandex Disk хранится в базе данных.

---

## Архитектура

```
├── client/          # React 18 + Vite (фронтенд)
├── server/          # Express + TypeScript (бэкенд)
│   ├── mcp/         # MCP-серверы (Google Calendar)
│   ├── services/    # Внешние интеграции (TickTick, etc.)
│   └── vault/       # Obsidian Bridge (синхронизация заметок)
├── shared/          # Общие типы и схема БД (schema.ts)
├── migrations/      # SQL-миграции (drizzle-kit)
└── scripts/         # Утилиты и тестовые скрипты
```

**Стек:** React 18 + Vite + Express + Drizzle ORM + PostgreSQL + pgvector + OpenAI SDK

---

## Частые вопросы

**Q: Нужно ли заполнять ВСЕ AI-провайдеры?**
A: Нет, достаточно одного. Система автоматически использует доступного провайдера. Рекомендуется OpenRouter — через него доступны все модели.

**Q: Что если не поставить pgvector?**
A: Семантический поиск фактов и память будут работать через JavaScript-fallback (медленнее, но функционально). В логах будут безвредные warning: `⚠️ pgvector UPDATE пропущен`.

**Q: Приложение падает с ошибкой `ANTIGRAVITY_URL не настроен`?**
A: Если вы не используете Antigravity Manager, просто не добавляйте эту переменную. Убедитесь, что настроен хотя бы один другой провайдер.
