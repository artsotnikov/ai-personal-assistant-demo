import { useState, useEffect } from 'react';
import { Download, X } from 'lucide-react';
import { Button } from './ui/button';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
    const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
    const [showInstallButton, setShowInstallButton] = useState(false);
    const [dismissed, setDismissed] = useState(false);

    useEffect(() => {
        // Проверяем локальное хранилище
        const isDismissed = localStorage.getItem('pwa-install-dismissed');
        if (isDismissed) {
            setDismissed(true);
            return;
        }

        // Проверяем, не установлено ли уже приложение
        if (window.matchMedia('(display-mode: standalone)').matches) {
            return;
        }

        const handleBeforeInstallPrompt = (e: Event) => {
            // Предотвращаем автоматический показ браузерного промпта
            e.preventDefault();
            // Сохраняем событие для последующего использования
            setDeferredPrompt(e as BeforeInstallPromptEvent);
            setShowInstallButton(true);
        };

        const handleAppInstalled = () => {
            // Скрываем кнопку после установки
            setShowInstallButton(false);
            setDeferredPrompt(null);
        };

        window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
        window.addEventListener('appinstalled', handleAppInstalled);

        return () => {
            window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
            window.removeEventListener('appinstalled', handleAppInstalled);
        };
    }, []);

    const handleInstallClick = async () => {
        if (!deferredPrompt) return;

        // Показываем системный промпт установки
        await deferredPrompt.prompt();

        // Ждем ответа пользователя
        const { outcome } = await deferredPrompt.userChoice;

        if (outcome === 'accepted') {
            console.log('✅ Пользователь установил PWA');
        } else {
            console.log('❌ Пользователь отклонил установку PWA');
        }

        // Очищаем сохраненное событие
        setDeferredPrompt(null);
        setShowInstallButton(false);
    };

    const handleDismiss = () => {
        setShowInstallButton(false);
        setDismissed(true);
        localStorage.setItem('pwa-install-dismissed', 'true');
    };

    if (!showInstallButton || dismissed) {
        return null;
    }

    return (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-in slide-in-from-bottom-5">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-4 flex items-start gap-3">
                <div className="flex-shrink-0 w-10 h-10 bg-blue-500 rounded-lg flex items-center justify-center">
                    <Download className="w-5 h-5 text-white" />
                </div>

                <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 dark:text-white mb-1">
                        Установить приложение
                    </h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                        Добавьте ИИ Ассистента на рабочий стол для быстрого доступа
                    </p>

                    <div className="flex gap-2">
                        <Button
                            onClick={handleInstallClick}
                            size="sm"
                            className="flex-1"
                        >
                            Установить
                        </Button>
                        <Button
                            onClick={handleDismiss}
                            size="sm"
                            variant="ghost"
                        >
                            Позже
                        </Button>
                    </div>
                </div>

                <button
                    onClick={handleDismiss}
                    className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    aria-label="Закрыть"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
}
