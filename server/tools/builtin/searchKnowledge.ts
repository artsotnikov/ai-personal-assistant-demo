/**
 * Tool: search_knowledge — Поиск по графу знаний
 * 
 * Делегирует к entityExtractor.getRelevantGraphContext()
 */

import type { ToolDefinition, ToolResult } from '../types';
import { getRelevantGraphContext } from '../../entityExtractor';

interface SearchKnowledgeInput {
    query: string;
    maxEntities?: number;
    categories?: string[];
}

export const searchKnowledgeTool: ToolDefinition<SearchKnowledgeInput> = {
    name: 'search_knowledge',
    description: `Поиск по графу знаний — связи между сущностями (люди, проекты, абстрактные боли, технологии, цели). Используй для понимания структуры проблемы, поиска завимостей, контекста проектов, или причин болей. НЕ используй для поиска простых плоских фактов (они уже подаются в автоматическом контексте).`,
    category: 'memory',
    toolPack: 'core',
    permission: 'read',
    isReadOnly: true,
    timeout: 45_000, // embedding (10с+10с fallback) + граф-поиск + O(N) fallback
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Поисковый запрос — имя сущности, компании, проекта',
            },
            maxEntities: {
                type: 'number',
                description: 'Максимум сущностей в результате (по умолчанию 5)',
            },
            categories: {
                type: 'array',
                items: { type: 'string' },
                description: 'Опциональный фильтр по категориям связей (goals, tools, people, problems, fears, habits, ownership, influence, competition)',
            }
        },
        required: ['query'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            const result = await getRelevantGraphContext(input.query, {
                maxEntities: input.maxEntities || 5,
                maxConnected: 10,
                categories: input.categories,
            });

            if (result.entities.length === 0) {
                return {
                    success: true,
                    data: { entities: [], relations: [] },
                    displayText: `По запросу "${input.query}" сущностей не найдено в графе знаний.`,
                };
            }

            const entitiesText = result.entities
                .map((e, i) => `${i + 1}. ${e.entity.name} (${e.entity.baseType || 'unknown'}, совпадение: ${Math.round(e.similarity * 100)}%)`)
                .join('\n');

            const relationsText = result.relations.length > 0
                ? '\n\nСвязи (с контекстом и атрибутами):\n' + result.relations
                    .map(r => {
                        const attrs = r.attributes && Object.keys(r.attributes).length > 0
                            ? ' | Атрибуты: ' + JSON.stringify(r.attributes)
                            : '';
                        const desc = r.description ? ` (${r.description})` : '';
                        return `- [${r.relationCategory}] ${r.source.name} → ${r.relationType} → ${r.target.name}${desc}${attrs}`;
                    })
                    .join('\n')
                : '';

            const connectedText = result.connectedEntities.length > 0
                ? '\n\nСвязанные сущности:\n' + result.connectedEntities
                    .slice(0, 5)
                    .map(c => `- ${c.entity.name} (через: ${c.connectedVia})`)
                    .join('\n')
                : '';

            return {
                success: true,
                data: {
                    entities: result.entities.map(e => ({ name: e.entity.name, type: e.entity.baseType, similarity: e.similarity })),
                    relations: result.relations.map(r => ({ category: r.relationCategory, source: r.source.name, relation: r.relationType, target: r.target.name, description: r.description, attributes: r.attributes })),
                    connected: result.connectedEntities.map(c => ({ name: c.entity.name, via: c.connectedVia })),
                },
                displayText: `🧠 Найдено ${result.entities.length} сущностей:\n${entitiesText}${relationsText}${connectedText}`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка поиска в графе знаний: ${error?.message || error}`,
            };
        }
    },
};
