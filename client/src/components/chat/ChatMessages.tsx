import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, Loader2 } from "lucide-react";
import MessageBubble from "./MessageBubble";
import DemoButton from "@/components/demo/DemoButton";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { Message } from "@shared/schema";

export default function ChatMessages() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousLengthRef = useRef(0);

  // Используем простую загрузку всех сообщений
  const { data: messages = [], isLoading, error, refetch } = useQuery<Message[]>({
    queryKey: ["/api/messages"],
    refetchInterval: 2000, // Опрос каждые 2 секунды
  });

  // WebSocket для real-time обновлений
  const { isConnected, connectionStatus } = useWebSocket();

  // Автопрокрутка к новым сообщениям
  useEffect(() => {
    if (scrollRef.current && messages.length > previousLengthRef.current) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
    previousLengthRef.current = messages.length;
  }, [messages]);

  // Принудительная прокрутка вниз при загрузке страницы
  useEffect(() => {
    if (scrollRef.current && messages.length > 0) {
      setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 100);
    }
  }, []);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-gray-900 p-6">
        <div className="text-center">
          <div className="text-red-500 dark:text-red-400 mb-4">
            <Bot className="w-12 h-12 mx-auto mb-2" />
            <p className="text-lg font-medium">Ошибка загрузки сообщений</p>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-2">
              {error instanceof Error ? error.message : 'Неизвестная ошибка'}
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            Попробовать снова
          </button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-gray-900">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600 dark:text-blue-400 mx-auto mb-4" />
          <p className="text-gray-600 dark:text-gray-400">Загрузка сообщений...</p>
        </div>
      </div>
    );
  }

  // Показываем приветственное сообщение только если нет сообщений
  const showWelcome = messages.length === 0;

  return (
    <div 
      ref={scrollRef}
      className="flex-1 overflow-y-auto bg-white dark:bg-gray-900 chat-messages"
      style={{ 
        scrollBehavior: 'smooth',
        overflowAnchor: 'none'
      }}
    >
      {showWelcome ? (
        <div className="flex items-center justify-center h-full p-6">
          <div className="text-center max-w-md">
            <Bot className="w-16 h-16 text-blue-500 dark:text-blue-400 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-gray-800 dark:text-gray-200 mb-3">
              Добро пожаловать!
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6 leading-relaxed">
              Ваш персональный ИИ-ассистент готов помочь с любыми вопросами. 
              Отправьте сообщение, изображение или голосовую заметку для начала общения.
            </p>
            <DemoButton />
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-4">
          {messages.map((message, index) => (
            <MessageBubble 
              key={message.id || index} 
              message={message} 
            />
          ))}
        </div>
      )}
    </div>
  );
}