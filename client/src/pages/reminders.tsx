import { useState, useEffect } from "react";
import { Link } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Bell, Plus, Trash2, Clock, Calendar, Check, Pause, X } from "lucide-react";

interface Reminder {
    id: number;
    title: string;
    description: string | null;
    remindAt: string;
    status: string;
    priority: string;
    createdAt: string;
    sentAt: string | null;
}

export default function RemindersPage() {
    const [reminders, setReminders] = useState<Reminder[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);

    // New reminder form
    const [title, setTitle] = useState("");
    const [description, setDescription] = useState("");
    const [remindDate, setRemindDate] = useState("");
    const [remindTime, setRemindTime] = useState("09:00");
    const [priority, setPriority] = useState("medium");

    useEffect(() => {
        fetchReminders();
    }, []);

    const fetchReminders = async () => {
        try {
            const res = await fetch("/api/reminders");
            const data = await res.json();
            setReminders(data);
        } catch (error) {
            console.error("Error fetching reminders:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleCreateReminder = async () => {
        if (!title.trim() || !remindDate) return;

        const remindAt = new Date(`${remindDate}T${remindTime}:00`);

        try {
            const res = await fetch("/api/reminders", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title,
                    description: description || null,
                    remindAt: remindAt.toISOString(),
                    priority,
                }),
            });

            if (res.ok) {
                setTitle("");
                setDescription("");
                setRemindDate("");
                setRemindTime("09:00");
                setPriority("medium");
                setShowForm(false);
                fetchReminders();
            }
        } catch (error) {
            console.error("Error creating reminder:", error);
        }
    };

    const handleSnooze = async (id: number, minutes: number) => {
        try {
            await fetch(`/api/reminders/${id}/snooze`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ minutes }),
            });
            fetchReminders();
        } catch (error) {
            console.error("Error snoozing reminder:", error);
        }
    };

    const handleCancel = async (id: number) => {
        try {
            await fetch(`/api/reminders/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: "cancelled" }),
            });
            fetchReminders();
        } catch (error) {
            console.error("Error cancelling reminder:", error);
        }
    };

    const handleDelete = async (id: number) => {
        if (!confirm("Удалить напоминание?")) return;

        try {
            await fetch(`/api/reminders/${id}`, { method: "DELETE" });
            fetchReminders();
        } catch (error) {
            console.error("Error deleting reminder:", error);
        }
    };

    const pendingReminders = reminders.filter(r => r.status === "pending");
    const sentReminders = reminders.filter(r => r.status === "sent");
    const cancelledReminders = reminders.filter(r => r.status === "cancelled");

    const formatDateTime = (dateStr: string) => {
        return new Date(dateStr).toLocaleString("ru-RU", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit"
        });
    };

    const getTimeRemaining = (dateStr: string) => {
        const diff = new Date(dateStr).getTime() - Date.now();
        if (diff < 0) return "Просрочено";

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

        if (hours > 24) {
            const days = Math.floor(hours / 24);
            return `Через ${days} дн.`;
        }
        if (hours > 0) return `Через ${hours} ч.`;
        return `Через ${minutes} мин.`;
    };

    const getPriorityColor = (priority: string) => {
        switch (priority) {
            case "high": return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
            case "medium": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
            case "low": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
            default: return "bg-gray-100 text-gray-700";
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-500"></div>
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
                            <div className="p-2 bg-purple-500/10 rounded-lg">
                                <Bell className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                                    Напоминания
                                </h1>
                                <p className="text-gray-500 dark:text-gray-400 text-sm">
                                    Управление персональными напоминаниями
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
                            <div className="text-3xl font-bold text-purple-600">{pendingReminders.length}</div>
                            <div className="text-sm text-gray-500">Ожидают</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-4 text-center">
                            <div className="text-3xl font-bold text-green-600">{sentReminders.length}</div>
                            <div className="text-sm text-gray-500">Отправлено</div>
                        </CardContent>
                    </Card>
                    <Card>
                        <CardContent className="p-4 text-center">
                            <div className="text-3xl font-bold text-gray-400">{cancelledReminders.length}</div>
                            <div className="text-sm text-gray-500">Отменено</div>
                        </CardContent>
                    </Card>
                </div>

                {/* Create Reminder Form */}
                {showForm && (
                    <Card className="mb-6 border-purple-200 dark:border-purple-800">
                        <CardHeader>
                            <CardTitle>Новое напоминание</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <Input
                                placeholder="О чём напомнить?"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                            />

                            <Textarea
                                placeholder="Детали (необязательно)"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={2}
                            />

                            <div className="grid grid-cols-3 gap-4">
                                <div>
                                    <label className="text-sm text-gray-500 block mb-1">Дата</label>
                                    <Input
                                        type="date"
                                        value={remindDate}
                                        onChange={(e) => setRemindDate(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label className="text-sm text-gray-500 block mb-1">Время</label>
                                    <Input
                                        type="time"
                                        value={remindTime}
                                        onChange={(e) => setRemindTime(e.target.value)}
                                    />
                                </div>
                                <div>
                                    <label className="text-sm text-gray-500 block mb-1">Приоритет</label>
                                    <select
                                        className="w-full h-10 px-3 rounded-md border border-input bg-background"
                                        value={priority}
                                        onChange={(e) => setPriority(e.target.value)}
                                    >
                                        <option value="low">Низкий</option>
                                        <option value="medium">Средний</option>
                                        <option value="high">Высокий</option>
                                    </select>
                                </div>
                            </div>

                            <div className="flex gap-2 justify-end">
                                <Button variant="outline" onClick={() => setShowForm(false)}>
                                    Отмена
                                </Button>
                                <Button onClick={handleCreateReminder} disabled={!title.trim() || !remindDate}>
                                    Создать
                                </Button>
                            </div>
                        </CardContent>
                    </Card>
                )}

                {/* Pending Reminders */}
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Clock className="h-5 w-5 text-purple-500" />
                            Ожидающие
                        </CardTitle>
                        <CardDescription>{pendingReminders.length} напоминаний</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {pendingReminders.length === 0 ? (
                            <p className="text-center text-gray-500 py-8">
                                Нет запланированных напоминаний
                            </p>
                        ) : (
                            <div className="space-y-3">
                                {pendingReminders.map((reminder) => {
                                    const isOverdue = new Date(reminder.remindAt) < new Date();
                                    return (
                                        <div
                                            key={reminder.id}
                                            className={`p-4 rounded-lg border ${isOverdue
                                                ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
                                                : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800/50"
                                                }`}
                                        >
                                            <div className="flex items-start justify-between">
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-2 mb-1">
                                                        <h3 className="font-medium">{reminder.title}</h3>
                                                        <Badge className={getPriorityColor(reminder.priority)}>
                                                            {reminder.priority === "high" ? "Важно" : reminder.priority === "low" ? "Низкий" : "Средний"}
                                                        </Badge>
                                                    </div>
                                                    {reminder.description && (
                                                        <p className="text-sm text-gray-500 mb-2">{reminder.description}</p>
                                                    )}
                                                    <div className="flex items-center gap-3 text-xs text-gray-500">
                                                        <span className="flex items-center gap-1">
                                                            <Calendar className="h-3 w-3" />
                                                            {formatDateTime(reminder.remindAt)}
                                                        </span>
                                                        <span className={isOverdue ? "text-red-500 font-medium" : "text-purple-600"}>
                                                            {getTimeRemaining(reminder.remindAt)}
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleSnooze(reminder.id, 30)}
                                                        className="text-amber-600 hover:text-amber-700"
                                                        title="Отложить на 30 мин"
                                                    >
                                                        <Pause className="h-4 w-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleCancel(reminder.id)}
                                                        className="text-gray-500 hover:text-gray-700"
                                                        title="Отменить"
                                                    >
                                                        <X className="h-4 w-4" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() => handleDelete(reminder.id)}
                                                        className="text-red-500 hover:text-red-600"
                                                    >
                                                        <Trash2 className="h-4 w-4" />
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Sent Reminders */}
                {sentReminders.length > 0 && (
                    <Card className="mb-6">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-green-600">
                                <Check className="h-5 w-5" />
                                Отправленные
                            </CardTitle>
                            <CardDescription>{sentReminders.length} напоминаний</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="space-y-2">
                                {sentReminders.slice(0, 10).map((reminder) => (
                                    <div
                                        key={reminder.id}
                                        className="flex items-center justify-between p-3 rounded-lg bg-green-50 dark:bg-green-950/30"
                                    >
                                        <div className="flex items-center gap-2">
                                            <Check className="h-4 w-4 text-green-600" />
                                            <span className="text-gray-600 dark:text-gray-400">{reminder.title}</span>
                                            <span className="text-xs text-gray-400">
                                                {reminder.sentAt && formatDateTime(reminder.sentAt)}
                                            </span>
                                        </div>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => handleDelete(reminder.id)}
                                            className="text-gray-400 hover:text-red-500"
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
