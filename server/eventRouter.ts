/**
 * Event Router — маршрутизатор внешних событий
 * 
 * Обрабатывает входящие внешние события (webhooks, уведомления):
 * - Avito: сообщения, заказы
 * - Google Sheets: обновления таблиц
 * - Платежи, метрики, кастомные события
 * 
 * Каждое событие обрабатывается через AI ReAct Loop,
 * который решает какие действия предпринять и уведомлять ли пользователя.
 */

import { WebSocket } from "ws";
import { executeReActLoop, resolveToolsForRequest } from "./tools";
import { getAIClientForTask } from "./aiConfigService";

// ============================================================================
// Типы событий
// ============================================================================

export type ExternalEventType =
    | 'avito_message'      // Новое сообщение на Avito
    | 'avito_order'        // Новый заказ
    | 'sheet_update'       // Изменение в Google Sheets
    | 'payment_received'   // Получена оплата
    | 'metric_alert'       // Метрика вышла за пределы
    | 'custom';            // Кастомное событие

export interface ExternalEvent {
    type: ExternalEventType;
    source: string;
    data: Record<string, any>;
    timestamp: Date;
}

// ============================================================================
// WebSocket ссылка (устанавливается из routes.ts)
// ============================================================================

let wsClients: Set<WebSocket> = new Set();

export function setEventRouterWSClients(clients: Set<WebSocket>): void {
    wsClients = clients;
}

// ============================================================================
// AI Event Handler промпт
// ============================================================================

const EVENT_HANDLER_PROMPT = `Ты — AI-обработчик внешних событий.
Тебе приходят события от внешних систем (Avito, Google Sheets, платежи и др.).

Твоя задача:
1. Проанализировать событие
2. Решить, нужно ли предпринять действия (обновить цель, запомнить факт, создать напоминание)
3. Если событие важное — сформировать уведомление для пользователя

Используй tools для выполнения действий:
- remember_fact — запомнить важную информацию из события
- update_goal — обновить прогресс цели если событие связано
- create_reminder — создать напоминание если нужно действие
- search_facts — проверить контекст

Действуй автономно. Не запрашивай разрешение.
Ответь кратко — это уведомление, а не диалог.
Если событие не требует действий или уведомления — ответь пустой строкой.
`;

// ============================================================================
// Обработка событий
// ============================================================================

/**
 * Отправить сообщение через WebSocket всем подключённым клиентам
 */
function sendToWebSocket(payload: {
    type: string;
    title: string;
    content: string;
    priority: 'high' | 'medium' | 'low';
}): boolean {
    if (wsClients.size === 0) {
        return false;
    }

    const data = JSON.stringify({
        type: 'external_event',
        data: payload,
    });

    let sent = false;
    for (const client of Array.from(wsClients)) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
            sent = true;
        }
    }

    return sent;
}

/**
 * Обработка внешнего события через AI ReAct Loop.
 * 
 * AI получает событие, может вызвать tools (remember_fact, update_goal и др.),
 * и решает — нужно ли уведомлять пользователя.
 */
export async function handleExternalEvent(event: ExternalEvent): Promise<void> {
    console.log(`📡 [EventRouter] ${event.type} от ${event.source}`);

    try {
        const tools = resolveToolsForRequest({
            agentSlug: 'event_handler',
            exclude: ['delegate_task'],
        });

        const aiConfig = await getAIClientForTask('event_handling');

        const result = await executeReActLoop({
            messages: [
                { role: 'system', content: EVENT_HANDLER_PROMPT },
                {
                    role: 'user',
                    content: `Событие: ${event.type}\nИсточник: ${event.source}\nВремя: ${event.timestamp.toISOString()}\nДанные:\n${JSON.stringify(event.data, null, 2)}`,
                },
            ],
            tools,
            aiConfig,
            context: { sessionId: 'event-handler', messageId: 0, isSubagent: true },
            agentSlug: 'event_handler',
            maxIterations: 6,
        });

        console.log(`📡 [EventRouter] ✅ ${event.type}: ${result.iterations} итераций, ${result.toolCalls.length} tool calls, ${result.tokensUsed} tokens`);

        // Если AI решил уведомить пользователя (ответ > 20 символов)
        if (result.content && result.content.trim().length > 20) {
            const delivered = sendToWebSocket({
                type: 'external_event',
                title: `📡 ${event.source}`,
                content: result.content,
                priority: 'medium',
            });

            console.log(`📡 [EventRouter] Уведомление: ${delivered ? 'доставлено через WS' : 'WS не подключён'}`);
        }
    } catch (error) {
        console.error(`❌ [EventRouter] Ошибка обработки ${event.type}:`, error);
    }
}
