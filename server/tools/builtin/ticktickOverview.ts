/**
 * Tool: ticktick_overview — Обзор (сводка) всех задач TickTick
 * 
 * Лёгкий инструмент: возвращает агрегированную информацию
 * (просроченные, на сегодня, на неделю, по проектам, теги)
 * без полного дампа всех задач.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

export const ticktickOverviewTool: ToolDefinition = {
    name: 'ticktick_overview',
    description: `Получить краткий обзор (сводку) ВСЕХ задач TickTick — без загрузки полного списка.

📊 Возвращает:
- Количество задач по проектам (включая Inbox)
- 🔴 Просроченные задачи (с деталями)
- 📅 Задачи на сегодня (с деталями)
- 📆 Задачи на эту неделю
- ⏰ Ближайшие 7 задач по дедлайну
- 🔴 Задачи с высоким приоритетом
- 🏷️ Все используемые теги с количеством
- 📌 Количество задач без даты

⚡ ИСПОЛЬЗУЙ ЭТОТ ИНСТРУМЕНТ ПЕРВЫМ, когда пользователь спрашивает:
- «Что у меня на сегодня?», «Какие дела?», «Что мне делать?»
- «Обзор задач», «Сводка», «Дай общую картину»
- «Что просрочено?», «Есть ли что-то срочное?»
- «Расскажи про мои задачи»

После обзора можешь запросить детали конкретного проекта через ticktick_get_tasks.`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {},
    },

    handler: async (_input, _ctx): Promise<ToolResult> => {
        if (!tickTickService.isAuthenticated()) {
            return {
                success: false,
                error: 'TickTick не подключён',
                displayText: '❌ TickTick не подключён. Попросите пользователя авторизоваться через настройки.',
            };
        }

        try {
            const overview = await tickTickService.getOverview();

            return {
                success: true,
                data: overview,
                displayText: tickTickService.formatOverview(overview),
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка получения обзора TickTick: ${error?.message || error}`,
            };
        }
    },
};
