import { useState, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Message, MessageProcessingRun } from '@shared/schema';

interface PaginatedMessagesResponse {
  messages: Message[];
  totalCount: number;
  hasMore: boolean;
  workflows: Record<number, MessageProcessingRun>;
}

export function usePaginatedMessages() {
  const [allMessages, setAllMessages] = useState<Message[]>([]);
  const [allWorkflows, setAllWorkflows] = useState<Record<number, MessageProcessingRun>>({});
  const [offset, setOffset] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const queryClient = useQueryClient();
  const limit = 20;

  // Загружаем первую порцию сообщений
  const { data, isLoading, error, refetch } = useQuery<PaginatedMessagesResponse>({
    queryKey: ['/api/messages/paginated', { limit, offset: 0 }],
    queryFn: async () => {
      const response = await fetch(`/api/messages/paginated?limit=${limit}&offset=0`);
      if (!response.ok) {
        throw new Error('Ошибка загрузки сообщений');
      }
      return response.json();
    },
    refetchInterval: 2000, // Опрос каждые 2 секунды для новых сообщений
  });

  // Функция для загрузки предыдущих сообщений с сохранением позиции
  const loadPreviousMessages = useCallback(async (anchorMessageId?: number) => {
    if (isLoadingMore || !data?.hasMore) return;

    setIsLoadingMore(true);
    try {
      const response = await fetch(`/api/messages/paginated?limit=${limit}&offset=${allMessages.length}`);
      if (!response.ok) {
        throw new Error('Ошибка загрузки предыдущих сообщений');
      }

      const previousData: PaginatedMessagesResponse = await response.json();

      // Добавляем предыдущие сообщения в начало списка
      setAllMessages(prev => [...previousData.messages, ...prev]);

      // Добавляем workflows для предыдущих сообщений
      setAllWorkflows(prev => ({
        ...prev,
        ...previousData.workflows,
      }));

      setOffset(prev => prev + limit);

      // Возвращаем информацию для восстановления позиции скролла
      return {
        newMessagesCount: previousData.messages.length,
        anchorMessageId
      };
    } catch (error) {
      console.error('Error loading previous messages:', error);
      return null;
    } finally {
      setIsLoadingMore(false);
    }
  }, [allMessages.length, data?.hasMore, isLoadingMore, limit]);

  // Обновляем список сообщений и workflows при получении новых данных
  useEffect(() => {
    if (data?.messages) {
      setAllMessages(prevMessages => {
        // Для первой загрузки или когда пришли новые сообщения
        if (offset === 0) {
          // Проверяем, есть ли новые сообщения (сравниваем по ID последнего сообщения)
          const lastCurrentMessage = prevMessages[prevMessages.length - 1];
          const lastNewMessage = data.messages[data.messages.length - 1];

          if (!lastCurrentMessage || lastNewMessage?.id > lastCurrentMessage.id) {
            // Если это первая загрузка или есть новые сообщения, обновляем
            return data.messages;
          }
          return prevMessages;
        }
        return prevMessages;
      });

      // Обновляем workflows
      if (data.workflows) {
        setAllWorkflows(prev => ({
          ...prev,
          ...data.workflows,
        }));
      }
    }
  }, [data, offset]);

  // Функция для принудительного обновления
  const refresh = useCallback(() => {
    setOffset(0);
    setAllMessages([]);
    setAllWorkflows({});
    refetch();
  }, [refetch]);

  return {
    messages: allMessages,
    workflows: allWorkflows, // Теперь возвращаем workflows
    isLoading,
    isLoadingMore,
    error,
    hasMore: data?.hasMore || false,
    totalCount: data?.totalCount || 0,
    loadPreviousMessages,
    refresh,
  };
}
