import { useRef, useCallback, useEffect, useMemo } from 'react';

/**
 * Хук для предотвращения автоматического выключения экрана во время записи.
 * 
 * Использует два механизма:
 * 1. Screen Wake Lock API (нативный, запрещает экрану гаснуть)
 * 2. Fallback: тихое аудио-воспроизведение (поддерживает активность вкладки)
 */
export function useWakeLock() {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const isRequestedRef = useRef(false);
  const silentAudioRef = useRef<HTMLAudioElement | null>(null);
  const silentVideoRef = useRef<HTMLVideoElement | null>(null);

  const isWakeLockSupported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  /**
   * Создаёт и запускает «невидимое» видео — трюк для предотвращения
   * блокировки экрана на Android, когда Wake Lock API не срабатывает.
   * Браузер считает, что идёт воспроизведение медиа и не отдаёт экран в сон.
   */
  const startNoSleepVideo = useCallback(() => {
    try {
      // Тихий аудио-контекст для поддержки активности
      if (!silentAudioRef.current) {
        // Минимальный WAV: 1 сэмпл тишины
        const silentWav = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
        silentAudioRef.current = new Audio(silentWav);
        silentAudioRef.current.loop = true;
        silentAudioRef.current.volume = 0.001; // Практически беззвучно
      }
      silentAudioRef.current.play().catch(() => {});

      // Создаём невидимое видео с MediaStream из canvas
      // Это самый надёжный трюк для Android — браузер не уходит в сон при активном видео
      if (!silentVideoRef.current) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillRect(0, 0, 1, 1);
        }
        const stream = canvas.captureStream(1); // 1 fps
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.setAttribute('playsinline', 'true');
        video.style.position = 'fixed';
        video.style.top = '-9999px';
        video.style.width = '1px';
        video.style.height = '1px';
        video.style.opacity = '0.01';
        document.body.appendChild(video);
        silentVideoRef.current = video;
      }
      silentVideoRef.current.play().catch(() => {});
    } catch {
      // Если fallback не работает — не критично
    }
  }, []);

  const stopNoSleepVideo = useCallback(() => {
    if (silentAudioRef.current) {
      silentAudioRef.current.pause();
      silentAudioRef.current.currentTime = 0;
    }
    if (silentVideoRef.current) {
      silentVideoRef.current.pause();
      if (silentVideoRef.current.srcObject) {
        const stream = silentVideoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(t => t.stop());
        silentVideoRef.current.srcObject = null;
      }
      silentVideoRef.current.remove();
      silentVideoRef.current = null;
    }
  }, []);

  const request = useCallback(async () => {
    isRequestedRef.current = true;

    // Механизм 1: Screen Wake Lock API
    if (isWakeLockSupported) {
      try {
        wakeLockRef.current = await navigator.wakeLock.request('screen');

        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null;
          // Восстанавливаем если запись ещё идёт
          if (isRequestedRef.current && document.visibilityState === 'visible') {
            navigator.wakeLock.request('screen')
              .then(lock => { wakeLockRef.current = lock; })
              .catch(() => {});
          }
        });
      } catch {
        // Wake Lock не доступен — используем fallback
      }
    }

    // Механизм 2: Fallback с тихим видео/аудио (работает на большинстве Android)
    startNoSleepVideo();
  }, [isWakeLockSupported, startNoSleepVideo]);

  const release = useCallback(() => {
    isRequestedRef.current = false;
    wakeLockRef.current?.release();
    wakeLockRef.current = null;
    stopNoSleepVideo();
  }, [stopNoSleepVideo]);

  // Восстанавливаем Wake Lock при возврате на вкладку
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isRequestedRef.current) {
        if (isWakeLockSupported && !wakeLockRef.current) {
          navigator.wakeLock.request('screen')
            .then(lock => { wakeLockRef.current = lock; })
            .catch(() => {});
        }
        // Перезапускаем fallback
        startNoSleepVideo();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isWakeLockSupported, startNoSleepVideo]);

  // Очистка при размонтировании
  useEffect(() => {
    return () => {
      isRequestedRef.current = false;
      wakeLockRef.current?.release();
      stopNoSleepVideo();
    };
  }, [stopNoSleepVideo]);

  return useMemo(
    () => ({ request, release, isSupported: isWakeLockSupported }),
    [request, release, isWakeLockSupported]
  );
}
