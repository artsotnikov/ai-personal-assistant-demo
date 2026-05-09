/**
 * Self-Reflection Engine — Самоанализ после каждого диалога
 * 
 * «Мог ли я ответить лучше? Что я упустил?»
 * 
 * Запускается как fire-and-forget после каждого ответа агента.
 * Анализирует:
 * - Неудачные tool calls
 * - «Я не знаю» ответы — есть ли данные в памяти?
 * - Неиспользованные инструменты, которые могли бы помочь
 * - Паттерны запросов пользователя
 */

import { db } from "./db";
import { facts, messages } from "@shared/schema";
import { eq, and, gt, desc, count, sql } from "drizzle-orm";
import { searchFactsByQuery } from "./embeddingService";

// ============================================================================
// Конфигурация
// ============================================================================

const CONFIG = {
    /** Минимальная длина ответа для анализа (исключаем «Привет!») */
    minResponseLength: 50,
    
    /** Максимально анализируемых tool calls */
    maxToolCallsToAnalyze: 10,

    /** Фразы, указывающие на незнание */
    uncertaintyPhrases: [
        'не знаю', 'не могу найти', 'нет информации', 'не удалось',
        'к сожалению', 'не уверен', 'точно не скажу', 'затрудняюсь',
        'у меня нет данных', 'не располагаю',
    ],
};

// ============================================================================
// Типы
// ============================================================================

export interface ReflectionResult {
    analyzed: boolean;
    findings: ReflectionFinding[];
    improvements: string[];
    timestamp: Date;
}

export interface ReflectionFinding {
    type: 'failed_tool' | 'missed_knowledge' | 'unused_capability' | 'pattern';
    severity: 'low' | 'medium' | 'high';
    description: string;
    suggestion?: string;
}

// In-memory хранилище последних findings (для инъекции в контекст)
let recentFindings: ReflectionFinding[] = [];
let lastReflectionTime: Date | null = null;

/**
 * Получить недавние findings для контекста
 * (очищает findings после получения — one-shot)
 */
export function getAndClearRecentFindings(): ReflectionFinding[] {
    const findings = [...recentFindings];
    recentFindings = [];
    return findings;
}

// ============================================================================
// Основная логика
// ============================================================================

/**
 * Анализ завершённого диалога
 * 
 * Вызывается из agentOrchestrator.ts после отправки ответа.
 * Fire-and-forget — не блокирует ответ пользователю.
 */
export async function analyzeConversation(params: {
    userMessage: string;
    agentResponse: string;
    toolCalls?: Array<{ toolName: string; success: boolean; durationMs: number }>;
    agentSlug: string;
    tokensUsed: number;
}): Promise<ReflectionResult> {
    const { userMessage, agentResponse, toolCalls = [], agentSlug, tokensUsed } = params;

    // Пропускаем короткие ответы (приветствия, small talk)
    if (agentResponse.length < CONFIG.minResponseLength) {
        return { analyzed: false, findings: [], improvements: [], timestamp: new Date() };
    }

    const findings: ReflectionFinding[] = [];
    const improvements: string[] = [];

    try {
        // 1. Проверяем неудачные tool calls
        const failedCalls = toolCalls.filter(tc => !tc.success);
        if (failedCalls.length > 0) {
            for (const tc of failedCalls) {
                findings.push({
                    type: 'failed_tool',
                    severity: 'medium',
                    description: `Tool «${tc.toolName}» завершился с ошибкой (${tc.durationMs}ms)`,
                    suggestion: `Проверить доступность ${tc.toolName} и входные параметры`,
                });
            }
        }

        // 2. Проверяем «я не знаю» ответы
        const responseLower = agentResponse.toLowerCase();
        const hadUncertainty = CONFIG.uncertaintyPhrases.some(phrase => 
            responseLower.includes(phrase)
        );

        if (hadUncertainty) {
            // Ищем в памяти — может, ответ уже есть?
            try {
                const memoryResults = await searchFactsByQuery(userMessage, 3, 0.5);
                if (memoryResults.length > 0) {
                    findings.push({
                        type: 'missed_knowledge',
                        severity: 'high',
                        description: `Ответ содержал неуверенность, но в памяти есть ${memoryResults.length} релевантных факт(ов)`,
                        suggestion: `Факты: ID ${memoryResults.map((f: { id: number }) => f.id).join(', ')}`,
                    });
                    improvements.push('Улучшить поиск знаний перед генерацией ответа');
                }
            } catch {
                // Embedding сервис может быть недоступен
            }
        }

        // 3. Проверяем затратность — слишком много токенов на простой вопрос?
        if (tokensUsed > 5000 && userMessage.length < 100) {
            findings.push({
                type: 'pattern',
                severity: 'low',
                description: `Высокий расход токенов (${tokensUsed}) на короткий запрос (${userMessage.length} символов)`,
                suggestion: 'Возможно, лишние tool calls или слишком широкий контекст',
            });
        }

        // 4. Проверяем медленные tool calls
        const slowCalls = toolCalls.filter(tc => tc.durationMs > 10000);
        if (slowCalls.length > 0) {
            findings.push({
                type: 'pattern',
                severity: 'low',
                description: `${slowCalls.length} tool call(s) заняли >10с: ${slowCalls.map(tc => `${tc.toolName} (${Math.round(tc.durationMs / 1000)}с)`).join(', ')}`,
            });
        }

        // Сохраняем findings для следующего диалога
        if (findings.length > 0) {
            recentFindings = findings.slice(0, 5);  // Храним максимум 5
            lastReflectionTime = new Date();
            console.log(`🔬 [SelfReflect] ${findings.length} findings: ${findings.map(f => f.type).join(', ')}`);
        }

    } catch (error) {
        console.error('🔬 [SelfReflect] Ошибка анализа:', error);
    }

    return {
        analyzed: true,
        findings,
        improvements,
        timestamp: new Date(),
    };
}

/**
 * Мета-анализ — выполняется раз в неделю (вызывается из cognitiveLoop или вручную)
 * Анализирует статистику за последние 7 дней
 */
export async function weeklyMetaAnalysis(): Promise<{
    topDomains: string[];
    averageTokens: number;
    totalConversations: number;
    failureRate: number;
    recommendations: string[];
}> {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Подсчитываем количество сообщений за неделю
    const weeklyMessages = await db.select({ cnt: count() })
        .from(messages)
        .where(and(
            gt(messages.timestamp, weekAgo),
            eq(messages.sender, 'user')
        ));

    const totalConversations = weeklyMessages[0]?.cnt || 0;

    // Подсчитываем факты за неделю
    const weeklyFacts = await db.select({ cnt: count() })
        .from(facts)
        .where(gt(facts.createdAt, weekAgo));

    const recommendations: string[] = [];

    if (totalConversations < 5) {
        recommendations.push('Мало диалогов за неделю — пользователь может не знать о возможностях ассистента');
    }

    const factsCount = weeklyFacts[0]?.cnt || 0;
    if (factsCount > 50) {
        recommendations.push(`Много фактов (${factsCount}) за неделю — стоит запустить профильный синтез`);
    }

    return {
        topDomains: [],  // TODO: подсчитать из intent classification
        averageTokens: 0,  // TODO: из workflow logs
        totalConversations,
        failureRate: 0,
        recommendations,
    };
}
