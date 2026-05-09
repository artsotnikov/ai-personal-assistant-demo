import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sizes = [48, 72, 96, 144, 192, 512];
const svgPath = path.join(__dirname, '../client/public/pwa-icon.svg');
const outputDir = path.join(__dirname, '../client/public');

async function generateIcons() {
    console.log('🎨 Генерация PWA иконок из SVG...\n');

    // Проверяем что SVG существует
    if (!fs.existsSync(svgPath)) {
        console.error('❌ SVG файл не найден:', svgPath);
        process.exit(1);
    }

    // Читаем SVG
    const svgBuffer = fs.readFileSync(svgPath);

    // Генерируем PNG для каждого размера
    for (const size of sizes) {
        const outputPath = path.join(outputDir, `icon-${size}.png`);

        try {
            await sharp(svgBuffer)
                .resize(size, size)
                .png()
                .toFile(outputPath);

            const stats = fs.statSync(outputPath);
            console.log(`✅ Создана иконка ${size}x${size}: ${outputPath} (${(stats.size / 1024).toFixed(2)} KB)`);
        } catch (error) {
            console.error(`❌ Ошибка создания иконки ${size}x${size}:`, error.message);
        }
    }

    // Генерируем maskable иконки (с padding для Android)
    console.log('\n🎭 Генерация maskable иконок...\n');

    for (const size of [192, 512]) {
        const outputPath = path.join(outputDir, `icon-${size}-maskable.png`);

        try {
            // Создаем canvas с padding 10%
            const paddedSize = Math.round(size * 0.8);
            const padding = Math.round((size - paddedSize) / 2);

            await sharp(svgBuffer)
                .resize(paddedSize, paddedSize)
                .extend({
                    top: padding,
                    bottom: padding,
                    left: padding,
                    right: padding,
                    background: { r: 59, g: 130, b: 246, alpha: 1 } // #3b82f6
                })
                .png()
                .toFile(outputPath);

            const stats = fs.statSync(outputPath);
            console.log(`✅ Создана maskable иконка ${size}x${size}: ${outputPath} (${(stats.size / 1024).toFixed(2)} KB)`);
        } catch (error) {
            console.error(`❌ Ошибка создания maskable иконки ${size}x${size}:`, error.message);
        }
    }

    console.log('\n✨ Генерация иконок завершена!');
}

generateIcons().catch(error => {
    console.error('❌ Критическая ошибка:', error);
    process.exit(1);
});
