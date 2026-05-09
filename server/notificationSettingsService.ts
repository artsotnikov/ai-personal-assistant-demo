/**
 * Notification Settings Service
 * Управление настройками уведомлений с кэшированием
 */

import { db } from "./db";
import { notificationSettings, type NotificationSettings } from "@shared/schema";
import { eq } from "drizzle-orm";

// ============================================================================
// Кэш
// ============================================================================

let cachedSettings: NotificationSettings | null = null;
let cacheExpiry: number = 0;
const CACHE_TTL = 60 * 1000; // 1 минута

// ============================================================================
// Значения по умолчанию
// ============================================================================

export const DEFAULT_SETTINGS: Omit<NotificationSettings, 'id' | 'updatedAt'> = {
    // Расписание
    morningBriefingHour: 9,
    morningBriefingMinute: 0,
    eveningRecapHour: 21,
    eveningRecapMinute: 0,
    checkIntervalMinutes: 15,
    maxDailyReminders: 5,
    cooldownHours: 4,

    // Типы
    enableMorningBriefing: true,
    enableEveningRecap: false,
    enableDeadlineAlerts: true,
    enableGoalReminders: true,
    enableTopicReminders: true,
    goalStalledDays: 14,
    topicAbandonedDays: 21,

    // Telegram
    telegramEnabled: false,
    telegramBotToken: null,
    telegramChatId: null,

    // Тихие часы
    quietHoursEnabled: false,
    quietHoursStart: 22,
    quietHoursEnd: 8,
    quietHoursWeekendOnly: false,

    // Браузер
    browserPushEnabled: true,
    browserSoundEnabled: true,
    browserSoundType: "soft",
};

// ============================================================================
// Основные функции
// ============================================================================

/**
 * Получить настройки (с кэшированием)
 */
export async function getSettings(): Promise<NotificationSettings> {
    const now = Date.now();

    if (cachedSettings && now < cacheExpiry) {
        return cachedSettings;
    }

    const rows = await db.select().from(notificationSettings).limit(1);

    if (rows.length > 0) {
        cachedSettings = rows[0];
    } else {
        // Создаём запись с дефолтами
        const [created] = await db.insert(notificationSettings)
            .values(DEFAULT_SETTINGS)
            .returning();
        cachedSettings = created;
    }

    cacheExpiry = now + CACHE_TTL;
    return cachedSettings!;
}

/**
 * Сохранить настройки
 */
export async function saveSettings(updates: Partial<NotificationSettings>): Promise<NotificationSettings> {
    const existing = await db.select().from(notificationSettings).limit(1);

    let result: NotificationSettings;

    if (existing.length > 0) {
        const [updated] = await db.update(notificationSettings)
            .set({ ...updates, updatedAt: new Date() })
            .where(eq(notificationSettings.id, existing[0].id))
            .returning();
        result = updated;
    } else {
        const [created] = await db.insert(notificationSettings)
            .values({ ...DEFAULT_SETTINGS, ...updates })
            .returning();
        result = created;
    }

    invalidateCache();
    return result;
}

/**
 * Сбросить кэш
 */
export function invalidateCache(): void {
    cachedSettings = null;
    cacheExpiry = 0;
}

// ============================================================================
// Telegram функции
// ============================================================================

/**
 * Проверить, включён ли Telegram
 */
export async function isTelegramEnabled(): Promise<boolean> {
    const settings = await getSettings();
    return !!(settings.telegramEnabled && settings.telegramBotToken && settings.telegramChatId);
}

/**
 * Отправить сообщение через Telegram
 */
export async function sendTelegramMessage(
    text: string,
    parseMode: 'HTML' | 'Markdown' = 'HTML',
    disableNotification = false
): Promise<boolean> {
    const settings = await getSettings();

    if (!settings.telegramEnabled || !settings.telegramBotToken || !settings.telegramChatId) {
        return false;
    }

    try {
        const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: settings.telegramChatId,
                text,
                parse_mode: parseMode,
                disable_notification: disableNotification,
            }),
        });

        const result = await response.json();
        return result.ok;
    } catch (error) {
        console.error('📱 Telegram error:', error);
        return false;
    }
}

/**
 * Отправить сообщение через Telegram с inline кнопками
 */
export async function sendTelegramMessageWithButtons(
    text: string,
    buttons: { text: string; callback_data: string }[][],
    parseMode: 'HTML' | 'Markdown' = 'HTML',
    disableNotification = false
): Promise<{ ok: boolean; message_id?: number }> {
    const settings = await getSettings();

    if (!settings.telegramEnabled || !settings.telegramBotToken || !settings.telegramChatId) {
        return { ok: false };
    }

    try {
        const url = `https://api.telegram.org/bot${settings.telegramBotToken}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: settings.telegramChatId,
                text,
                parse_mode: parseMode,
                disable_notification: disableNotification,
                reply_markup: {
                    inline_keyboard: buttons,
                },
            }),
        });

        const result = await response.json();
        return { ok: result.ok, message_id: result.result?.message_id };
    } catch (error) {
        console.error('📱 Telegram error:', error);
        return { ok: false };
    }
}

/**
 * Валидация Telegram настроек
 */
export async function validateTelegram(botToken: string, chatId: string): Promise<{
    valid: boolean;
    botInfo?: any;
    error?: string;
}> {
    try {
        // Проверяем токен
        const botUrl = `https://api.telegram.org/bot${botToken}/getMe`;
        const botRes = await fetch(botUrl);
        const botData = await botRes.json();

        if (!botData.ok) {
            return { valid: false, error: 'Неверный токен бота' };
        }

        // Пробуем отправить сообщение
        const sendUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const sendRes = await fetch(sendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: '✅ Telegram подключён к AI Assistant!',
            }),
        });

        const sendData = await sendRes.json();
        if (!sendData.ok) {
            return { valid: false, botInfo: botData.result, error: 'Неверный Chat ID' };
        }

        return { valid: true, botInfo: botData.result };
    } catch (error) {
        return { valid: false, error: 'Ошибка подключения' };
    }
}

// ============================================================================
// Тихие часы
// ============================================================================

/**
 * Проверить, сейчас тихие часы
 */
export async function isQuietHours(): Promise<boolean> {
    const settings = await getSettings();

    if (!settings.quietHoursEnabled) {
        return false;
    }

    // Московское время
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    const moscow = new Date(utc + (3 * 60 * 60 * 1000));
    const hour = moscow.getHours();
    const day = moscow.getDay(); // 0 = Sunday, 6 = Saturday

    // Только выходные?
    if (settings.quietHoursWeekendOnly && day !== 0 && day !== 6) {
        return false;
    }

    // Проверяем диапазон
    const start = settings.quietHoursStart;
    const end = settings.quietHoursEnd;

    if (start > end) {
        // Через полночь, например: 23:00 - 09:00
        // Тихо если час >= 23 ИЛИ час < 9
        return hour >= start || hour < end;
    } else {
        // В один день, например: 08:00 - 22:00
        // Тихо если час >= 8 И час < 22
        return hour >= start && hour < end;
    }
}

// ============================================================================
// Scheduler config
// ============================================================================

/**
 * Получить конфиг для proactiveScheduler
 */
export async function getSchedulerConfig() {
    const settings = await getSettings();

    return {
        checkIntervalMs: settings.checkIntervalMinutes * 60 * 1000,
        cooldownHours: settings.cooldownHours,
        maxDailyReminders: settings.maxDailyReminders,
        morningBriefingHour: settings.morningBriefingHour,
        eveningBriefingHour: settings.eveningRecapHour,
        goalStalledDays: settings.goalStalledDays,
        topicAbandonedDays: settings.topicAbandonedDays,
        enableMorningBriefing: settings.enableMorningBriefing,
        enableEveningRecap: settings.enableEveningRecap,
        enableDeadlineAlerts: settings.enableDeadlineAlerts,
    };
}
