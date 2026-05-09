import { useState, useEffect } from "react";
import { Bot, BotOff } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

interface AIConfig {
  availableProviders: {
    openai: boolean;
    deepseek: boolean;
  };
  currentProvider: string;
  isConfigured: boolean;
}

export default function ConnectionStatus() {
  const { data: aiConfig, isLoading } = useQuery<AIConfig>({
    queryKey: ["/api/ai/config"],
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center space-x-2 text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800 px-3 py-2 rounded-lg">
        <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
        <span className="text-sm">Проверка...</span>
      </div>
    );
  }

  if (!aiConfig?.isConfigured) {
    return (
      <div className="flex items-center space-x-2 text-orange-600 dark:text-orange-400 bg-orange-50 dark:bg-orange-900/20 px-3 py-2 rounded-lg">
        <BotOff className="w-4 h-4" />
        <span className="text-sm">ИИ не настроен</span>
      </div>
    );
  }

  const providerName = aiConfig.currentProvider === 'deepseek' ? 'DeepSeek' : 'OpenAI';

  return (
    <div className="flex items-center space-x-2 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-3 py-2 rounded-lg">
      <Bot className="w-4 h-4" />
      <span className="text-sm">{providerName} подключен</span>
    </div>
  );
}
