import { useEffect } from "react";
import ChatHeader from "@/components/chat/ChatHeader";
import PaginatedChatMessages from "@/components/chat/PaginatedChatMessages";
import InputArea from "@/components/chat/InputArea";

export default function Chat() {
  useEffect(() => {
    document.title = "ИИ Бизнес Ассистент - Чат";
  }, []);

  return (
    <div className="bg-gray-50 dark:bg-gray-900 font-sans flex flex-col fixed inset-0" style={{ height: 'calc(var(--vh, 1vh) * 100)' }}>
      {/* Фиксированная шапка */}
      <div className="flex-shrink-0">
        <ChatHeader />
      </div>

      {/* Основная область чата */}
      <div className="flex-1 min-h-0 flex flex-col">
        <PaginatedChatMessages />

        {/* Фиксированное поле ввода */}
        <div className="flex-shrink-0">
          <InputArea />
        </div>
      </div>
    </div>
  );
}
