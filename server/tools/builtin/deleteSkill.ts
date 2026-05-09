/**
 * Tool: delete_skill — Удаление пользовательского навыка
 * 
 * Безопасно удаляет навык с проверками:
 * - Навык должен существовать
 * - Встроенные навыки нельзя удалить
 */

import type { ToolDefinition, ToolResult } from '../types';
import { deleteSkill, getSkillById } from '../../skillManager';

interface DeleteSkillInput {
    id: number;
}

export const deleteSkillTool: ToolDefinition<DeleteSkillInput> = {
    name: 'delete_skill',
    description: `Удалить пользовательский навык AI-ассистента.

ОГРАНИЧЕНИЯ:
- Нельзя удалить встроенные навыки (isBuiltin = true)
- Действие необратимо

ВАЖНО: 
- Перед удалением вызови get_skills() чтобы найти ID нужного навыка
- Получи подтверждение пользователя перед удалением
- НЕ удаляй навык молча`,
    category: 'system',
    toolPack: 'skill_management',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            id: {
                type: 'string',
                description: 'ID навыка для удаления (получи из get_skills)',
            },
        },
        required: ['id'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const id = typeof input.id === 'string' ? parseInt(input.id as string) : input.id;
            if (isNaN(id)) {
                return {
                    success: false,
                    error: 'Некорректный ID навыка',
                    displayText: '❌ Некорректный ID навыка',
                };
            }

            // Проверяем что навык существует
            const existing = await getSkillById(id);
            if (!existing) {
                return {
                    success: false,
                    error: `Навык с ID ${id} не найден`,
                    displayText: `❌ Навык с ID ${id} не найден. Используй get_skills() чтобы просмотреть список навыков.`,
                };
            }

            if (existing.isBuiltin) {
                return {
                    success: false,
                    error: `Навык "${existing.name}" является встроенным и не может быть удалён`,
                    displayText: `🔒 Навык "${existing.name}" является встроенным (isBuiltin) и не может быть удалён. ` +
                        `Встроенные навыки можно только отключить через настройки.`,
                };
            }

            const deleted = await deleteSkill(id);
            if (!deleted) {
                return {
                    success: false,
                    error: 'Не удалось удалить навык',
                    displayText: '❌ Не удалось удалить навык.',
                };
            }

            return {
                success: true,
                data: { id, name: existing.name, deleted: true },
                displayText: `🗑️ Навык "${existing.name}" (ID: ${id}) удалён.`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка удаления навыка: ${error?.message || error}`,
            };
        }
    },
};
