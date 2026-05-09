/**
 * Web Push Service — серверная отправка push-уведомлений
 * 
 * Использует VAPID для аутентификации и web-push для доставки.
 * Автоматически удаляет просроченные подписки (410 Gone).
 */

import webpush from "web-push";
import { db } from "./db";
import { pushSubscriptions } from "@shared/schema";
import { eq } from "drizzle-orm";

// ============================================================================
// Инициализация VAPID
// ============================================================================

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let isConfigured = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    isConfigured = true;
    console.log("🔔 Web Push: VAPID настроен");
} else {
    console.warn("🔔 Web Push: VAPID ключи не найдены в .env, push отключён");
}

// ============================================================================
// Управление подписками
// ============================================================================

/**
 * Сохранить или обновить подписку
 */
export async function saveSubscription(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    userAgent?: string;
}): Promise<void> {
    // Upsert: если endpoint уже есть — обновляем ключи
    const existing = await db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, subscription.endpoint))
        .limit(1);

    if (existing.length > 0) {
        await db
            .update(pushSubscriptions)
            .set({
                p256dh: subscription.keys.p256dh,
                auth: subscription.keys.auth,
                userAgent: subscription.userAgent || null,
            })
            .where(eq(pushSubscriptions.endpoint, subscription.endpoint));
    } else {
        await db.insert(pushSubscriptions).values({
            endpoint: subscription.endpoint,
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
            userAgent: subscription.userAgent || null,
        });
    }

    console.log("🔔 Push подписка сохранена");
}

/**
 * Удалить подписку по endpoint
 */
export async function removeSubscription(endpoint: string): Promise<void> {
    await db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint));
    console.log("🔔 Push подписка удалена");
}

/**
 * Получить публичный VAPID ключ
 */
export function getVapidPublicKey(): string | null {
    return VAPID_PUBLIC_KEY || null;
}

// ============================================================================
// Отправка Push
// ============================================================================

/**
 * Отправить push-уведомление всем подписанным устройствам
 * Возвращает true если хотя бы одно устройство получило уведомление
 */
export async function sendPushToAll(
    title: string,
    body: string,
    data?: Record<string, any>
): Promise<boolean> {
    if (!isConfigured) {
        return false;
    }

    const subscriptions = await db.select().from(pushSubscriptions);

    if (subscriptions.length === 0) {
        return false;
    }

    const payload = JSON.stringify({
        title,
        body,
        icon: "/icon-192.png",
        badge: "/icon-96.png",
        tag: data?.tag || "proactive-notification",
        data: {
            url: "/",
            timestamp: Date.now(),
            ...data,
        },
    });

    let delivered = false;
    const expiredEndpoints: string[] = [];

    await Promise.allSettled(
        subscriptions.map(async (sub) => {
            const pushSub = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth,
                },
            };

            try {
                await webpush.sendNotification(pushSub, payload);
                delivered = true;
            } catch (error: any) {
                // 410 Gone или 404 — подписка протухла
                if (error.statusCode === 410 || error.statusCode === 404) {
                    expiredEndpoints.push(sub.endpoint);
                } else {
                    console.error(
                        `🔔 Push error (${error.statusCode}):`,
                        error.body || error.message
                    );
                }
            }
        })
    );

    // Удаляем протухшие подписки
    for (const endpoint of expiredEndpoints) {
        await db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.endpoint, endpoint));
        console.log("🔔 Удалена протухшая подписка");
    }

    if (delivered) {
        console.log(`🔔 Push доставлен (${subscriptions.length - expiredEndpoints.length} устройств)`);
    }

    return delivered;
}

/**
 * Проверить, есть ли активные push-подписки
 */
export async function hasPushSubscriptions(): Promise<boolean> {
    if (!isConfigured) return false;
    const result = await db.select().from(pushSubscriptions).limit(1);
    return result.length > 0;
}
