/**
 * Tool: ticktick_create_project — Создать новый проект (список) в TickTick
 */

import type { ToolDefinition, ToolResult } from '../types';
import { tickTickService } from '../../services/tickTickService';

interface CreateProjectInput {
    name: string;
    color?: string;
}

export const ticktickCreateProjectTool: ToolDefinition<CreateProjectInput> = {
    name: 'ticktick_create_project',
    description: `Создать новый проект (список) в TickTick.
Используй, когда пользователь просит создать новый список задач, папку или проект.
Например: «создай список Покупки», «сделай проект Ремонт».`,
    category: 'planning',
    toolPack: 'ticktick' as any,
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Название нового проекта/списка',
            },
            color: {
                type: 'string',
                description: 'Цвет проекта (hex, например #FF5733), опционально',
            },
        },
        required: ['name'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        if (!tickTickService.isAuthenticated()) {
            return {
                success: false,
                error: 'TickTick не подключён',
                displayText: '❌ TickTick не подключён.',
            };
        }

        try {
            const project = await tickTickService.createProject({
                name: input.name,
                color: input.color,
            });

            return {
                success: true,
                data: project,
                displayText: `✅ Проект «${project.name}» создан (id: \`${project.id}\`)`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `❌ Ошибка создания проекта: ${error?.message || error}`,
            };
        }
    },
};
