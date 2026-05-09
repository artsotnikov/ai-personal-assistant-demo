import { CheckCheck, Play, FileText, Download, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Message } from "@shared/schema";
import { useState } from 'react';
import { useToast } from '@/hooks/use-toast';
import MermaidDiagram from './MermaidDiagram';

interface MessageBubbleProps {
  message: Message;
}

export default function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.sender === 'user';
  const [isCopied, setIsCopied] = useState(false);
  const { toast } = useToast();

  // Функция для поиска и извлечения Mermaid диаграмм
  const extractMermaidDiagrams = (content: string) => {
    const mermaidRegex = /```(?:mermaid)?\s*((?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|gitgraph|journey|mindmap)[^`]*?)```/gi;
    const diagrams: { id: string; chart: string; placeholder: string }[] = [];
    let match;
    let index = 0;

    while ((match = mermaidRegex.exec(content)) !== null) {
      const chart = match[1].trim();
      const placeholder = `__MERMAID_DIAGRAM_${index}__`;
      diagrams.push({
        id: `${message.id}-${index}`,
        chart,
        placeholder
      });
      index++;
    }

    return diagrams;
  };

  // Заменяем Mermaid диаграммы на плейсхолдеры для корректного рендеринга Markdown
  const processContentWithDiagrams = (content: string) => {
    const diagrams = extractMermaidDiagrams(content);
    let processedContent = content;

    diagrams.forEach((diagram) => {
      const originalPattern = new RegExp(`\`\`\`(?:mermaid)?\\s*${diagram.chart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`\`\``, 'gi');
      processedContent = processedContent.replace(originalPattern, diagram.placeholder);
    });

    return { processedContent, diagrams };
  };

  const timestamp = new Date(message.timestamp).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleCopyText = async () => {
    try {
      await navigator.clipboard.writeText(message.content || '');
      setIsCopied(true);
      toast({
        title: "Скопировано!",
        description: "Текст сообщения скопирован в буфер обмена",
        duration: 2000,
      });
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      toast({
        title: "Ошибка",
        description: "Не удалось скопировать текст",
        variant: "destructive",
      });
    }
  };

  const renderContent = () => {
    switch (message.type) {
      case 'image':
        return (
          <>
            {message.fileUrl && (
              <img
                src={message.fileUrl}
                alt="Uploaded image"
                className="rounded-lg mb-2 w-full max-w-sm"
              />
            )}
            {message.content && <p className="message-text">{message.content}</p>}
          </>
        );

      case 'audio':
        return (
          <div className="flex flex-col space-y-2">
            {message.fileUrl && (
              <audio controls className="max-w-xs">
                <source src={message.fileUrl} type="audio/webm" />
                <source src={message.fileUrl} type="audio/mp3" />
                <source src={message.fileUrl} type="audio/wav" />
                Ваш браузер не поддерживает аудио элемент.
              </audio>
            )}
            {!message.fileUrl && (
              <div className="flex items-center space-x-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className={`w-10 h-10 rounded-full flex items-center justify-center hover:bg-opacity-30 ${isUser ? 'bg-white bg-opacity-20' : 'bg-gray-200'
                    }`}
                >
                  <Play className="text-sm" />
                </Button>
                <div className="flex-1">
                  <div className="flex items-center space-x-1 mb-1">
                    <div className={`h-1 rounded-full flex-1 ${isUser ? 'bg-white bg-opacity-40' : 'bg-gray-300'
                      }`}></div>
                    <div className={`h-2 rounded-full flex-1 ${isUser ? 'bg-white bg-opacity-60' : 'bg-gray-400'
                      }`}></div>
                    <div className={`h-1.5 rounded-full flex-1 ${isUser ? 'bg-white bg-opacity-50' : 'bg-gray-350'
                      }`}></div>
                    <div className={`h-1 rounded-full flex-1 ${isUser ? 'bg-white bg-opacity-40' : 'bg-gray-300'
                      }`}></div>
                  </div>
                  <div className="text-xs opacity-75 message-text">
                    {message.fileName || 'Голосовое сообщение'}
                  </div>
                </div>
              </div>
            )}
            {/* Показываем транскрипцию, если она есть и отличается от дефолтного текста */}
            {message.content && message.content !== 'Голосовое сообщение' && (
              <div className={`text-sm mt-1 ${isUser ? 'text-white/90' : 'text-gray-700 dark:text-gray-300'}`}>
                <span className="opacity-70">📝 </span>
                <span className="whitespace-pre-wrap">{message.content}</span>
              </div>
            )}
          </div>
        );

      case 'document':
        return (
          <div className="flex items-center space-x-3 p-3 bg-gray-50 dark:bg-gray-600 rounded-lg">
            <FileText className="text-2xl text-green-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900 dark:text-gray-100 truncate message-text">
                {message.fileName || 'Документ'}
              </div>
              <div className="text-sm text-gray-500 dark:text-gray-400 message-text">
                {message.fileSize && `${(message.fileSize / 1024).toFixed(1)} KB`}
              </div>
            </div>
            {message.fileUrl && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => message.fileUrl && window.open(message.fileUrl, '_blank')}
                className="text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400"
              >
                <Download className="h-4 w-4" />
              </Button>
            )}
          </div>
        );

      default:
        return (
          <div className={isUser ? "text-white message-text" : "markdown text-gray-900 dark:text-gray-100"} style={{ fontSize: 'var(--chat-font-size)' }}>
            {isUser ? (
              <p className="whitespace-pre-wrap message-text">{message.content}</p>
            ) : (
              <div className="prose dark:prose-invert max-w-none" style={{ fontSize: 'var(--chat-font-size)' }}>
                {(() => {
                  const { processedContent, diagrams } = processContentWithDiagrams(message.content || '');

                  return (
                    <>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          p: ({ children }) => {
                            // Проверяем, содержит ли параграф плейсхолдер диаграммы
                            const text = children?.toString() || '';
                            const diagramPlaceholder = diagrams.find(d => text.includes(d.placeholder));

                            if (diagramPlaceholder) {
                              return <MermaidDiagram key={diagramPlaceholder.id} chart={diagramPlaceholder.chart} id={diagramPlaceholder.id} />;
                            }

                            return <p className="mb-2 last:mb-0" style={{ fontSize: 'inherit' }}>{children}</p>;
                          },
                          h1: ({ children }) => <h1 className="font-bold mb-2 text-gray-900 dark:text-gray-100" style={{ fontSize: 'calc(var(--chat-font-size) * 1.3)' }}>{children}</h1>,
                          h2: ({ children }) => <h2 className="font-bold mb-2 text-gray-900 dark:text-gray-100" style={{ fontSize: 'calc(var(--chat-font-size) * 1.2)' }}>{children}</h2>,
                          h3: ({ children }) => <h3 className="font-bold mb-1 text-gray-900 dark:text-gray-100" style={{ fontSize: 'calc(var(--chat-font-size) * 1.1)' }}>{children}</h3>,
                          ul: ({ children }) => <ul className="list-disc pl-4 mb-2" style={{ fontSize: 'inherit' }}>{children}</ul>,
                          ol: ({ children }) => <ol className="list-decimal pl-4 mb-2" style={{ fontSize: 'inherit' }}>{children}</ol>,
                          li: ({ children }) => <li className="mb-1" style={{ fontSize: 'inherit' }}>{children}</li>,
                          code: ({ children }) => <code className="bg-gray-100 dark:bg-gray-600 px-1 py-0.5 rounded text-gray-900 dark:text-gray-100" style={{ fontSize: 'calc(var(--chat-font-size) * 0.9)' }}>{children}</code>,
                          pre: ({ children }) => <pre className="bg-gray-100 dark:bg-gray-600 p-3 rounded mb-2 overflow-x-auto text-gray-900 dark:text-gray-100" style={{ fontSize: 'calc(var(--chat-font-size) * 0.9)' }}>{children}</pre>,
                          blockquote: ({ children }) => <blockquote className="border-l-4 border-gray-300 dark:border-gray-600 pl-4 italic mb-2" style={{ fontSize: 'inherit' }}>{children}</blockquote>,
                          strong: ({ children }) => <strong className="font-bold" style={{ fontSize: 'inherit' }}>{children}</strong>,
                          em: ({ children }) => <em className="italic" style={{ fontSize: 'inherit' }}>{children}</em>,
                        }}
                      >
                        {processedContent}
                      </ReactMarkdown>
                    </>
                  );
                })()}
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`message-bubble ${isUser ? 'message-bubble-user' : 'message-bubble-ai'} ${isUser
            ? 'bg-blue-600 dark:bg-blue-700 text-white rounded-2xl rounded-br-md shadow-md'
            : 'bg-white dark:bg-gray-700 rounded-2xl rounded-bl-md shadow-sm border border-gray-200 dark:border-gray-600'
          } px-4 py-3`}
      >
        {renderContent()}

        <div
          className={`flex items-center justify-between mt-2 text-xs ${isUser
              ? 'opacity-75 text-white'
              : 'text-gray-500 dark:text-gray-400'
            }`}
        >
          <div className="flex items-center">
            <span>{timestamp}</span>
            {isUser && <CheckCheck className="ml-1 h-3 w-3" />}
          </div>

          {message.content && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyText}
              className={`h-6 w-6 p-0 ml-2 transition-colors ${isUser
                  ? 'hover:bg-white/20 text-white/70 hover:text-white'
                  : 'hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
                }`}
            >
              {isCopied ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}