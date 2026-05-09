/**
 * Context Builder - Сборка контекста для AI-ответа
 * 
 * Отвечает за:
 * - Сбор релевантного контекста из памяти (единая buildContext с ContextPreferences)
 * - Форматирование контекста для промпта
 * - Определение приоритетов информации
 */

import { db } from "./db";
import { messages, facts, goals, type Message, type Fact, type Topic, type Goal, type MetricSnapshot } from "@shared/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import { hybridSearchFacts, type HybridSearchResult } from "./embeddingService";
import { TokenBudgetManager, type ContextSection } from "./tokenBudget";
import { getProfileContextForPrompt } from "./profileManager";
import { getCompetitorComparison } from "./competitorRegistry";
import { getLatestSnapshot } from "./metricsTracker";
import { imageToBase64DataUrl } from "./imageUtils";
import type { ContentPart } from "./aiConfigService";
import { getThinkingSummaryForContext } from "./cognitiveLoop";
import { getAdvisorContextForPrompt } from "./advisorEngine";
import { getRecentDocuments, searchDocuments } from "./documentManager";
import type { QueryPlan } from "./queryPlanner";


/**
 * Структура релевантного контекста
 */
export interface RelevantContext {
    recentMessages: Message[];
    relevantFacts: Fact[];
    relatedTopics: Topic[];
    detectedTopics: string[];
    userProfile: string; // Контекст профиля пользователя
    knowledgeRelationsContext: string | null; // Knowledge Graph v2
    goalsContext: { goals: Goal[]; summary: string } | null; // Цели пользователя
    // Data Ingestion контекст
    documentsContext: string | null; // Сохранённые документы
    competitorsContext: string | null; // Реестр конкурентов
    metricsContext: string | null; // Последние бизнес-метрики
    skillsContext: string | null; // Активные навыки AI
    preferencesContext: string | null; // Предпочтения пользователя (стилевые паттерны)
    reflectionContext: string | null; // Данные, найденные рефлектором (tool calls из contextReflector)
    cognitiveContext: string | null; // Данные из фонового мыслительного цикла (cognitiveLoop)
    advisorContext: string | null;   // Стратегическое видение советника (advisorEngine)
    // Context propagation
    sessionId?: string;
    messageId?: number;
    /** true если активирован режим быстрого выполнения (Fast Path) */
    _isFastPath?: boolean;
    broadcastStep?: (step: import('@shared/schema').ProcessingStep) => void;
}


/**
 * Опции для сборки контекста
 */
export interface ContextOptions {
    recentMessagesLimit?: number;
    factsLimit?: number;
    minFactSimilarity?: number;
    contextLength?: number; // размер контекстного окна модели (в токенах)
}

const DEFAULT_OPTIONS: ContextOptions = {
    recentMessagesLimit: 20,
    factsLimit: 15,
    minFactSimilarity: 0.4,
};

// ============================================================================
// Общие хелперы загрузки базовых данных
// ============================================================================

/**
 * Загрузка последних сообщений (хронологический порядок, без excludeFromContext)
 */
async function loadRecentMessages(limit: number): Promise<Message[]> {
    const msgs = await db.select()
        .from(messages)
        .where(eq(messages.excludeFromContext, false))
        .orderBy(desc(messages.timestamp))
        .limit(limit);
    msgs.reverse();
    return msgs;
}

/**
 * Загрузка профиля пользователя (с обработкой ошибок)
 */
async function loadUserProfile(): Promise<string> {
    try {
        return await getProfileContextForPrompt();
    } catch (err) {
        console.error('Ошибка получения профиля:', err);
        return '';
    }
}




// ============================================================================
// Единая сборка контекста (Adaptive — по ContextPreferences)
// ============================================================================

/**
 * Настройки загрузки контекста из экспертизы (expertise.contextPreferences)
 * 
 * Определяет, какие данные загружать помимо базовых (messages + profile).
 * Выбор preferences делает agentOrchestrator на основе:
 * - expertise (expertise.contextPreferences)
 * - Fast Path (уменьшает объём для простых команд)
 * - classification.needsContext (увеличивает глубину при необходимости)
 */
export interface ContextPreferences {
    loadGoals: boolean;
    loadMetrics: boolean;
    loadCompetitors: boolean;
    factSearchDepth: 'none' | 'shallow' | 'deep';
    maxFacts: number;
}

export const DEFAULT_CONTEXT_PREFERENCES: ContextPreferences = {
    loadGoals: true,
    loadMetrics: false,
    loadCompetitors: false,
    factSearchDepth: 'shallow',
    maxFacts: 10,
};

/**
 * 🎯 Единая функция сборки контекста
 * 
 * Адаптируется к экспертизе через ContextPreferences:
 * - business → loadMetrics + loadCompetitors + deep facts
 * - psychology → only goals + shallow facts
 * - general → base data only
 * 
 * Базовые данные (recentMessages + userProfile) грузятся ВСЕГДА.
 */
export async function buildContext(
    userMessage: string,
    preferences: ContextPreferences = DEFAULT_CONTEXT_PREFERENCES,
    options: ContextOptions = {}
): Promise<RelevantContext> {
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const prefs = { ...DEFAULT_CONTEXT_PREFERENCES, ...preferences };

    const startTime = Date.now();

    // ── Базовые данные (ВСЕГДА) ──
    const basePromises: Promise<any>[] = [
        loadRecentMessages(opts.recentMessagesLimit!),
        loadUserProfile(),
    ];

    // ── Факты (по factSearchDepth) ──
    const factLimit = prefs.factSearchDepth === 'deep' ? prefs.maxFacts :
        prefs.factSearchDepth === 'shallow' ? Math.min(prefs.maxFacts, 8) : 0;

    if (prefs.factSearchDepth !== 'none' && factLimit > 0) {
        basePromises.push(
            hybridSearchFacts(userMessage, factLimit, 0.35).catch(err => {
                console.error('Ошибка adaptive hybrid search:', err);
                return [] as HybridSearchResult[];
            })
        );
    } else {
        basePromises.push(Promise.resolve([]));
    }

    // ── Цели (опционально) ──
    if (prefs.loadGoals) {
        basePromises.push(
            db.select()
                .from(goals)
                .where(eq(goals.status, 'active'))
                .limit(5)
                .catch(err => {
                    console.error('Ошибка получения целей:', err);
                    return [] as Goal[];
                })
        );
    } else {
        basePromises.push(Promise.resolve([]));
    }

    // ── Метрики (опционально) ──
    if (prefs.loadMetrics) {
        basePromises.push(
            getLatestSnapshot().catch(err => {
                console.error('Ошибка получения метрик:', err);
                return null;
            })
        );
    } else {
        basePromises.push(Promise.resolve(null));
    }

    // ── Конкуренты (опционально) ──
    if (prefs.loadCompetitors) {
        basePromises.push(
            getCompetitorComparison().catch(err => {
                console.error('Ошибка получения конкурентов:', err);
                return null;
            })
        );
    } else {
        basePromises.push(Promise.resolve(null));
    }

    const [recentMessages, userProfile, autoSearchResults, activeGoals, metricsSnapshot, competitorsData] =
        await Promise.all(basePromises);

    // Загружаем полные данные фактов по найденным ID
    let relevantFacts: Fact[] = [];
    if (autoSearchResults && autoSearchResults.length > 0) {
        try {
            const factIds = autoSearchResults.map((r: HybridSearchResult) => r.id);
            relevantFacts = await db.select()
                .from(facts)
                .where(and(
                    sql`${facts.id} IN (${sql.join(factIds.map((id: number) => sql`${id}`), sql`, `)})`,
                    eq(facts.isCurrent, true)
                ));
            const similarityMap = new Map(autoSearchResults.map((r: HybridSearchResult) => [r.id, r.similarity]));
            relevantFacts.sort((a, b) => (Number(similarityMap.get(b.id)) || 0) - (Number(similarityMap.get(a.id)) || 0));
        } catch (err) {
            console.error('Ошибка загрузки авто-фактов:', err);
        }
    }

    // Форматируем метрики
    let metricsContext: string | null = null;
    if (metricsSnapshot) {
        const s = metricsSnapshot as MetricSnapshot;
        metricsContext = `📊 БИЗНЕС-МЕТРИКИ (${new Date(s.createdAt).toLocaleDateString('ru-RU')}):\n` +
            Object.entries(s.metrics as Record<string, any>)
                .map(([key, val]) => `  • ${key}: ${val}`)
                .join('\n');
    }

    // Форматируем конкурентов
    let competitorsContext: string | null = null;
    if (competitorsData) {
        const comp = competitorsData as any;
        if (comp.competitors && comp.competitors.length > 0) {
            competitorsContext = `🏢 КОНКУРЕНТЫ:\n` +
                comp.competitors.map((c: any) => `  • ${c.name}: ${c.description || ''}`).join('\n');
        }
    }

    const elapsed = Date.now() - startTime;
    const loadedSections = [
        `facts:${relevantFacts.length}`,
        prefs.loadGoals ? `goals:${activeGoals?.length || 0}` : 'goals:skip',
        prefs.loadMetrics ? `metrics:${metricsSnapshot ? 'yes' : 'no'}` : 'metrics:skip',
        prefs.loadCompetitors ? `competitors:${competitorsData ? 'yes' : 'no'}` : 'competitors:skip',
    ].join(', ');
    console.log(`[AdaptiveContext] 🎯 ${elapsed}ms | depth=${prefs.factSearchDepth} | ${loadedSections}`);

    return {
        recentMessages,
        relevantFacts,
        relatedTopics: [],
        detectedTopics: [],
        userProfile,
        knowledgeRelationsContext: null,
        goalsContext: activeGoals && activeGoals.length > 0
            ? { goals: activeGoals as Goal[], summary: `${activeGoals.length} активных целей` }
            : null,
        documentsContext: null,
        competitorsContext,
        metricsContext,
        skillsContext: null,
        preferencesContext: null,         // Заполняется в agentOrchestrator
        reflectionContext: null,          // Заполняется в contextReflector
        cognitiveContext: null,           // Заполняется из cognitiveLoop
        advisorContext: null,             // Заполняется из advisorEngine
    };
}

/**
 * [CRITICAL: CACHE-FIRST DESIGN PATTERN]
 * 
 * Формирует секции контекста из памяти с адаптивным бюджетированием.
 * 
 * ⚠️ ПРАВИЛО СОРТИРОВКИ: Секции отранжированы от стабильных (Skills, Profile) 
 * до динамичных (Facts, Time). Не меняйте порядок! 
 * Это критично для префиксного кеширования DeepSeek.
 * 
 * @param context - собранный контекст
 * @param contextLength - лимит токенов (окно модели)
 */
export function formatContextForPrompt(context: RelevantContext, contextLength?: number, modelName?: string): string {
    const budget = new TokenBudgetManager(contextLength);
    const sections: string[] = [];

    // ── B1: Intent-based приоритизация секций ──
    // Буст секций на основе тем, обнаруженных в сообщении пользователя.
    // Вызывается ДО любого fitContent/fitItems, чтобы аллокации были скорректированы.
    if (context.detectedTopics && context.detectedTopics.length > 0) {
        const topicsLower = context.detectedTopics.map(t => t.toLowerCase());
        const hasMatch = (keywords: string[]) =>
            topicsLower.some(t => keywords.some(k => t.includes(k)));

        if (hasMatch(['цел', 'план', 'goal'])) budget.boostSection('goals', 1.5);
        if (hasMatch(['метрик', 'финанс', 'деньг', 'доход', 'выручк'])) budget.boostSection('metrics', 1.5);
        if (hasMatch(['заметк', 'запис', 'документ', 'note'])) budget.boostSection('documents', 1.5);
        if (hasMatch(['конкурент', 'рынок', 'competitor'])) budget.boostSection('competitors', 1.5);
    }

    // Секция: Навыки AI (приоритет 9 — высокий, перед фактами)
    if (context.skillsContext) {
        const { content } = budget.fitContent('skills', context.skillsContext);
        sections.push(content);
    } else {
        budget.markEmpty('skills');
    }

    // Секция: Профиль пользователя (приоритет 7)
    if (context.userProfile && context.userProfile.trim().length > 0) {
        const profileText = `👤 ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ:\n${context.userProfile}`;
        const { content } = budget.fitContent('userProfile', profileText);
        sections.push(content);
    } else {
        budget.markEmpty('userProfile');
    }

    // Перераспределяем после профиля (может быть компактным)
    budget.redistributeUnused();

    // Секция: Факты о пользователе/бизнесе (приоритет 8)
    // B2: Дедупликация — убираем факты, уже представленные в reflectionContext
    let factsToFormat = context.relevantFacts;
    if (context.reflectionContext && factsToFormat.length > 0) {
        const reflectionLower = context.reflectionContext.toLowerCase();
        const before = factsToFormat.length;
        factsToFormat = factsToFormat.filter(f => {
            const preview = f.content.substring(0, 100).toLowerCase();
            return !reflectionLower.includes(preview);
        });
        const removed = before - factsToFormat.length;
        if (removed > 0) {
            console.log(`[ContextDedup] Убрано ${removed} фактов — уже есть в reflection`);
        }
    }

    if (factsToFormat.length > 0) {
        const { items: fittedFacts, keptItems, totalItems } = budget.fitItems(
            'facts',
            factsToFormat,
            (f) => {
                const confidence = f.confidence === 'high' ? '✓' : f.confidence === 'medium' ? '~' : '?';
                return `${confidence} ${f.content}`;
            }
        );

        const factsSection = fittedFacts.map(f => {
            const confidence = f.confidence === 'high' ? '✓' : f.confidence === 'medium' ? '~' : '?';
            return `${confidence} ${f.content}`;
        }).join('\n');

        const truncNote = keptItems < totalItems ? ` (показано ${keptItems} из ${totalItems})` : '';
        sections.push(`📋 ИЗВЕСТНЫЕ ФАКТЫ${truncNote}:\n${factsSection}`);
    } else {
        budget.markEmpty('facts');
    }

    // Секция: Связанные области (не потребляет бюджет — малый объём)
    if (context.relatedTopics.length > 0) {
        const topicNames = context.relatedTopics.map(t => t.name).join(', ');
        sections.push(`🔗 СВЯЗАННЫЕ ОБЛАСТИ ЗНАНИЙ: ${topicNames}`);
    }

    // Перераспределяем бюджет перед оставшимися секциями
    budget.redistributeUnused();

    // Секция: Knowledge Graph v2 (приоритет 5)
    if (context.knowledgeRelationsContext) {
        const { content } = budget.fitContent('knowledgeGraph', context.knowledgeRelationsContext);
        sections.push(content);
    } else {
        budget.markEmpty('knowledgeGraph');
    }

    // Секции фонового анализа и рефлектора перенесены в конец (динамические данные)

    // Секция: Цели пользователя (приоритет 6)
    if (context.goalsContext && context.goalsContext.goals.length > 0) {
        const goalsText = context.goalsContext.goals.map(g => {
            const statusIcon = g.status === 'active' ? '🎯' : g.status === 'completed' ? '✅' : '❌';
            const deadline = g.deadline ? ` (дедлайн: ${new Date(g.deadline).toLocaleDateString('ru-RU')})` : '';
            const progress = g.progress > 0 ? ` [${g.progress}%]` : '';
            return `${statusIcon} [ID: ${g.id}] ${g.title}${deadline}${progress}`;
        }).join('\n');

        const { content } = budget.fitContent('goals', `🎯 ЦЕЛИ ПОЛЬЗОВАТЕЛЯ:\n${goalsText}`);
        sections.push(content);
    } else {
        budget.markEmpty('goals');
    }

    // Перераспределяем перед data-ingestion секциями
    budget.redistributeUnused();

    // Секция: Бизнес-метрики (приоритет 2)
    if (context.metricsContext) {
        const { content } = budget.fitContent('metrics', context.metricsContext);
        sections.push(content);
    } else {
        budget.markEmpty('metrics');
    }

    // Секция: Конкуренты (приоритет 3)
    if (context.competitorsContext) {
        const { content } = budget.fitContent('competitors', context.competitorsContext);
        sections.push(content);
    } else {
        budget.markEmpty('competitors');
    }

    // Перераспределяем весь неиспользованный бюджет для документов
    budget.redistributeUnused();

    // Секция: Документы (приоритет 4, но часто самые объёмные)
    if (context.documentsContext) {
        const { content } = budget.fitContent('documents', context.documentsContext);
        sections.push(content);
    } else {
        budget.markEmpty('documents');
    }

    // ── ДИНАМИЧЕСКИЙ КОНТЕКСТ (В КОНЦЕ ДЛЯ КЕШИРОВАНИЯ) ──

    // Секция: Фоновый анализ Cognitive Loop (если есть свежие мысли)
    const thinkingSummary = context.cognitiveContext || getThinkingSummaryForContext();
    if (thinkingSummary) {
        sections.push(`🧠 ФОНОВЫЙ АНАЛИЗ АССИСТЕНТА:\n${thinkingSummary}`);
    }

    // Секция: Стратегическое видение советника
    const advisorSummary = context.advisorContext || getAdvisorContextForPrompt();
    if (advisorSummary) {
        sections.push(`🎯 СТРАТЕГИЧЕСКОЕ ВИДЕНИЕ СОВЕТНИКА:\n${advisorSummary}\n(Используй этот контекст для мягких советов, когда релевантно. Не навязывай — предлагай.)`);
    }

    // Секция: Данные рефлектора (приоритет 9 — высокий, чтобы модель видела что уже найдено)
    if (context.reflectionContext) {
        const reflectionHeader = `🔍 ДАННЫЕ, НАЙДЕННЫЕ РЕФЛЕКТОРОМ (НЕ НУЖНО ЗАПРАШИВАТЬ ПОВТОРНО):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        const reflectionFull = `${reflectionHeader}\n${context.reflectionContext}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        const { content } = budget.fitContent('reflection', reflectionFull);
        sections.push(content);
    } else {
        budget.markEmpty('reflection');
    }

    // ── СТАБИЛЬНЫЙ КЕШ: Время и динамические данные перенесены в конец ──
    // Это позволяет закешировать все предыдущие секции (профиль, факты, цели), 
    // даже если время меняется каждую минуту.
    const now = new Date();
    const timeInfo = now.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
    sections.push(`\n🕐 ТЕКУЩЕЕ ВРЕМЯ: ${timeInfo} (МСК)`);

    // Отправляем сводку бюджета как шаг обработки (для визуализации в UI)
    if (context.broadcastStep && context.messageId) {
        const budgetData = budget.getSummaryData();
        context.broadcastStep({
            type: 'processing_step',
            messageId: context.messageId,
            stepId: 'context_optimization',
            stepName: 'Оптимизация контекста',
            stepIcon: '📐',
            status: 'completed',
            timestamp: new Date().toISOString(),
            output: {
                summary: `Бюджет: ${budgetData.total_used}/${budgetData.total_budget} токенов (${budgetData.usage_percentage}%)`,
                data: {
                    ...budgetData,
                    model: modelName || 'unknown'
                }
            }
        });
    }

    // Логируем использование бюджета в консоль
    console.log(budget.getSummary());

    if (sections.length === 0) {
        return '';
    }

    return `
═══════════════════════════════════════════════════════
КОНТЕКСТ ИЗ ПАМЯТИ:
═══════════════════════════════════════════════════════
${sections.join('\n\n')}
═══════════════════════════════════════════════════════
`;
}


/**
 * Форматирование истории сообщений для промпта
 *
 * Поддерживает multimodal: если сообщение — изображение (type='image' + fileUrl),
 * content становится массивом ContentPart[] с текстом и base64 image_url.
 *
 * @param messages - Список сообщений (уже отфильтрованных по excludeFromContext = false)
 * @param compactionSummary - Опциональное резюме прошлой части диалога (Session Compaction).
 *   Если передано, вставляется первым assistant-сообщением перед историей,
 *   чтобы модель «помнила» то, что было сжато.
 */
export function formatMessagesForPrompt(
    messages: Message[],
    compactionSummary?: string | null
): Array<{ role: 'user' | 'assistant'; content: string | ContentPart[] }> {
    // ─── Дедупликация: пропускаем сообщения с идентичным content_preview/content в пределах 10 минут ───
    const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 минут
    const seen = new Map<string, number>(); // content hash → timestamp
    const deduplicated = messages.filter(m => {
        if (!m.content) return true;
        const key = m.content.substring(0, 200).trim().toLowerCase();
        const ts = m.timestamp ? new Date(m.timestamp).getTime() : 0;
        const prevTs = seen.get(key);
        if (prevTs !== undefined && Math.abs(ts - prevTs) < DEDUP_WINDOW_MS) {
            return false; // дубликат
        }
        seen.set(key, ts);
        return true;
    });

    // 🗜️ Session Compaction: вставляем резюме первым assistant-сообщением
    const prefixMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    if (compactionSummary) {
        prefixMessages.push({
            role: 'assistant' as const,
            content: `[КРАТКОЕ РЕЗЮМЕ ПРЕДЫДУЩЕЙ ЧАСТИ РАЗГОВОРА]:\n${compactionSummary}\n[КОНЕЦ РЕЗЮМЕ — далее идёт текущая история]`,
        });
    }

    const formattedMessages = deduplicated
        .filter(m => m.sender === 'user' || m.sender === 'ai')
        .map(m => {
            const role = m.sender === 'user' ? 'user' as const : 'assistant' as const;

            // Временная метка сообщения — позволяет агенту видеть хронологию диалога
            const timePrefix = m.timestamp
                ? `[${new Date(m.timestamp).toLocaleString('ru-RU', {
                    timeZone: 'Europe/Moscow',
                    day: '2-digit', month: '2-digit', year: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                })}] `
                : '';

            // Multimodal: изображения отправляем как ContentPart[]
            if (m.type === 'image' && m.fileUrl && role === 'user') {
                const dataUrl = imageToBase64DataUrl(m.fileUrl);
                if (dataUrl) {
                    const parts: ContentPart[] = [];
                    // Текст пользователя (если есть, кроме дефолтного "Изображение")
                    const textContent = m.content && m.content !== 'Изображение'
                        ? timePrefix + m.content
                        : 'Что на этом изображении?';
                    parts.push({ type: 'text', text: textContent });
                    parts.push({
                        type: 'image_url',
                        image_url: { url: dataUrl, detail: 'low' }
                    });
                    return { role, content: parts };
                }
                // Fallback: если не удалось прочитать файл, отправляем только текст
                console.warn(`[formatMessages] ⚠️ Не удалось загрузить изображение: ${m.fileUrl}`);
            }

            // ─── Обработка аудио-транскриптов ───
            let content = m.content || '';
            if (m.type === 'audio' && role === 'user') {
                // Маркируем аудио, чтобы модель не путала транскрипт со своим текстом
                const AUDIO_MAX_WORDS = 300;
                const words = content.split(/\s+/);
                if (words.length > AUDIO_MAX_WORDS) {
                    // Обрезаем длинные аудио-транскрипты для экономии контекста
                    content = words.slice(0, 200).join(' ')
                        + `\n[...транскрипт обрезан, ${words.length} слов всего]`;
                }
                content = `[🎙️ Транскрипт аудио пользователя]\n${content}`;
            }

            return { role, content: timePrefix + content };
        });

    return [...prefixMessages, ...formattedMessages];
}

/**
 * Получение полного контекста как одной строки для отладки
 */
export function getContextSummary(context: RelevantContext): string {
    return `Контекст: ${context.recentMessages.length} сообщений, ${context.relevantFacts.length} фактов, ${context.relatedTopics.length} тем, определено тем: ${context.detectedTopics.join(', ') || 'нет'}`;
}


// ============================================================================
// Data Ingestion контекстные хелперы
// ============================================================================

/**
 * Формирует контекст из сохранённых документов
 * 
 * Подтягивает ПОЛНОЕ содержимое релевантных документов,
 * с ограничением общего размера чтобы не раздувать промпт.
 */
const MAX_DOCUMENTS_CONTEXT_LENGTH = 50000; // Максимум символов на все документы

async function buildDocumentsContext(userMessage: string): Promise<string | null> {
    try {
        // Ищем релевантные документы по сообщению, иначе последние
        let docs = await searchDocuments(userMessage, 3);
        if (docs.length === 0) {
            docs = await getRecentDocuments(2);
        }
        if (docs.length === 0) return null;

        let totalLength = 0;
        const items: string[] = [];

        for (const d of docs) {
            const header = `📄 [${d.documentType}] ${d.title}`;
            const date = d.createdAt ? ` (${new Date(d.createdAt).toLocaleDateString('ru-RU')})` : '';

            // Определяем сколько контента можно включить
            const remainingBudget = MAX_DOCUMENTS_CONTEXT_LENGTH - totalLength;

            if (remainingBudget <= 200) {
                // Бюджет исчерпан — только заголовок
                items.push(`${header}${date}: (содержимое не включено — лимит контекста)`);
                break;
            }

            const content = d.content || '';
            if (content.length <= remainingBudget) {
                // Полный контент помещается
                items.push(`${header}${date}\n${content}`);
                totalLength += content.length;
            } else {
                // Обрезаем контент
                const truncated = content.substring(0, remainingBudget - 50);
                const lastNewline = truncated.lastIndexOf('\n');
                const cleanCut = lastNewline > remainingBudget * 0.5 ? truncated.substring(0, lastNewline) : truncated;
                items.push(`${header}${date}\n${cleanCut}\n... [документ обрезан, полный размер: ${content.length} символов]`);
                totalLength += cleanCut.length;
            }
        }

        return `📄 СОХРАНЁННЫЕ ДОКУМЕНТЫ:\n\n${items.join('\n\n---\n\n')}`;
    } catch (error) {
        console.error('Ошибка загрузки документов:', error);
        return null;
    }
}

/**
 * Формирует контекст из реестра конкурентов
 */
async function buildCompetitorsContext(): Promise<string | null> {
    try {
        const comparison = await getCompetitorComparison();
        if (comparison.length === 0) return null;

        const items = comparison.map(({ competitor, attributes }) => {
            const attrStr = attributes.length > 0
                ? attributes.map(a => `  • ${a.key}: ${a.value}`).join('\n')
                : '  (нет атрибутов)';
            const website = competitor.website ? ` (${competitor.website})` : '';
            const aliases = (competitor.aliases || []) as string[];
            const aliasStr = aliases.length > 0 ? `\n  📝 Также известен как: ${aliases.join(', ')}` : '';
            return `🏢 ${competitor.name}${website}${aliasStr}\n${attrStr}`;
        }).join('\n');

        return `🏆 КОНКУРЕНТЫ:\n${items}`;
    } catch (error) {
        console.error('Ошибка загрузки конкурентов:', error);
        return null;
    }
}

/**
 * Формирует контекст из последних бизнес-метрик
 */
async function buildMetricsContext(): Promise<string | null> {
    try {
        const snapshot = await getLatestSnapshot();
        if (!snapshot) return null;

        const metrics = snapshot.metrics as Record<string, number | string>;
        const metricsStr = Object.entries(metrics)
            .map(([key, value]) => `  • ${key}: ${value}`)
            .join('\n');

        let changesStr = '';
        if (snapshot.changes) {
            const changes = snapshot.changes as Record<string, { prev: number; curr: number; delta: number; pct: number }>;
            changesStr = '\nИзменения: ' + Object.entries(changes)
                .map(([k, c]) => `${k}: ${c.pct > 0 ? '+' : ''}${c.pct}%`)
                .join(', ');
        }

        return `📊 БИЗНЕС-МЕТРИКИ (за ${snapshot.period}, ${snapshot.periodType}):\n${metricsStr}${changesStr}`;
    } catch (error) {
        console.error('Ошибка загрузки метрик:', error);
        return null;
    }
}


// ============================================================================
// Типы, экспортируемые для других модулей
// ============================================================================

/**
 * Результат планирования контекста (используется в insightEngine)
 */
export interface QueryPlanningResult {
    plan: QueryPlan;
    dataSources: {
        topicCategories: string[];
        factCount: number;
        hasProfile: boolean;
        hasGoals: boolean;
    };
}

