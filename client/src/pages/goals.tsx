import { useState, useEffect, useCallback } from "react";
import { Link } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
    Target, Plus, Trash2, Check, Calendar,
    TrendingUp, ChevronDown, ChevronRight, Flame,
    Milestone as MilestoneIcon, ListTodo, BarChart3,
    Activity, Star, Zap, Clock, AlertTriangle
} from "lucide-react";

// ============================================================================
// Типы
// ============================================================================

interface Goal {
    id: number;
    title: string;
    description: string | null;
    smartDescription: string | null;
    category: string | null;
    priority: string | null;
    deadline: string | null;
    status: string;
    progress: number;
    parentGoalId: number | null;
    reviewFrequency: string | null;
    targetReviewDate: string | null;
    createdAt: string;
    updatedAt: string;
}

interface GoalMilestone {
    id: number;
    goalId: number;
    title: string;
    description: string | null;
    sortOrder: number;
    deadline: string | null;
    status: string;
    completedAt: string | null;
    createdAt: string;
}

interface GoalTask {
    id: number;
    milestoneId: number;
    goalId: number;
    title: string;
    description: string | null;
    sortOrder: number;
    status: string;
    priority: string | null;
    dueDate: string | null;
    completedAt: string | null;
}

interface GoalKeyResult {
    id: number;
    goalId: number;
    title: string;
    metric: string | null;
    targetValue: number | null;
    currentValue: number;
    unit: string | null;
    autoQuery: string | null;
    status: string;
}

interface GoalActivityLogEntry {
    id: number;
    goalId: number;
    activityType: string;
    description: string;
    metadata: Record<string, any> | null;
    createdAt: string;
}

interface GoalDetails {
    goal: Goal;
    milestones: GoalMilestone[];
    tasks: GoalTask[];
    keyResults: GoalKeyResult[];
    recentActivity: GoalActivityLogEntry[];
}

// ============================================================================
// Утилиты
// ============================================================================

const formatDate = (dateStr: string | null) => {
    if (!dateStr) return null;
    return new Date(dateStr).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
};

const formatRelativeDate = (dateStr: string) => {
    const now = new Date();
    const date = new Date(dateStr);
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 60) return `${minutes} мин назад`;
    if (hours < 24) return `${hours} ч назад`;
    if (days < 7) return `${days} дн назад`;
    return formatDate(dateStr);
};

const PRIORITY_CONFIG: Record<string, { label: string; color: string; icon: typeof Star }> = {
    focus: { label: "Фокус", color: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300", icon: Flame },
    high: { label: "Высокий", color: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300", icon: Zap },
    medium: { label: "Средний", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300", icon: Star },
    low: { label: "Низкий", color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400", icon: Clock },
};

const CATEGORY_COLORS: Record<string, string> = {
    career: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
    health: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    finance: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
    education: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
    personal: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
    project: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300",
    business: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
};

const CATEGORY_LABELS: Record<string, string> = {
    career: "Карьера",
    health: "Здоровье",
    finance: "Финансы",
    education: "Обучение",
    personal: "Личное",
    project: "Проект",
    business: "Бизнес",
};

const ACTIVITY_ICONS: Record<string, string> = {
    created: "🆕",
    progress_update: "📈",
    milestone_added: "📌",
    task_completed: "✅",
    task_added: "➕",
    review: "📊",
    note: "📝",
    status_change: "🔄",
    merged: "🔀",
};

// ============================================================================
// Компоненты
// ============================================================================

/** Бейдж приоритета */
function PriorityBadge({ priority }: { priority: string | null }) {
    const config = PRIORITY_CONFIG[priority || "medium"] || PRIORITY_CONFIG.medium;
    const Icon = config.icon;
    return (
        <Badge variant="outline" className={`${config.color} border-0 text-xs gap-1`}>
            <Icon className="h-3 w-3" />
            {config.label}
        </Badge>
    );
}

/** Бейдж категории */
function CategoryBadge({ category }: { category: string | null }) {
    if (!category) return null;
    const color = CATEGORY_COLORS[category] || "bg-gray-100 text-gray-600";
    const label = CATEGORY_LABELS[category] || category;
    return (
        <Badge variant="outline" className={`${color} border-0 text-xs`}>
            {label}
        </Badge>
    );
}

/** Карточка Key Result */
function KeyResultCard({ kr }: { kr: GoalKeyResult }) {
    const percentage = kr.targetValue ? Math.min(100, Math.round((kr.currentValue / kr.targetValue) * 100)) : 0;
    return (
        <div className="flex items-center gap-3 p-2 rounded-md bg-gray-50 dark:bg-gray-800/30">
            <BarChart3 className="h-4 w-4 text-indigo-500 shrink-0" />
            <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between text-sm">
                    <span className="truncate font-medium">{kr.title}</span>
                    <span className="text-xs text-gray-500 tabular-nums ml-2 shrink-0">
                        {kr.currentValue}{kr.unit ? ` ${kr.unit}` : ""} / {kr.targetValue}{kr.unit ? ` ${kr.unit}` : ""}
                    </span>
                </div>
                <Progress value={percentage} className="h-1.5 mt-1" />
            </div>
            <span className="text-xs font-medium text-gray-500 tabular-nums w-10 text-right">{percentage}%</span>
        </div>
    );
}

/** Карточка Milestone с tasks */
function MilestoneCard({ milestone, tasks }: { milestone: GoalMilestone; tasks: GoalTask[] }) {
    const [expanded, setExpanded] = useState(false);
    const milestoneTasks = tasks.filter((t) => t.milestoneId === milestone.id);
    const completedTasks = milestoneTasks.filter((t) => t.status === "done");
    const progress = milestoneTasks.length > 0 ? Math.round((completedTasks.length / milestoneTasks.length) * 100) : 0;
    const isDone = milestone.status === "completed";

    return (
        <div className={`rounded-md border p-3 ${isDone ? "bg-green-50/50 dark:bg-green-900/10 border-green-200 dark:border-green-800/50" : "border-gray-200 dark:border-gray-700"}`}>
            <div
                className="flex items-center gap-2 cursor-pointer select-none"
                onClick={() => setExpanded(!expanded)}
            >
                {isDone ? (
                    <Check className="h-4 w-4 text-green-500 shrink-0" />
                ) : expanded ? (
                    <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" />
                ) : (
                    <ChevronRight className="h-4 w-4 text-gray-400 shrink-0" />
                )}
                <span className={`text-sm font-medium flex-1 ${isDone ? "line-through text-gray-400" : ""}`}>
                    {milestone.title}
                </span>
                <span className="text-xs text-gray-400 tabular-nums">{completedTasks.length}/{milestoneTasks.length}</span>
                {milestone.deadline && (
                    <span className="text-xs text-gray-400 flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatDate(milestone.deadline)}
                    </span>
                )}
            </div>

            {milestoneTasks.length > 0 && <Progress value={progress} className="h-1 mt-2" />}

            {expanded && milestoneTasks.length > 0 && (
                <div className="mt-2 ml-5 space-y-1">
                    {milestoneTasks.map((task) => (
                        <div key={task.id} className="flex items-center gap-2 text-sm">
                            {task.status === "done" ? (
                                <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                            ) : (
                                <div className="h-3.5 w-3.5 rounded-sm border border-gray-300 dark:border-gray-600 shrink-0" />
                            )}
                            <span className={task.status === "done" ? "line-through text-gray-400" : "text-gray-700 dark:text-gray-300"}>
                                {task.title}
                            </span>
                            {task.dueDate && (
                                <span className="text-xs text-gray-400 ml-auto">{formatDate(task.dueDate)}</span>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/** Раскрываемый блок подробностей цели */
function GoalDetailsPanel({ goalId }: { goalId: number }) {
    const [details, setDetails] = useState<GoalDetails | null>(null);
    const [loading, setLoading] = useState(true);
    const [tab, setTab] = useState<"plan" | "results" | "activity">("plan");

    useEffect(() => {
        fetch(`/api/goals/${goalId}/details`)
            .then((r) => r.json())
            .then((d) => setDetails(d))
            .catch(console.error)
            .finally(() => setLoading(false));
    }, [goalId]);

    if (loading) {
        return (
            <div className="flex items-center justify-center py-4">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-emerald-500" />
            </div>
        );
    }
    if (!details) return null;

    const hasMilestones = details.milestones.length > 0;
    const hasKeyResults = details.keyResults.length > 0;
    const hasActivity = details.recentActivity.length > 0;

    return (
        <div className="mt-3 space-y-3">
            {/* Tabs */}
            <div className="flex gap-1">
                <Button
                    variant={tab === "plan" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => setTab("plan")}
                >
                    <ListTodo className="h-3 w-3" />
                    План {hasMilestones && `(${details.milestones.length})`}
                </Button>
                <Button
                    variant={tab === "results" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => setTab("results")}
                >
                    <BarChart3 className="h-3 w-3" />
                    KR {hasKeyResults && `(${details.keyResults.length})`}
                </Button>
                <Button
                    variant={tab === "activity" ? "default" : "ghost"}
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={() => setTab("activity")}
                >
                    <Activity className="h-3 w-3" />
                    Активность
                </Button>
            </div>

            {/* Tab content */}
            {tab === "plan" && (
                <div className="space-y-2">
                    {hasMilestones ? (
                        details.milestones.map((m) => (
                            <MilestoneCard key={m.id} milestone={m} tasks={details.tasks} />
                        ))
                    ) : (
                        <p className="text-xs text-gray-400 italic text-center py-3">
                            Нет вех. Попросите AI декомпозировать цель через чат.
                        </p>
                    )}
                </div>
            )}

            {tab === "results" && (
                <div className="space-y-2">
                    {hasKeyResults ? (
                        details.keyResults.map((kr) => (
                            <KeyResultCard key={kr.id} kr={kr} />
                        ))
                    ) : (
                        <p className="text-xs text-gray-400 italic text-center py-3">
                            Нет ключевых результатов. Создайте через чат.
                        </p>
                    )}
                </div>
            )}

            {tab === "activity" && (
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {hasActivity ? (
                        details.recentActivity.map((a) => (
                            <div key={a.id} className="flex items-start gap-2 text-xs text-gray-600 dark:text-gray-400">
                                <span className="shrink-0">{ACTIVITY_ICONS[a.activityType] || "📌"}</span>
                                <span className="flex-1">{a.description}</span>
                                <span className="text-gray-400 shrink-0">{formatRelativeDate(a.createdAt)}</span>
                            </div>
                        ))
                    ) : (
                        <p className="text-xs text-gray-400 italic text-center py-3">Нет активности</p>
                    )}
                </div>
            )}
        </div>
    );
}

/** Карточка одной цели */
function GoalCard({
    goal,
    onComplete,
    onDelete,
}: {
    goal: Goal;
    onComplete: (id: number) => void;
    onDelete: (id: number) => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const isOverdue = goal.deadline && new Date(goal.deadline) < new Date();
    const isFocus = goal.priority === "focus";

    return (
        <div
            className={`p-4 rounded-lg border transition-all ${isFocus
                ? "border-orange-300 bg-orange-50/50 dark:border-orange-700 dark:bg-orange-950/20 ring-1 ring-orange-200 dark:ring-orange-800"
                : isOverdue
                    ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
                    : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800/50"
                }`}
        >
            {/* Header */}
            <div className="flex items-start justify-between mb-2">
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                        {isFocus && <Flame className="h-4 w-4 text-orange-500 shrink-0" />}
                        <h3 className="font-medium text-sm">{goal.title}</h3>
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                        <PriorityBadge priority={goal.priority} />
                        <CategoryBadge category={goal.category} />
                        {isOverdue && (
                            <Badge variant="destructive" className="text-xs gap-1">
                                <AlertTriangle className="h-3 w-3" />
                                Просрочено
                            </Badge>
                        )}
                    </div>
                    {(goal.smartDescription || goal.description) && (
                        <p className="text-xs text-gray-500 mt-1.5 line-clamp-2">
                            {goal.smartDescription || goal.description}
                        </p>
                    )}
                    {goal.deadline && (
                        <div className="flex items-center gap-1 mt-1.5 text-xs text-gray-500">
                            <Calendar className="h-3 w-3" />
                            {formatDate(goal.deadline)}
                        </div>
                    )}
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-green-600 hover:text-green-700 hover:bg-green-50"
                        onClick={() => onComplete(goal.id)}
                        title="Отметить выполненной"
                    >
                        <Check className="h-4 w-4" />
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-50"
                        onClick={() => onDelete(goal.id)}
                    >
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            </div>

            {/* Progress */}
            <div className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                    <span className="text-gray-500">Прогресс</span>
                    <span className="font-medium tabular-nums">{goal.progress}%</span>
                </div>
                <Progress value={goal.progress} className="h-1.5" />
            </div>

            {/* Expand button */}
            <Button
                variant="ghost"
                size="sm"
                className="w-full mt-2 h-6 text-xs text-gray-400 hover:text-gray-600"
                onClick={() => setExpanded(!expanded)}
            >
                {expanded ? (
                    <>
                        <ChevronDown className="h-3 w-3 mr-1" />
                        Свернуть
                    </>
                ) : (
                    <>
                        <ChevronRight className="h-3 w-3 mr-1" />
                        Подробности
                    </>
                )}
            </Button>

            {expanded && <GoalDetailsPanel goalId={goal.id} />}
        </div>
    );
}

// ============================================================================
// Главная страница
// ============================================================================

export default function GoalsPage() {
    const [goals, setGoals] = useState<Goal[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [filter, setFilter] = useState<"all" | "focus" | string>("all");

    // New goal form
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [deadline, setDeadline] = useState("");
    const [category, setCategory] = useState("");
    const [priority, setPriority] = useState("medium");

    const fetchGoals = useCallback(async () => {
        try {
            const res = await fetch("/api/goals?active=true");
            const data = await res.json();
            setGoals(data);
        } catch (error) {
            console.error("Error fetching goals:", error);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchGoals();
    }, [fetchGoals]);

    const handleCreateGoal = async () => {
        if (!title.trim()) return;

        try {
            const res = await fetch("/api/goals", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title,
                    description: description || null,
                    deadline: deadline || null,
                    category: category || null,
                    priority: priority || "medium",
                }),
            });

            if (res.ok) {
                setTitle("");
                setDescription("");
                setDeadline("");
                setCategory("");
                setPriority("medium");
                setShowForm(false);
                fetchGoals();
            }
        } catch (error) {
            console.error("Error creating goal:", error);
        }
    };

    const handleCompleteGoal = async (id: number) => {
        try {
            await fetch(`/api/goals/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "completed", progress: 100 }),
            });
            fetchGoals();
        } catch (error) {
            console.error("Error completing goal:", error);
        }
    };

    const handleDeleteGoal = async (id: number) => {
        if (!confirm("Удалить цель?")) return;
        try {
            await fetch(`/api/goals/${id}`, { method: "DELETE" });
            fetchGoals();
        } catch (error) {
            console.error("Error deleting goal:", error);
        }
    };

    // Фильтрация
    const activeGoals = goals.filter((g) => g.status === "active");
    const completedGoals = goals.filter((g) => g.status === "completed");
    const focusGoals = activeGoals.filter((g) => g.priority === "focus");
    const overdueGoals = activeGoals.filter((g) => g.deadline && new Date(g.deadline) < new Date());

    const filteredGoals = activeGoals.filter((g) => {
        if (filter === "all") return true;
        if (filter === "focus") return g.priority === "focus";
        return g.category === filter;
    });

    // Уникальные категории для фильтра
    const categories = Array.from(new Set(activeGoals.map((g) => g.category).filter(Boolean))) as string[];

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500" />
            </div>
        );
    }

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
                            <div className="p-2 bg-emerald-500/10 rounded-lg">
                                <Target className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                                    Живые цели
                                </h1>
                                <p className="text-gray-500 dark:text-gray-400 text-sm">
                                    Иерархические цели с AI-коучем
                                </p>
                            </div>
                        </div>
                        <Button onClick={() => setShowForm(!showForm)}>
                            <Plus className="h-4 w-4 mr-2" />
                            Новая цель
                        </Button>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 md:p-8">
                    <div className="max-w-4xl mx-auto">

                {/* Stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                    <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter("all")}>
                        <CardContent className="p-3 text-center">
                            <div className="text-2xl font-bold text-emerald-600">{activeGoals.length}</div>
                            <div className="text-xs text-gray-500">Активных</div>
                        </CardContent>
                    </Card>
                    <Card className="cursor-pointer hover:shadow-md transition-shadow" onClick={() => setFilter("focus")}>
                        <CardContent className="p-3 text-center">
                            <div className="text-2xl font-bold text-orange-500 flex items-center justify-center gap-1">
                                <Flame className="h-5 w-5" />
                                {focusGoals.length}
                            </div>
                            <div className="text-xs text-gray-500">В фокусе</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-3 text-center">
                            <div className="text-2xl font-bold text-green-600">{completedGoals.length}</div>
                            <div className="text-xs text-gray-500">Выполнено</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-3 text-center">
                            <div className="text-2xl font-bold text-red-500">{overdueGoals.length}</div>
                            <div className="text-xs text-gray-500">Просрочено</div>
                        </CardContent>
                    </Card>
                </div>

                {/* Create Goal Form */}
                {showForm && (
                    <Card className="mb-6 border-emerald-200 dark:border-emerald-800">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">Новая цель</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <Input
                                placeholder="Название цели"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                            />
                            <Textarea
                                placeholder="Описание (необязательно)"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={2}
                            />
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">Дедлайн</label>
                                    <Input
                                        type="date"
                                        value={deadline}
                                        onChange={(e) => setDeadline(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">Категория</label>
                                    <select
                                        className="w-full h-9 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm"
                                        value={category}
                                        onChange={(e) => setCategory(e.target.value)}
                                    >
                                        <option value="">—</option>
                                        {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                                            <option key={key} value={key}>{label}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-xs text-gray-500 block mb-1">Приоритет</label>
                                    <select
                                        className="w-full h-9 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 text-sm"
                                        value={priority}
                                        onChange={(e) => setPriority(e.target.value)}
                                    >
                                        <option value="low">Низкий</option>
                                        <option value="medium">Средний</option>
                                        <option value="high">Высокий</option>
                                        <option value="focus">🔥 Фокус</option>
                                    </select>
                                </div>
                            </div>
                            <div className="flex gap-2 justify-end">
                                <Button variant="outline" onClick={() => setShowForm(false)}>Отмена</Button>
                                <Button onClick={handleCreateGoal} disabled={!title.trim()}>Создать</Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Filter bar */}
                {categories.length > 0 && (
                    <div className="flex gap-1.5 mb-4 flex-wrap">
                        <Button
                            variant={filter === "all" ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => setFilter("all")}
                        >
                            Все
                        </Button>
                        <Button
                            variant={filter === "focus" ? "default" : "outline"}
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={() => setFilter("focus")}
                        >
                            <Flame className="h-3 w-3" />
                            Фокус
                        </Button>
                        {categories.map((cat) => (
                            <Button
                                key={cat}
                                variant={filter === cat ? "default" : "outline"}
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => setFilter(cat)}
                            >
                                {CATEGORY_LABELS[cat] || cat}
                            </Button>
                        ))}
                    </div>
                )}

                {/* Active Goals */}
                <Card className="mb-6">
                    <CardHeader className="pb-3">
                        <CardTitle className="flex items-center gap-2 text-base">
                            <TrendingUp className="h-5 w-5 text-emerald-500" />
                            Активные цели
                        </CardTitle>
                        <CardDescription>{filteredGoals.length} целей</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {filteredGoals.length === 0 ? (
                            <p className="text-center text-gray-500 py-8 text-sm">
                                {filter !== "all"
                                    ? "Нет целей с таким фильтром"
                                    : "Нет активных целей. Создайте первую!"}
                            </p>
                        ) : (
                            <div className="space-y-3">
                                {filteredGoals
                                    .sort((a, b) => {
                                        // Фокус сверху, потом по приоритету
                                        const priorityOrder: Record<string, number> = { focus: 0, high: 1, medium: 2, low: 3 };
                                        return (priorityOrder[a.priority || "medium"] ?? 2) - (priorityOrder[b.priority || "medium"] ?? 2);
                                    })
                                    .map((goal) => (
                                        <GoalCard
                                            key={goal.id}
                                            goal={goal}
                                            onComplete={handleCompleteGoal}
                                            onDelete={handleDeleteGoal}
                                        />
                                    ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Completed Goals */}
                {completedGoals.length > 0 && (
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="flex items-center gap-2 text-green-600 text-base">
                                <Check className="h-5 w-5" />
                                Выполненные
                            </CardTitle>
                            <CardDescription>{completedGoals.length} целей</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-2">
                                {completedGoals.map((goal) => (
                                    <div
                                        key={goal.id}
                                        className="flex items-center justify-between p-3 rounded-lg bg-green-50 dark:bg-green-950/30"
                                    >
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Check className="h-4 w-4 text-green-600 shrink-0" />
                                            <span className="line-through text-gray-500 truncate">{goal.title}</span>
                                            <CategoryBadge category={goal.category} />
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-7 w-7 text-gray-400 hover:text-red-500 shrink-0"
                                            onClick={() => handleDeleteGoal(goal.id)}
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                ))}
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
