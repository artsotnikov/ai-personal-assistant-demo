import { useState } from "react";
import {
  Settings,
  LogOut,
  Sparkles,
  Workflow,
  Brain,
  User,
  Target,
  Menu,
  MessageSquare,
  Bot,
  Bell,
  Network,
  CalendarClock,
  Puzzle,
  FileText,
  Cloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link, useLocation } from "wouter";
import SettingsModal from "@/components/settings/SettingsModal";
import { ConnectionStatusIcon } from "@/components/ui/connection-status-icon";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useWebSocket } from "@/hooks/useWebSocket";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetClose,
} from "@/components/ui/sheet";

interface NavItem {
  href: string;
  icon: React.ReactNode;
  label: string;
  color: string;
}

const navItems: NavItem[] = [
  {
    href: "/",
    icon: <MessageSquare className="h-5 w-5" />,
    label: "Чат",
    color: "text-blue-600 dark:text-blue-400",
  },
  {
    href: "/profile",
    icon: <User className="h-5 w-5" />,
    label: "Профиль",
    color: "text-purple-600 dark:text-purple-400",
  },
  {
    href: "/goals",
    icon: <Target className="h-5 w-5" />,
    label: "Цели",
    color: "text-amber-600 dark:text-amber-400",
  },
  {
    href: "/notes",
    icon: <FileText className="h-5 w-5" />,
    label: "Заметки",
    color: "text-cyan-600 dark:text-cyan-400",
  },
  {
    href: "/reminders",
    icon: <Bell className="h-5 w-5" />,
    label: "Напоминания",
    color: "text-rose-600 dark:text-rose-400",
  },
  {
    href: "/scheduled-tasks",
    icon: <CalendarClock className="h-5 w-5" />,
    label: "Cron-задачи",
    color: "text-blue-600 dark:text-blue-400",
  },
  {
    href: "/memory",
    icon: <Brain className="h-5 w-5" />,
    label: "Память ассистента",
    color: "text-emerald-600 dark:text-emerald-400",
  },
  {
    href: "/graph",
    icon: <Network className="h-5 w-5" />,
    label: "Граф знаний",
    color: "text-violet-600 dark:text-violet-400",
  },
  {
    href: "/settings/ai",
    icon: <Bot className="h-5 w-5" />,
    label: "AI Конфигуратор",
    color: "text-cyan-600 dark:text-cyan-400",
  },
  {
    href: "/skills",
    icon: <Puzzle className="h-5 w-5" />,
    label: "Навыки AI",
    color: "text-fuchsia-600 dark:text-fuchsia-400",
  },
  {
    href: "/expertises",
    icon: <Sparkles className="h-5 w-5" />,
    label: "Экспертизы AI",
    color: "text-orange-600 dark:text-orange-400",
  },
  {
    href: "/settings/obsidian",
    icon: <Cloud className="h-5 w-5" />,
    label: "Obsidian Bridge",
    color: "text-blue-500 dark:text-blue-400",
  },
];


export default function ChatHeader() {
  const [showSettings, setShowSettings] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { logout } = useAuth();
  const { toast } = useToast();
  const { connectionStatus } = useWebSocket();
  const [location] = useLocation();

  const handleLogout = () => {
    logout();
    toast({
      title: "До свидания!",
      description: "Выход выполнен успешно",
    });
    setMenuOpen(false);
  };

  const handleNavClick = () => {
    setMenuOpen(false);
  };

  const handleSettingsClick = () => {
    setShowSettings(true);
    setMenuOpen(false);
  };

  return (
    <header className="bg-white dark:bg-gray-900 shadow-sm border-b border-gray-200 dark:border-gray-700 px-3 py-2 flex items-center justify-between chat-header">
      {/* Левая часть: гамбургер-меню */}
      <div className="flex items-center">
        <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMenuOpen(true)}
            className="p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg"
            data-testid="button-menu"
          >
            <Menu className="h-5 w-5" />
          </Button>

          <SheetContent side="left" className="w-72">
            <SheetHeader className="mb-4">
              <SheetTitle>Навигация</SheetTitle>
            </SheetHeader>

            <nav className="flex flex-col gap-1">
              {navItems.map((item) => (
                <SheetClose asChild key={item.href}>
                  <Link href={item.href} onClick={handleNavClick}>
                    <Button
                      variant="ghost"
                      className={`w-full justify-start gap-3 h-11 ${location === item.href
                        ? "bg-gray-100 dark:bg-gray-800"
                        : ""
                        }`}
                    >
                      <span className={item.color}>{item.icon}</span>
                      <span className="text-gray-700 dark:text-gray-200">
                        {item.label}
                      </span>
                    </Button>
                  </Link>
                </SheetClose>
              ))}

              <SheetClose asChild>
                <Button
                  variant="ghost"
                  onClick={handleSettingsClick}
                  className="w-full justify-start gap-3 h-11"
                >
                  <Settings className="h-5 w-5 text-gray-600 dark:text-gray-400" />
                  <span className="text-gray-700 dark:text-gray-200">
                    Настройки приложения
                  </span>
                </Button>
              </SheetClose>

              <div className="my-2 border-t border-gray-200 dark:border-gray-700" />

              <SheetClose asChild>
                <Button
                  variant="ghost"
                  onClick={handleLogout}
                  className="w-full justify-start gap-3 h-11 text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20"
                >
                  <LogOut className="h-5 w-5" />
                  <span>Выйти</span>
                </Button>
              </SheetClose>
            </nav>
          </SheetContent>
        </Sheet>
      </div>

      {/* Правая часть: статус и переключатель темы */}
      <div className="flex items-center gap-3">
        <ConnectionStatusIcon status={connectionStatus} />
        <ThemeToggle />
      </div>

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />
    </header>
  );
}