import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Settings, X, Save, Type, Bell, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [fontSize, setFontSize] = useState([14]);
  const [, navigate] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    const savedFontSize = localStorage.getItem('chat_font_size');
    if (savedFontSize) {
      setFontSize([parseInt(savedFontSize)]);
      document.documentElement.style.setProperty('--chat-font-size', `${savedFontSize}px`);
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem('chat_font_size', fontSize[0].toString());
    document.documentElement.style.setProperty('--chat-font-size', `${fontSize[0]}px`);

    toast({
      title: "Настройки сохранены",
      description: "Размер шрифта обновлён",
    });

    window.dispatchEvent(new Event('localStorageChange'));
    onClose();
  };

  const handleFontSizeChange = (value: number[]) => {
    setFontSize(value);
    document.documentElement.style.setProperty('--chat-font-size', `${value[0]}px`);
  };

  const openNotificationsPage = () => {
    onClose();
    navigate("/notifications");
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-xl max-w-sm w-full">
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center space-x-3">
            <Settings className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Настройки</h2>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-full"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-4 space-y-4">
          {/* Размер шрифта */}
          <div>
            <div className="flex items-center space-x-2 mb-3">
              <Type className="w-4 h-4 text-gray-600 dark:text-gray-400" />
              <Label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Размер шрифта сообщений
              </Label>
            </div>
            <div className="space-y-3">
              <Slider
                value={fontSize}
                onValueChange={handleFontSizeChange}
                max={20}
                min={12}
                step={1}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
                <span>12px</span>
                <span className="font-medium">{fontSize[0]}px</span>
                <span>20px</span>
              </div>
              <div
                className="p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border text-gray-700 dark:text-gray-300"
                style={{ fontSize: `${fontSize[0]}px` }}
              >
                Пример текста
              </div>
            </div>
          </div>

          {/* Ссылка на настройки уведомлений */}
          <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={openNotificationsPage}
              className="w-full flex items-center justify-between p-3 rounded-lg bg-blue-50 dark:bg-blue-950 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Bell className="w-4 h-4 text-blue-600" />
                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">
                  Настройки уведомлений
                </span>
              </div>
              <ExternalLink className="w-4 h-4 text-blue-600" />
            </button>
            <p className="text-xs text-gray-500 mt-1 text-center">
              Расписание, Telegram, тихие часы
            </p>
          </div>
        </div>

        <div className="flex justify-end space-x-3 p-4 border-t border-gray-200 dark:border-gray-700">
          <Button
            variant="outline"
            onClick={onClose}
            className="px-4 py-2"
          >
            Отмена
          </Button>
          <Button
            onClick={handleSave}
            className="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700"
          >
            <Save className="w-4 h-4 mr-2" />
            Сохранить
          </Button>
        </div>
      </div>
    </div>
  );
}
