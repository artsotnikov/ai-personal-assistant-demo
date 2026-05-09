/**
 * 🗜️ Session Compactor — Сжатие длинных диалогов (Этап 3 OpenClaw)
 *
 * Проблема: длинные диалоги вытесняют важный контекст из окна модели.
 * Решение: когда история превышает порог, старые сообщения сжимаются LLM
 *          в краткое резюме. Резюме вставляется первым блоком в контекст.
 *
 * Принципы:
 * - Оригинальные сообщения НЕ удаляются — помечаются excludeFromContext = true
 * - Резюме хранится в session_compactions (персистентно)
 * - Compaction выполняется асинхронно, не блокирует ответ пользователю
 * - Повторный compaction — ROLLING: новое резюме включает предыдущее
 * - Cooldown 30 мин между компакциями одной сессии
 *
 * Scope: компактируется ТОЛЬКО последовательная история (recentMessages).
 *   Данные из hybrid search (факты, цели, документы, KG) НЕ затрагиваются —
 *   они формируются отдельно в formatContextForPrompt().
 */

import { db } from "./db";
import { messages, sessionCompactions, type Message, type SessionCompaction } from "@shared/schema";
import { eq, desc, and, inArray } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";

// ── Пороги срабатывания ──
const COMPACT_MESSAGE_THRESHOLD = 30;  // >30 сообщений
const COMPACT_CHARS_THRESHOLD = 15_000; // >15K символов
const COMPACT_KEEP_RECENT = 10;         // Оставить последние N сообщений без сжатия

// ── Cooldown между компакциями одной сессии (30 мин) ──
const COMPACTION_COOLDOWN_MS = 30 * 60 * 1000;

// ── Оценка токенов: кириллица ≈ 2 символа на токен (вместо 4 для латиницы) ──
const CHARS_PER_TOKEN = 2;

/**
 * Результат компакции
 */
export interface CompactionResult {
  summary: string;
  compactedCount: number;
  savedTokens: number;
}

/**
 * Проверяет, нужна ли компакция для набора сообщений.
 * true — если >30 сообщений ИЛИ суммарный размер >15K символов.
 */
export function shouldCompact(msgs: Message[]): boolean {
  if (msgs.length > COMPACT_MESSAGE_THRESHOLD) {
    return true;
  }
  // Дополнительная проверка по объёму символов
  const totalChars = msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  return totalChars > COMPACT_CHARS_THRESHOLD;
}

/**
 * Проверяет, была ли сессия недавно компактирована (cooldown).
 */
async function wasRecentlyCompacted(sessionId: string): Promise<boolean> {
  const recent = await db.select()
    .from(sessionCompactions)
    .where(eq(sessionCompactions.sessionId, sessionId))
    .orderBy(desc(sessionCompactions.createdAt))
    .limit(1);

  if (recent.length === 0) return false;

  const lastCompaction = recent[0];
  const elapsedMs = Date.now() - new Date(lastCompaction.createdAt).getTime();
  return elapsedMs < COMPACTION_COOLDOWN_MS;
}

/**
 * Вызывает LLM для сжатия истории сообщений в краткое резюме.
 * Использует модель conversation_summary (обычно fast: Gemini Flash / DeepSeek).
 *
 * @param messagesToCompact - сообщения для сжатия
 * @param previousSummary - предыдущее резюме (для rolling compaction).
 *   Если передано, новое резюме ВКЛЮЧАЕТ информацию из предыдущего,
 *   чтобы контекст не терялся при повторных компакциях.
 */
export async function compactSession(
  messagesToCompact: Message[],
  previousSummary?: string | null
): Promise<CompactionResult> {
  const historyText = messagesToCompact
    .filter(m => m.sender === 'user' || m.sender === 'ai')
    .map(m => {
      const role = m.sender === 'user' ? 'Пользователь' : 'Ассистент';
      return `${role}: ${m.content}`;
    })
    .join('\n\n');

  const originalTokens = Math.ceil(historyText.length / CHARS_PER_TOKEN);

  // Rolling compaction: если есть предыдущее резюме — включаем его
  const previousBlock = previousSummary
    ? `\nТАКЖЕ УЧТИ предыдущее резюме (из ещё более раннего разговора) — интегрируй ключевую информацию:\n---\n${previousSummary}\n---\n`
    : '';

  const prompt = `Сожми следующую историю диалога в краткое резюме (до 500 слов).

Сохрани:
- Ключевые решения и выводы
- Важные факты о пользователе и его задачах
- Незавершённые задачи и открытые вопросы
- Эмоциональный контекст (если значимый)

Убери:
- Приветствия и светскую беседу
- Промежуточные рассуждения без выводов
- Tool output и технические детали
- Повторы одной и той же информации
${previousBlock}
История диалога:
---
${historyText}
---

Напиши ТОЛЬКО резюме, без вводных слов.`;

  const aiConfig = await getAIClientForTask('conversation_summary');
  const result = await callWithFallback(aiConfig, [
    { role: 'user', content: prompt }
  ]);

  const summary = result.content?.trim() || '';
  const compactedTokens = Math.ceil(summary.length / CHARS_PER_TOKEN);

  return {
    summary,
    compactedCount: messagesToCompact.length,
    savedTokens: Math.max(0, originalTokens - compactedTokens),
  };
}

/**
 * Применяет компакцию к сессии (атомарная операция):
 * 1. Загружает предыдущую компакцию (для rolling summary)
 * 2. Вызывает compactSession() для генерации резюме
 * 3. Помечает старые сообщения excludeFromContext = true (оставляет COMPACT_KEEP_RECENT свежих)
 * 4. Сохраняет запись в session_compactions
 *
 * @param allMessages - все сообщения сессии (уже отфильтрованные по excludeFromContext = false)
 * @param sessionId - ID сессии (для таблицы compactions)
 */
export async function applyCompaction(
  allMessages: Message[],
  sessionId: string
): Promise<CompactionResult> {
  // Cooldown: не компактируем снова если недавно уже делали
  const recentlyCompacted = await wasRecentlyCompacted(sessionId);
  if (recentlyCompacted) {
    console.log(`🗜️ [SessionCompaction] Сессия ${sessionId} была недавно компактирована, пропускаем`);
    return { summary: '', compactedCount: 0, savedTokens: 0 };
  }

  // Разделяем: что сжимаем и что оставляем нетронутым
  const messagesToCompact = allMessages.slice(0, -COMPACT_KEEP_RECENT);
  if (messagesToCompact.length < 5) {
    // Нечего сжимать — слишком мало старых сообщений
    return { summary: '', compactedCount: 0, savedTokens: 0 };
  }

  // Rolling compaction: загружаем предыдущее резюме, чтобы не потерять контекст
  const previousCompaction = await getLastCompaction(sessionId);
  const previousSummary = previousCompaction?.summary || null;

  if (previousSummary) {
    console.log(`🗜️ [SessionCompaction] Rolling: включаем предыдущее резюме (${previousSummary.length} символов)`);
  }

  // Генерируем резюме через LLM
  const result = await compactSession(messagesToCompact, previousSummary);

  if (!result.summary) {
    console.error('🗜️ [SessionCompaction] Пустое резюме, компакция отменена');
    return { summary: '', compactedCount: 0, savedTokens: 0 };
  }

  // Помечаем старые сообщения как excludeFromContext = true
  const messageIds = messagesToCompact
    .map(m => m.id)
    .filter((id): id is number => typeof id === 'number' && id > 0);

  if (messageIds.length > 0) {
    await db.update(messages)
      .set({ excludeFromContext: true })
      .where(inArray(messages.id, messageIds));
  }

  // Сохраняем запись о компакции в БД
  const estimatedOriginalTokens = Math.ceil(
    messagesToCompact.reduce((s, m) => s + (m.content?.length || 0), 0) / CHARS_PER_TOKEN
  );
  const estimatedCompactedTokens = Math.ceil(result.summary.length / CHARS_PER_TOKEN);

  await db.insert(sessionCompactions).values({
    sessionId,
    summary: result.summary,
    compactedMessageIds: messageIds,
    originalTokens: estimatedOriginalTokens,
    compactedTokens: estimatedCompactedTokens,
  });

  console.log(`🗜️ [SessionCompaction] ✅ Сжато ${messageIds.length} сообщений | ~${estimatedOriginalTokens} → ~${estimatedCompactedTokens} токенов | Экономия: ~${result.savedTokens} токенов`);

  return result;
}

/**
 * Возвращает последнюю компакцию для сессии (для вставки в контекст).
 * Если для сессии нет компакций — возвращает null.
 */
export async function getLastCompaction(sessionId: string): Promise<SessionCompaction | null> {
  const rows = await db.select()
    .from(sessionCompactions)
    .where(eq(sessionCompactions.sessionId, sessionId))
    .orderBy(desc(sessionCompactions.createdAt))
    .limit(1);

  return rows[0] ?? null;
}
