/**
 * Tool: get_skills — Просмотр и поиск навыков AI
 * 
 * Позволяет AI просматривать список всех навыков или искать
 * конкретные навыки по имени/описанию/ключевым словам.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { searchSkills, getSkillById } from '../../skillManager';

interface GetSkillsInput {
    query?: string;
    id?: number;
}

export const getSkillsTool: ToolDefinition<GetSkillsInput> = {
    name: 'get_skills',
    description: `Получить список навыков AI-ассистента или найти конкретный навык.

Используй этот tool чтобы:
- Посмотреть все существующие навыки (без параметров)
- Найти навык по имени, описанию или ключевым словам (query)
- Получить полную информацию о навыке по ID (id)

ВАЖНО: Всегда вызывай этот tool ПЕРЕД созданием нового навыка (create_skill), чтобы проверить дубликаты.`,
    category: 'system',
    toolPack: 'skill_management',
    permission: 'read',
    isReadOnly: true,
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Поисковый запрос (по имени, описанию, категории, ключевым словам). Если не указан — вернёт все навыки.',
            },
            id: {
                type: 'string',
                description: 'ID конкретного навыка для получения полной информации (включая content).',
            },
        },
        required: [],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            // Если запрошен конкретный навык по ID
            if (input.id) {
                const id = typeof input.id === 'string' ? parseInt(input.id) : input.id;
                const skill = await getSkillById(id);
                if (!skill) {
                    return {
                        success: false,
                        error: `Навык с ID ${id} не найден`,
                        displayText: `❌ Навык с ID ${id} не найден`,
                    };
                }

                return {
                    success: true,
                    data: skill,
                    displayText: `🧩 Навык "${skill.name}" (ID: ${skill.id}):\n` +
                        `  📝 ${skill.description}\n` +
                        `  📂 Категория: ${skill.category}\n` +
                        `  ${skill.isBuiltin ? '🔒 Встроенный' : '👤 Пользовательский'}\n` +
                        `  ${skill.isActive ? '✅ Активен' : '❌ Отключён'}\n` +
                        `  🏷️ Ключевые слова: ${skill.triggerKeywords?.join(', ') || 'нет'}\n` +
                        `  📄 Content:\n${skill.content}`,
                };
            }

            // Поиск/список навыков
            const results = await searchSkills(input.query);

            if (results.length === 0) {
                return {
                    success: true,
                    data: [],
                    displayText: input.query
                        ? `🔍 Навыки по запросу "${input.query}" не найдены`
                        : '📭 Нет созданных навыков',
                };
            }

            const formatted = results.map(s => {
                const type = s.isBuiltin ? '🔒' : '👤';
                const status = s.isActive ? '✅' : '❌';
                const kw = s.triggerKeywords?.length ? ` [${s.triggerKeywords.join(', ')}]` : '';
                return `${type}${status} [ID: ${s.id}] ${s.icon} **${s.name}** — ${s.description}${kw}`;
            }).join('\n');

            const title = input.query
                ? `🔍 Найдено ${results.length} навыков по запросу "${input.query}"`
                : `🧩 Все навыки (${results.length})`;

            return {
                success: true,
                data: results.map(s => ({
                    id: s.id,
                    name: s.name,
                    description: s.description,
                    category: s.category,
                    isBuiltin: s.isBuiltin,
                    isActive: s.isActive,
                    triggerKeywords: s.triggerKeywords,
                    icon: s.icon,
                })),
                displayText: `${title}:\n${formatted}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка поиска навыков: ${error?.message || error}`,
            };
        }
    },
};
