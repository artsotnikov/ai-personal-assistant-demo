import { useState, useEffect } from "react";
import { Link } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
    Calendar, Plus, Trash2, Clock, Play, Pause, X,
    RefreshCw, Timer, Zap, CalendarClock, FileText, ChevronDown, ChevronUp,
    CheckCircle2, XCircle, AlertTriangle, Bot
} from "lucide-react";

interface ScheduledTask {
    id: number;
    title: string;
    prompt: string;
    cronExpression: string;
    timezone: string;
    status: string; // active | paused | cancelled | error_paused
    lastRunAt: string | null;
    nextRunAt: string | null;
    runCount: number;
    maxRuns: number | null;
    createdByAi: boolean;
    metadata: Record<string, any> | null;
    // Backoff fields (Этап 2 OpenClaw)
    consecutiveErrors: number;
    lastErrorAt: string | null;
    backoffUntil: string | null;
    createdAt: string;
    updatedAt: string;
}

interface ExecutionLog {
    id: number;
    taskId: number;
    status: string; // success | error | timeout
    response: string | null;
    agentUsed: string | null;
    agentName: string | null;
    tokensUsed: number;
    toolCalls: Array<{ toolName: string; success: boolean; durationMs: number }> | null;
    durationMs: number | null;
    error: string | null;
    executedAt: string;
}

export default function ScheduledTasksPage() {
    const [tasks, setTasks] = useState<ScheduledTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [runningTask, setRunningTask] = useState<number | null>(null);

    // Log viewer state
    const [expandedLogTask, setExpandedLogTask] = useState<number | null>(null);
    const [logs, setLogs] = useState<ExecutionLog[]>([]);
    const [logsLoading, setLogsLoading] = useState(false);
    const [expandedLogEntry, setExpandedLogEntry] = useState<number | null>(null);

    // Form state
    const [title, setTitle] = useState("");
    const [prompt, setPrompt] = useState("");
    const [cronExpression, setCronExpression] = useState("0 9 * * *");
    const [maxRuns, setMaxRuns] = useState("");

    // Visual Cron Builder State
    const [cronMode, setCronMode] = useState<"preset" | "hourly" | "daily" | "weekly" | "monthly" | "custom">("preset");
    const [cronMinute, setCronMinute] = useState("0");
    const [cronHour, setCronHour] = useState("9");
    const [cronDayOfWeek, setCronDayOfWeek] = useState("1");
    const [cronDayOfMonth, setCronDayOfMonth] = useState("1");

    useEffect(() => {
        if (cronMode === "hourly") setCronExpression(`${cronMinute} * * * *`);
        else if (cronMode === "daily") setCronExpression(`${cronMinute} ${cronHour} * * *`);
        else if (cronMode === "weekly") setCronExpression(`${cronMinute} ${cronHour} * * ${cronDayOfWeek}`);
        else if (cronMode === "monthly") setCronExpression(`${cronMinute} ${cronHour} ${cronDayOfMonth} * *`);
    }, [cronMode, cronMinute, cronHour, cronDayOfWeek, cronDayOfMonth]);

    useEffect(() => {
        fetchTasks();
    }, []);

    const fetchTasks = async () => {
        try {
            const res = await fetch("/api/scheduled-tasks");
            const data = await res.json();
            setTasks(data);
        } catch (error) {
            console.error("Error fetching tasks:", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchLogs = async (taskId: number) => {
        setLogsLoading(true);
        try {
            const res = await fetch(`/api/scheduled-tasks/${taskId}/logs?limit=20`);
            const data = await res.json();
            setLogs(data);
        } catch (error) {
            console.error("Error fetching logs:", error);
            setLogs([]);
        } finally {
            setLogsLoading(false);
        }
    };

    const toggleLogs = (taskId: number) => {
        if (expandedLogTask === taskId) {
            setExpandedLogTask(null);
            setLogs([]);
            setExpandedLogEntry(null);
        } else {
            setExpandedLogTask(taskId);
            setExpandedLogEntry(null);
            fetchLogs(taskId);
        }
    };

    const handleCreate = async () => {
        if (!title.trim() || !prompt.trim() || !cronExpression.trim()) return;

        try {
            const res = await fetch("/api/scheduled-tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title,
                    prompt,
                    cronExpression,
                    maxRuns: maxRuns ? parseInt(maxRuns) : undefined,
                }),
            });

            if (res.ok) {
                setTitle("");
                setPrompt("");
                setCronExpression("0 9 * * *");
                setCronMode("preset");
                setMaxRuns("");
                setShowForm(false);
                fetchTasks();
            } else {
                const err = await res.json();
                alert(err.message || "Ошибка создания");
            }
        } catch (error) {
            console.error("Error creating task:", error);
        }
    };

    const handleStatusChange = async (id: number, status: string) => {
        try {
            await fetch(`/api/scheduled-tasks/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status }),
            });
            fetchTasks();
        } catch (error) {
            console.error("Error updating task:", error);
        }
    };

    const handleDelete = async (id: number) => {
        if (!confirm("Удалить задачу?")) return;
        try {
            await fetch(`/api/scheduled-tasks/${id}`, { method: "DELETE" });
            fetchTasks();
        } catch (error) {
            console.error("Error deleting task:", error);
        }
    };

    const handleForceRun = async (id: number) => {
        setRunningTask(id);
        try {
            await fetch(`/api/scheduled-tasks/${id}/run`, { method: "POST" });
            fetchTasks();
            // Refresh logs if this task's logs are open
            if (expandedLogTask === id) {
                setTimeout(() => fetchLogs(id), 1000);
            }
        } catch (error) {
            console.error("Error running task:", error);
        } finally {
            setRunningTask(null);
        }
    };

    const activeTasks = tasks.filter(t => t.status === "active");
    const pausedTasks = tasks.filter(t => t.status === "paused");
    const errorPausedTasks = tasks.filter(t => t.status === "error_paused");
    const cancelledTasks = tasks.filter(t => t.status === "cancelled");

    const formatDateTime = (dateStr: string | null) => {
        if (!dateStr) return "—";
        return new Date(dateStr).toLocaleString("ru-RU", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
        });
    };

    const formatDuration = (ms: number | null) => {
        if (!ms) return "—";
        if (ms < 1000) return `${ms}мс`;
        const seconds = (ms / 1000).toFixed(1);
        if (ms < 60000) return `${seconds}с`;
        const minutes = Math.floor(ms / 60000);
        const secs = Math.floor((ms % 60000) / 1000);
        return `${minutes}м ${secs}с`;
    };

    const getNextRunLabel = (nextRunAt: string | null) => {
        if (!nextRunAt) return "Не запланировано";
        const diff = new Date(nextRunAt).getTime() - Date.now();
        if (diff < 0) return "Скоро запустится";

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 24) {
            const days = Math.floor(hours / 24);
            return `Через ${days} дн.`;
        }
        if (hours > 0) return `Через ${hours} ч. ${minutes} мин.`;
        return `Через ${minutes} мин.`;
    };

    const describeCron = (expr: string): string => {
        const parts = expr.split(" ");
        if (parts.length !== 5) return expr;
        const [min, hour, dom, mon, dow] = parts;

        if (dom === "*" && mon === "*") {
            const timeStr = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;

            if (dow === "*") return `Каждый день в ${timeStr}`;
            if (dow === "1-5") return `По будням в ${timeStr}`;
            if (dow === "0,6") return `По выходным в ${timeStr}`;

            const dayNames: Record<string, string> = {
                "0": "воскресеньям", "1": "понедельникам", "2": "вторникам",
                "3": "средам", "4": "четвергам", "5": "пятницам", "6": "субботам",
            };
            if (dayNames[dow]) return `По ${dayNames[dow]} в ${timeStr}`;
        }

        if (hour.startsWith("*/")) return `Каждые ${hour.slice(2)} ч.`;
        if (min === "0" && hour === "*") return "Каждый час";

        return expr;
    };

    const getStatusBadge = (status: string) => {
        switch (status) {
            case "active":
                return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">Активна</Badge>;
            case "paused":
                return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Пауза</Badge>;
            case "error_paused":
                return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">Ошибка ⏸</Badge>;
            case "cancelled":
                return <Badge className="bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">Отменена</Badge>;
            default:
                return <Badge>{status}</Badge>;
        }
    };

    const getLogStatusIcon = (status: string) => {
        switch (status) {
            case "success":
                return <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0" />;
            case "error":
                return <XCircle className="h-4 w-4 text-red-500 flex-shrink-0" />;
            case "timeout":
                return <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0" />;
            default:
                return <Clock className="h-4 w-4 text-gray-400 flex-shrink-0" />;
        }
    };

    // Common presets for cron expressions
    const cronPresets = [
        { label: "Каждый день 9:00", value: "0 9 * * *" },
        { label: "По будням 8:30", value: "30 8 * * 1-5" },
        { label: "Каждый понедельник 10:00", value: "0 10 * * 1" },
        { label: "Каждый час", value: "0 * * * *" },
        { label: "Каждые 2 часа", value: "0 */2 * * *" },
        { label: "1-е число месяца", value: "0 9 1 * *" },
    ];

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
        );
    }

    const renderLogEntry = (log: ExecutionLog) => {
        const isExpanded = expandedLogEntry === log.id;

        return (
            <div
                key={log.id}
                className="border border-gray-100 dark:border-gray-700 rounded-lg overflow-hidden"
            >
                {/* Log header — always visible */}
                <button
                    onClick={() => setExpandedLogEntry(isExpanded ? null : log.id)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors text-left"
                >
                    {getLogStatusIcon(log.status)}

                    <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {formatDateTime(log.executedAt)}
                    </span>

                    {log.agentName && (
                        <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 truncate">
                            <Bot className="h-3 w-3 flex-shrink-0" />
                            {log.agentName}
                        </span>
                    )}

                    {log.durationMs != null && (
                        <span className="text-xs text-gray-400 whitespace-nowrap">
                            {formatDuration(log.durationMs)}
                        </span>
                    )}

                    {log.toolCalls && log.toolCalls.length > 0 && (
                        <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                            {log.toolCalls.length} tool{log.toolCalls.length > 1 ? 's' : ''}
                        </Badge>
                    )}

                    <div className="ml-auto flex-shrink-0">
                        {isExpanded
                            ? <ChevronUp className="h-4 w-4 text-gray-400" />
                            : <ChevronDown className="h-4 w-4 text-gray-400" />
                        }
                    </div>
                </button>

                {/* Expanded details */}
                {isExpanded && (
                    <div className="border-t border-gray-100 dark:border-gray-700 px-3 py-3 space-y-3 bg-gray-50/50 dark:bg-gray-900/30">
                        {/* Error */}
                        {log.error && (
                            <div className="p-2 bg-red-50 dark:bg-red-900/20 rounded text-sm text-red-700 dark:text-red-300 border border-red-100 dark:border-red-800">
                                <span className="font-medium">Ошибка:</span> {log.error}
                            </div>
                        )}

                        {/* Response */}
                        {log.response && (
                            <div>
                                <div className="text-xs font-medium text-gray-500 mb-1">Ответ AI:</div>
                                <div className="p-3 bg-white dark:bg-gray-800 rounded border border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300 max-h-64 overflow-y-auto whitespace-pre-wrap">
                                    {log.response}
                                </div>
                            </div>
                        )}

                        {/* Tool calls */}
                        {log.toolCalls && log.toolCalls.length > 0 && (
                            <div>
                                <div className="text-xs font-medium text-gray-500 mb-1">Инструменты:</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {log.toolCalls.map((tc, i) => (
                                        <Badge
                                            key={i}
                                            variant="outline"
                                            className={`text-[10px] ${tc.success
                                                ? 'border-emerald-200 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400'
                                                : 'border-red-200 text-red-700 dark:border-red-800 dark:text-red-400'
                                                }`}
                                        >
                                            {tc.success ? '✓' : '✗'} {tc.toolName} ({formatDuration(tc.durationMs)})
                                        </Badge>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Stats row */}
                        <div className="flex items-center gap-4 text-xs text-gray-400">
                            {log.tokensUsed > 0 && <span>Токены: {log.tokensUsed}</span>}
                            {log.agentUsed && <span>Агент: {log.agentUsed}</span>}
                        </div>
                    </div>
                )}
            </div>
        );
    };

    const renderTask = (task: ScheduledTask) => (
        <div key={task.id}>
            <div
                className="p-4 rounded-lg border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800/50 hover:shadow-md transition-shadow"
            >
                <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <h3 className="font-medium text-gray-900 dark:text-white truncate">{task.title}</h3>
                            {getStatusBadge(task.status)}
                            {task.createdByAi && (
                                <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 text-xs">
                                    <Zap className="h-3 w-3 mr-1" />AI
                                </Badge>
                            )}
                        </div>

                        <p className="text-sm text-gray-500 dark:text-gray-400 mb-2 line-clamp-2">{task.prompt}</p>

                        <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
                            <span className="flex items-center gap-1 font-mono bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
                                <Timer className="h-3 w-3" />
                                {describeCron(task.cronExpression)}
                            </span>
                            {task.status === "active" && task.nextRunAt && (
                                <span className="flex items-center gap-1 text-blue-600 dark:text-blue-400">
                                    <CalendarClock className="h-3 w-3" />
                                    {getNextRunLabel(task.nextRunAt)}
                                </span>
                            )}
                            <span className="flex items-center gap-1">
                                <RefreshCw className="h-3 w-3" />
                                {task.runCount} запусков{task.maxRuns ? ` / ${task.maxRuns}` : ""}
                            </span>
                            {task.lastRunAt && (
                                <span className="flex items-center gap-1">
                                    <Clock className="h-3 w-3" />
                                    Посл.: {formatDateTime(task.lastRunAt)}
                                </span>
                            )}
                            {task.status === "error_paused" && task.consecutiveErrors > 0 && (
                                <span className="flex items-center gap-1 text-red-600 dark:text-red-400 font-medium">
                                    <AlertTriangle className="h-3 w-3" />
                                    {task.consecutiveErrors} ошибок подряд
                                </span>
                            )}
                            {task.status === "active" && task.consecutiveErrors > 0 && task.backoffUntil && (
                                <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                                    <AlertTriangle className="h-3 w-3" />
                                    Backoff: {task.consecutiveErrors} ошиб., повтор {formatDateTime(task.backoffUntil)}
                                </span>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                        {/* Logs button */}
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => toggleLogs(task.id)}
                            className={`${expandedLogTask === task.id
                                ? 'text-blue-600 bg-blue-50 dark:bg-blue-900/20'
                                : 'text-gray-500 hover:text-gray-700'
                                }`}
                            title="Журнал выполнений"
                        >
                            <FileText className="h-4 w-4" />
                        </Button>

                        {task.status === "active" && (
                            <>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleForceRun(task.id)}
                                    disabled={runningTask === task.id}
                                    className="text-green-600 hover:text-green-700"
                                    title="Запустить сейчас"
                                >
                                    {runningTask === task.id
                                        ? <RefreshCw className="h-4 w-4 animate-spin" />
                                        : <Play className="h-4 w-4" />
                                    }
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleStatusChange(task.id, "paused")}
                                    className="text-amber-600 hover:text-amber-700"
                                    title="Приостановить"
                                >
                                    <Pause className="h-4 w-4" />
                                </Button>
                            </>
                        )}
                        {(task.status === "paused" || task.status === "error_paused") && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleStatusChange(task.id, "active")}
                                className="text-emerald-600 hover:text-emerald-700"
                                title="Возобновить"
                            >
                                <Play className="h-4 w-4" />
                            </Button>
                        )}
                        {task.status !== "cancelled" && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleStatusChange(task.id, "cancelled")}
                                className="text-gray-500 hover:text-gray-700"
                                title="Отменить"
                            >
                                <X className="h-4 w-4" />
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(task.id)}
                            className="text-red-500 hover:text-red-600"
                            title="Удалить"
                        >
                            <Trash2 className="h-4 w-4" />
                        </Button>
                    </div>
                </div>
            </div>

            {/* Execution Logs panel */}
            {expandedLogTask === task.id && (
                <div className="mt-1 ml-4 mr-1 p-3 rounded-lg border border-blue-100 dark:border-blue-900/40 bg-blue-50/30 dark:bg-blue-950/20">
                    <div className="flex items-center justify-between mb-2">
                        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center gap-1.5">
                            <FileText className="h-4 w-4 text-blue-500" />
                            Журнал выполнений
                        </h4>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => fetchLogs(task.id)}
                            className="text-xs text-gray-500 h-7"
                        >
                            <RefreshCw className="h-3 w-3 mr-1" />
                            Обновить
                        </Button>
                    </div>

                    {logsLoading ? (
                        <div className="flex items-center justify-center py-6">
                            <RefreshCw className="h-5 w-5 animate-spin text-blue-500" />
                        </div>
                    ) : logs.length === 0 ? (
                        <p className="text-center text-sm text-gray-400 py-6">
                            Задача ещё ни разу не запускалась
                        </p>
                    ) : (
                        <div className="space-y-1.5">
                            {logs.map(renderLogEntry)}
                        </div>
                    )}
                </div>
            )}
        </div>
    );

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>

            <div className="flex-1 flex flex-col h-full overflow-hidden">
                {/* Sub-header */}
                <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4 shrink-0">
                    <div className="flex items-center justify-between max-w-4xl mx-auto w-full">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-500/10 rounded-lg">
                                <CalendarClock className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                                    Cron-задачи
                                </h1>
                                <p className="text-gray-500 dark:text-gray-400 text-sm">
                                    Автоматические задачи AI по расписанию
                                </p>
                            </div>
                        </div>
                        <Button onClick={() => setShowForm(!showForm)}>
                            <Plus className="h-4 w-4 mr-2" />
                            Добавить
                        </Button>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 md:p-8">
                    <div className="max-w-4xl mx-auto">

                {/* Stats */}
                <div className="grid grid-cols-3 gap-4 mb-8">
                    <Card>
                        <CardContent className="p-4 text-center">
                            <div className="text-3xl font-bold text-emerald-600">{activeTasks.length}</div>
                            <div className="text-sm text-gray-500">Активных</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-4 text-center">
                            <div className="text-3xl font-bold text-amber-600">{pausedTasks.length + errorPausedTasks.length}</div>
                            <div className="text-sm text-gray-500">На паузе{errorPausedTasks.length > 0 ? ` (${errorPausedTasks.length} ⚠️)` : ""}</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-4 text-center">
                            <div className="text-3xl font-bold text-gray-400">{cancelledTasks.length}</div>
                            <div className="text-sm text-gray-500">Отменённых</div>
                        </CardContent>
                    </Card>
                </div>

                {/* Create Form */}
                {showForm && (
                    <Card className="mb-6 border-blue-200 dark:border-blue-800">
                        <CardHeader>
                            <CardTitle>Новая cron-задача</CardTitle>
                            <CardDescription>
                                AI будет выполнять промпт по заданному расписанию через полный пайплайн (роли, инструменты, контекст)
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <Input
                                placeholder="Название задачи"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                            />

                            <Textarea
                                placeholder="Промпт для AI (что нужно делать при каждом запуске)"
                                value={prompt}
                                onChange={(e) => setPrompt(e.target.value)}
                                rows={3}
                            />

                            <div>
                                <label className="text-sm font-medium block mb-3 text-gray-700 dark:text-gray-300">Расписание запуска</label>

                                <Tabs value={cronMode} onValueChange={(v: any) => setCronMode(v)} className="w-full">
                                    <TabsList className="grid grid-cols-3 md:grid-cols-6 mb-4 h-auto py-1">
                                        <TabsTrigger value="preset" className="text-xs py-1.5 leading-snug">Шаблоны</TabsTrigger>
                                        <TabsTrigger value="hourly" className="text-xs py-1.5 leading-snug">Ежечасно</TabsTrigger>
                                        <TabsTrigger value="daily" className="text-xs py-1.5 leading-snug">Ежедневно</TabsTrigger>
                                        <TabsTrigger value="weekly" className="text-xs py-1.5 leading-snug">Раз в неделю</TabsTrigger>
                                        <TabsTrigger value="monthly" className="text-xs py-1.5 leading-snug">Раз в месяц</TabsTrigger>
                                        <TabsTrigger value="custom" className="text-xs py-1.5 leading-snug">Свой cron</TabsTrigger>
                                    </TabsList>

                                    <div className="p-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg border border-gray-100 dark:border-gray-800">
                                        <TabsContent value="preset" className="mt-0">
                                            <div className="flex gap-2 flex-wrap">
                                                {cronPresets.map(p => (
                                                    <Button
                                                        key={p.value}
                                                        variant={cronExpression === p.value ? "default" : "outline"}
                                                        size="sm"
                                                        onClick={() => setCronExpression(p.value)}
                                                        className="text-xs"
                                                    >
                                                        {p.label}
                                                    </Button>
                                                ))}
                                            </div>
                                        </TabsContent>

                                        <TabsContent value="hourly" className="mt-0 space-y-4">
                                            <div className="flex items-center gap-4 flex-wrap">
                                                <label className="text-sm text-gray-600 dark:text-gray-300">Минута запуска (0-59):</label>
                                                <Input
                                                    type="number" min="0" max="59"
                                                    value={cronMinute} onChange={e => setCronMinute(e.target.value)}
                                                    className="w-24 bg-white dark:bg-gray-900"
                                                />
                                            </div>
                                        </TabsContent>

                                        <TabsContent value="daily" className="mt-0 space-y-4">
                                            <div className="flex items-center gap-4 flex-wrap">
                                                <label className="text-sm text-gray-600 dark:text-gray-300">Время:</label>
                                                <Input
                                                    type="time"
                                                    value={`${cronHour.padStart(2, '0')}:${cronMinute.padStart(2, '0')}`}
                                                    onChange={e => {
                                                        if (e.target.value) {
                                                            const [h, m] = e.target.value.split(':');
                                                            setCronHour(parseInt(h, 10).toString());
                                                            setCronMinute(parseInt(m, 10).toString());
                                                        }
                                                    }}
                                                    className="w-32 bg-white dark:bg-gray-900"
                                                />
                                            </div>
                                        </TabsContent>

                                        <TabsContent value="weekly" className="mt-0 space-y-4">
                                            <div className="flex flex-col sm:flex-row sm:items-center gap-4 flex-wrap">
                                                <div className="flex items-center gap-2">
                                                    <label className="text-sm text-gray-600 dark:text-gray-300 whitespace-nowrap">День недели:</label>
                                                    <Select value={cronDayOfWeek} onValueChange={setCronDayOfWeek}>
                                                        <SelectTrigger className="w-40 bg-white dark:bg-gray-900">
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="1">Понедельник</SelectItem>
                                                            <SelectItem value="2">Вторник</SelectItem>
                                                            <SelectItem value="3">Среда</SelectItem>
                                                            <SelectItem value="4">Четверг</SelectItem>
                                                            <SelectItem value="5">Пятница</SelectItem>
                                                            <SelectItem value="6">Суббота</SelectItem>
                                                            <SelectItem value="0">Воскресенье</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    <label className="text-sm text-gray-600 dark:text-gray-300">Время:</label>
                                                    <Input
                                                        type="time"
                                                        value={`${cronHour.padStart(2, '0')}:${cronMinute.padStart(2, '0')}`}
                                                        onChange={e => {
                                                            if (e.target.value) {
                                                                const [h, m] = e.target.value.split(':');
                                                                setCronHour(parseInt(h, 10).toString());
                                                                setCronMinute(parseInt(m, 10).toString());
                                                            }
                                                        }}
                                                        className="w-32 bg-white dark:bg-gray-900"
                                                    />
                                                </div>
                                            </div>
                                        </TabsContent>

                                        <TabsContent value="monthly" className="mt-0 space-y-4">
                                            <div className="flex flex-col sm:flex-row sm:items-center gap-4 flex-wrap">
                                                <div className="flex items-center gap-2">
                                                    <label className="text-sm text-gray-600 dark:text-gray-300">День (1-31):</label>
                                                    <Input
                                                        type="number" min="1" max="31"
                                                        value={cronDayOfMonth} onChange={e => setCronDayOfMonth(e.target.value)}
                                                        className="w-24 bg-white dark:bg-gray-900"
                                                    />
                                                </div>

                                                <div className="flex items-center gap-2">
                                                    <label className="text-sm text-gray-600 dark:text-gray-300">Время:</label>
                                                    <Input
                                                        type="time"
                                                        value={`${cronHour.padStart(2, '0')}:${cronMinute.padStart(2, '0')}`}
                                                        onChange={e => {
                                                            if (e.target.value) {
                                                                const [h, m] = e.target.value.split(':');
                                                                setCronHour(parseInt(h, 10).toString());
                                                                setCronMinute(parseInt(m, 10).toString());
                                                            }
                                                        }}
                                                        className="w-32 bg-white dark:bg-gray-900"
                                                    />
                                                </div>
                                            </div>
                                        </TabsContent>

                                        <TabsContent value="custom" className="mt-0">
                                            <Input
                                                placeholder="0 9 * * * (мин час день_мес месяц день_нед)"
                                                value={cronExpression}
                                                onChange={(e) => setCronExpression(e.target.value)}
                                                className="font-mono mb-2 bg-white dark:bg-gray-900"
                                            />
                                            <p className="text-xs text-blue-600 dark:text-blue-400">
                                                Формат: Мин Час ДеньМес Месяц ДеньНед
                                            </p>
                                        </TabsContent>
                                    </div>

                                    <div className="mt-3 flex flex-col sm:flex-row sm:items-center justify-between px-1 gap-2">
                                        <div className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 font-medium">
                                            Итоговый cron: <span className="font-mono bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 px-2 py-0.5 rounded">{cronExpression}</span>
                                        </div>
                                        <p className="text-sm text-gray-500 font-medium bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded">
                                            {describeCron(cronExpression)}
                                        </p>
                                    </div>
                                </Tabs>
                            </div>

                            <div>
                                <label className="text-sm text-gray-500 block mb-1">
                                    Макс. запусков (пусто = бесконечно)
                                </label>
                                <Input
                                    type="number"
                                    placeholder="Без ограничений"
                                    value={maxRuns}
                                    onChange={(e) => setMaxRuns(e.target.value)}
                                    className="w-48"
                                    min="1"
                                />
                            </div>

                            <div className="flex gap-2 justify-end">
                                <Button variant="outline" onClick={() => setShowForm(false)}>
                                    Отмена
                                </Button>
                                <Button
                                    onClick={handleCreate}
                                    disabled={!title.trim() || !prompt.trim() || !cronExpression.trim()}
                                >
                                    Создать
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Active Tasks */}
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Play className="h-5 w-5 text-emerald-500" />
                            Активные
                        </CardTitle>
                        <CardDescription>{activeTasks.length} задач</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {activeTasks.length === 0 ? (
                            <p className="text-center text-gray-500 py-8">
                                Нет активных cron-задач. Создайте первую или попросите AI!
                            </p>
                        ) : (
                            <div className="space-y-3">
                                {activeTasks.map(renderTask)}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Paused Tasks */}
                {pausedTasks.length > 0 && (
                    <Card className="mb-6">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-amber-600">
                                <Pause className="h-5 w-5" />
                                На паузе
                            </CardTitle>
                            <CardDescription>{pausedTasks.length} задач</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {pausedTasks.map(renderTask)}
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Error-paused Tasks */}
                {errorPausedTasks.length > 0 && (
                    <Card className="mb-6 border-red-200 dark:border-red-800">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-red-600">
                                <AlertTriangle className="h-5 w-5" />
                                Приостановлены из-за ошибок
                            </CardTitle>
                            <CardDescription>{errorPausedTasks.length} задач — автоматически приостановлены после серии ошибок</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-3">
                                {errorPausedTasks.map(renderTask)}
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Cancelled Tasks */}
                {cancelledTasks.length > 0 && (
                    <Card className="mb-6">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-gray-500">
                                <X className="h-5 w-5" />
                                Отменённые
                            </CardTitle>
                            <CardDescription>{cancelledTasks.length} задач</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-2">
                                {cancelledTasks.slice(0, 10).map(renderTask)}
                            </div>
                        </CardContent>
                    </Card>
                )}
                    </div>
                </main>
            </div>
        </div>
    );
}
