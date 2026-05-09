import { Wifi, WifiOff, RotateCw } from "lucide-react";

interface ConnectionStatusProps {
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
}

export function ConnectionStatus({ status }: ConnectionStatusProps) {
  const getStatusInfo = () => {
    switch (status) {
      case 'connected':
        return {
          icon: <Wifi className="w-4 h-4 text-green-500" />,
          text: 'Подключено',
          className: 'bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300 border-green-200 dark:border-green-800'
        };
      case 'connecting':
        return {
          icon: <RotateCw className="w-4 h-4 text-yellow-500 animate-spin" />,
          text: 'Подключение...',
          className: 'bg-yellow-50 dark:bg-yellow-950 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800'
        };
      case 'disconnected':
        return {
          icon: <WifiOff className="w-4 h-4 text-gray-500" />,
          text: 'Отключено',
          className: 'bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-700'
        };
      case 'error':
        return {
          icon: <WifiOff className="w-4 h-4 text-red-500" />,
          text: 'Ошибка подключения',
          className: 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800'
        };
    }
  };

  const { icon, text, className } = getStatusInfo();

  return (
    <div className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs border ${className}`}>
      {icon}
      <span>{text}</span>
    </div>
  );
}