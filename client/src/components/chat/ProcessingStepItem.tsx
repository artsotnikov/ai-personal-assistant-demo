import { Check, X, Loader2, ChevronRight } from 'lucide-react';
import type { ProcessingStep } from '@shared/schema';
import { cn } from '@/lib/utils';

interface ProcessingStepItemProps {
    step: ProcessingStep;
    onClick: () => void;
}

/**
 * Отдельный шаг в Timeline обработки
 */
export function ProcessingStepItem({ step, onClick }: ProcessingStepItemProps) {
    const isClickable = step.status === 'completed' || step.status === 'error';

    return (
        <div
            onClick={isClickable ? onClick : undefined}
            className={cn(
                "flex items-center gap-2 py-1.5 px-2 rounded-md transition-colors",
                isClickable && "cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/50",
                !isClickable && "opacity-75"
            )}
        >
            {/* Icon */}
            <span className="w-5 text-center text-sm">{step.stepIcon}</span>

            {/* Name */}
            <span className="flex-1 text-sm text-gray-700 dark:text-gray-300">
                {step.stepName}
            </span>

            {/* Status indicator */}
            {step.status === 'pending' && (
                <div className="w-4 h-4 rounded-full border-2 border-gray-300 dark:border-gray-600" />
            )}
            {step.status === 'running' && (
                <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
            )}
            {step.status === 'completed' && (
                <Check className="w-4 h-4 text-green-500" />
            )}
            {step.status === 'error' && (
                <X className="w-4 h-4 text-red-500" />
            )}
            {step.status === 'skipped' && (
                <div className="w-4 h-4 rounded-full bg-gray-300 dark:bg-gray-600" />
            )}

            {/* Duration */}
            {step.duration !== undefined && step.status !== 'running' && (
                <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums min-w-[40px] text-right">
                    {(step.duration / 1000).toFixed(2)}с
                </span>
            )}

            {/* Summary preview - only for completed steps */}
            {step.output?.summary && step.status === 'completed' && (
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[120px] hidden sm:inline">
                    {step.output.summary}
                </span>
            )}

            {/* Arrow for clickable items */}
            {isClickable && (
                <ChevronRight className="w-4 h-4 text-gray-400 dark:text-gray-500" />
            )}
        </div>
    );
}
