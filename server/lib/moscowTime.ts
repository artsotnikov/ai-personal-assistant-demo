/**
 * Moscow Time Utilities — единая точка для работы с московским временем (UTC+3).
 * 
 * Используется в proactiveScheduler, cognitiveLoop, advisorEngine.
 * Всегда работает корректно независимо от таймзоны сервера.
 */

/**
 * Получить текущий час по Москве (UTC+3), 0-23
 */
export function getMoscowHour(): number {
    return parseInt(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Moscow',
            hour: 'numeric',
            hour12: false,
        }).format(new Date()),
        10
    );
}

/**
 * Получить текущий день недели по Москве (0 = воскресенье, 6 = суббота)
 */
export function getMoscowDayOfWeek(): number {
    const dayStr = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Moscow',
        weekday: 'short',
    }).format(new Date());

    const dayMap: Record<string, number> = {
        'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3,
        'Thu': 4, 'Fri': 5, 'Sat': 6,
    };

    return dayMap[dayStr] ?? new Date().getDay();
}

/**
 * Получить текущую дату по Москве в формате YYYY-MM-DD
 */
export function getMoscowDateKey(): string {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Moscow',
    }).format(new Date());
}

/**
 * Получить текущую минуту по Москве, 0-59
 */
export function getMoscowMinute(): number {
    return parseInt(
        new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Moscow',
            minute: 'numeric',
        }).format(new Date()),
        10
    );
}

/**
 * Получить Date, соответствующий полуночи текущего дня по Москве (UTC+3).
 * 
 * Используется для подсчёта дневных лимитов и статистики.
 * Пример: если сейчас 14 апреля 15:00 МСК → вернёт 14 апреля 00:00 МСК (= 13 апреля 21:00 UTC)
 */
export function getMoscowMidnight(): Date {
    const moscowDateStr = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Europe/Moscow',
    }).format(new Date());
    // moscowDateStr = "2026-04-14", добавляем T00:00:00 с offset МСК
    return new Date(`${moscowDateStr}T00:00:00+03:00`);
}

/**
 * Получить текущую дату по Москве, отформатированную на русском.
 * Пример: "понедельник, 14 апреля 2026 г."
 */
export function getMoscowFormattedDate(): string {
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    }).format(new Date());
}

/**
 * Получить текущее время по Москве в формате HH:MM.
 * Пример: "15:30"
 */
export function getMoscowFormattedTime(): string {
    return new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date());
}
