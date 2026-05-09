import { serviceWorkerManager } from './serviceWorker';

// Типы звуков уведомлений
export type SoundType = 'soft' | 'chime' | 'drop' | 'zen' | 'default';

export const SOUND_OPTIONS: { value: SoundType; label: string; description: string }[] = [
  { value: 'soft', label: 'Мягкий', description: 'Нежный низкочастотный тон' },
  { value: 'chime', label: 'Колокольчик', description: 'Мелодичный переливающийся звук' },
  { value: 'drop', label: 'Капля', description: 'Короткий приятный звук' },
  { value: 'zen', label: 'Дзен', description: 'Спокойный медитативный тон' },
  { value: 'default', label: 'Стандартный', description: 'Классический сигнал уведомления' },
];

// Настройки уведомлений
interface NotificationSettings {
  soundEnabled: boolean;
  pushEnabled: boolean;
  volume: number;
  soundType: SoundType;
}

class NotificationService {
  private notificationSound: HTMLAudioElement | null = null;
  private audioContext: AudioContext | null = null;
  private isAudioInitialized = false;
  private settings: NotificationSettings;
  private isPageVisible: boolean = true;

  constructor() {
    // Загружаем настройки из localStorage
    const savedSettings = localStorage.getItem('notificationSettings');
    const defaultSettings: NotificationSettings = {
      soundEnabled: true,
      pushEnabled: true,
      volume: 0.5,
      soundType: 'soft' // По умолчанию мягкий спокойный звук
    };
    this.settings = savedSettings ? { ...defaultSettings, ...JSON.parse(savedSettings) } : defaultSettings;

    // Отслеживаем видимость страницы
    document.addEventListener('visibilitychange', () => {
      this.isPageVisible = !document.hidden;
    });

    // Создаем аудио элемент для уведомлений
    this.createNotificationSound();
    // Инициализируем аудио контекст при первом взаимодействии
    this.initializeAudioOnUserInteraction();
    // Инициализируем Service Worker
    this.initServiceWorker();
  }

  private initializeAudioOnUserInteraction() {
    const initAudio = async () => {
      if (!this.isAudioInitialized) {
        try {
          this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
          if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
          }
          this.isAudioInitialized = true;
          console.log('Аудио контекст инициализирован');
        } catch (error) {
          console.log('Ошибка инициализации аудио:', error);
        }
      }
    };

    // Добавляем слушатели для первого взаимодействия пользователя
    ['click', 'touchstart', 'keydown'].forEach(event => {
      document.addEventListener(event, initAudio, { once: true });
    });
  }

  private createNotificationSound() {
    // Создаем простую функцию для воспроизведения звука
    this.notificationSound = {
      play: () => {
        return new Promise<void>((resolve, reject) => {
          try {
            if (!this.audioContext || !this.isAudioInitialized) {
              console.log('Аудио контекст не инициализирован, создаем новый');
              this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
              this.isAudioInitialized = true;
            }

            // Проверяем состояние аудио контекста
            if (this.audioContext.state === 'suspended') {
              this.audioContext.resume().then(() => {
                this.playBeep(resolve, reject);
              });
            } else {
              this.playBeep(resolve, reject);
            }
          } catch (error) {
            console.log('Ошибка воспроизведения звука:', error);
            reject(error);
          }
        });
      }
    } as HTMLAudioElement;
  }

  private playBeep(resolve: () => void, reject: (error: any) => void) {
    try {
      if (!this.audioContext) {
        reject(new Error('Аудио контекст недоступен'));
        return;
      }

      const ctx = this.audioContext;
      const now = ctx.currentTime;
      const volume = this.settings.volume * 0.5; // Максимальная громкость 0.25 (50% от 0.5)

      switch (this.settings.soundType) {
        case 'soft':
          this.playSoftSound(ctx, now, volume, resolve);
          break;
        case 'chime':
          this.playChimeSound(ctx, now, volume, resolve);
          break;
        case 'drop':
          this.playDropSound(ctx, now, volume, resolve);
          break;
        case 'zen':
          this.playZenSound(ctx, now, volume, resolve);
          break;
        case 'default':
        default:
          this.playDefaultSound(ctx, now, volume, resolve);
          break;
      }
    } catch (error) {
      console.log('Ошибка создания звука:', error);
      reject(error);
    }
  }

  // Мягкий низкочастотный тон
  private playSoftSound(ctx: AudioContext, now: number, volume: number, resolve: () => void) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(250, now + 0.6);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.8);

    osc.start(now);
    osc.stop(now + 0.8);
    osc.onended = () => resolve();
    setTimeout(() => resolve(), 900);
  }

  // Мелодичный колокольчик - два переливающихся тона
  private playChimeSound(ctx: AudioContext, now: number, volume: number, resolve: () => void) {
    const playNote = (freq: number, delay: number, duration: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + delay);

      gain.gain.setValueAtTime(0, now + delay);
      gain.gain.linearRampToValueAtTime(volume * 0.8, now + delay + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, now + delay + duration);

      osc.start(now + delay);
      osc.stop(now + delay + duration);
      return osc;
    };

    playNote(523, 0, 0.4);      // C5
    playNote(659, 0.15, 0.5);   // E5
    const lastOsc = playNote(784, 0.3, 0.6);  // G5

    lastOsc.onended = () => resolve();
    setTimeout(() => resolve(), 1000);
  }

  // Звук капли воды
  private playDropSound(ctx: AudioContext, now: number, volume: number, resolve: () => void) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, now);
    osc.frequency.exponentialRampToValueAtTime(400, now + 0.15);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

    osc.start(now);
    osc.stop(now + 0.3);
    osc.onended = () => resolve();
    setTimeout(() => resolve(), 400);
  }

  // Медитативный дзен-звук
  private playZenSound(ctx: AudioContext, now: number, volume: number, resolve: () => void) {
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    const gain2 = ctx.createGain();

    osc1.connect(gain1);
    osc2.connect(gain2);
    gain1.connect(ctx.destination);
    gain2.connect(ctx.destination);

    // Основная частота
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(220, now); // A3

    // Гармоника (октава выше)
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(440, now); // A4

    // Плавное нарастание и затухание
    gain1.gain.setValueAtTime(0, now);
    gain1.gain.linearRampToValueAtTime(volume, now + 0.3);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

    gain2.gain.setValueAtTime(0, now);
    gain2.gain.linearRampToValueAtTime(volume * 0.4, now + 0.3);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 1.0);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 1.2);
    osc2.stop(now + 1.0);

    osc1.onended = () => resolve();
    setTimeout(() => resolve(), 1300);
  }

  // Классический звук уведомления (оригинальный)
  private playDefaultSound(ctx: AudioContext, now: number, volume: number, resolve: () => void) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.frequency.setValueAtTime(1000, now);
    osc.frequency.linearRampToValueAtTime(800, now + 0.1);
    osc.frequency.linearRampToValueAtTime(1200, now + 0.2);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(volume * 0.6, now + 0.05);
    gain.gain.linearRampToValueAtTime(volume * 0.2, now + 0.15);
    gain.gain.linearRampToValueAtTime(volume * 0.6, now + 0.25);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

    osc.start(now);
    osc.stop(now + 0.5);
    osc.onended = () => resolve();
    setTimeout(() => resolve(), 600);
  }

  async playNotificationSound(): Promise<void> {
    if (!this.settings.soundEnabled || !this.notificationSound) {
      return;
    }

    try {
      await this.notificationSound.play();
    } catch (error) {
      console.log('Не удалось воспроизвести звук уведомления:', error);
    }
  }

  private async initServiceWorker(): Promise<void> {
    try {
      await serviceWorkerManager.register();
      const permission = await serviceWorkerManager.requestNotificationPermission();
      // Автоматически подписываемся на push если разрешение выдано
      if (permission === 'granted') {
        await serviceWorkerManager.subscribeToPush();
      }
    } catch (error) {
      console.log('Ошибка инициализации Service Worker:', error);
    }
  }

  // Обновляем настройки
  updateSettings(newSettings: Partial<NotificationSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    localStorage.setItem('notificationSettings', JSON.stringify(this.settings));
  }

  // Получаем текущие настройки
  getSettings(): NotificationSettings {
    return { ...this.settings };
  }

  async showPushNotification(title: string, body: string, icon?: string): Promise<void> {
    if (!this.settings.pushEnabled || !('Notification' in window)) {
      return;
    }

    // Используем Service Worker для показа уведомлений если доступен
    try {
      await serviceWorkerManager.showNotification(title, {
        body,
        icon: icon || '/icon-192x192.png',
        badge: '/icon-192x192.png',
        tag: 'ai-response',
        requireInteraction: false,
        silent: false,
        data: {
          timestamp: Date.now(),
          source: 'ai-assistant'
        }
      });
      return;
    } catch (error) {
      console.log('Service Worker уведомление не удалось, используем fallback:', error);
    }

    // Проверяем разрешение
    if (Notification.permission === 'granted') {
      new Notification(title, {
        body,
        icon: icon || '/favicon.ico',
        badge: '/favicon.ico',
        tag: 'ai-response', // Заменяет предыдущие уведомления
        requireInteraction: false,
        silent: false,
      });
    } else if (Notification.permission !== 'denied') {
      // Запрашиваем разрешение
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        new Notification(title, {
          body,
          icon: icon || '/favicon.ico',
          badge: '/favicon.ico',
          tag: 'ai-response',
          requireInteraction: false,
          silent: false,
        });
      }
    }
  }

  async notifyNewAIMessage(messagePreview: string): Promise<void> {
    // Задержка чтобы пользователь успел отвлечься после отправки сообщения
    setTimeout(async () => {
      try {
        if (!this.isPageVisible) {
          // Если страница в фоне - показываем и звук, и push
          await Promise.all([
            this.playNotificationSound(),
            this.showPushNotification(
              'Новое сообщение от ИИ Ассистента',
              messagePreview.slice(0, 80) + (messagePreview.length > 80 ? '...' : ''),
              '/icon-192x192.png'
            )
          ]);
        } else {
          // Если страница активна, играем только звук
          await this.playNotificationSound();
        }
      } catch (error) {
        console.log('Ошибка при отправке уведомления:', error);
      }
    }, 1000); // Задержка 1 секунда
  }

  // Метод для тестирования уведомлений
  async testNotifications(): Promise<void> {
    await this.notifyNewAIMessage('Это тестовое уведомление для проверки настроек звука и push-уведомлений.');
  }
}

export const notificationService = new NotificationService();