import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { notificationService } from '@/lib/notificationService';
import type { Message, ProcessingStep } from '@shared/schema';

export interface EphemeralMessage {
  type: 'ephemeral_message';
  content: string;
  sender: 'ai';
  timestamp: string;
  pipelineName: string;
  isEphemeral: true;
}



export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const wsRef = useRef<WebSocket | null>(null);
  const queryClient = useQueryClient();
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttempts = useRef(0);
  const maxReconnectAttempts = 5;

  const [lastMessage, setLastMessage] = useState<any>(null);
  const [ephemeralMessages, setEphemeralMessages] = useState<EphemeralMessage[]>([]);

  // Processing Timeline — шаги обработки по messageId
  const [processingSteps, setProcessingSteps] = useState<Map<number, ProcessingStep[]>>(new Map());

  const connect = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    setConnectionStatus('connecting');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || (window.location.hostname + (window.location.port ? ':' + window.location.port : ''));
    const wsUrl = `${protocol}//${host}/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);
        setConnectionStatus('connected');
        reconnectAttempts.current = 0;
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLastMessage(data);

          if (data.type === 'new_message') {
            const message: Message = data.message;

            // Обновляем кеш для обычных сообщений
            queryClient.setQueryData<Message[]>(['/api/messages'], (oldMessages) => {
              if (!oldMessages) return [message];

              // Проверяем, нет ли уже этого сообщения в кеше
              const messageExists = oldMessages.some(msg => msg.id === message.id);
              if (messageExists) return oldMessages;

              return [...oldMessages, message];
            });

            // Обновляем кеш для пагинированных сообщений
            queryClient.setQueryData(['/api/messages/paginated'], (oldData: any) => {
              if (!oldData?.pages) return oldData;

              const updatedPages = [...oldData.pages];
              const lastPage = updatedPages[updatedPages.length - 1];

              if (lastPage) {
                // Проверяем, нет ли уже этого сообщения
                const messageExists = lastPage.messages.some((msg: Message) => msg.id === message.id);
                if (!messageExists) {
                  // Добавляем новое сообщение к последней странице
                  lastPage.messages.push(message);
                  lastPage.totalCount++;
                }
              }

              return { ...oldData, pages: updatedPages };
            });

            // Отправляем уведомление если это сообщение от ИИ и не помечено как silent
            // (silent используется для транскрипции голосовых сообщений)
            if (message.sender === 'ai' && !data.silent) {
              notificationService.notifyNewAIMessage(message.content);
            }
          } else if (data.type === 'ephemeral_message') {
            // Эфемерное сообщение - не сохраняется в БД, только отображается
            const ephemeral: EphemeralMessage = {
              type: 'ephemeral_message',
              content: data.content,
              sender: 'ai',
              timestamp: data.timestamp,
              pipelineName: data.pipelineName,
              isEphemeral: true,
            };
            setEphemeralMessages(prev => [...prev, ephemeral]);

            // Отправляем уведомление
            notificationService.notifyNewAIMessage(data.content);
          } else if (data.type === 'connection') {
            console.log('WebSocket connection confirmed:', data.message);
          } else if (data.type === 'processing_step') {
            // Processing Timeline — обновление шагов обработки
            const step = data as ProcessingStep;
            setProcessingSteps(prev => {
              const newMap = new Map(prev);
              const messageSteps = newMap.get(step.messageId) || [];

              // Обновляем существующий шаг или добавляем новый
              const existingIndex = messageSteps.findIndex(s => s.stepId === step.stepId);
              if (existingIndex >= 0) {
                messageSteps[existingIndex] = step;
              } else {
                messageSteps.push(step);
              }

              newMap.set(step.messageId, [...messageSteps]);
              return newMap;
            });
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.onclose = (event) => {
        console.log('WebSocket disconnected:', event.code, event.reason);
        setIsConnected(false);
        setConnectionStatus('disconnected');
        wsRef.current = null;

        // Автоматическое переподключение с экспоненциальной задержкой
        if (reconnectAttempts.current < maxReconnectAttempts) {
          const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
          console.log(`Attempting to reconnect in ${delay}ms...`);

          reconnectTimeoutRef.current = setTimeout(() => {
            reconnectAttempts.current++;
            connect();
          }, delay);
        } else {
          setConnectionStatus('error');
          console.error('Max reconnection attempts reached');
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setConnectionStatus('error');
      };

    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      setConnectionStatus('error');
    }
  };

  const disconnect = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
    setConnectionStatus('disconnected');
  };

  // Подключаемся при монтировании компонента
  useEffect(() => {
    connect();

    // Очистка при размонтировании
    return () => {
      disconnect();
    };
  }, []);

  // Переподключение при изменении видимости страницы
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && !isConnected) {
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isConnected]);

  const clearEphemeralMessages = () => {
    setEphemeralMessages([]);
  };

  // Processing Timeline — функции для работы с шагами
  const getStepsForMessage = useCallback((messageId: number): ProcessingStep[] => {
    return processingSteps.get(messageId) || [];
  }, [processingSteps]);

  const clearProcessingSteps = useCallback((messageId: number) => {
    setProcessingSteps(prev => {
      const newMap = new Map(prev);
      newMap.delete(messageId);
      return newMap;
    });
  }, []);

  const clearAllProcessingSteps = useCallback(() => {
    setProcessingSteps(new Map());
  }, []);

  return {
    isConnected,
    connectionStatus,
    connect,
    disconnect,
    lastMessage,
    ephemeralMessages,
    clearEphemeralMessages,
    // Processing Timeline
    processingSteps,
    getStepsForMessage,
    clearProcessingSteps,
    clearAllProcessingSteps,
  };
}