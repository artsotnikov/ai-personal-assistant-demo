import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import type { ProcessingStep } from '@shared/schema';
import { cn } from '@/lib/utils';

interface ProcessingStepDetailProps {
    step: ProcessingStep | null;
    open: boolean;
    onClose: () => void;
}

// Иконки по типам сущностей
const entityTypeIcons: Record<string, string> = {
    person: '👤',
    organization: '🏢',
    location: '📍',
    concept: '💡',
    artifact: '📦',
    event: '📅',
    other: '❓',
};

// Цвета по типам сущностей
const entityTypeColors: Record<string, string> = {
    person: 'text-blue-600 dark:text-blue-400',
    organization: 'text-purple-600 dark:text-purple-400',
    location: 'text-teal-600 dark:text-teal-400',
    concept: 'text-emerald-600 dark:text-emerald-400',
    artifact: 'text-orange-600 dark:text-orange-400',
    event: 'text-rose-600 dark:text-rose-400',
    other: 'text-gray-600 dark:text-gray-400',
};

/**
 * Рекурсивный рендер данных в читаемом формате
 */
function DataRenderer({ data, depth = 0 }: { data: any; depth?: number }) {
    if (data === null || data === undefined) {
        return <span className="text-gray-400 italic">нет данных</span>;
    }

    if (typeof data === 'string') {
        return <span className="text-gray-700 dark:text-gray-300">{data}</span>;
    }

    if (typeof data === 'number' || typeof data === 'boolean') {
        return <span className="text-blue-600 dark:text-blue-400 font-medium">{String(data)}</span>;
    }

    if (Array.isArray(data)) {
        if (data.length === 0) {
            return <span className="text-gray-400 italic">пусто</span>;
        }

        // Если массив строк — выводим списком
        if (data.every(item => typeof item === 'string')) {
            return (
                <ul className="list-disc list-inside space-y-1">
                    {data.map((item, i) => (
                        <li key={i} className="text-gray-700 dark:text-gray-300">{item}</li>
                    ))}
                </ul>
            );
        }

        // Если массив объектов — выводим карточками
        return (
            <div className="space-y-2">
                {data.map((item, i) => (
                    <div key={i} className="bg-gray-50 dark:bg-gray-800/50 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
                        <DataRenderer data={item} depth={depth + 1} />
                    </div>
                ))}
            </div>
        );
    }

    if (typeof data === 'object') {
        const entries = Object.entries(data);
        if (entries.length === 0) {
            return <span className="text-gray-400 italic">пусто</span>;
        }

        return (
            <div className={cn("space-y-3", depth > 0 && "pl-0")}>
                {entries.map(([key, value]) => (
                    <div key={key}>
                        <div className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-1 capitalize">
                            {key.replace(/_/g, ' ')}
                        </div>
                        <div className="ml-2">
                            <DataRenderer data={value} depth={depth + 1} />
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    return <span>{String(data)}</span>;
}

// Иконки категорий триплетов
const categoryIcons: Record<string, string> = {
    goals: '🎯',
    tools: '🔧',
    people: '👥',
    problems: '⚠️',
    fears: '😰',
    habits: '🔄',
    ownership: '🏠',
    influence: '📊',
    competition: '⚔️',
    other: '📌',
};

// Цвета важности
const importanceColors: Record<string, string> = {
    critical: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    high: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    normal: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    low: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

/**
 * Рендер триплетов Knowledge Graph v2
 */
function TripletRenderer({ triplets }: {
    triplets: Array<{ связь: string; тип: string; категория: string; важность: string }>;
}) {
    // Группируем по категории
    const byCategory = triplets.reduce((acc, t) => {
        const cat = t.категория || 'other';
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(t);
        return acc;
    }, {} as Record<string, typeof triplets>);

    return (
        <div className="space-y-3">
            {Object.entries(byCategory).map(([category, items]) => (
                <div key={category} className="rounded-lg bg-gray-50 dark:bg-gray-800/50 p-3 border border-gray-200 dark:border-gray-700">
                    {/* Category header */}
                    <div className="flex items-center gap-2 mb-2">
                        <span className="text-lg">{categoryIcons[category] || categoryIcons.other}</span>
                        <span className="font-medium text-gray-700 dark:text-gray-300 capitalize">{category}</span>
                        <Badge variant="outline" className="text-xs ml-auto">{items.length}</Badge>
                    </div>

                    {/* Triplets in this category */}
                    <div className="space-y-1 ml-6">
                        {items.map((t, idx) => (
                            <div key={idx} className="flex items-center gap-2 text-sm">
                                <span className="text-gray-600 dark:text-gray-400">{t.связь}</span>
                                <span className="text-xs text-gray-400 ml-auto font-mono">{t.тип}</span>
                                <Badge className={cn("text-xs", importanceColors[t.важность] || importanceColors.normal)}>
                                    {t.важность}
                                </Badge>
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

/**
 * Рендер бюджета токенов (Token Budget Optimization)
 */
function TokenBudgetRenderer({ budget }: { budget: any }) {
    if (!budget || !budget.sections) return null;

    const sections = Object.entries(budget.sections)
        .map(([key, value]: [string, any]) => ({ key, ...value }))
        .sort((a, b) => (b.used as number) - (a.used as number));

    return (
        <div className="space-y-6">
            {/* Общий бюджет */}
            <div className="bg-white dark:bg-gray-950 p-4 rounded-xl border border-gray-200 dark:border-gray-800 shadow-sm">
                <div className="flex justify-between items-end mb-2">
                    <div>
                        <div className="text-xs text-gray-500 uppercase tracking-wider font-semibold">Общий контекст</div>
                        <div className="text-xl font-bold text-gray-900 dark:text-gray-100 tabular-nums">
                            {budget.total_used.toLocaleString()} <span className="text-sm font-normal text-gray-500">/ {budget.total_budget.toLocaleString()}</span>
                        </div>
                    </div>
                    <div className={cn(
                        "text-lg font-bold tabular-nums",
                        budget.usage_percentage > 90 ? "text-red-500" :
                        budget.usage_percentage > 70 ? "text-amber-500" :
                        "text-emerald-500"
                    )}>
                        {budget.usage_percentage}%
                    </div>
                </div>
                <Progress
                    value={budget.usage_percentage}
                    className={cn(
                        "h-2 shadow-inner",
                        budget.usage_percentage > 90 ? "bg-red-100 dark:bg-red-900/30" :
                        budget.usage_percentage > 70 ? "bg-amber-100 dark:bg-amber-900/30" :
                        "bg-emerald-100 dark:bg-emerald-900/30"
                    )}
                />
            </div>

            {/* Секции */}
            <div className="space-y-3">
                <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest px-1">Распределение по секциям</h4>
                <div className="grid gap-2">
                    {sections.map((section: any) => (
                        <div key={section.key} className="group flex flex-col p-3 rounded-lg bg-gray-50 dark:bg-gray-800/40 border border-transparent hover:border-gray-200 dark:hover:border-gray-700 transition-all">
                            <div className="flex justify-between items-center mb-1.5">
                                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{section.label}</span>
                                <span className="text-xs text-gray-500 tabular-nums font-medium">
                                    {section.used.toLocaleString()} <span className="text-gray-400 font-normal">/ {section.allocated.toLocaleString()}</span>
                                </span>
                            </div>
                            <div className="flex items-center gap-3">
                                <div className="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-blue-500 dark:bg-blue-600 transition-all duration-500 rounded-full shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                                        style={{ width: `${Math.min(100, section.percentage)}%` }}
                                    />
                                </div>
                                <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400 w-6 text-right tabular-nums">
                                    {section.percentage}%
                                </span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>

            {/* Легенда */}
            <div className="text-[10px] text-gray-400 dark:text-gray-500 text-center uppercase tracking-tighter italic">
                Оптимизация проведена для предотвращения превышения лимита модели
            </div>
        </div>
    );
}

/**
 * Определяет тип данных и выбирает подходящий рендер
 */
function SmartDataRenderer({ data }: { data: any }) {


    // Проверяем, это ли данные триплетов Knowledge Graph v2
    const hasTriplets = data?.['триплеты'] && Array.isArray(data['триплеты']);

    // Проверяем, это ли данные бюджета токенов
    const isBudget = data?.total_budget && data?.sections;

    if (hasTriplets) {
        return <TripletRenderer triplets={data['триплеты']} />;
    }

    if (isBudget) {
        return <TokenBudgetRenderer budget={data} />;
    }

    // Иначе используем стандартный рендер
    return <DataRenderer data={data} />;
}

/**
 * Панель детального просмотра шага обработки
 */
export function ProcessingStepDetail({ step, open, onClose }: ProcessingStepDetailProps) {
    if (!step) return null;

    const statusColors = {
        pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
        running: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
        completed: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
        error: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
        skipped: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
    };

    const statusLabels = {
        pending: 'Ожидание',
        running: 'Выполняется',
        completed: 'Завершено',
        error: 'Ошибка',
        skipped: 'Пропущено',
    };

    return (
        <Sheet open={open} onOpenChange={onClose}>
            <SheetContent className="w-[400px] sm:w-[540px] overflow-y-auto">
                <SheetHeader className="pb-4 border-b dark:border-gray-700">
                    <SheetTitle className="flex items-center gap-3">
                        <span className="text-2xl">{step.stepIcon}</span>
                        <span>{step.stepName}</span>
                    </SheetTitle>
                </SheetHeader>

                <div className="py-6 space-y-6">
                    {/* Status & Duration */}
                    <div className="flex items-center gap-3 flex-wrap">
                        <Badge className={cn("font-medium", statusColors[step.status])}>
                            {statusLabels[step.status]}
                        </Badge>
                        {step.duration !== undefined && (
                            <span className="text-sm text-gray-500 dark:text-gray-400">
                                ⏱️ {step.duration}ms
                            </span>
                        )}
                        <span className="text-xs text-gray-400 dark:text-gray-500">
                            {new Date(step.timestamp).toLocaleTimeString('ru-RU')}
                        </span>
                    </div>

                    {/* Summary */}
                    {step.output?.summary && (
                        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-800">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="text-blue-600 dark:text-blue-400">📋</span>
                                <span className="text-sm font-medium text-blue-700 dark:text-blue-300">Результат</span>
                            </div>
                            <p className="text-sm text-blue-800 dark:text-blue-200">
                                {step.output.summary}
                            </p>
                        </div>
                    )}

                    {/* Detailed data — умный рендер */}
                    {step.output?.data && Object.keys(step.output.data).length > 0 && (
                        <div>
                            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-2">
                                <span>📊</span>
                                Детальная информация
                            </h4>
                            <div className="bg-gray-50 dark:bg-gray-800/30 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                                <SmartDataRenderer data={step.output.data} />
                            </div>
                        </div>
                    )}

                    {/* Error */}
                    {step.error && (
                        <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded-lg border border-red-200 dark:border-red-800">
                            <h4 className="text-sm font-medium text-red-600 dark:text-red-400 mb-2">
                                ⚠️ Ошибка
                            </h4>
                            <p className="text-sm text-red-500 dark:text-red-400 font-mono break-all">
                                {step.error}
                            </p>
                        </div>
                    )}

                    {/* Empty state */}
                    {!step.output?.summary && !step.output?.data && !step.error && (
                        <p className="text-sm text-gray-400 dark:text-gray-500 italic text-center py-4">
                            Нет дополнительной информации
                        </p>
                    )}
                </div>
            </SheetContent>
        </Sheet>
    );
}
