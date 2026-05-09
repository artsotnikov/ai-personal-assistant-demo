// Service Worker регистрация и управление

export interface ServiceWorkerManager {
  register(): Promise<ServiceWorkerRegistration | null>;
  requestNotificationPermission(): Promise<NotificationPermission>;
  isSupported(): boolean;
  getRegistration(): Promise<ServiceWorkerRegistration | undefined>;
  subscribeToPush(): Promise<boolean>;
  unsubscribeFromPush(): Promise<void>;
}

class ServiceWorkerManagerImpl implements ServiceWorkerManager {
  private registration: ServiceWorkerRegistration | null = null;

  isSupported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async register(): Promise<ServiceWorkerRegistration | null> {
    if (!this.isSupported()) {
      console.warn('Service Worker не поддерживается в этом браузере');
      return null;
    }

    try {
      this.registration = await navigator.serviceWorker.register('/sw.js', {
        scope: '/',
        updateViaCache: 'none' // Принудительно проверяем обновления SW
      });

      console.log('Service Worker зарегистрирован:', this.registration.scope);

      // Проверяем обновления сразу
      this.registration.update();

      // Обработка обновлений Service Worker
      this.registration.addEventListener('updatefound', () => {
        const newWorker = this.registration?.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed') {
              if (navigator.serviceWorker.controller) {
                // Новая версия доступна - перезагружаем страницу
                console.log('Новая версия приложения обнаружена, перезагружаем...');
                setTimeout(() => {
                  window.location.reload();
                }, 100);
              } else {
                // Первая установка
                console.log('Приложение готово к работе офлайн');
              }
            }
          });
        }
      });

      // Автоматическая проверка обновлений каждые 30 секунд
      setInterval(() => {
        this.registration?.update();
      }, 30000);

      // Слушаем сообщения от Service Worker
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'CACHE_UPDATED') {
          console.log('Кеш обновлен, перезагружаем страницу...');
          window.location.reload();
        }
      });

      return this.registration;
    } catch (error) {
      console.error('Ошибка регистрации Service Worker:', error);
      return null;
    }
  }

  async requestNotificationPermission(): Promise<NotificationPermission> {
    if (!('Notification' in window)) {
      console.warn('Браузер не поддерживает уведомления');
      return 'denied';
    }

    if (Notification.permission === 'granted') {
      return 'granted';
    }

    if (Notification.permission === 'denied') {
      return 'denied';
    }

    // Запрашиваем разрешение
    const permission = await Notification.requestPermission();
    return permission;
  }

  async getRegistration(): Promise<ServiceWorkerRegistration | undefined> {
    if (!this.isSupported()) {
      return undefined;
    }

    if (this.registration) {
      return this.registration;
    }

    return await navigator.serviceWorker.getRegistration();
  }

  async sendMessageToServiceWorker(message: any): Promise<void> {
    const registration = await this.getRegistration();
    if (registration?.active) {
      registration.active.postMessage(message);
    }
  }

  async showNotification(title: string, options: NotificationOptions): Promise<void> {
    const registration = await this.getRegistration();
    if (registration) {
      await registration.showNotification(title, {
        icon: '/icon-192x192.png',
        badge: '/icon-192x192.png',
        ...options
      });
    } else {
      // Fallback к обычным уведомлениям
      if (Notification.permission === 'granted') {
        new Notification(title, options);
      }
    }
  }

  // ============================================================================
  // Web Push подписка
  // ============================================================================

  /**
   * Подписаться на серверные push-уведомления
   * Получает VAPID ключ с сервера, создаёт PushSubscription и отправляет на сервер
   */
  async subscribeToPush(): Promise<boolean> {
    try {
      const registration = await this.getRegistration();
      if (!registration) {
        console.warn('🔔 Push: нет регистрации SW');
        return false;
      }

      // Проверяем, есть ли уже подписка
      const existingSub = await registration.pushManager.getSubscription();
      if (existingSub) {
        // Обновляем подписку на сервере (на случай если она была удалена)
        await this.sendSubscriptionToServer(existingSub);
        console.log('🔔 Push: подписка обновлена');
        return true;
      }

      // Получаем VAPID ключ с сервера
      const response = await fetch('/api/push/vapid-key');
      if (!response.ok) {
        console.warn('🔔 Push: сервер не настроен');
        return false;
      }
      const { publicKey } = await response.json();

      // Конвертируем ключ в Uint8Array
      const applicationServerKey = this.urlBase64ToUint8Array(publicKey);

      // Создаём подписку
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey.buffer as ArrayBuffer,
      });

      // Отправляем подписку на сервер
      await this.sendSubscriptionToServer(subscription);
      console.log('🔔 Push: подписка создана');
      return true;
    } catch (error) {
      console.error('🔔 Push: ошибка подписки:', error);
      return false;
    }
  }

  /**
   * Отписаться от push-уведомлений
   */
  async unsubscribeFromPush(): Promise<void> {
    try {
      const registration = await this.getRegistration();
      if (!registration) return;

      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await subscription.unsubscribe();
        // Удаляем подписку на сервере
        await fetch('/api/push/subscribe', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        console.log('🔔 Push: подписка удалена');
      }
    } catch (error) {
      console.error('🔔 Push: ошибка отписки:', error);
    }
  }

  private async sendSubscriptionToServer(subscription: PushSubscription): Promise<void> {
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });
  }

  private urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
}

export const serviceWorkerManager = new ServiceWorkerManagerImpl();