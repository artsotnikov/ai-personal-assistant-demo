/**
 * Reminder Service — Персональные напоминания
 *
 * Функции:
 * - Извлечение напоминаний из сообщений пользователя через AI
 * - CRUD операции с напоминаниями
 * - Проверка наступивших напоминаний
 */

import { db } from "./db";
import { reminders, type InsertReminder, type Reminder } from "@shared/schema";
import { eq, and, lte, desc } from "drizzle-orm";
import { getAIClientForTask, callWithFallback } from "./aiConfigService";

// ============================================================================
// AI-экстракция напоминаний
// ============================================================================

/**
 * Извлечь напоминания из сообщения пользователя
 */
export async function extractRemindersFromMessage(message: string): Promise<InsertReminder[]> {
    // Быстрая проверка — есть ли индикаторы напоминания
    const reminderIndicators = [
        'напомни', 'напомнить', 'напоминание',
        'remind', 'reminder',
        'не забыть', 'нужно помнить',
        'поставь будильник', 'alarm'
    ];

    const hasIndicator = reminderIndicators.some(ind =>
        message.toLowerCase().includes(ind)
    );

    if (!hasIndicator) {
        return [];
    }

    console.log(`⏰ [ReminderExtractor] Обнаружен индикатор напоминания в: "${message.substring(0, 80)}..."`);

    let aiConfig;
    try {
        aiConfig = await getAIClientForTask('reminder_extraction');
    } catch (error) {
        console.error(`⏰ [ReminderExtractor] ❌ Ошибка AI клиента:`, error);
        return [];
    }

    const now = new Date();
    // Форматируем текущее время в московском часовом поясе
    const moscowTimeStr = now.toLocaleString('ru-RU', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
    // Также передаём ISO формат для точных вычислений
    const moscowISOish = now.toLocaleString('sv-SE', { timeZone: 'Europe/Moscow' }).replace(' ', 'T') + '+03:00';

    const prompt = `Проанализируй сообщение и определи, просит ли пользователь создать напоминание.

Сообщение:
"${message}"

ТЕКУЩАЯ ДАТА И ВРЕМЯ (Москва, UTC+3): ${moscowTimeStr}
ТЕКУЩЕЕ ВРЕМЯ ISO: ${moscowISOish}

Индикаторы напоминания:
- "напомни", "напомни мне", "напомнить"
- "поставь напоминание", "создай напоминание"
- "не забыть", "нужно помнить"
- "через N минут/часов", "завтра", "послезавтра"
- Конкретные даты: "15 февраля", "в понедельник"

Если найдено напоминание, извлеки:
1. title — что напомнить (краткое описание действия)
2. description — детали (опционально)
3. remindAt — когда напомнить в формате ISO 8601 с таймзоной +03:00
4. priority — приоритет (low/medium/high)

ВАЖНО при парсинге времени:
- "завтра" = следующий день
- "через N часов" = текущее время + N часов
- "в 10:00" без даты = ближайшие 10:00 (сегодня или завтра)
- "в понедельник" = ближайший понедельник

Ответ СТРОГО в JSON:
{
  "reminders": [
    {
      "title": "Позвонить клиенту",
      "description": "Обсудить новый проект",
      "remindAt": "2026-02-15T10:00:00+03:00",
      "priority": "medium"
    }
  ]
}

Если напоминаний нет: {"reminders": []}`;

    try {
        const result = await callWithFallback(aiConfig, [
            {
                role: "system",
                content: aiConfig.systemPrompt!
            },
            { role: "user", content: prompt }
        ]);

        const content = result.content?.trim() || "{}";
        console.log(`⏰ [ReminderExtractor] Ответ AI: "${content.substring(0, 200)}..."`);

        const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(cleanContent);

        const extractedReminders: InsertReminder[] = [];

        if (Array.isArray(parsed.reminders)) {
            for (const rem of parsed.reminders) {
                if (rem.title && rem.remindAt) {
                    const remindAt = new Date(rem.remindAt);
                    if (isNaN(remindAt.getTime())) {
                        console.warn(`⏰ [ReminderExtractor] ⚠️ Невалидная дата: ${rem.remindAt}`);
                        continue;
                    }

                    // DEBUG: Логируем парсинг времени
                    const now = new Date();
                    console.log(`⏰ [ReminderExtractor] DEBUG: AI вернул: "${rem.remindAt}"`);
                    console.log(`⏰ [ReminderExtractor] DEBUG: Parsed to Date: ${remindAt.toISOString()}`);
                    console.log(`⏰ [ReminderExtractor] DEBUG: Now (UTC): ${now.toISOString()}`);
                    console.log(`⏰ [ReminderExtractor] DEBUG: Diff: ${(remindAt.getTime() - now.getTime()) / 1000 / 60} minutes`);

                    extractedReminders.push({
                        title: rem.title,
                        description: rem.description || null,
                        remindAt: remindAt,
                        status: "pending",
                        priority: rem.priority || "medium",
                        sourceMessageId: null,
                    });

                    console.log(`⏰ [ReminderExtractor] ✅ Извлечено: "${rem.title}" на ${remindAt.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} (MSK)`);
                }
            }
        }

        return extractedReminders;

    } catch (error) {
        console.error(`⏰ [ReminderExtractor] ❌ Ошибка:`, error);
        return [];
    }
}

// ============================================================================
// CRUD операции
// ============================================================================

/**
 * Создать напоминание
 */
export async function createReminder(data: InsertReminder): Promise<Reminder> {
    const [reminder] = await db.insert(reminders).values(data).returning();
    console.log(`⏰ Создано напоминание: "${reminder.title}" на ${reminder.remindAt}`);
    return reminder;
}

/**
 * Получить все активные напоминания
 */
export async function getActiveReminders(): Promise<Reminder[]> {
    return db.select()
        .from(reminders)
        .where(eq(reminders.status, "pending"))
        .orderBy(reminders.remindAt);
}

/**
 * Получить наступившие напоминания (для отправки)
 */
export async function getPendingReminders(): Promise<Reminder[]> {
    const now = new Date();
    return db.select()
        .from(reminders)
        .where(
            and(
                eq(reminders.status, "pending"),
                lte(reminders.remindAt, now)
            )
        )
        .orderBy(reminders.remindAt);
}

/**
 * Пометить напоминание как отправленное
 */
export async function markReminderSent(id: number): Promise<void> {
    await db.update(reminders)
        .set({ status: "sent", sentAt: new Date() })
        .where(eq(reminders.id, id));
}

/**
 * Отложить напоминание
 */
export async function snoozeReminder(id: number, minutes: number): Promise<Reminder> {
    const newTime = new Date(Date.now() + minutes * 60 * 1000);
    const [updated] = await db.update(reminders)
        .set({ remindAt: newTime, status: "pending" })
        .where(eq(reminders.id, id))
        .returning();
    console.log(`⏰ Напоминание отложено на ${minutes} мин: "${updated.title}"`);
    return updated;
}

/**
 * Отменить напоминание
 */
export async function cancelReminder(id: number): Promise<void> {
    await db.update(reminders)
        .set({ status: "cancelled" })
        .where(eq(reminders.id, id));
}

/**
 * Получить недавние напоминания (для UI)
 */
export async function getRecentReminders(limit = 20): Promise<Reminder[]> {
    return db.select()
        .from(reminders)
        .orderBy(desc(reminders.createdAt))
        .limit(limit);
}
