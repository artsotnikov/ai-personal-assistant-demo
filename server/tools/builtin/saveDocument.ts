/**
 * Tool: save_document — Сохранить документ
 * 
 * Делегирует к documentManager.saveDocument()
 */

import type { ToolDefinition, ToolResult } from '../types';
import { saveDocument } from '../../documentManager';

interface SaveDocumentInput {
    content: string;
    title?: string;
    documentType?: string;
}

export const saveDocumentTool: ToolDefinition<SaveDocumentInput> = {
    name: 'save_document',
    description: `Сохранить текст как документ для долгосрочного хранения. ⚠️ Используй ТОЛЬКО когда пользователь ЯВНО просит сохранить/записать что-то как документ (например: «сохрани это», «запиши как документ», «составь отчёт и сохрани»). НЕ используй для обычных сообщений, голосовых, размышлений — даже если текст длинный. Длинный текст ≠ документ. Для фактов используй remember_fact, для списков — create_note.`,
    category: 'documents',
    toolPack: 'core',
    permission: 'write',
    inputSchema: {
        type: 'object',
        properties: {
            content: {
                type: 'string',
                description: 'Содержимое документа',
            },
            title: {
                type: 'string',
                description: 'Название документа (если не указано, будет сгенерировано AI)',
            },
            documentType: {
                type: 'string',
                description: 'Тип документа: general, financial_report, competitor_analysis, strategy, plan',
            },
        },
        required: ['content'],
    },

    handler: async (input, ctx): Promise<ToolResult> => {
        try {
            const result = await saveDocument({
                content: input.content,
                title: input.title,
                documentType: input.documentType || 'general',
                sourceMessageId: ctx.messageId || undefined,
            });

            return {
                success: true,
                data: { id: result.documentId, title: result.title },
                displayText: `📄 Документ сохранён: "${result.title}" (тип: ${result.documentType})`,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error?.message || String(error),
                displayText: `Ошибка сохранения документа: ${error?.message || error}`,
            };
        }
    },
};
