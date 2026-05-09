import { useEffect, useRef, useState } from 'react';

interface MermaidDiagramProps {
  chart: string;
  id: string;
}

export default function MermaidDiagram({ chart, id }: MermaidDiagramProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadAndRenderMermaid = async () => {
      try {
        setIsLoading(true);
        setError(null);

        // Проверяем доступность Mermaid и импортируем
        const mermaidModule = await import('mermaid');
        const mermaid = mermaidModule.default || mermaidModule;

        if (!mounted) return;

        // Инициализируем Mermaid
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
          securityLevel: 'loose',
          flowchart: {
            htmlLabels: true,
            useMaxWidth: true,
          },
        });

        if (!ref.current || !mounted) return;

        // Очищаем предыдущий контент
        ref.current.innerHTML = '';
        
        // Рендерим диаграмму
        const { svg } = await mermaid.render(`mermaid-${id}`, chart);
        
        if (!mounted || !ref.current) return;
        
        ref.current.innerHTML = svg;
        
        // Настраиваем стили SVG
        const svgElement = ref.current.querySelector('svg');
        if (svgElement) {
          svgElement.style.maxWidth = '100%';
          svgElement.style.height = 'auto';
        }
        
        setIsLoading(false);
      } catch (error) {
        console.error('Ошибка рендеринга Mermaid диаграммы:', error);
        if (mounted) {
          setError(error instanceof Error ? error.message : 'Неизвестная ошибка');
          setIsLoading(false);
        }
      }
    };

    loadAndRenderMermaid();

    return () => {
      mounted = false;
    };
  }, [chart, id]);

  if (isLoading) {
    return (
      <div className="mermaid-diagram my-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600">
        <div className="flex items-center justify-center py-8">
          <div className="text-gray-500 dark:text-gray-400 text-sm">
            Загрузка диаграммы...
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mermaid-diagram my-4 p-4 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800">
        <p className="text-red-600 dark:text-red-400 text-sm mb-2">
          Ошибка отображения диаграммы: {error}
        </p>
        <details className="mt-2">
          <summary className="text-xs text-red-500 cursor-pointer">Показать исходный код</summary>
          <pre className="mt-2 text-xs bg-red-100 dark:bg-red-900/40 p-2 rounded overflow-x-auto text-red-800 dark:text-red-200">
            {chart}
          </pre>
        </details>
      </div>
    );
  }

  return (
    <div 
      ref={ref} 
      className="mermaid-diagram my-4 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 overflow-x-auto"
      style={{ fontSize: 'var(--chat-font-size)' }}
    />
  );
}