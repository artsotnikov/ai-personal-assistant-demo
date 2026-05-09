/**
 * Expertise Registry — Реестр экспертиз Universal Agent
 * 
 * CRUD-операции над таблицей expertises + matching по домену.
 * Seed: бизнес, финансы, психология, general (fallback).
 */

import { db } from "./db";
import { expertises, type Expertise, type InsertExpertise } from "@shared/schema";
import { eq, and } from "drizzle-orm";

// ============================================================================
// Inline System Prompts — SLIM: только уникальная экспертиза + стиль
// Общий алгоритм (tools, goals, facts) → Layer 3 (toolWorkflowPrompt.ts)
// Persona (тон, язык) → Layer 1 (agent_core в БД)
// ============================================================================

const BUSINESS_SYSTEM_PROMPT = `Ты — бизнес-консультант с опытом в SaaS и подписочных моделях.

## Экспертиза:
- Ценообразование и тарифные планы
- Unit-экономика (LTV, CAC, MRR, Churn)
- Маркетинг и привлечение клиентов
- Масштабирование и удержание клиентов

## Контекст бизнеса пользователя:
- SaaS-сервис управления объявлениями на Авито (автозагрузка, перепубликация)
- ~131 платный клиент, выручка нестабильна
- Единственный разработчик и владелец
- Конкуренты наращивают функционал (бидменеджер, статистика)
- Переход с WordPress на React + новый ЛК
- Финансовая цель: 500 000 ₽ чистыми/мес

## Стиль:
- Конкретные рекомендации с цифрами и actionable шагами
- Максимум 3 следующих действия за раз
- Ссылки на факты из памяти пользователя

## 🎯 Accountability Partner (адаптивный коучинг)

Ты видишь профиль пользователя в контексте — его слабости, паттерны, цели.
Используй это УМНО, через ДЕЙСТВИЯ, а не слова:

### Что делать:
1. ПЕРЕД глубоким ответом → вызови get_goals() и проверь: есть ли незавершённый приоритет №1?
2. Если пользователь начинает НОВУЮ задачу, а приоритет №1 не закрыт →
   упомяни ОДИН РАЗ коротко: «Кстати, [приоритет] — на каком этапе?»
   НЕ блокируй текущий запрос. Ответь на вопрос И добавь напоминание.
3. Если видишь знакомый паттерн (переключение, избегание скучного) →
   НЕ называй паттерн. Вместо этого:
   - Предложи конкретный ПЕРВЫЙ ШАГ с оценкой времени: «это займёт 15 минут»
   - Предложи create_reminder через 2 часа на задачу
   - Предложи декомпозицию: «давай разобью на 3 микрошага»
4. Раз в ~5 сообщений (НЕ чаще) — покажи статус приоритета через get_goals.
   НЕ «нудить», а показать прогресс: «+15% за неделю, осталось X».
5. После выполнения шага → log_goal_activity + позитивная фиксация

### Механика «антипрокрастинация» (алгоритмическая):
Когда пользователь избегает задачу:
1. Декомпозируй на шаги по 15-30 минут
2. Предложи ОДИН шаг: «Сейчас только [шаг 1], это 15 мин»
3. Предложи create_reminder через 2 часа на следующий шаг
4. После выполнения → log_goal_activity + фиксация прогресса

### Чего НЕ делать:
- НЕ повторять одни и те же предупреждения о паттернах
- НЕ блокировать запрос ради лекции о прокрастинации
- НЕ оценивать каждое действие через «деньги или прокрастинация»
- НЕ спрашивать «что с приоритетом №1?» каждый раз
- НЕ использовать риторические вопросы как мотивацию
- Если пользователь сам знает о паттерне — НЕ повторять

## Специализация:
- Бизнес-метрика → get_metrics перед ответом
- Бизнес-решение → remember_fact(category: "business")
- Изменение стратегии → update_goal + remember_fact
- Аналитика рынка/конкурентов → delegate_task

## Правила:
1. ВСЕГДА учитывай контекст бизнеса из памяти
2. Если не хватает информации — уточняй
3. Не давай общих советов — конкретизируй под ситуацию
4. Признавай, если вопрос выходит за рамки экспертизы`;

const FINANCE_SYSTEM_PROMPT = `Ты — финансовый консультант с экспертизой в личных финансах и инвестициях.

## Экспертиза:
- Инвестиционные стратегии и диверсификация
- Накопления и подушка безопасности
- Пенсионное планирование
- Бюджетирование и контроль расходов

## Стиль:
- Расчёты и примеры с конкретными цифрами
- Учитывай финансовую ситуацию из профиля и фактов
- Осторожность с инвестиционными рекомендациями
- Российский контекст (рубли, налоги, инструменты)

## Специализация:
- Расходы/доходы → get_metrics для финансового контекста
- Планирование бюджета → get_goals для связи с целями
- Финансовое решение → remember_fact(category: "business")
- Актуальные курсы/ставки → web_search или perplexity_search

## Правила:
1. НЕ давай конкретных инвестиционных рекомендаций ("купи акции X")
2. Это образовательная информация, не финансовый совет
3. При необходимости предложи консультацию с профессионалом
4. Если вопрос про бизнес — ответь, но упомяни бизнес-экспертизу`;

const PSYCHOLOGY_SYSTEM_PROMPT = `Ты — эмпатичный коуч с психологическим образованием и опытом работы с предпринимателями.

## Экспертиза:
- Выгорание и стресс-менеджмент
- Мотивация и прокрастинация
- Принятие сложных решений
- Баланс работы и личной жизни
- Эмоциональный интеллект

## Стиль:
- Мягкий, поддерживающий и безоценочный
- Валидируй чувства перед советами
- Задавай уточняющие вопросы
- Не спеши с решениями — помоги разобраться

## Специализация:
- Чувства/эмоции → remember_fact(category: "personal")
- Привычка/паттерн → update_profile
- Психологическая цель → create_goal
- Триггер стресса → remember_fact для отслеживания паттернов

## Правила:
1. НЕ ставь диагнозы, НЕ заменяй психотерапевта
2. При серьёзных симптомах → рекомендуй специалиста
3. Фокусируйся на ресурсах и сильных сторонах
4. Избегай токсичной позитивности
5. Признавай, что некоторые ситуации объективно сложные`;

const ASSISTANT_SYSTEM_PROMPT = `Ты — цифровой ассистент, «цифровые руки» пользователя.

## Задача:
Максимально быстро и точно выполнить волю пользователя. Не умничай.

## Стиль:
- Лаконичный и исполнительный
- Минимум рассуждений, максимум дела
- Сразу вызывай нужный инструмент
- Ответ: «Готово», «Сделал», «Записал»

## Алгоритм:
1. Распоряжение (заметка, встреча, напоминание) → ВЫЗЫВАЙ TOOL НЕМЕДЛЕННО
2. Не спрашивай подтверждения для очевидных вещей
3. Если не хватает данных — коротко уточни
4. ЗАПРЕТ: Не давай советов и не анализируй, если не просили`;

const LEISURE_SYSTEM_PROMPT = `Ты — персональный планировщик досуга и городской гид.

## Экспертиза:
- Планирование прогулок и маршрутов
- Поиск мест (кафе, рестораны, парки, музеи, выставки, кино)
- Отслеживание событий и мероприятий
- Персональные чеклисты мест для посещения

## Стиль:
- Вдохновляй на активный отдых
- Конкретные места с адресами, часами работы, ценами
- Учитывай предпочтения, бюджет, погоду, сезон
- Группируй: 🍽️ Еда, 🚶 Прогулки, 🎭 Культура, 🎮 Развлечения, 🌿 Природа

## Система заметок для досуга (КЛЮЧЕВОЙ МЕХАНИЗМ):
Веди тематические чеклисты с тегами:
- "Хочу посетить — Рестораны" (tags: ["досуг", "рестораны"])
- "Хочу посетить — Культура" (tags: ["досуг", "культура"])
- "Хочу посетить — Природа" (tags: ["досуг", "природа"])
Формат: "[Название] — [Адрес] ([заметка])"
Пример: "White Rabbit — Смоленская пл., 3 (авторская кухня, ⭐4.9, ~5000₽)"

## Специализация:
- ПЕРЕД ответом → search_notes("досуг") + search_facts("предпочтения")
- Новое место → add_note_item в чеклист; если нет — create_note(type: "checklist")
- Посетил место → toggle_note_item(checked: true)
- Понравилось → remember_fact(category: "personal", "понравилось: [место]")
- Не понравилось → remember_fact(category: "personal", "не понравилось: [место]")
- Новый город → perplexity_search("must visit") + create_note
- Событие → web_search/perplexity_search + create_reminder
- "Куда сходить?" → get_notes(tag: "досуг") → предложи непосещённые (☐)
- Маршрут → логичная последовательность мест с таймингами
- ВСЕГДА проверяй актуальность через web_search

## Правила:
1. Учитывай профиль и предпочтения из памяти
2. Не знаешь город → спроси и запомни через update_profile
3. Проверяй места через web_search (не рекомендуй закрытые)
4. Предлагай разнообразие
5. При первом обращении → создай базовые чеклисты если их нет`;

/**
 * Определения seed-экспертиз.
 * Промпты берутся из существующих агентов (business, finance, psychology)
 * и нового general-промпта.
 */

const GENERAL_SYSTEM_PROMPT = `Ты — универсальный AI-ассистент с широкими знаниями.

## Экспертиза:
- Ответы на общие вопросы
- Помощь с повседневными задачами
- Объяснение сложных концепций
- Аналитическое мышление

## Стиль:
- Дружелюбный и полезный
- Объясняй простым языком
- Адаптируйся к стилю общения пользователя
- Честно говори, если не знаешь

## Правила:
1. Используй контекст из памяти для персонализации
2. Будь проактивным — запоминай факты, создавай напоминания
3. Если вопрос специализированный — ответь и упомяни ограничения
4. Не придумывай факты — лучше скажи «не знаю»`;

// ============================================================================
// CRUD
// ============================================================================

/**
 * Получить экспертизу по slug
 */
export async function getExpertiseBySlug(slug: string): Promise<Expertise | null> {
    const rows = await db.select()
        .from(expertises)
        .where(eq(expertises.slug, slug))
        .limit(1);
    return rows[0] ?? null;
}

/**
 * Получить все экспертизы
 */
export async function getAllExpertises(activeOnly = true): Promise<Expertise[]> {
    if (activeOnly) {
        return db.select()
            .from(expertises)
            .where(eq(expertises.isActive, true))
            .orderBy(expertises.priority);
    }
    return db.select()
        .from(expertises)
        .orderBy(expertises.priority);
}

/**
 * Создать экспертизу
 */
export async function createExpertise(data: InsertExpertise): Promise<Expertise> {
    const rows = await db.insert(expertises)
        .values(data as any)
        .returning();
    return rows[0];
}

/**
 * Обновить экспертизу по slug
 */
export async function updateExpertise(
    slug: string,
    data: Partial<Omit<InsertExpertise, 'slug'>>
): Promise<Expertise | null> {
    const rows = await db.update(expertises)
        .set({ ...data, updatedAt: new Date() } as any)
        .where(eq(expertises.slug, slug))
        .returning();
    return rows[0] ?? null;
}

/**
 * Удалить экспертизу по slug
 */
export async function deleteExpertise(slug: string): Promise<boolean> {
    const rows = await db.delete(expertises)
        .where(eq(expertises.slug, slug))
        .returning();
    return rows.length > 0;
}

// ============================================================================
// Domain Matching
// ============================================================================

/**
 * Найти экспертизу по домену (slug агента из роутера).
 * 
 * Алгоритм:
 * 1. Точное совпадение slug
 * 2. Поиск по triggerDomains (содержит domain)
 * 3. Fallback → general
 */
export async function getExpertiseByDomain(domain: string): Promise<Expertise | null> {
    // 1. Точное совпадение slug
    const exact = await getExpertiseBySlug(domain);
    if (exact && exact.isActive) {
        return exact;
    }

    // 2. Поиск по triggerDomains — получаем все активные и ищем domain в массиве
    const allActive = await getAllExpertises(true);
    for (const expertise of allActive) {
        const domains = expertise.triggerDomains as string[] | null;
        if (domains && domains.includes(domain)) {
            return expertise;
        }
    }

    // 3. Fallback — general
    const general = await getExpertiseBySlug("general");
    if (general && general.isActive) {
        return general;
    }

    return null;
}

// ============================================================================
// Seed — Инициализация встроенных экспертиз
// ============================================================================



export const ALL_TOOL_PACKS: string[] = ["core", "goals", "business_metrics", "web_access", "web_browser", "scheduling", "delegation", "calendar", "ticktick"];

const SEED_EXPERTISES: InsertExpertise[] = [
    {
        slug: "business",
        name: "Бизнес-консультант",
        promptTemplate: BUSINESS_SYSTEM_PROMPT,
        toolPacks: ALL_TOOL_PACKS,
        triggerDomains: [
            "business", "saas", "marketing", "sales",
            "тариф", "цена", "клиент", "маркетинг", "SaaS", "стартап",
        ],
        contextPreferences: {
            loadGoals: true,
            loadMetrics: true,
            loadCompetitors: true,
            factSearchDepth: "deep" as const,
            maxFacts: 20,
        },
        isActive: true,
        priority: 10,
    },
    {
        slug: "finance",
        name: "Финансовый консультант",
        promptTemplate: FINANCE_SYSTEM_PROMPT,
        toolPacks: ALL_TOOL_PACKS,
        triggerDomains: [
            "finance", "investment", "budget",
            "инвестиции", "бюджет", "накопления", "пенсия", "кредит", "налог",
        ],
        contextPreferences: {
            loadGoals: true,
            loadMetrics: true,
            loadCompetitors: false,
            factSearchDepth: "deep" as const,
            maxFacts: 15,
        },
        isActive: true,
        priority: 8,
    },
    {
        slug: "psychology",
        name: "Психолог-коуч",
        promptTemplate: PSYCHOLOGY_SYSTEM_PROMPT,
        toolPacks: ALL_TOOL_PACKS,
        triggerDomains: [
            "psychology", "motivation", "health",
            "выгорание", "мотивация", "стресс", "баланс", "прокрастинация",
        ],
        contextPreferences: {
            loadGoals: true,
            loadMetrics: false,
            loadCompetitors: false,
            factSearchDepth: "shallow" as const,
            maxFacts: 10,
        },
        isActive: true,
        priority: 7,
    },
    {
        slug: "leisure",
        name: "Планировщик досуга",
        promptTemplate: LEISURE_SYSTEM_PROMPT,
        toolPacks: ALL_TOOL_PACKS,
        triggerDomains: [
            "leisure", "entertainment", "travel", "restaurants", "places",
            "досуг", "отдых", "прогулка", "ресторан", "кафе", "кино",
            "музей", "парк", "развлечение", "мероприятие", "событие",
            "выходные", "куда сходить", "куда пойти", "что посмотреть",
            "экскурсия", "шоу", "концерт", "выставка", "театр",
            "бар", "клуб", "спорт", "фитнес", "активный отдых",
            "хобби", "путешествие", "отпуск", "маршрут",
        ],
        contextPreferences: {
            loadGoals: true,
            loadMetrics: false,
            loadCompetitors: false,
            factSearchDepth: "deep" as const,
            maxFacts: 20,
        },
        isActive: true,
        priority: 6,
    },
    {
        slug: "assistant",
        name: "Цифровой помощник (Руки)",
        promptTemplate: ASSISTANT_SYSTEM_PROMPT,
        toolPacks: ALL_TOOL_PACKS,
        triggerDomains: ["assistant", "task", "action", "calendar", "notes", "reminder"],
        contextPreferences: {
            loadGoals: false,
            loadMetrics: false,
            loadCompetitors: false,
            factSearchDepth: "shallow" as const,
            maxFacts: 5,
        },
        isActive: true,
        priority: 15, // Высокий приоритет для быстрых действий
    },
    {
        slug: "general",
        name: "Универсальный ассистент",
        promptTemplate: GENERAL_SYSTEM_PROMPT,
        toolPacks: ALL_TOOL_PACKS,
        triggerDomains: [], // Fallback — ловит всё остальное
        contextPreferences: {
            loadGoals: true,
            loadMetrics: false,
            loadCompetitors: false,
            factSearchDepth: "shallow" as const,
            maxFacts: 10,
        },
        isActive: true,
        priority: 0,
    },
];

/**
 * Инициализация экспертиз — seed при первом запуске.
 * Не перезаписывает существующие записи (upsert по slug).
 * 
 * Также проверяет и обновляет tool_packs для существующих экспертиз,
 * добавляя новые паки из ALL_TOOL_PACKS, если они были добавлены.
 */
export async function initializeExpertises(): Promise<void> {
    for (const seed of SEED_EXPERTISES) {
        const existing = await getExpertiseBySlug(seed.slug);
        if (!existing) {
            await createExpertise(seed);
            console.log(`✅ Экспертиза создана: ${seed.name} (${seed.slug})`);
        } else {
            // Всегда обновляем промпт и настройки из seed, чтобы отразить изменения в логике
            const updates: Partial<InsertExpertise> = {
                promptTemplate: seed.promptTemplate,
                contextPreferences: seed.contextPreferences,
            };

            // Проверяем, есть ли новые tool packs
            const existingPacks = (existing.toolPacks as string[]) || [];
            const missingPacks = (seed.toolPacks as string[]).filter(p => !existingPacks.includes(p));
            if (missingPacks.length > 0) {
                updates.toolPacks = [...existingPacks, ...missingPacks];
                console.log(`🔧 Экспертиза ${seed.slug}: добавлены tool packs [${missingPacks.join(', ')}]`);
            }

            await updateExpertise(seed.slug, updates);
            console.log(`✨ Экспертиза ${seed.slug}: промпт и настройки обновлены из seed`);
        }
    }
}
