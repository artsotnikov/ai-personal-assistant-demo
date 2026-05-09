/**
 * Token Budget Manager — Интеллектуальное распределение контекстного окна
 * 
 * Вместо жёстких лимитов (35 фактов, 10 сообщений, 3 документа)
 * динамически распределяет бюджет токенов по секциям в зависимости
 * от размера контекстного окна текущей LLM-модели.
 * 
 * Приоритеты элементов:
 * 1. System prompt (фиксирован)
 * 2. Recent messages (история диалога)
 * 3. Facts (факты из hybrid search)
 * 4. User profile
 * 5. Goals
 * 6. Knowledge graph
 * 7. Documents
 * 8. Competitors
 * 9. Metrics
 * 10. Response budget (резерв для ответа модели)
 */

import { estimateTokenCount } from "./chunkService";

// ============================================================================
// Типы
// ============================================================================

/** Имена секций контекста */
export type ContextSection =
    | 'systemPrompt'
    | 'recentMessages'
    | 'reflection'
    | 'facts'
    | 'userProfile'
    | 'goals'
    | 'knowledgeGraph'
    | 'documents'
    | 'competitors'
    | 'metrics'
    | 'skills';

/** Конфигурация одной секции */
interface SectionConfig {
    /** Приоритет (выше = важнее, 10 = макс) */
    priority: number;
    /** Минимальная доля бюджета (0-1) */
    minShare: number;
    /** Максимальная доля бюджета (0-1) */
    maxShare: number;
    /** Метка для логов */
    label: string;
}

/** Результат распределения бюджета */
export interface TokenAllocation {
    /** Имя секции */
    section: ContextSection;
    /** Выделено токенов */
    allocated: number;
    /** Использовано токенов */
    used: number;
    /** Метка */
    label: string;
}

/** Результат усечения контента */
export interface FitResult {
    /** Текст, вписанный в бюджет */
    content: string;
    /** Сколько токенов использовано */
    tokensUsed: number;
    /** Был ли контент обрезан */
    wasTruncated: boolean;
}

// ============================================================================
// Конфигурация секций
// ============================================================================

const SECTION_CONFIGS: Record<ContextSection, SectionConfig> = {
    systemPrompt: { priority: 10, minShare: 0, maxShare: 0, label: 'System Prompt' },
    recentMessages: { priority: 9, minShare: 0.15, maxShare: 0.40, label: 'История диалога' },
    facts: { priority: 8, minShare: 0.10, maxShare: 0.35, label: 'Факты' },
    userProfile: { priority: 7, minShare: 0.02, maxShare: 0.08, label: 'Профиль' },
    goals: { priority: 6, minShare: 0.02, maxShare: 0.08, label: 'Цели' },
    knowledgeGraph: { priority: 5, minShare: 0.02, maxShare: 0.10, label: 'Граф знаний' },
    documents: { priority: 4, minShare: 0.03, maxShare: 0.20, label: 'Документы' },
    competitors: { priority: 3, minShare: 0.02, maxShare: 0.10, label: 'Конкуренты' },
    metrics: { priority: 2, minShare: 0.01, maxShare: 0.05, label: 'Метрики' },
    skills: { priority: 9, minShare: 0.02, maxShare: 0.08, label: 'Навыки' },
    reflection: { priority: 9, minShare: 0.05, maxShare: 0.20, label: 'Данные рефлектора' },
};

/** Доля бюджета, зарезервированная для ответа модели */
const RESPONSE_RESERVE_SHARE = 0.12;

/** Бюджет по умолчанию (если contextLength не указан).
 * 128K — совпадает с DeepSeek V3.2 (минимальная модель в workflow).
 * Реальное значение приходит из modelContextRegistry через aiConfigService. */
const DEFAULT_CONTEXT_LENGTH = 128_000;

/** Токены на systemPrompt (фиксированная оценка) */
const SYSTEM_PROMPT_TOKENS = 600;

// ============================================================================
// TokenBudgetManager
// ============================================================================

export class TokenBudgetManager {
    /** Полный бюджет контекстного окна (токены) */
    readonly totalBudget: number;
    /** Бюджет, доступный для контента (без system prompt и reserve) */
    readonly contentBudget: number;
    /** Распределение по секциям */
    private allocations = new Map<ContextSection, number>();
    /** Фактическое использование */
    private usage = new Map<ContextSection, number>();

    constructor(contextLength?: number) {
        this.totalBudget = contextLength || DEFAULT_CONTEXT_LENGTH;
        // Вычитаем system prompt и резерв для ответа
        const responseReserve = Math.ceil(this.totalBudget * RESPONSE_RESERVE_SHARE);
        this.contentBudget = this.totalBudget - SYSTEM_PROMPT_TOKENS - responseReserve;

        this.allocateInitialBudget();
    }

    /**
     * Начальное распределение бюджета по секциям
     * Каждая секция получает свою долю от contentBudget
     */
    private allocateInitialBudget(): void {
        // Суммируем все minShare для определения базового распределения
        const sections = Object.entries(SECTION_CONFIGS) as [ContextSection, SectionConfig][];

        // Сначала выделяем минимум каждой секции
        let remainingBudget = this.contentBudget;
        for (const [section, config] of sections) {
            if (section === 'systemPrompt') continue; // уже учтён
            const minTokens = Math.ceil(this.contentBudget * config.minShare);
            this.allocations.set(section, minTokens);
            remainingBudget -= minTokens;
        }

        // Распределяем остаток пропорционально приоритетам
        if (remainingBudget > 0) {
            const weightedSections = sections
                .filter(([s]) => s !== 'systemPrompt')
                .map(([section, config]) => ({
                    section,
                    weight: config.priority,
                    maxExtra: Math.ceil(this.contentBudget * config.maxShare) - (this.allocations.get(section) || 0),
                }))
                .filter(s => s.maxExtra > 0);

            const totalWeight = weightedSections.reduce((sum, s) => sum + s.weight, 0);

            for (const s of weightedSections) {
                const extraShare = remainingBudget * (s.weight / totalWeight);
                const extra = Math.min(Math.ceil(extraShare), s.maxExtra);
                const current = this.allocations.get(s.section) || 0;
                this.allocations.set(s.section, current + extra);
            }
        }
    }

    /**
     * Получить бюджет для секции
     */
    getAllocation(section: ContextSection): number {
        return this.allocations.get(section) || 0;
    }

    /**
     * Вычислить максимальное количество элементов (фактов, сообщений),
     * которые вписываются в бюджет секции
     */
    getMaxItems(section: ContextSection, avgTokensPerItem: number): number {
        const budget = this.getAllocation(section);
        return Math.max(1, Math.floor(budget / Math.max(1, avgTokensPerItem)));
    }

    /**
     * Вписать текст в бюджет секции.
     * Если текст не влезает — обрезает с конца, стараясь обрезать по \n
     */
    fitContent(section: ContextSection, content: string): FitResult {
        const budget = this.getAllocation(section);
        const tokens = estimateTokenCount(content);

        if (tokens <= budget) {
            this.usage.set(section, tokens);
            return { content, tokensUsed: tokens, wasTruncated: false };
        }

        // Нужно обрезать — приблизительно ratio символов к токенам
        const charBudget = Math.floor(content.length * (budget / tokens));
        let truncated = content.substring(0, charBudget);

        // Ищем последний перенос строки для "чистого" обрезания
        const lastNewline = truncated.lastIndexOf('\n');
        if (lastNewline > charBudget * 0.5) {
            truncated = truncated.substring(0, lastNewline);
        }

        const truncatedTokens = estimateTokenCount(truncated);
        this.usage.set(section, truncatedTokens);

        return {
            content: truncated + '\n... [обрезано по бюджету токенов]',
            tokensUsed: truncatedTokens,
            wasTruncated: true,
        };
    }

    /**
     * Вписать массив элементов в бюджет секции.
     * Возвращает подмножество элементов, вписывающееся в бюджет.
     */
    fitItems<T>(
        section: ContextSection,
        items: T[],
        formatter: (item: T) => string,
    ): { items: T[]; tokensUsed: number; totalItems: number; keptItems: number } {
        const budget = this.getAllocation(section);
        const result: T[] = [];
        let totalTokens = 0;

        for (const item of items) {
            const formatted = formatter(item);
            const itemTokens = estimateTokenCount(formatted);

            if (totalTokens + itemTokens > budget && result.length > 0) {
                // Бюджет исчерпан, но хотя бы 1 элемент включён
                break;
            }

            result.push(item);
            totalTokens += itemTokens;
        }

        this.usage.set(section, totalTokens);

        return {
            items: result,
            tokensUsed: totalTokens,
            totalItems: items.length,
            keptItems: result.length,
        };
    }

    /**
     * Перераспределить неиспользованный бюджет.
     * Вызывается после того как секции с высоким приоритетом использовали меньше,
     * чем им было выделено. Остаток перекидывается на секции с более низким приоритетом.
     */
    redistributeUnused(): void {
        let freed = 0;

        // Собираем неиспользованный бюджет
        Array.from(this.allocations.entries()).forEach(([section, allocated]) => {
            const used = this.usage.get(section) || 0;
            if (used < allocated) {
                freed += (allocated - used);
                this.allocations.set(section, used); // сжимаем до использованного
            }
        });

        if (freed <= 0) return;

        // Раздаём освобождённый бюджет секциям, которые ещё не обработаны
        const sections = Object.entries(SECTION_CONFIGS) as [ContextSection, SectionConfig][];
        const unfilled = sections
            .filter(([s]) => s !== 'systemPrompt' && !this.usage.has(s))
            .sort((a, b) => b[1].priority - a[1].priority);

        if (unfilled.length === 0) return;

        const totalWeight = unfilled.reduce((sum, [, c]) => sum + c.priority, 0);
        for (const [section, config] of unfilled) {
            const extra = Math.ceil(freed * (config.priority / totalWeight));
            const maxAllowed = Math.ceil(this.contentBudget * config.maxShare);
            const current = this.allocations.get(section) || 0;
            this.allocations.set(section, Math.min(current + extra, maxAllowed));
        }
    }

    /**
     * Отметить секцию как обработанную (когда контент пустой)
     */
    markEmpty(section: ContextSection): void {
        this.usage.set(section, 0);
    }

    /**
     * Увеличить бюджет секции для intent-based приоритизации.
     *
     * Перераспределяет токены от необработанных секций с низким приоритетом
     * к указанной секции. Не опускает доноров ниже их minShare.
     *
     * @param section - секция, получающая буст
     * @param multiplier - коэффициент (1.5 = +50% к текущей аллокации)
     */
    boostSection(section: ContextSection, multiplier: number): void {
        if (multiplier <= 1) return;
        const current = this.allocations.get(section);
        if (!current) return;

        const config = SECTION_CONFIGS[section];
        const maxAllowed = Math.ceil(this.contentBudget * config.maxShare);
        const desired = Math.ceil(current * multiplier);
        const boost = Math.min(desired - current, maxAllowed - current);
        if (boost <= 0) return;

        // Собираем бюджет у необработанных низкоприоритетных секций
        const allEntries = Array.from(this.allocations.entries()) as [ContextSection, number][];
        const filteredDonors = allEntries
            .filter(([s]) => s !== section && s !== 'systemPrompt' && !this.usage.has(s))
            .sort((a, b) => SECTION_CONFIGS[a[0]].priority - SECTION_CONFIGS[b[0]].priority);

        let remaining = boost;
        for (const [donorSection, donorAlloc] of filteredDonors) {
            if (remaining <= 0) break;
            const minTokens = Math.ceil(this.contentBudget * SECTION_CONFIGS[donorSection].minShare);
            const canGive = Math.max(0, donorAlloc - minTokens);
            const give = Math.min(canGive, remaining);
            if (give > 0) {
                this.allocations.set(donorSection, donorAlloc - give);
                remaining -= give;
            }
        }

        const actualBoost = boost - remaining;
        if (actualBoost > 0) {
            this.allocations.set(section, current + actualBoost);
            console.log(`[TokenBudget] ⚡ boost ${section}: ${current} → ${current + actualBoost} tok (×${multiplier})`);
        }
    }

    /**
     * Получить данные сводки бюджета (машиночитаемые)
     */
    getSummaryData(): Record<string, any> {
        const sections: Record<string, any> = {};
        let totalUsed = 0;

        for (const [section, config] of Object.entries(SECTION_CONFIGS) as [ContextSection, SectionConfig][]) {
            if (section === 'systemPrompt') {
                sections[section] = {
                    label: config.label,
                    allocated: SYSTEM_PROMPT_TOKENS,
                    used: SYSTEM_PROMPT_TOKENS,
                    percentage: 100
                };
                totalUsed += SYSTEM_PROMPT_TOKENS;
                continue;
            }

            const allocated = this.allocations.get(section) || 0;
            const used = this.usage.get(section) || 0;
            totalUsed += used;

            if (used > 0 || allocated > 0) {
                sections[section] = {
                    label: config.label,
                    allocated,
                    used,
                    percentage: allocated > 0 ? Math.round((used / allocated) * 100) : 0
                };
            }
        }

        const usagePct = Math.round((totalUsed / this.totalBudget) * 100);
        const contentUsagePct = Math.round(((totalUsed - SYSTEM_PROMPT_TOKENS) / this.contentBudget) * 100);

        return {
            total_budget: this.totalBudget,
            content_budget: this.contentBudget,
            total_used: totalUsed,
            usage_percentage: usagePct,
            content_usage_percentage: contentUsagePct,
            sections
        };
    }

    /**
     * Получить сводку бюджета для логирования
     */
    getSummary(): string {
        const data = this.getSummaryData();
        const lines: string[] = [];

        for (const section of Object.values(data.sections) as any[]) {
            lines.push(`  ${section.label}: ${section.used}/${section.allocated} tok (${section.percentage}%)`);
        }

        return `📊 Token budget (${data.total_budget} total, ${data.content_budget} content):\n` +
            lines.join('\n') +
            `\n  ─────────────────────────────\n  ИТОГО: ${data.total_used}/${data.total_budget} tok (${data.usage_percentage}%)`;
    }
}
