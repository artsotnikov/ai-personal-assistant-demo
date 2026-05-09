import { useEffect, useRef, useState, useCallback } from "react";
import { Bot, Loader2, ChevronUp, Sparkles, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import MessageBubble from "./MessageBubble";
import DemoButton from "@/components/demo/DemoButton";
import { useWebSocket, type EphemeralMessage } from "@/hooks/useWebSocket";
import { usePaginatedMessages } from "@/hooks/usePaginatedMessages";
import { useToast } from "@/hooks/use-toast";
import { ProcessingTimeline } from "./ProcessingTimeline";
import { ProcessingStepDetail } from "./ProcessingStepDetail";
import type { ProcessingStep, ProcessingStepRecord } from "@shared/schema";

export default function PaginatedChatMessages() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousLengthRef = useRef(0);
  const [shouldScrollToBottom, setShouldScrollToBottom] = useState(true);
  const [isLoadingWithPositionRestore, setIsLoadingWithPositionRestore] = useState(false);
  const anchorMessageRef = useRef<number | null>(null);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);
  const { toast } = useToast();

  const {
    messages,
    workflows, // Сохранённые workflows из БД
    isLoading,
    isLoadingMore,
    error,
    hasMore,
    loadPreviousMessages,
    refresh,
  } = usePaginatedMessages();

  // WebSocket для real-time обновлений
  const {
    isConnected,
    ephemeralMessages,
    getStepsForMessage
  } = useWebSocket();

  // Processing Timeline — выбранный шаг для детального просмотра
  const [selectedStep, setSelectedStep] = useState<ProcessingStep | null>(null);

  /**
   * Получить шаги обработки для сообщения — объединяет сохранённые и real-time данные
   * Приоритет: real-time данные (если есть) > сохранённые в БД
   */
  const getProcessingStepsForMessage = useCallback((messageId: number): ProcessingStep[] => {
    // Сначала проверяем real-time данные из WebSocket
    const realtimeSteps = getStepsForMessage(messageId);
    if (realtimeSteps.length > 0) {
      return realtimeSteps;
    }

    // Если нет real-time данных — используем сохранённые из БД
    const savedWorkflow = workflows[messageId];
    if (savedWorkflow?.steps && Array.isArray(savedWorkflow.steps)) {
      // Преобразуем ProcessingStepRecord в ProcessingStep
      return (savedWorkflow.steps as ProcessingStepRecord[]).map(step => ({
        type: 'processing_step' as const,
        messageId,
        stepId: step.stepId,
        stepName: step.stepName,
        stepIcon: step.stepIcon,
        status: step.status,
        duration: step.durationMs,
        output: step.output,
        error: step.error,
        timestamp: step.startedAt,
      }));
    }

    return [];
  }, [getStepsForMessage, workflows]);

  // Функция копирования для эфемерных сообщений
  const handleCopyEphemeral = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedIndex(index);
      toast({
        title: "Скопировано!",
        description: "Текст сообщения скопирован в буфер обмена",
        duration: 2000,
      });
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (error) {
      toast({
        title: "Ошибка",
        description: "Не удалось скопировать текст",
        variant: "destructive",
      });
    }
  };

  // Автопрокрутка к новым сообщениям (только если пользователь не скроллил вверх)
  useEffect(() => {
    if (scrollRef.current && messages.length > previousLengthRef.current && shouldScrollToBottom) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
    previousLengthRef.current = messages.length;
  }, [messages, shouldScrollToBottom]);

  // Прокрутка при появлении эфемерных сообщений
  useEffect(() => {
    if (scrollRef.current && ephemeralMessages.length > 0 && shouldScrollToBottom) {
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    }
  }, [ephemeralMessages, shouldScrollToBottom]);

  // Принудительная прокрутка вниз при первой загрузке
  useEffect(() => {
    if (scrollRef.current && messages.length > 0 && isLoading === false) {
      setTimeout(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      }, 100);
    }
  }, [isLoading]);

  // Отслеживание позиции скролла для определения нужности автопрокрутки
  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 100; // 100px от низа
      setShouldScrollToBottom(isAtBottom);
    }
  };

  // Функция для загрузки с сохранением позиции
  const handleLoadPrevious = async () => {
    if (!scrollRef.current) return;

    // Находим первое видимое сообщение как якорь
    const scrollContainer = scrollRef.current;
    const messageElements = scrollContainer.querySelectorAll('[data-message-id]');
    let anchorMessageId = null;

    for (const element of Array.from(messageElements)) {
      const rect = element.getBoundingClientRect();
      const containerRect = scrollContainer.getBoundingClientRect();

      // Если элемент видим в контейнере
      if (rect.top >= containerRect.top && rect.top <= containerRect.bottom) {
        anchorMessageId = parseInt((element as HTMLElement).dataset.messageId || '0');
        break;
      }
    }

    if (anchorMessageId) {
      anchorMessageRef.current = anchorMessageId;
      setIsLoadingWithPositionRestore(true);
    }

    const result = await loadPreviousMessages(anchorMessageId || undefined);

    if (result && anchorMessageId) {
      // Ждем обновления DOM
      setTimeout(() => {
        restoreScrollPosition(anchorMessageId);
      }, 50);
    }
  };

  // Восстановление позиции скролла после загрузки
  const restoreScrollPosition = (anchorMessageId: number) => {
    if (!scrollRef.current) return;

    const anchorElement = scrollRef.current.querySelector(`[data-message-id="${anchorMessageId}"]`);
    if (anchorElement) {
      anchorElement.scrollIntoView({ block: 'start', behavior: 'auto' });
      setIsLoadingWithPositionRestore(false);
      anchorMessageRef.current = null;
    }
  };

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
            onClick={() => refresh()}
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
        <div className="flex flex-col items-center space-y-4">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
          <p className="text-gray-600 dark:text-gray-400">Загружаем сообщения...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-white dark:bg-gray-900 relative overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto p-4 space-y-4"
        style={{
          scrollBehavior: 'smooth',
        }}
      >

        {/* Кнопка загрузки предыдущих сообщений */}
        {hasMore && (
          <div className="flex justify-center mb-4">
            <Button
              onClick={handleLoadPrevious}
              disabled={isLoadingMore}
              variant="outline"
              size="sm"
              className="bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              {isLoadingMore ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  {isLoadingWithPositionRestore ? 'Загружаем и сохраняем позицию...' : 'Загружаем...'}
                </>
              ) : (
                <>
                  <ChevronUp className="w-4 h-4 mr-2" />
                  Загрузить предыдущие 20 сообщений
                </>
              )}
            </Button>
          </div>
        )}

        {/* Приветственное сообщение */}
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4 py-12">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-full p-6 mb-6">
              <Bot className="w-12 h-12 text-blue-600 dark:text-blue-400" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-3">
              Добро пожаловать в ИИ-ассистент!
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6 max-w-md">
              Начните общение с искусственным интеллектом. Отправляйте текстовые сообщения, изображения или аудиофайлы.
            </p>
            <DemoButton />
          </div>
        )}

        {/* Сообщения */}
        {messages.map((message) => (
          <div key={message.id} data-message-id={message.id}>
            <MessageBubble message={message} />

            {/* Processing Timeline — показываем после сообщений пользователя */}
            {message.sender === 'user' && getProcessingStepsForMessage(message.id).length > 0 && (
              <ProcessingTimeline
                messageId={message.id}
                steps={getProcessingStepsForMessage(message.id)}
                onStepClick={setSelectedStep}
              />
            )}
          </div>
        ))}

        {/* Эфемерные сообщения (не сохраняются в БД) */}
        {ephemeralMessages.map((ephemeral, index) => (
          <div key={`ephemeral-${index}-${ephemeral.timestamp}`} className="flex justify-start">
            <div className="max-w-[85%] md:max-w-[70%]">
              <div className="flex items-center gap-2 mb-1">
                <div className="flex items-center gap-1 px-2 py-0.5 bg-purple-100 dark:bg-purple-900/30 rounded-full">
                  <Sparkles className="w-3 h-3 text-purple-600 dark:text-purple-400" />
                  <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">
                    Транскрибация
                  </span>
                </div>
                <span className="text-xs text-gray-400">{ephemeral.pipelineName}</span>
              </div>
              <div className="bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-700 rounded-lg px-4 py-3 text-gray-800 dark:text-gray-200 group relative">
                <p className="whitespace-pre-wrap pr-8">{ephemeral.content}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopyEphemeral(ephemeral.content, index)}
                  className="absolute top-2 right-2 h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-purple-100 dark:hover:bg-purple-800"
                  data-testid={`button-copy-ephemeral-${index}`}
                >
                  {copiedIndex === index ? (
                    <Check className="w-4 h-4 text-green-600 dark:text-green-400" />
                  ) : (
                    <Copy className="w-4 h-4 text-purple-600 dark:text-purple-400" />
                  )}
                </Button>
              </div>
              <div className="text-xs text-gray-400 mt-1">
                Временное сообщение (не сохранено)
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Индикатор подключения (показывается только при проблемах) */}
      {!isConnected && (
        <div className="absolute top-2 left-1/2 transform -translate-x-1/2 bg-yellow-100 dark:bg-yellow-900/20 border border-yellow-300 dark:border-yellow-600 rounded-lg px-3 py-1 text-sm text-yellow-800 dark:text-yellow-200">
          Переподключение...
        </div>
      )}

      {/* Processing Timeline — детальный просмотр шага */}
      <ProcessingStepDetail
        step={selectedStep}
        open={!!selectedStep}
        onClose={() => setSelectedStep(null)}
      />
    </div>
  );
}