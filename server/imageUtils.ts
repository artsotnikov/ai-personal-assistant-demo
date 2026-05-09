/**
 * Image Utilities — подготовка изображений для Vision API
 * 
 * Конвертирует локальные файлы изображений в base64 data URL
 * для отправки в multimodal LLM (OpenAI Vision API формат).
 */

import fs from 'fs';
import path from 'path';

// Поддерживаемые MIME-типы для vision
const MIME_TYPES: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
};

/**
 * Определить MIME-тип по расширению файла
 */
export function getImageMimeType(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || null;
}

/**
 * Проверить, является ли файл поддерживаемым изображением
 */
export function isSupportedImage(filePath: string): boolean {
    return getImageMimeType(filePath) !== null;
}

/**
 * Конвертировать изображение в base64 data URL
 * 
 * @param filePath - путь к файлу изображения (относительный от корня проекта или абсолютный)
 * @returns data URL строка в формате `data:image/jpeg;base64,...` или null если файл не найден
 */
export function imageToBase64DataUrl(filePath: string): string | null {
    try {
        // Нормализуем путь — fileUrl хранится как `/uploads/filename.jpg`
        const normalizedPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;

        if (!fs.existsSync(normalizedPath)) {
            console.warn(`[ImageUtils] ⚠️ Файл не найден: ${normalizedPath}`);
            return null;
        }

        const mimeType = getImageMimeType(normalizedPath);
        if (!mimeType) {
            console.warn(`[ImageUtils] ⚠️ Неподдерживаемый формат: ${normalizedPath}`);
            return null;
        }

        const fileBuffer = fs.readFileSync(normalizedPath);
        const base64 = fileBuffer.toString('base64');

        // Проверяем размер (OpenAI лимит ~20MB, но мы ограничиваем 10MB для производительности)
        const sizeMB = fileBuffer.length / (1024 * 1024);
        if (sizeMB > 10) {
            console.warn(`[ImageUtils] ⚠️ Изображение слишком большое (${sizeMB.toFixed(1)}MB): ${normalizedPath}`);
            return null;
        }

        console.log(`[ImageUtils] 🖼️ Encoded ${normalizedPath} (${sizeMB.toFixed(2)}MB, ${mimeType})`);
        return `data:${mimeType};base64,${base64}`;
    } catch (error) {
        console.error(`[ImageUtils] ❌ Ошибка чтения файла ${filePath}:`, error);
        return null;
    }
}
