/**
 * Tool: update_skill — Редактирование существующего навыка
 * 
 * Позволяет AI обновлять любые поля навыка:
 * name, description, content, category, triggerKeywords, icon.
 * Автоматически пересчитывает embedding при изменении семантических полей.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { updateSkill, getSkillById } from '../../skillManager';

interface UpdateSkillInput {
    id: number;
    name?: string;
    description?: string;
    content?: string;
    category?: string;
    triggerKeywords?: string;
    icon?: string;
}

export const updateSkillTool: ToolDefinition<UpdateSkillInput> = {
    name: 'update_skill',
    description: `Обновить существующий навык AI-ассистента.

Используй для:
- Изменения содержимого (content) навыка
- Обновления ключевых слов для активации
- Изменения названия, описания, категории или иконки
- Исправления и доработки навыков

ВАЖНО: Перед обновлением вызови get_skills(), чтобы найти нужный навык и получить его ID.
Можно обновлять отдельные поля — не обязательно передавать все.`,
    category: 'system',
    toolPack: 'skill_management',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            id: {
                type: 'string',
                description: 'ID навыка для обновления (получи из get_skills)',
            },
            name: {
                type: 'string',
                description: 'Новое название навыка (до 64 символов)',
            },
            description: {
                type: 'string',
                description: 'Новое описание (до 200 символов)',
            },
            content: {
                type: 'string',
                description: 'Новое содержимое навыка в Markdown',
            },
            category: {
                type: 'string',
                description: 'Новая категория: custom, business, analytics, coaching, finance, system',
            },
            triggerKeywords: {
                type: 'string',
                description: 'Новые ключевые слова для активации (через запятую)',
            },
            icon: {
                type: 'string',
                description: 'Новая emoji-иконка (1 символ)',
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
                    displayText: `❌ Навык с ID ${id} не найден. Используй get_skills() чтобы найти нужный навык.`,
                };
            }

            // Собираем данные для обновления
            const updateData: Record<string, any> = {};
            if (input.name) updateData.name = input.name;
            if (input.description) updateData.description = input.description;
            if (input.content) updateData.content = input.content;
            if (input.category) updateData.category = input.category;
            if (input.icon) updateData.icon = input.icon;

            // Парсим ключевые слова
            if (input.triggerKeywords) {
                if (Array.isArray(input.triggerKeywords)) {
                    updateData.triggerKeywords = input.triggerKeywords;
                } else if (typeof input.triggerKeywords === 'string') {
                    updateData.triggerKeywords = (input.triggerKeywords as string)
                        .split(',')
                        .map(k => k.trim())
                        .filter(Boolean);
                }
            }

            if (Object.keys(updateData).length === 0) {
                return {
                    success: false,
                    error: 'Не указаны поля для обновления',
                    displayText: '❌ Укажи хотя бы одно поле для обновления (name, description, content, category, triggerKeywords, icon).',
                };
            }

            const updated = await updateSkill(id, updateData);
            if (!updated) {
                return {
                    success: false,
                    error: 'Не удалось обновить навык',
                    displayText: '❌ Не удалось обновить навык.',
                };
            }

            const changedFields = Object.keys(updateData).join(', ');
            return {
                success: true,
                data: { id: updated.id, name: updated.name, updatedFields: changedFields },
                displayText: `✅ Навык "${updated.name}" (ID: ${updated.id}) обновлён.\n` +
                    `  Изменённые поля: ${changedFields}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка обновления навыка: ${error?.message || error}`,
            };
        }
    },
};
