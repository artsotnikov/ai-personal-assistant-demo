# Техническая спецификация: AI Эндпоинт через Antigravity-Manager (2026)

Эта спецификация описывает интеграцию между ассистентом и Antigravity-Manager — OpenAI-совместимым API-шлюзом, развёрнутым через Docker.

---

## 1. Обзор архитектуры
*   **Сервер:** Linux (Debian/Ubuntu) с внешним IP.
*   **Стек:** Nginx (HTTPS/SSL → Bearer Auth) → Antigravity-Manager (Docker, порт 8045) → Cockpit Tools (Fingerprint Manager).
*   **Протокол:** Стандартный OpenAI REST API (`/v1/chat/completions`), **не** JSON-RPC.
*   **Безопасность:** Let's Encrypt SSL + Bearer Token авторизация.

## 2. Параметры подключения
| Параметр | Значение |
| :--- | :--- |
| **API Base URL** | Задаётся через `ANTIGRAVITY_URL` в `.env` |
| **Admin Panel** | Доступна по HTTPS на порту 8045 |
| **Метод передачи** | POST |
| **Авторизация** | Bearer Token (`Authorization: Bearer <API_KEY>`) |

## 3. Заголовки (Headers)
```http
Accept: application/json, text/event-stream
Content-Type: application/json
Authorization: Bearer <ANTIGRAVITY_API_KEY>
```

## 4. Список актуальных моделей
Antigravity-Manager поддерживает **маппинг моделей** — можно использовать привычные имена, которые будут перенаправлены на соответствующие модели:
1.  **`gemini-2.5-pro`** (Google, флагман)
2.  **`gemini-2.5-flash`** (Google, быстрая)
3.  **`gemini-2.0-flash`** (Google, предыдущее поколение)

> Конкретные модели настраиваются в админке Antigravity-Manager (Model Router).

## 5. Формат запроса (стандартный OpenAI)
```json
{
  "model": "gemini-2.5-pro",
  "messages": [
    {
      "role": "user",
      "content": "Твой запрос здесь..."
    }
  ],
  "temperature": 0.7,
  "max_tokens": 4000,
  "stream": false
}
```

## 6. Переменные окружения (`.env`)
```
ANTIGRAVITY_URL=https://your-server-domain/antigravity-api/v1
ANTIGRAVITY_API_KEY=sk-ваш-ключ-из-antigravity-manager
```

## 7. Примечания
*   Antigravity-Manager **автоматически ротирует** аккаунты Google при 429/401 ошибках.
*   Поддерживает **SSE streaming** — клиент OpenAI SDK обрабатывает это нативно.
*   Мониторинг доступен через веб-панель Antigravity-Manager.
*   Если эндпоинт возвращает `502`, проверьте запущен ли Docker-контейнер: `docker ps | grep antigravity`.
