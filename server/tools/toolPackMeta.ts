/**
 * Tool Pack Metadata — описания, иконки и флаги для каждого пака
 *
 * Используется:
 * - в API GET /api/tool-packs (для UI)
 * - в toolResolver для автоматического включения обязательных паков
 */

import type { ToolPack } from './types';
import { toolRegistry } from './toolRegistry';

export interface ToolPackMeta {
    /** Идентификатор пака */
    id: ToolPack;
    /** Человекочитаемое название */
    name: string;
    /** Краткое описание: что умеет этот пак */
    description: string;
    /** Эмодзи-иконка */
    icon: string;
    /** Если true — пак добавляется автоматически для всех экспертиз,
     *  нельзя убрать через UI */
    alwaysInclude: boolean;
}

export const TOOL_PACK_META: Record<ToolPack, ToolPackMeta> = {
    core: {
        id: 'core',
        name: 'Заметки и память',
        description: 'Создание и поиск заметок, сохранение фактов, обновление профиля, поиск по истории переписки',
        icon: '📝',
        alwaysInclude: true,
    },
    goals: {
        id: 'goals',
        name: 'Цели и задачи',
        description: 'Постановка целей, отслеживание прогресса, ключевые результаты, вехи и журнал активности',
        icon: '🎯',
        alwaysInclude: false,
    },
    business_metrics: {
        id: 'business_metrics',
        name: 'Бизнес-метрики',
        description: 'Получение бизнес-метрик и аналитики, создание пользовательских навыков',
        icon: '📊',
        alwaysInclude: false,
    },
    web_access: {
        id: 'web_access',
        name: 'Поиск в интернете',
        description: 'Поиск через Google/Perplexity, чтение веб-страниц и статей',
        icon: '🌐',
        alwaysInclude: false,
    },
    web_browser: {
        id: 'web_browser',
        name: 'Управление браузером',
        description: 'Открытие сайтов, навигация, клики и взаимодействие с веб-интерфейсами (только для browser-агента)',
        icon: '🖥️',
        alwaysInclude: false,
    },
    scheduling: {
        id: 'scheduling',
        name: 'Расписание',
        description: 'Создание напоминаний и планирование задач по времени',
        icon: '📅',
        alwaysInclude: false,
    },
    delegation: {
        id: 'delegation',
        name: 'Делегирование',
        description: 'Делегирование сложных задач суб-агентам для параллельного выполнения',
        icon: '🤝',
        alwaysInclude: false,
    },
    calendar: {
        id: 'calendar',
        name: 'Google Календарь',
        description: 'Просмотр, создание, редактирование и удаление событий в Google Календаре',
        icon: '📅',
        alwaysInclude: false,
    },
    ticktick: {
        id: 'ticktick',
        name: 'Планировщик TickTick',
        description: 'Создание, просмотр, обновление и завершение задач в TickTick',
        icon: '✅',
        alwaysInclude: false,
    },
    skill_management: {
        id: 'skill_management',
        name: 'Управление навыками',
        description: 'Создание, редактирование, удаление и поиск навыков AI-ассистента',
        icon: '🧩',
        alwaysInclude: false,
    },
};

/** Все доступные паки (упорядочены для UI) */
export const ALL_TOOL_PACKS: ToolPack[] = [
    'core',
    'goals',
    'business_metrics',
    'web_access',
    'scheduling',
    'delegation',
    'web_browser',
    'calendar',
    'ticktick',
    'skill_management',
];

/** Паки, которые автоматически включаются для всех экспертиз */
export function getAlwaysIncludePacks(): ToolPack[] {
    return ALL_TOOL_PACKS.filter(pack => TOOL_PACK_META[pack].alwaysInclude);
}

/**
 * Получить полный список паков с описаниями и инструментами
 * для отдачи клиенту через API
 */
export function getToolPacksInfo(): Array<ToolPackMeta & {
    tools: Array<{ name: string; description: string }>;
    toolCount: number;
}> {
    const allTools = toolRegistry.getAll();

    return ALL_TOOL_PACKS.map(packId => {
        const meta = TOOL_PACK_META[packId];
        const tools = allTools
            .filter(t => t.toolPack === packId)
            .map(t => ({ name: t.name, description: t.description.split('\n')[0].substring(0, 80) }));

        return {
            ...meta,
            tools,
            toolCount: tools.length,
        };
    });
}
