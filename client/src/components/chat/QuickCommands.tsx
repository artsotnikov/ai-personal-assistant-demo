import { Button } from "@/components/ui/button";

interface QuickCommand {
  label: string;
  command: string;
  icon?: string;
  description?: string;
}

interface QuickCommandsProps {
  onCommandSelect: (command: string) => void;
}

const quickCommands: QuickCommand[] = [
  {
    label: "Сохранить в базу",
    command: "/command-save-to-base",
    icon: "💾",
    description: "Сохранить информацию в базу данных"
  },
  {
    label: "Помощь",
    command: "/command-help",
    icon: "❓",
    description: "Показать доступные команды"
  },
  {
    label: "Статус",
    command: "/command-status",
    icon: "📊",
    description: "Показать текущий статус системы"
  },
  {
    label: "Очистить чат",
    command: "/command-clear",
    icon: "🗑️",
    description: "Очистить историю сообщений"
  },
  {
    label: "Анализ",
    command: "/command-analyze",
    icon: "🔍",
    description: "Проанализировать последние данные"
  },
  {
    label: "Отчет",
    command: "/command-report",
    icon: "📈",
    description: "Создать отчет по данным"
  }
];

export default function QuickCommands({ onCommandSelect }: QuickCommandsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
      <div className="flex gap-2 min-w-max">
        {quickCommands.map((cmd, index) => (
          <Button
            key={index}
            variant="outline"
            size="sm"
            onClick={() => onCommandSelect(cmd.command)}
            className="flex items-center gap-2 whitespace-nowrap text-xs px-3 py-1.5 h-8
                     bg-gray-50 dark:bg-gray-800 
                     border-gray-200 dark:border-gray-700
                     hover:bg-gray-100 dark:hover:bg-gray-700
                     hover:border-blue-300 dark:hover:border-blue-600
                     text-gray-700 dark:text-gray-300
                     hover:text-blue-600 dark:hover:text-blue-400
                     transition-all duration-200 ease-in-out
                     shadow-sm hover:shadow-md"
            title={cmd.description}
          >
            <span className="text-sm">{cmd.icon}</span>
            <span className="font-medium">{cmd.label}</span>
          </Button>
        ))}
      </div>
    </div>
  );
}