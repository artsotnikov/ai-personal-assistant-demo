import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, MessageSquare, Wrench, Loader2, Check, X } from 'lucide-react';
import type { ProcessingStep } from '@shared/schema';
import { cn } from '@/lib/utils';
import { TOOL_ICONS } from '@shared/schema';

/** Форматирует ms → секунды (например 250 → "0.25с") */
function formatDuration(ms: number): string {
    return `${(ms / 1000).toFixed(2)}с`;
}

interface ReasoningChainProps {
    steps: ProcessingStep[];
    onStepClick?: (step: ProcessingStep) => void;
    phaseLabel?: string;   // "Мышление: Рефлексия" / "Мышление: Генерация"
    phaseIcon?: string;    // "🤔" / "🧠"
}

/**
 * Группа шагов одной итерации ReAct Loop
 */
interface IterationGroup {
    iteration: number;
    thinking?: ProcessingStep;
    toolCalls: ProcessingStep[];
    isRunning: boolean;
    totalDuration: number;
}

/**
 * ReasoningChain — Accordion-визуализация цепочки мышлений AI
 * 
 * Отображает каждую итерацию ReAct Loop с:
 * - 💭 Thinking text (дословное размышление)
 * - 🔧 Tool calls (input + полный output)
 * 
 * Каждая секция имеет фиксированную высоту (max-h-48) со scroll внутри.
 */
export function ReasoningChain({ steps, onStepClick, phaseLabel, phaseIcon }: ReasoningChainProps) {
    const [expandedIteration, setExpandedIteration] = useState<number | null>(null);
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
    const [isFullyExpanded, setIsFullyExpanded] = useState(true);

    // Группируем шаги по итерациям
    const iterations = useMemo(() => {
        const groups: Map<number, IterationGroup> = new Map();
        // Также отслеживаем «финальное» мышление и model cascade / response phase
        let finalThinking: ProcessingStep | null = null;
        let responsePhaseStep: ProcessingStep | null = null;
        let modelCascadeStep: ProcessingStep | null = null;

        for (const step of steps) {
            const kind = step.output?.kind;
            const iteration = step.output?.iteration || 0;

            if (step.stepId === 'thinking_final' || step.stepId.endsWith('_thinking_final')) {
                finalThinking = step;
                continue;
            }

            // Response Phase / Model Cascade — финальные шаги
            if (kind === 'response_phase') {
                responsePhaseStep = step;
                continue;
            }
            if (kind === 'model_cascade') {
                modelCascadeStep = step;
                continue;
            }

            if (!kind) continue;

            if (!groups.has(iteration)) {
                groups.set(iteration, {
                    iteration,
                    toolCalls: [],
                    isRunning: false,
                    totalDuration: 0,
                });
            }

            const group = groups.get(iteration)!;

            if (kind === 'thinking') {
                group.thinking = step;
            } else if (kind === 'tool_call') {
                group.toolCalls.push(step);
                if (step.duration) group.totalDuration += step.duration;
            }

            if (step.status === 'running') {
                group.isRunning = true;
                // Auto-expand running iteration
                if (expandedIteration === null) {
                    setExpandedIteration(iteration);
                }
            }
        }

        // Добавляем финальное мышление как отдельную «итерацию»
        if (finalThinking) {
            const finalIter = (finalThinking.output?.iteration || 0) + 100; // big number to sort last
            groups.set(finalIter, {
                iteration: finalIter,
                thinking: finalThinking,
                toolCalls: [],
                isRunning: false,
                totalDuration: 0,
            });
        }

        // Добавляем Response Phase как финальную итерацию
        if (responsePhaseStep) {
            groups.set(200, {
                iteration: 200,
                thinking: responsePhaseStep,
                toolCalls: [],
                isRunning: responsePhaseStep.status === 'running',
                totalDuration: 0,
            });
        }

        // Добавляем Model Cascade как финальную итерацию (если нет Response Phase)
        if (modelCascadeStep && !responsePhaseStep) {
            groups.set(201, {
                iteration: 201,
                thinking: modelCascadeStep,
                toolCalls: [],
                isRunning: modelCascadeStep.status === 'running',
                totalDuration: 0,
            });
        }

        return Array.from(groups.values()).sort((a, b) => a.iteration - b.iteration);
    }, [steps]);

    // Статистика
    const totalToolCalls = iterations.reduce((sum, g) => sum + g.toolCalls.length, 0);
    const totalDuration = steps.reduce((sum, s) => sum + (s.duration || 0), 0);
    const isRunning = iterations.some(g => g.isRunning);
    const hasErrors = steps.some(s => s.status === 'error');
    const iterationCount = iterations.filter(g => g.iteration < 100).length; // exclude final

    const toggleIteration = (iteration: number) => {
        setExpandedIteration(prev => prev === iteration ? null : iteration);
    };

    const toggleSection = (key: string) => {
        setExpandedSections(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    if (iterations.length === 0) return null;

    return (
        <div className={cn(
            "reasoning-chain my-2 mx-1 rounded-lg border transition-all duration-200",
            hasErrors
                ? "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/50"
                : isRunning
                    ? "bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800/50"
                    : "bg-violet-50 dark:bg-violet-900/10 border-violet-200 dark:border-violet-800/50"
        )}>
            {/* Header */}
            <div
                onClick={() => setIsFullyExpanded(!isFullyExpanded)}
                className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
            >
                {isRunning ? (
                    <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                ) : hasErrors ? (
                    <span className="text-sm">⚠️</span>
                ) : (
                    <span className="text-sm">{phaseIcon || '💭'}</span>
                )}

                <span className={cn(
                    "flex-1 text-sm font-medium",
                    hasErrors
                        ? "text-red-700 dark:text-red-400"
                        : isRunning
                            ? "text-blue-700 dark:text-blue-400"
                            : "text-violet-700 dark:text-violet-400"
                )}>
                    {isRunning ? 'AI размышляет...' : (phaseLabel || 'Мышление AI')}
                </span>

                {/* Summary badges */}
                {iterationCount > 0 && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                        {iterationCount} итер.
                    </span>
                )}
                {totalToolCalls > 0 && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                        {totalToolCalls} инстр.
                    </span>
                )}
                {!isRunning && totalDuration > 0 && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                        {formatDuration(totalDuration)}
                    </span>
                )}

                {isFullyExpanded ? (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                ) : (
                    <ChevronRight className="w-4 h-4 text-gray-400" />
                )}
            </div>

            {/* Iterations accordion */}
            {isFullyExpanded && (
                <div className="px-2 pb-2 space-y-1">
                    {iterations.map((group) => {
                        const isFinal = group.iteration >= 100 && group.iteration < 200;
                        const isResponsePhase = group.iteration === 200;
                        const isModelCascade = group.iteration === 201;
                        const label = isResponsePhase
                            ? `📝 Формулировка ответа${group.thinking?.output?.data?.responseModel ? ` (${group.thinking.output.data.responseModel})` : ''}`
                            : isModelCascade
                                ? `🏆 Финальный ответ${group.thinking?.output?.data?.finalModel ? ` (${group.thinking.output.data.finalModel})` : ''}`
                                : isFinal
                                    ? '📝 Формирование ответа'
                                    : `Итерация ${group.iteration}`;
                        const isExpanded = expandedIteration === group.iteration;

                        return (
                            <div key={group.iteration} className="rounded-md border border-gray-200 dark:border-gray-700/50 overflow-hidden">
                                {/* Iteration header */}
                                <div
                                    onClick={() => toggleIteration(group.iteration)}
                                    className={cn(
                                        "flex items-center gap-2 px-3 py-1.5 cursor-pointer select-none transition-colors",
                                        isExpanded
                                            ? "bg-gray-100 dark:bg-gray-800/50"
                                            : "hover:bg-gray-50 dark:hover:bg-gray-800/30"
                                    )}
                                >
                                    {isExpanded ? (
                                        <ChevronDown className="w-3.5 h-3.5 text-gray-400" />
                                    ) : (
                                        <ChevronRight className="w-3.5 h-3.5 text-gray-400" />
                                    )}

                                    <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">
                                        {label}
                                    </span>

                                    {/* Tool count */}
                                    {group.toolCalls.length > 0 && (
                                        <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-full">
                                            {group.toolCalls.length} 🔧
                                        </span>
                                    )}

                                    {/* Status */}
                                    {group.isRunning ? (
                                        <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500" />
                                    ) : group.toolCalls.some(tc => tc.status === 'error') ? (
                                        <X className="w-3.5 h-3.5 text-red-500" />
                                    ) : (
                                        <Check className="w-3.5 h-3.5 text-green-500" />
                                    )}

                                    {/* Duration */}
                                    {group.totalDuration > 0 && !group.isRunning && (
                                        <span className="text-xs text-gray-400 tabular-nums">
                                            {formatDuration(group.totalDuration)}
                                        </span>
                                    )}
                                </div>

                                {/* Iteration body */}
                                {isExpanded && (
                                    <div className="border-t border-gray-200 dark:border-gray-700/50 divide-y divide-gray-100 dark:divide-gray-800/50">
                                        {/* Thinking section */}
                                        {group.thinking && group.thinking.output?.thinking && (
                                            <ThinkingSection
                                                step={group.thinking}
                                                sectionKey={`thinking-${group.iteration}`}
                                                isExpanded={expandedSections.has(`thinking-${group.iteration}`)}
                                                onToggle={() => toggleSection(`thinking-${group.iteration}`)}
                                            />
                                        )}

                                        {/* Tool call sections */}
                                        {group.toolCalls.map((toolStep, idx) => (
                                            <ToolCallSection
                                                key={toolStep.stepId}
                                                step={toolStep}
                                                sectionKey={`tool-${group.iteration}-${idx}`}
                                                isExpanded={expandedSections.has(`tool-${group.iteration}-${idx}`)}
                                                onToggle={() => toggleSection(`tool-${group.iteration}-${idx}`)}
                                                onClick={onStepClick ? () => onStepClick(toolStep) : undefined}
                                            />
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

/**
 * Секция «Размышление» — текст мышления AI
 */
function ThinkingSection({ step, sectionKey, isExpanded, onToggle }: {
    step: ProcessingStep;
    sectionKey: string;
    isExpanded: boolean;
    onToggle: () => void;
}) {
    const thinking = step.output?.thinking || '';

    return (
        <div className="p-2">
            <div
                onClick={onToggle}
                className="flex items-center gap-2 py-1 px-2 rounded cursor-pointer select-none hover:bg-violet-50 dark:hover:bg-violet-900/20"
            >
                <MessageSquare className="w-3.5 h-3.5 text-violet-500" />
                <span className="text-xs font-medium text-violet-700 dark:text-violet-400 flex-1">
                    Размышление
                </span>
                {isExpanded ? (
                    <ChevronDown className="w-3 h-3 text-gray-400" />
                ) : (
                    <ChevronRight className="w-3 h-3 text-gray-400" />
                )}
            </div>

            {isExpanded && (
                <div className="mt-1 mx-2 max-h-48 overflow-y-auto rounded-md bg-violet-50/50 dark:bg-violet-900/10 border border-violet-200/50 dark:border-violet-800/30 p-3">
                    <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
                        {thinking}
                    </p>
                </div>
            )}
        </div>
    );
}

/**
 * Секция Tool Call — input и output инструмента
 */
function ToolCallSection({ step, sectionKey, isExpanded, onToggle, onClick }: {
    step: ProcessingStep;
    sectionKey: string;
    isExpanded: boolean;
    onToggle: () => void;
    onClick?: () => void;
}) {
    const toolName = step.stepName;
    const toolIcon = step.stepIcon;
    const toolInput = step.output?.toolInput;
    const toolOutput = step.output?.toolOutput;
    const isError = step.status === 'error';
    const isRunning = step.status === 'running';

    return (
        <div className="p-2">
            <div
                onClick={onToggle}
                className="flex items-center gap-2 py-1 px-2 rounded cursor-pointer select-none hover:bg-amber-50 dark:hover:bg-amber-900/20"
            >
                <span className="text-sm">{toolIcon}</span>
                <span className={cn(
                    "text-xs font-medium flex-1 font-mono",
                    isError
                        ? "text-red-600 dark:text-red-400"
                        : "text-amber-700 dark:text-amber-400"
                )}>
                    {toolName}
                </span>

                {/* Status */}
                {isRunning ? (
                    <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                ) : isError ? (
                    <X className="w-3 h-3 text-red-500" />
                ) : (
                    <Check className="w-3 h-3 text-green-500" />
                )}

                {step.duration && !isRunning && (
                    <span className="text-xs text-gray-400 tabular-nums">{formatDuration(step.duration)}</span>
                )}

                {isExpanded ? (
                    <ChevronDown className="w-3 h-3 text-gray-400" />
                ) : (
                    <ChevronRight className="w-3 h-3 text-gray-400" />
                )}
            </div>

            {isExpanded && (
                <div className="mt-1 mx-2 space-y-2">
                    {/* Input */}
                    {toolInput && Object.keys(toolInput).length > 0 && (
                        <div className="max-h-32 overflow-y-auto rounded-md bg-blue-50/50 dark:bg-blue-900/10 border border-blue-200/50 dark:border-blue-800/30 p-2">
                            <div className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">
                                Входные данные:
                            </div>
                            <pre className="text-xs text-gray-600 dark:text-gray-400 whitespace-pre-wrap font-mono">
                                {JSON.stringify(toolInput, null, 2)}
                            </pre>
                        </div>
                    )}

                    {/* Output / Error */}
                    {isError && step.error && (
                        <div className="max-h-32 overflow-y-auto rounded-md bg-red-50/50 dark:bg-red-900/10 border border-red-200/50 dark:border-red-800/30 p-2">
                            <div className="text-xs font-medium text-red-600 dark:text-red-400 mb-1">
                                Ошибка:
                            </div>
                            <p className="text-xs text-red-500 dark:text-red-400 font-mono">
                                {step.error}
                            </p>
                        </div>
                    )}

                    {!isError && toolOutput && (
                        <div className="max-h-48 overflow-y-auto rounded-md bg-green-50/50 dark:bg-green-900/10 border border-green-200/50 dark:border-green-800/30 p-2">
                            <div className="text-xs font-medium text-green-600 dark:text-green-400 mb-1">
                                Результат:
                            </div>
                            <p className="text-xs text-gray-700 dark:text-gray-300 whitespace-pre-wrap leading-relaxed">
                                {toolOutput}
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
