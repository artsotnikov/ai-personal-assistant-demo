/**
 * Chunk Service — Разбиение текста на чанки для RAG
 * 
 * Реализует:
 * - Splitting длинных текстов на семантические чанки
 * - Overlap между чанками для сохранения контекста
 * - Metadata для каждого чанка (позиция, источник)
 */

export interface TextChunk {
    content: string;
    index: number;
    startChar: number;
    endChar: number;
    metadata?: Record<string, any>;
}

export interface ChunkingOptions {
    /** Максимальный размер чанка в символах */
    maxChunkSize?: number;
    /** Размер перекрытия между чанками */
    overlapSize?: number;
    /** Разделители для семантического разбиения (по приоритету) */
    separators?: string[];
}

const DEFAULT_OPTIONS: Required<ChunkingOptions> = {
    maxChunkSize: 1000,      // ~250 токенов
    overlapSize: 200,        // ~50 токенов overlap
    separators: [
        '\n\n',              // Параграфы
        '\n',                // Строки
        '. ',                // Предложения
        '? ',                // Вопросы
        '! ',                // Восклицания
        '; ',                // Точка с запятой
        ', ',                // Запятые
        ' ',                 // Слова
    ],
};

/**
 * Разбивает текст на чанки с учётом семантических границ
 */
export function splitTextIntoChunks(
    text: string,
    options: ChunkingOptions = {}
): TextChunk[] {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    if (!text || text.length === 0) {
        return [];
    }

    // Если текст меньше максимального размера — возвращаем как есть
    if (text.length <= opts.maxChunkSize) {
        return [{
            content: text,
            index: 0,
            startChar: 0,
            endChar: text.length,
        }];
    }

    const chunks: TextChunk[] = [];
    let currentPosition = 0;

    while (currentPosition < text.length) {
        // Определяем конец текущего чанка
        let chunkEnd = Math.min(currentPosition + opts.maxChunkSize, text.length);

        // Если это не конец текста, ищем лучшую точку разрыва
        if (chunkEnd < text.length) {
            chunkEnd = findBestBreakPoint(
                text,
                currentPosition,
                chunkEnd,
                opts.separators
            );
        }

        // Извлекаем чанк
        const chunkContent = text.slice(currentPosition, chunkEnd).trim();

        if (chunkContent.length > 0) {
            chunks.push({
                content: chunkContent,
                index: chunks.length,
                startChar: currentPosition,
                endChar: chunkEnd,
            });
        }

        // Переходим к следующей позиции с учётом overlap
        currentPosition = chunkEnd - opts.overlapSize;

        // Защита от бесконечного цикла
        if (currentPosition <= chunks[chunks.length - 1]?.startChar) {
            currentPosition = chunkEnd;
        }
    }

    return chunks;
}

/**
 * Находит лучшую точку разрыва текста
 */
function findBestBreakPoint(
    text: string,
    start: number,
    end: number,
    separators: string[]
): number {
    // Ищем разделитель с наивысшим приоритетом
    for (const separator of separators) {
        // Ищем последнее вхождение разделителя в диапазоне
        const searchRange = text.slice(start, end);
        const lastIndex = searchRange.lastIndexOf(separator);

        if (lastIndex > 0) {
            // Возвращаем позицию после разделителя
            return start + lastIndex + separator.length;
        }
    }

    // Если разделитель не найден — режем по границе
    return end;
}

/**
 * Разбивает факт на чанки, если он слишком длинный
 */
export function chunkFact(
    factContent: string,
    factId: number,
    topicPath: string,
    options: ChunkingOptions = {}
): TextChunk[] {
    const chunks = splitTextIntoChunks(factContent, options);

    // Добавляем metadata к каждому чанку
    return chunks.map(chunk => ({
        ...chunk,
        metadata: {
            factId,
            topicPath,
            isPartial: chunks.length > 1,
            totalChunks: chunks.length,
        },
    }));
}

/**
 * Объединяет перекрывающиеся чанки обратно в текст
 */
export function mergeChunks(chunks: TextChunk[]): string {
    if (chunks.length === 0) return '';
    if (chunks.length === 1) return chunks[0].content;

    // Сортируем по индексу
    const sorted = [...chunks].sort((a, b) => a.index - b.index);

    let result = sorted[0].content;

    for (let i = 1; i < sorted.length; i++) {
        const current = sorted[i];
        const prevEnd = sorted[i - 1].endChar;
        const currentStart = current.startChar;

        // Если есть overlap — находим уникальную часть
        if (currentStart < prevEnd) {
            const overlapLength = prevEnd - currentStart;
            result += current.content.slice(overlapLength);
        } else {
            result += current.content;
        }
    }

    return result;
}

/**
 * Оценивает количество токенов в тексте (приблизительно)
 * 1 токен ≈ 4 символа для английского, ~2-3 для русского
 */
export function estimateTokenCount(text: string): number {
    // Более точная оценка для смешанного русско-английского текста
    const cyrillicCount = (text.match(/[а-яёА-ЯЁ]/g) || []).length;
    const latinCount = (text.match(/[a-zA-Z]/g) || []).length;
    const otherCount = text.length - cyrillicCount - latinCount;

    // Русский: ~2.5 символа на токен, Английский: ~4 символа, другое: ~2
    return Math.ceil(cyrillicCount / 2.5 + latinCount / 4 + otherCount / 2);
}

/**
 * Проверяет, нужно ли разбивать текст на чанки
 */
export function needsChunking(text: string, maxTokens: number = 250): boolean {
    return estimateTokenCount(text) > maxTokens;
}

/**
 * Оценивает общее количество токенов в массиве сообщений (system + user + assistant).
 * Учитывает multimodal контент (изображения ~1K токенов).
 * 
 * Используется для pre-send валидации перед отправкой в API модели.
 */
export function estimateMessagesTokenCount(
    messages: Array<{ role: string; content: string | any[] }>
): number {
    let total = 0;

    for (const msg of messages) {
        // Overhead на каждое сообщение (role, separators, etc.)
        total += 4;

        if (typeof msg.content === 'string') {
            total += estimateTokenCount(msg.content);
        } else if (Array.isArray(msg.content)) {
            // Multimodal: массив ContentPart[]
            for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                    total += estimateTokenCount(part.text);
                } else if (part.type === 'image_url') {
                    // Изображения: ~1K токенов для low detail, ~3K для high
                    const detail = part.image_url?.detail;
                    total += detail === 'high' ? 3000 : 1000;
                }
            }
        }
    }

    return total;
}
