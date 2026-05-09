/**
 * Skill Manager — Управление модульными навыками AI-ассистента
 * 
 * Skills — это Markdown-инструкции, которые динамически подключаются к промпту AI.
 * Каждый навык может иметь ключевые слова для автоматической активации.
 * Встроенные навыки создаются при первом запуске (seed).
 */

import { db } from "./db";
import { skills, userSkillSettings, type Skill, type InsertSkill } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { createEmbedding, cosineSimilarity, parseEmbedding, serializeEmbedding } from "./embeddingService";

// Минимальная cosine similarity для семантического matching
const SEMANTIC_MIN_SIMILARITY = 0.35;
// Количество семантически подобранных навыков (top-N)
const SEMANTIC_TOP_K = 3;

// ============================================================================
// Встроенные навыки (seed)
// ============================================================================

const BUILTIN_SKILLS: Omit<InsertSkill, 'isBuiltin'>[] = [
    {
        slug: 'avito-analysis',
        name: 'Анализ Avito',
        description: 'Помощь с анализом объявлений на Avito: позиции, конкуренция, оптимизация текстов и цен.',
        content: `## Навык: Анализ Avito

Когда пользователь обсуждает Avito, объявления, товары или услуги на площадке:

### Подход к анализу
- Оценивай позиции объявлений и их видимость
- Предлагай оптимизацию заголовков и описаний
- Анализируй ценовую стратегию относительно конкурентов
- Учитывай сезонность и тренды категории

### Рекомендации
- Давай конкретные советы по улучшению CTR (кликабельности)
- Предлагай A/B тесты для заголовков и фото
- Отмечай сильные и слабые стороны конкурентных объявлений
- Используй данные из контекста (метрики, конкуренты) если доступны`,
        category: 'business',
        isActive: true,
        triggerKeywords: ['avito', 'авито', 'объявление', 'объявления', 'площадка', 'листинг'],
        icon: '📦',
    },
    {
        slug: 'competitor-tracking',
        name: 'Отслеживание конкурентов',
        description: 'Структурированный анализ конкурентов: сравнение, SWOT, тренды.',
        content: `## Навык: Отслеживание конкурентов

Когда пользователь обсуждает конкурентов, рынок или конкурентную среду:

### Структура анализа
- Сравнивай по ключевым параметрам: цена, функционал, UX, маркетинг
- Используй SWOT-анализ при необходимости
- Отслеживай изменения относительно предыдущих данных

### Выводы
- Определяй конкурентные преимущества и угрозы
- Предлагай actionable шаги для улучшения позиции
- Учитывай данные из реестра конкурентов если доступны`,
        category: 'analytics',
        isActive: true,
        triggerKeywords: ['конкурент', 'конкуренты', 'конкуренция', 'рынок', 'swot', 'сравнение'],
        icon: '🔍',
    },
    {
        slug: 'business-metrics',
        name: 'Бизнес-метрики',
        description: 'Анализ KPI, юнит-экономики, финансовых показателей.',
        content: `## Навык: Бизнес-метрики

Когда пользователь обсуждает метрики, KPI, финансовые показатели:

### Анализ метрик
- Выявляй тренды и аномалии
- Сравнивай с предыдущими периодами
- Рассчитывай производные метрики (LTV, CAC, churn rate, конверсия)

### Юнит-экономика
- Помогай с расчётом unit economics
- Определяй точку безубыточности
- Оценивай маржинальность по продуктам/каналам

### Формат ответов
- Используй числа и проценты для наглядности
- Предлагай визуализацию (таблицы, списки)
- Давай рекомендации на основе данных`,
        category: 'analytics',
        isActive: true,
        triggerKeywords: ['метрик', 'kpi', 'выручка', 'прибыль', 'конверсия', 'ltv', 'cac', 'roi', 'юнит-экономик'],
        icon: '📊',
    },
    {
        slug: 'goal-coaching',
        name: 'Коучинг по целям',
        description: 'Помощь в постановке и достижении целей: декомпозиция, трекинг, мотивация.',
        content: `## Навык: Коучинг по целям

Когда пользователь обсуждает цели, планы, задачи или прогресс:

### Постановка целей
- Помогай формулировать SMART-цели
- Декомпозируй большие цели на подцели
- Определяй ключевые результаты (KR)

### Отслеживание прогресса
- Спрашивай о статусе текущих целей
- Отмечай прогресс и задержки
- Предлагай корректировки при отставании

### Мотивация
- Отмечай достижения и маленькие победы
- Предлагай стратегии при потере мотивации
- Напоминай о связи текущих задач с большими целями`,
        category: 'coaching',
        isActive: true,
        triggerKeywords: ['цель', 'цели', 'план', 'планирование', 'прогресс', 'достижение', 'задача'],
        icon: '🎯',
    },
    {
        slug: 'morning-briefing',
        name: 'Утренний брифинг',
        description: 'Формат ежедневного обзора: ключевые задачи, приоритеты, напоминания.',
        content: `## Навык: Утренний брифинг

Когда пользователь просит обзор дня, утренний брифинг или сводку:

### Структура брифинга
1. **Приоритеты дня** — 2-3 ключевые задачи
2. **Дедлайны** — что горит сегодня/на этой неделе
3. **Прогресс по целям** — краткий статус активных целей
4. **Напоминания** — запланированные на сегодня

### Формат
- Кратко и по делу, не больше 10-15 строк
- Используй emoji для визуального разделения
- Начинай с самого важного
- Завершай мотивирующей нотой`,
        category: 'coaching',
        isActive: true,
        triggerKeywords: ['брифинг', 'утро', 'обзор дня', 'сводка', 'что сегодня', 'план на день'],
        icon: '☀️',
    },
    {
        slug: 'time-manager',
        name: 'Тайм-менеджер',
        description: 'Помощь при перегрузе и прокрастинации: быстрый выбор одной задачи из системы целей, директивная рекомендация и 25-минутный спринт.',
        content: `## Навык: Тайм-менеджер (Антипрокрастинатор)

Активируется когда пользователь в состоянии перегруза, прокрастинации или не может выбрать задачу.
НЕ дублирует Утренний брифинг (обзор дня) и Коучинг по целям (декомпозиция).
Фокус: вытащить человека из ступора → дать ОДНО конкретное действие.

### Триггерная ситуация
Пользователь говорит что-то вроде: «не знаю за что взяться», «всё горит», «прокрастинирую», «завал», «не могу сосредоточиться».

### Алгоритм (3 шага, не больше)

**Шаг 1: Быстрая диагностика (10 секунд)**
- Вызови get_goals() — получи цели в фокусе (max 3).
- Вызови get_goal_details(goalId) для каждой focus-цели.
- Найди задачу с МАКСИМАЛЬНЫМ рычагом:
  - Горящий дедлайн у milestone?
  - Блокирующая задача (от неё зависят другие)?
  - Задача с наименьшим усилием и наибольшим прогрессом (quick win)?

**Шаг 2: Директивная рекомендация (1 задача)**
- Скажи: "Сейчас самое важное — [задача]. Она двигает цель [название], потому что [причина]."
- Разбей на первый микро-шаг (5 минут максимум).
- НЕ предлагай варианты. НЕ спрашивай "что ты хочешь?". Будь директивным.
- Если ни одна задача не горит — скажи: "У тебя всё под контролем. Лучшее вложение времени сейчас — [стратегическая задача из категории «важно, не срочно»]."

**Шаг 3: Зафиксируй и отпусти**
- Вызови create_reminder на 25 минут: "Как прошёл спринт по [задача]?"
- Вызови log_goal_activity(goalId, "focus_session", "Начал работу над: [задача]")
- Скажи: "Я напомню через 25 минут. Иди делай."

### Follow-up (когда пользователь возвращается)
- Спроси: "Сделал? Что получилось?"
- Если сделал → complete_task(taskId) + похвали + предложи следующий шаг
- Если не сделал → НЕ ругай. Спроси: "Что помешало?" и помоги устранить блокер
- Залогируй результат: log_goal_activity(goalId, "focus_result", "...")

### Жёсткие правила
- ❌ ЗАПРЕЩЕНО давать списки больше 3 пунктов
- ❌ ЗАПРЕЩЕНО спрашивать "А что бы ты хотел сделать?"
- ❌ ЗАПРЕЩЕНО использовать матрицу Эйзенхауэра или другие "учебниковые" фреймворки в явном виде
- ✅ ОБЯЗАТЕЛЬНО использовать данные из системы целей (get_goals, get_goal_details)
- ✅ ОБЯЗАТЕЛЬНО создать напоминание (create_reminder) после выбора задачи
- ✅ ОБЯЗАТЕЛЬНО залогировать начало работы (log_goal_activity)`,
        category: 'coaching',
        isActive: true,
        triggerKeywords: ['завал', 'не успеваю', 'прокрастинация', 'прокрастинирую', 'не могу начать', 'за что взяться', 'много задач', 'перегруз', 'не могу сосредоточиться', 'всё горит', 'фокус'],
        icon: '⏱',
    },
    {
        slug: 'skill-architect',
        name: 'Архитектор навыков',
        description: 'Системный навык: правильное создание, редактирование и удаление навыков AI. Проверка дубликатов, структурирование content, выбор ключевых слов.',
        content: `## Навык: Архитектор навыков

Активируется когда пользователь просит создать, изменить, удалить или посмотреть навык AI.

### Процесс создания навыка (ОБЯЗАТЕЛЬНО)

**Шаг 1: Анализ запроса**
- Вызови get_skills() — проверь, нет ли уже похожего навыка
- Если есть похожий → предложи обновить (update_skill) вместо создания нового
- Если нет → продолжай создание

**Шаг 2: Проектирование навыка**
Обсуди с пользователем:
1. Цель навыка — что конкретно он должен делать?
2. Триггеры — какие ключевые слова должны его активировать?
3. Структура — какие секции должны быть в инструкции?

**Шаг 3: Структура content (Markdown)**
Навык должен содержать:
- ## Заголовок с названием навыка
- ### Когда активируется — описание ситуации
- ### Алгоритм действий — пошаговая инструкция для AI
- ### Жёсткие правила — что ОБЯЗАТЕЛЬНО и что ЗАПРЕЩЕНО делать
- ### Примеры — конкретные образцы ответов (если нужны)

**Шаг 4: Категория и иконка**
Категории: custom, business, analytics, coaching, finance
Иконка: одна emoji, отражающая суть навыка

**Шаг 5: Ключевые слова (triggerKeywords)**
- Минимум 3-5 ключевых слов для активации
- На русском и английском языке
- Включай корни и вариации слов
- Не включай слишком общие слова ("помощь", "работа")

### Процесс редактирования навыка

1. Вызови get_skills() — найди нужный навык и его ID
2. Покажи пользователю текущее содержимое навыка
3. Обсуди изменения
4. Вызови update_skill(id, ...) с нужными полями

### Процесс удаления навыка

1. Вызови get_skills() — покажи список навыков
2. Уточни у пользователя какой именно навык удалить
3. Предупреди что действие необратимо
4. Получи подтверждение и вызови delete_skill(id)

### Жёсткие правила

- ❌ ЗАПРЕЩЕНО создавать навык без обсуждения структуры с пользователем
- ❌ ЗАПРЕЩЕНО создавать навык-дубликат (сначала проверь get_skills)
- ❌ ЗАПРЕЩЕНО удалять встроенные навыки (isBuiltin = true)
- ✅ ОБЯЗАТЕЛЬНО проверить существующие навыки перед созданием (get_skills)
- ✅ ОБЯЗАТЕЛЬНО получить подтверждение пользователя перед создание/удалением
- ✅ Content навыка должен быть директивным — это инструкция для AI, а не описание`,
        category: 'system',
        isActive: true,
        triggerKeywords: ['навык', 'навыки', 'skill', 'skills', 'создай навык', 'новый навык', 'удали навык', 'измени навык', 'редактировать навык'],
        icon: '🏗️',
    },
];

// ============================================================================
// Инициализация и CRUD
// ============================================================================

/**
 * Seed встроенных навыков при первом запуске.
 * Создает только те, которых нет в БД (проверка по slug).
 * Также генерирует embeddings для навыков, у которых их нет.
 */
export async function initializeBuiltinSkills(): Promise<void> {
    try {
        const existing = await db.select({ slug: skills.slug }).from(skills).where(eq(skills.isBuiltin, true));
        const existingSlugs = new Set(existing.map(s => s.slug));

        const toInsert = BUILTIN_SKILLS.filter(s => !existingSlugs.has(s.slug));

        if (toInsert.length > 0) {
            await db.insert(skills).values(
                toInsert.map(s => ({
                    ...s,
                    isBuiltin: true as const,
                    triggerKeywords: s.triggerKeywords as string[],
                }))
            );
            console.log(`🧩 Skills: создано ${toInsert.length} встроенных навыков`);
        } else {
            console.log(`🧩 Skills: все встроенные навыки уже существуют`);
        }

        // Генерируем embeddings для навыков без них (фоновая задача)
        generateMissingEmbeddings().catch(err =>
            console.error('⚠️ Ошибка генерации skill embeddings:', err)
        );
    } catch (error) {
        console.error('❌ Ошибка инициализации встроенных навыков:', error);
    }
}

/**
 * Сгенерировать embedding для навыка из name + description + keywords.
 * Текст составлен так, чтобы embedding отражал семантику навыка.
 */
async function generateSkillEmbedding(skill: { name: string; description: string; triggerKeywords?: string[] }): Promise<string> {
    const keywordsStr = skill.triggerKeywords?.length ? ` Ключевые слова: ${skill.triggerKeywords.join(', ')}` : '';
    const textForEmbedding = `${skill.name}. ${skill.description}${keywordsStr}`;
    const embedding = await createEmbedding(textForEmbedding);
    return serializeEmbedding(embedding);
}

/**
 * Фоновая генерация embeddings для навыков, у которых их нет.
 */
async function generateMissingEmbeddings(): Promise<void> {
    const allSkills = await db.select().from(skills);
    const withoutEmbedding = allSkills.filter(s => !s.embedding);

    if (withoutEmbedding.length === 0) return;

    console.log(`🧩 Skills: генерирую embeddings для ${withoutEmbedding.length} навыков...`);

    for (const skill of withoutEmbedding) {
        try {
            const embeddingJson = await generateSkillEmbedding(skill);
            await db.update(skills)
                .set({ embedding: embeddingJson })
                .where(eq(skills.id, skill.id));
            console.log(`  ✅ ${skill.name}`);
        } catch (error: any) {
            console.error(`  ❌ ${skill.name}: ${error.message}`);
        }
    }
}

/**
 * Получить все навыки с учётом пользовательских настроек.
 * Если в user_skill_settings есть запись — использует isEnabled оттуда.
 * Иначе — использует isActive из самого навыка.
 */
export async function getAllSkills(): Promise<(Skill & { effectiveEnabled: boolean })[]> {
    const allSkills = await db.select().from(skills).orderBy(skills.category, skills.name);
    const settings = await db.select().from(userSkillSettings);
    const settingsMap = new Map(settings.map(s => [s.skillId, s.isEnabled]));

    return allSkills.map(skill => ({
        ...skill,
        effectiveEnabled: settingsMap.has(skill.id)
            ? settingsMap.get(skill.id)!
            : skill.isActive,
    }));
}

/**
 * Получить один навык по ID.
 */
export async function getSkillById(id: number): Promise<Skill | null> {
    const [skill] = await db.select().from(skills).where(eq(skills.id, id));
    return skill || null;
}

/**
 * Найти навык по имени (case-insensitive).
 */
export async function getSkillByName(name: string): Promise<Skill | null> {
    const [skill] = await db.select().from(skills)
        .where(sql`LOWER(${skills.name}) = LOWER(${name})`);
    return skill || null;
}

/**
 * Поиск навыков по запросу (имя, описание, ключевые слова).
 * Если query пустой — возвращает все навыки.
 */
export async function searchSkills(query?: string): Promise<Skill[]> {
    if (!query || query.trim().length === 0) {
        return db.select().from(skills).orderBy(skills.category, skills.name);
    }

    const q = query.toLowerCase().trim();

    // Сначала получаем все навыки и фильтруем в JS (для полнотекстового + keyword поиска)
    const allSkills = await db.select().from(skills).orderBy(skills.category, skills.name);

    return allSkills.filter(skill => {
        // Поиск по имени
        if (skill.name.toLowerCase().includes(q)) return true;
        // Поиск по описанию
        if (skill.description.toLowerCase().includes(q)) return true;
        // Поиск по категории
        if (skill.category.toLowerCase().includes(q)) return true;
        // Поиск по ключевым словам
        if (skill.triggerKeywords?.some(kw => kw.toLowerCase().includes(q))) return true;
        return false;
    });
}

/**
 * Получить активные навыки (для подстановки в промпт).
 */
export async function getActiveSkills(): Promise<Skill[]> {
    const allWithStatus = await getAllSkills();
    return allWithStatus.filter(s => s.effectiveEnabled);
}

/**
 * Результат Progressive Disclosure для навыков.
 * Level 1: catalog — все активные навыки (name + description, без content)
 * Level 2: triggered — только keyword-matched навыки (с полным content)
 */
export interface SkillResolutionResult {
    /** Все активные навыки (Level 1 — каталог для ориентации AI) */
    catalog: Pick<Skill, 'id' | 'name' | 'description' | 'icon' | 'category'>[];
    /** Навыки, активированные по keyword match + always-on (Level 2 — полный контент) */
    triggered: Skill[];
}

/**
 * Progressive Disclosure: подобрать навыки, релевантные сообщению.
 * 
 * Level 1: Каталог всех активных навыков (name + description) — всегда в промпте.
 * Level 2: Полный content только для keyword-matched навыков.
 * 
 * Это экономит ~60-70% tokens при 5+ навыках (вдохновлено архитектурой Anthropic).
 */
export async function resolveSkillsForMessage(message: string): Promise<SkillResolutionResult> {
    const active = await getActiveSkills();
    const messageLower = message.toLowerCase();

    // Level 1: каталог всех активных навыков (без content)
    const catalog = active.map(s => ({
        id: s.id,
        name: s.name,
        description: s.description,
        icon: s.icon,
        category: s.category,
    }));

    // Level 2: keyword-matched + always-on (полный content)
    const triggered: Skill[] = [];
    const triggeredIds = new Set<number>();

    for (const skill of active) {
        if (!skill.triggerKeywords || skill.triggerKeywords.length === 0) {
            // Навыки без keywords — всегда активны (Level 2)
            triggered.push(skill);
            triggeredIds.add(skill.id);
        } else {
            const matches = skill.triggerKeywords.some(kw =>
                messageLower.includes(kw.toLowerCase())
            );
            if (matches) {
                triggered.push(skill);
                triggeredIds.add(skill.id);
            }
        }
    }

    // Semantic boost: для навыков, которые НЕ были keyword-matched,
    // проверяем cosine similarity с сообщением.
    // Это позволяет находить навыки даже когда точные ключевые слова не совпадают.
    const notTriggered = active.filter(s => !triggeredIds.has(s.id) && s.embedding);

    if (notTriggered.length > 0) {
        try {
            const queryEmbedding = await createEmbedding(message);

            const scored: { skill: Skill; similarity: number }[] = [];
            for (const skill of notTriggered) {
                const skillEmbedding = parseEmbedding(skill.embedding);
                if (!skillEmbedding) continue;

                const similarity = cosineSimilarity(queryEmbedding, skillEmbedding);
                if (similarity >= SEMANTIC_MIN_SIMILARITY) {
                    scored.push({ skill, similarity });
                }
            }

            // Top-K семантически подобранных
            scored.sort((a, b) => b.similarity - a.similarity);
            const semanticMatches = scored.slice(0, SEMANTIC_TOP_K);

            for (const { skill, similarity } of semanticMatches) {
                triggered.push(skill);
                console.log(`🔮 Semantic match: "${skill.name}" (similarity: ${similarity.toFixed(3)})`);
            }
        } catch (error: any) {
            // Semantic matching — не критично, keyword matching уже отработал
            console.warn(`⚠️ Semantic skill matching пропущен: ${error.message}`);
        }
    }

    return { catalog, triggered };
}

/**
 * Progressive Disclosure: форматирование навыков для промпта AI.
 * 
 * Level 1: Каталог всех навыков (name + description) — ~15 tokens/навык
 * Level 2: Полный content только для triggered навыков — ~100-200 tokens/навык
 */
export function formatSkillsForPrompt(result: SkillResolutionResult): string | null {
    if (result.catalog.length === 0) return null;

    // Level 1: каталог всех доступных навыков
    const catalogLines = result.catalog.map(s =>
        `- ${s.icon} **${s.name}** — ${s.description}`
    );

    let output = `🧩 ДОСТУПНЫЕ НАВЫКИ (${result.catalog.length}):\n${catalogLines.join('\n')}`;

    // Level 2: полный контент triggered навыков
    if (result.triggered.length > 0) {
        const fullSections = result.triggered.map(skill =>
            `${skill.icon} **${skill.name}**\n${skill.content}`
        );
        output += `\n\n---\n\n📌 АКТИВНЫЕ НАВЫКИ (${result.triggered.length}):\n\n${fullSections.join('\n\n---\n\n')}`;
    }

    return output;
}

/**
 * Создать пользовательский навык.
 * Проверяет дубликаты по имени перед созданием.
 * @throws Error если навык с таким именем уже существует
 */
export async function createSkill(data: {
    name: string;
    description: string;
    content: string;
    category?: string;
    triggerKeywords?: string[];
    icon?: string;
}): Promise<Skill> {
    // Проверка дубликатов по имени
    const existing = await getSkillByName(data.name);
    if (existing) {
        throw new Error(
            `Навык с именем "${data.name}" уже существует (ID: ${existing.id}, slug: ${existing.slug}). ` +
            `Используй update_skill для редактирования существующего навыка.`
        );
    }

    // Генерируем slug из имени
    const slug = data.name
        .toLowerCase()
        .replace(/[^a-zа-яёa-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .substring(0, 50);

    // Генерируем embedding для семантического matching
    let embeddingJson: string | undefined;
    try {
        embeddingJson = await generateSkillEmbedding({
            name: data.name,
            description: data.description,
            triggerKeywords: data.triggerKeywords,
        });
    } catch (error: any) {
        console.warn(`⚠️ Не удалось создать embedding для навыка "${data.name}": ${error.message}`);
    }

    const [skill] = await db.insert(skills).values({
        slug: `custom-${slug}-${Date.now()}`,
        name: data.name,
        description: data.description,
        content: data.content,
        category: data.category || 'custom',
        isBuiltin: false,
        isActive: true,
        triggerKeywords: data.triggerKeywords || [],
        icon: data.icon || '🧩',
        embedding: embeddingJson,
    }).returning();

    return skill;
}

/**
 * Обновить навык.
 */
export async function updateSkill(id: number, data: Partial<{
    name: string;
    description: string;
    content: string;
    category: string;
    triggerKeywords: string[];
    icon: string;
}>): Promise<Skill | null> {
    // Обновляем embedding если изменились name, description или keywords
    let embeddingUpdate: string | undefined;
    if (data.name || data.description || data.triggerKeywords) {
        try {
            // Получаем текущий навык для merge полей
            const [current] = await db.select().from(skills).where(eq(skills.id, id));
            if (current) {
                embeddingUpdate = await generateSkillEmbedding({
                    name: data.name || current.name,
                    description: data.description || current.description,
                    triggerKeywords: data.triggerKeywords || current.triggerKeywords,
                });
            }
        } catch (error: any) {
            console.warn(`⚠️ Не удалось обновить embedding навыка: ${error.message}`);
        }
    }

    const updateData: any = { ...data, updatedAt: new Date() };
    if (embeddingUpdate) {
        updateData.embedding = embeddingUpdate;
    }

    const [updated] = await db.update(skills)
        .set(updateData)
        .where(eq(skills.id, id))
        .returning();
    return updated || null;
}

/**
 * Удалить навык (только пользовательские).
 */
export async function deleteSkill(id: number): Promise<boolean> {
    // Проверяем что не встроенный
    const [skill] = await db.select().from(skills).where(eq(skills.id, id));
    if (!skill || skill.isBuiltin) return false;

    // Удаляем settings
    await db.delete(userSkillSettings).where(eq(userSkillSettings.skillId, id));
    // Удаляем навык
    await db.delete(skills).where(eq(skills.id, id));
    return true;
}

/**
 * Переключить навык (вкл/выкл) через user_skill_settings.
 */
export async function toggleSkill(skillId: number, isEnabled: boolean): Promise<void> {
    // Upsert: обновляем если запись есть, создаём если нет
    const existing = await db.select().from(userSkillSettings)
        .where(eq(userSkillSettings.skillId, skillId));

    if (existing.length > 0) {
        await db.update(userSkillSettings)
            .set({ isEnabled, updatedAt: new Date() })
            .where(eq(userSkillSettings.skillId, skillId));
    } else {
        await db.insert(userSkillSettings).values({
            skillId,
            isEnabled,
        });
    }
}
