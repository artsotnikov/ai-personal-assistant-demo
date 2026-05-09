import { useState, useEffect, useMemo } from 'react';
import { ChevronDown, ChevronUp, Loader2, Check, Wrench } from 'lucide-react';
import type { ProcessingStep } from '@shared/schema';
import { ProcessingStepItem } from './ProcessingStepItem';
import { ReasoningChain } from './ReasoningChain';
import { cn } from '@/lib/utils';

interface ProcessingTimelineProps {
    messageId: number;
    steps: ProcessingStep[];
    onStepClick: (step: ProcessingStep) => void;
}

/**
 * Timeline обработки сообщения — сворачиваемый список шагов
 * Группирует orchestrator-шаги и tool calls отдельно
 */
export function ProcessingTimeline({ messageId, steps, onStepClick }: ProcessingTimelineProps) {
    const [isExpanded, setIsExpanded] = useState(true);
    const [autoCollapsed, setAutoCollapsed] = useState(false);
    const [toolsExpanded, setToolsExpanded] = useState(true);

    // Разделяем orchestrator шаги, reasoning chain (по фазам) и legacy tool calls
    const { orchestratorSteps, reflectionSteps, responseSteps, toolCallSteps } = useMemo(() => {
        const orchestratorSteps: ProcessingStep[] = [];
        const reflectionSteps: ProcessingStep[] = [];
        const responseSteps: ProcessingStep[] = [];
        const toolCallSteps: ProcessingStep[] = [];
        for (const step of steps) {
            // Reasoning chain steps (с kind в output)
            if (step.output?.kind === 'thinking' || step.output?.kind === 'tool_call' || step.output?.kind === 'model_cascade' || step.output?.kind === 'response_phase') {
                if (step.output?.phase === 'reflection') {
                    reflectionSteps.push(step);
                } else {
                    responseSteps.push(step);
                }
            } else if (
                step.stepId.startsWith('thinking_') || step.stepId.startsWith('reflection_thinking_') || step.stepId.startsWith('response_thinking_') ||
                step.stepId === 'response_phase' ||
                step.stepId.startsWith('reflection_tool_') || step.stepId.startsWith('response_tool_') ||
                (step.stepId.startsWith('tool_') && step.output?.toolOutput)
            ) {
                // Также определяем по stepId для running статусов (когда output ещё нет)
                // Шаги с phase prefix маршрутизируются по prefix
                if (step.output?.phase === 'reflection' || step.stepId.startsWith('reflection_')) {
                    reflectionSteps.push(step);
                } else {
                    responseSteps.push(step);
                }
            } else if (step.stepId.startsWith('tool_')) {
                // Legacy tool calls (без reasoning chain fields) — backward compat
                toolCallSteps.push(step);
            } else {
                orchestratorSteps.push(step);
            }
        }
        return { orchestratorSteps, reflectionSteps, responseSteps, toolCallSteps };
    }, [steps]);
    // Подсчёт статусов
    const completedCount = steps.filter(s => s.status === 'completed').length;
    const errorCount = steps.filter(s => s.status === 'error').length;
    const runningCount = steps.filter(s => s.status === 'running').length;
    const totalCount = steps.length;
    const isComplete = runningCount === 0 && totalCount > 0;
    const hasErrors = errorCount > 0;

    // Tool calls статистика
    const toolsRunning = toolCallSteps.filter(s => s.status === 'running').length;
    const toolsCompleted = toolCallSteps.filter(s => s.status === 'completed').length;
    const toolsErrors = toolCallSteps.filter(s => s.status === 'error').length;
    const toolsDuration = toolCallSteps.reduce((sum, s) => sum + (s.duration || 0), 0);

    // Автосворачивание через 2 секунды после завершения
    useEffect(() => {
        if (isComplete && !autoCollapsed && !hasErrors) {
            const timer = setTimeout(() => {
                setIsExpanded(false);
                setAutoCollapsed(true);
            }, 2000);
            return () => clearTimeout(timer);
        }
    }, [isComplete, autoCollapsed, hasErrors]);

    // Общее время выполнения
    const totalDuration = steps.reduce((sum, s) => sum + (s.duration || 0), 0);

    if (steps.length === 0) return null;

    return (
        <div className={cn(
            "processing-timeline my-2 mx-1 rounded-lg border transition-all duration-200",
            hasErrors
                ? "bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800/50"
                : isComplete
                    ? "bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800/50"
                    : "bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800/50"
        )}>
            {/* Header - clickable to collapse/expand */}
            <div
                onClick={() => setIsExpanded(!isExpanded)}
                className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none"
            >
                {/* Status icon */}
                {!isComplete ? (
                    <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
                ) : hasErrors ? (
                    <span className="text-sm">⚠️</span>
                ) : (
                    <Check className="w-4 h-4 text-green-500" />
                )}

                {/* Title */}
                <span className={cn(
                    "flex-1 text-sm font-medium",
                    hasErrors
                        ? "text-red-700 dark:text-red-400"
                        : isComplete
                            ? "text-green-700 dark:text-green-400"
                            : "text-blue-700 dark:text-blue-400"
                )}>
                    {!isComplete ? 'Обработка...' : hasErrors ? 'Ошибка обработки' : 'Обработано'}
                </span>

                {/* Progress counter */}
                <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                    {completedCount}/{totalCount}
                </span>

                {/* Total duration */}
                {isComplete && totalDuration > 0 && (
                    <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                        {(totalDuration / 1000).toFixed(2)}с
                    </span>
                )}

                {/* Expand/collapse icon */}
                {isExpanded ? (
                    <ChevronUp className="w-4 h-4 text-gray-400" />
                ) : (
                    <ChevronDown className="w-4 h-4 text-gray-400" />
                )}
            </div>

            {/* Steps list */}
            {isExpanded && (
                <div className="px-2 pb-2 space-y-0.5">
                    {/* Orchestrator steps с inline reasoning chains */}
                    {orchestratorSteps.map(step => (
                        <div key={step.stepId}>
                            <ProcessingStepItem
                                step={step}
                                onClick={() => onStepClick(step)}
                            />

                            {/* Reasoning Chain: Рефлексия — после шага reflection */}
                            {step.stepId === 'reflection' && reflectionSteps.length > 0 && (
                                <ReasoningChain
                                    steps={reflectionSteps}
                                    onStepClick={onStepClick}
                                    phaseLabel="Мышление: Рефлексия"
                                    phaseIcon="🤔"
                                />
                            )}

                            {/* Reasoning Chain: Генерация ответа — после шага response */}
                            {step.stepId === 'response' && responseSteps.length > 0 && (
                                <ReasoningChain
                                    steps={responseSteps}
                                    onStepClick={onStepClick}
                                    phaseLabel="Мышление: Генерация"
                                    phaseIcon="🧠"
                                />
                            )}
                        </div>
                    ))}

                    {/* Tool calls group */}
                    {toolCallSteps.length > 0 && (
                        <div className="mt-1">
                            {/* Tool calls header */}
                            <div
                                onClick={() => setToolsExpanded(!toolsExpanded)}
                                className="flex items-center gap-2 py-1 px-2 rounded-md cursor-pointer select-none hover:bg-gray-100/50 dark:hover:bg-gray-700/30"
                            >
                                <Wrench className="w-3.5 h-3.5 text-amber-500" />
                                <span className="text-xs font-medium text-amber-700 dark:text-amber-400 flex-1">
                                    Инструменты AI
                                </span>
                                <span className="text-xs text-gray-400 tabular-nums">
                                    {toolsCompleted + toolsErrors}/{toolCallSteps.length}
                                </span>
                                {toolsRunning > 0 && (
                                    <Loader2 className="w-3 h-3 animate-spin text-blue-500" />
                                )}
                                {toolsDuration > 0 && toolsRunning === 0 && (
                                    <span className="text-xs text-gray-400 tabular-nums">
                                        {(toolsDuration / 1000).toFixed(2)}с
                                    </span>
                                )}
                                {toolsExpanded ? (
                                    <ChevronUp className="w-3 h-3 text-gray-400" />
                                ) : (
                                    <ChevronDown className="w-3 h-3 text-gray-400" />
                                )}
                            </div>

                            {/* Tool call items */}
                            {toolsExpanded && (
                                <div className="ml-3 pl-2 border-l-2 border-amber-200 dark:border-amber-800/50 space-y-0.5">
                                    {toolCallSteps.map(step => (
                                        <ProcessingStepItem
                                            key={step.stepId}
                                            step={step}
                                            onClick={() => onStepClick(step)}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
