import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import App from "./App";
import "./index.css";
import { serviceWorkerManager } from "@/lib/serviceWorker";

// Инициализация приложения
document.addEventListener('DOMContentLoaded', () => {
  // Предотвращаем pull-to-refresh
  document.body.style.overscrollBehaviorY = 'none';
  document.documentElement.style.overscrollBehaviorY = 'none';
  
  // Устанавливаем правильную высоту viewport
  const setViewportHeight = () => {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--vh', `${vh}px`);
  };
  
  setViewportHeight();
  window.addEventListener('resize', setViewportHeight);
  window.addEventListener('orientationchange', setViewportHeight);
});

// Регистрируем Service Worker только в продакшене
if (import.meta.env.PROD) {
  serviceWorkerManager.register().then(() => {
    console.log('Service Worker зарегистрирован');
  }).catch((error) => {
    console.error('Ошибка регистрации Service Worker:', error);
  });
} else {
  console.log('Service Worker отключен в режиме разработки');
}

// Обработчик PWA install prompt
let deferredPrompt: any = null;

// Проверяем поддержку PWA
const isPWASupported = () => {
  return 'serviceWorker' in navigator && 'beforeinstallprompt' in window;
};

// Показать уведомление о PWA
const showPWANotification = () => {
  console.log('ℹ️ PWA установка:', {
    isHTTPS: location.protocol === 'https:',
    hasServiceWorker: 'serviceWorker' in navigator,
    hasManifest: document.querySelector('link[rel="manifest"]') !== null,
    hasBeforeInstallPrompt: 'beforeinstallprompt' in window,
    currentURL: location.href
  });
  
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
    console.log('⚠️ PWA требует HTTPS для работы install prompt');
  }
};

window.addEventListener('beforeinstallprompt', (e) => {
  console.log('✅ PWA install prompt доступен');
  e.preventDefault();
  deferredPrompt = e;
  
  // Показываем уведомление пользователю
  setTimeout(() => {
    if (deferredPrompt) {
      console.log('📱 Автоматически показываем PWA install prompt');
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then((choiceResult: any) => {
        if (choiceResult.outcome === 'accepted') {
          console.log('✅ Пользователь принял установку PWA');
        } else {
          console.log('❌ Пользователь отклонил установку PWA');
        }
        deferredPrompt = null;
      });
    }
  }, 5000); // Увеличили до 5 секунд
});

// Показываем информацию о PWA при загрузке
setTimeout(showPWANotification, 2000);

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
