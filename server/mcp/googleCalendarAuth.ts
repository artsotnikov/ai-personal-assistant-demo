#!/usr/bin/env node
/**
 * Google Calendar OAuth — простая авторизация в одну команду
 * 
 * Использование:
 *   npx tsx server/mcp/googleCalendarAuth.ts
 * 
 * Что произойдёт:
 *   1. Откроется браузер с авторизацией Google
 *   2. Ты разрешаешь доступ к календарю
 *   3. Скрипт сам поймает ответ и сохранит токен
 *   4. Готово!
 */

import { OAuth2Client } from 'google-auth-library';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CREDENTIALS_PATH = path.resolve(process.cwd(), 'google-credentials.json');
const TOKEN_PATH = path.resolve(process.cwd(), 'google-token.json');

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const PORT = 3847; // Локальный порт для callback
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

/**
 * Открыть URL в браузере (кроссплатформенно)
 */
function openBrowser(url: string) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) console.log(`\n📋 Если браузер не открылся, перейди вручную:\n${url}\n`);
    });
}

async function main() {
    // Проверяем credentials.json
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.log(`
❌ Файл google-credentials.json не найден!

📝 Как получить:
   1. Зайди на https://console.cloud.google.com/apis/credentials
   2. Нажми "Create Credentials" → "OAuth client ID"
   3. Тип: "Desktop app", имя: любое
   4. Нажми "Download JSON"
   5. Сохрани файл как: ${CREDENTIALS_PATH}
   6. Запусти этот скрипт ещё раз
`);
        process.exit(1);
    }

    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const authData = credentials.installed || credentials.web;
    if (!authData) {
        console.log("❌ Некорректный формат google-credentials.json. Ожидается 'installed' или 'web'.");
        process.exit(1);
    }
    const { client_id, client_secret } = authData;

    const oauth2Client = new OAuth2Client(client_id, client_secret, REDIRECT_URI);

    // Если передан код в аргументах
    if (process.argv[2]) {
        const code = process.argv[2];
        console.log(`\n⏳ Обработка переданного кода...`);
        try {
            const { tokens } = await oauth2Client.getToken({
                code,
                redirect_uri: REDIRECT_URI,
            });
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            console.log(`\n✅ Токен успешно сохранён: ${TOKEN_PATH}`);
            process.exit(0);
        } catch (err: any) {
            console.error(`\n❌ Ошибка при получении токена по коду:`, err?.message);
            process.exit(1);
        }
    }

    // Проверяем, может токен уже есть и он валиден
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
            oauth2Client.setCredentials(token);
            // Пробуем обновить чтобы проверить валидность refresh_token
            console.log("🔄 Проверка существующего токена...");
            await oauth2Client.refreshAccessToken();
            console.log(`✅ Токен уже существует и успешно обновлён: ${TOKEN_PATH}`);
            console.log(`Если нужна полная пере-авторизация — удали этот файл и запусти скрипт снова.`);
            process.exit(0);
        } catch (e: any) {
            console.log(`⚠️ Существующий токен невалиден (${e.message}). Требуется повторная авторизация.`);
            // Удаляем старый токен чтобы начать процесс заново
            fs.unlinkSync(TOKEN_PATH);
        }
    }

    // Генерируем URL авторизации
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        redirect_uri: REDIRECT_URI,
    });

    console.log(`\n🔐 Авторизация Google Calendar\n`);
    console.log(`1. Перейди по ссылке для авторизации:\n\n${authUrl}\n`);
    console.log(`2. После разрешения доступа тебя перенаправит на localhost.`);
    console.log(`   Если скрипт запущен локально, он сам поймает код.`);
    console.log(`   Если нет — скопируй параметр 'code=' из адресной строки и запусти:\n`);
    console.log(`   npx tsx server/mcp/googleCalendarAuth.ts <ТВОЙ_КОД>\n`);

    // Запускаем локальный сервер как удобный бонус
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '', `http://localhost:${PORT}`);
        
        if (url.pathname === '/callback' || url.pathname === '/') {
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>❌ Авторизация отклонена</h1><p>Можно закрыть эту вкладку.</p>');
                console.error(`\n❌ Авторизация отклонена: ${error}`);
                server.close();
                process.exit(1);
            }

            if (code) {
                try {
                    const { tokens } = await oauth2Client.getToken({
                        code,
                        redirect_uri: REDIRECT_URI,
                    });
                    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`
                        <h1>✅ Авторизация успешна!</h1>
                        <p>Токен сохранён. Можно закрыть эту вкладку.</p>
                        <script>setTimeout(() => window.close(), 2000)</script>
                    `);

                    console.log(`\n✅ Токен сохранён: ${TOKEN_PATH}`);
                    console.log(`\n📝 Теперь в .env установи:`);
                    console.log(`   MCP_GOOGLE_CALENDAR_ENABLED=true`);
                    console.log(`\nИ перезапусти сервер. Готово! 🎉\n`);
                    
                    server.close();
                    process.exit(0);
                } catch (err: any) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(`<h1>❌ Ошибка</h1><p>${err?.message}</p>`);
                    console.error(`\n❌ Ошибка при получении токена:`, err?.message);
                    server.close();
                    process.exit(1);
                }
            }
        }
    });

    server.listen(PORT, () => {
        // Пробуем открыть браузер автоматически
        openBrowser(authUrl);
        console.log(`⏳ Жду автоматическую авторизацию... (слушаю порт ${PORT})`);
    });

    // Увеличим таймаут до 10 минут
    setTimeout(() => {
        console.log('\n⏱️ Время ожидания автоматического ответа истекло. Используй ручной ввод кода если браузер не смог достучаться до сервера.');
        server.close();
        process.exit(0);
    }, 10 * 60 * 1000);
}

main();
