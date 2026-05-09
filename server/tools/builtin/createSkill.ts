/**
 * Tool: create_skill — Создать пользовательский навык
 * 
 * Делегирует к skillManager.createSkill()
 * 
 * Вдохновлено Anthropic skill-creator:
 * AI должен вести диалог перед созданием — обсудить структуру,
 * ключевые слова, формат. НЕ создавать навык молча.
 */

import type { ToolDefinition, ToolResult } from '../types';
import { createSkill } from '../../skillManager';

interface CreateSkillInput {
    name: string;
    description: string;
    content: string;
    category?: string;
    triggerKeywords?: string[];
    icon?: string;
}

export const createSkillTool: ToolDefinition<CreateSkillInput> = {
    name: 'create_skill',
    description: `Создать новый навык (skill) — набор инструкций в Markdown, который автоматически подключается к контексту AI при упоминании ключевых слов.

ВАЖНО: Прежде чем вызывать этот tool, ОБЯЗАТЕЛЬНО обсуди с пользователем:
1. Что именно навык должен делать (цель и сценарии использования)
2. Какие ключевые слова будут его активировать
3. Предложи структуру content (секции, правила, примеры)
4. Получи подтверждение пользователя

НЕ создавай навык молча — это должен быть совместный процесс.

Хорошо подходит для: экспертных знаний, чек-листов, процедур, шаблонов ответов, бизнес-правил.`,
    category: 'system',
    toolPack: 'skill_management',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Название навыка (до 64 символов)',
            },
            description: {
                type: 'string',
                description: 'Краткое описание что делает навык и когда активируется (до 200 символов)',
            },
            content: {
                type: 'string',
                description: 'Содержимое навыка в Markdown: инструкции, знания, чек-листы. Используй ## заголовки для секций, - для списков, **жирный** для акцентов. Держи до 500 строк.',
            },
            category: {
                type: 'string',
                description: 'Категория: custom, business, analytics, coaching, finance, или своя',
            },
            triggerKeywords: {
                type: 'string',
                description: 'Ключевые слова для автоматической активации (через запятую). Это ВАЖНО — без них навык не будет подключаться автоматически.',
            },
            icon: {
                type: 'string',
                description: 'Emoji-иконка навыка (1 символ)',
            },
        },
        required: ['name', 'description', 'content'],
    },

    handler: async (input, _ctx): Promise<ToolResult> => {
        try {
            // Парсим ключевые слова из строки, если передана
            let keywords: string[] = [];
            if (input.triggerKeywords) {
                if (Array.isArray(input.triggerKeywords)) {
                    keywords = input.triggerKeywords;
                } else if (typeof input.triggerKeywords === 'string') {
                    keywords = (input.triggerKeywords as string).split(',').map(k => k.trim()).filter(Boolean);
                }
            }

            const skill = await createSkill({
                name: input.name,
                description: input.description,
                content: input.content,
                category: input.category || 'custom',
                triggerKeywords: keywords,
                icon: input.icon,
            });

            return {
                success: true,
                data: { id: skill.id, name: skill.name, slug: skill.slug, keywords },
                displayText: `🧩 Навык создан: "${skill.name}" (${input.category || 'custom'}, ${keywords.length} ключевых слов: ${keywords.join(', ') || 'нет'})`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка создания навыка: ${error?.message || error}`,
            };
        }
    },
};
