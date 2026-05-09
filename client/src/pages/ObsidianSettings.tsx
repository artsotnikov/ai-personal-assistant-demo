import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import { Cloud, Save, RefreshCw, ExternalLink, ShieldCheck, Database, FileText, Download, Eye, Play, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";

interface VaultSettings {
    token: string | null;
    hasToken: boolean;
    root: string;
    isConnected: boolean;
    connectionUser?: string;
    connectionError?: string;
}

interface SyncStatus {
    running: boolean;
    lastSyncAt: string | null;
    trackedFiles: number;
}

interface RemoteChanges {
    changed: { name: string; modified: string; md5: string; size: number }[];
    newFiles: { name: string; modified: string; md5: string; size: number }[];
    total: number;
}

interface PullResult {
    created: number;
    updated: number;
    skipped: number;
    errors: string[];
    message: string;
}

export default function ObsidianSettingsPage() {
    const [, setLocation] = useLocation();
    const { toast } = useToast();
    const queryClient = useQueryClient();

    const [token, setToken] = useState("");
    const [root, setRoot] = useState("app:/");

    const { data: settings, isLoading } = useQuery<VaultSettings>({
        queryKey: ["/api/vault/settings"],
    });

    const { data: syncStatus } = useQuery<SyncStatus>({
        queryKey: ["/api/vault/sync-status"],
        refetchInterval: 30_000,
    });

    useEffect(() => {
        if (settings) {
            setRoot(settings.root || "app:/");
            if (settings.hasToken) setToken("********");
        }
    }, [settings]);

    const saveMutation = useMutation({
        mutationFn: async (data: { token?: string; root: string }) => {
            const res = await apiRequest("POST", "/api/vault/settings", data);
            return res.json();
        },
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["/api/vault/settings"] });
            if (data.isConnected) {
                toast({ title: "✅ Подключено!", description: `Яндекс.Диск: ${data.connectionUser || 'OK'}` });
            } else if (data.connectionError) {
                toast({ title: "⚠️ Настройки сохранены", description: `Ошибка подключения: ${data.connectionError}`, variant: "destructive" });
            } else {
                toast({ title: "Сохранено", description: "Настройки обновлены" });
            }
        },
    });

    const syncMutation = useMutation({
        mutationFn: async () => {
            const res = await apiRequest("POST", "/api/vault/sync", {});
            return res.json();
        },
        onSuccess: (data) => {
            toast({ title: "Успех", description: data.message });
        },
    });

    const checkChangesMutation = useMutation({
        mutationFn: async () => {
            const res = await apiRequest("GET", "/api/vault/remote-changes");
            return res.json() as Promise<RemoteChanges>;
        },
        onSuccess: (data) => {
            const total = data.changed.length + data.newFiles.length;
            if (total === 0) {
                toast({ title: "✅ Нет изменений", description: `Все ${data.total} файлов синхронизированы` });
            } else {
                toast({ title: `📥 Найдено ${total} изменений`, description: `Изменено: ${data.changed.length}, Новых: ${data.newFiles.length}` });
            }
        },
        onError: () => {
            toast({ title: "Ошибка", description: "Не удалось проверить изменения", variant: "destructive" });
        },
    });

    const pullMutation = useMutation({
        mutationFn: async () => {
            const res = await apiRequest("POST", "/api/vault/pull", {});
            return res.json() as Promise<PullResult>;
        },
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["/api/vault/sync-status"] });
            toast({
                title: "📥 Pull завершён",
                description: data.message,
            });
        },
        onError: () => {
            toast({ title: "Ошибка", description: "Не удалось выполнить pull", variant: "destructive" });
        },
    });

    const watcherMutation = useMutation({
        mutationFn: async (enabled: boolean) => {
            const res = await apiRequest("POST", "/api/vault/watcher", { enabled, intervalMinutes: 5 });
            return res.json();
        },
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["/api/vault/sync-status"] });
            toast({ title: data.running ? "▶️ Watcher запущен" : "⏸️ Watcher остановлен" });
        },
    });

    const handleSave = () => {
        saveMutation.mutate({ token: token === "********" ? undefined : token, root });
    };

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
                                <Cloud className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                                    Obsidian Bridge
                                </h1>
                                <p className="text-gray-500 dark:text-gray-400 text-sm">
                                    Двунаправленная синхронизация заметок с Obsidian через Яндекс.Диск
                                </p>
                            </div>
                        </div>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
                    <div className="max-w-4xl mx-auto">

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-start">
                    {/* Main Settings */}
                    <Card className="md:col-span-2 shadow-xl border-none bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm">
                        <CardHeader>
                            <CardTitle className="text-xl">Настройки облака</CardTitle>
                            <CardDescription>
                                Подключите ваш Яндекс.Диск для зеркалирования заметок
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="space-y-2">
                                <Label htmlFor="token" className="flex items-center gap-2">
                                    <ShieldCheck className="h-4 w-4 text-green-500" />
                                    Yandex Disk OAuth Token
                                </Label>
                                <Input
                                    id="token"
                                    type="password"
                                    placeholder="Ваш токен..."
                                    value={token}
                                    onChange={(e) => setToken(e.target.value)}
                                    className="bg-white dark:bg-gray-900 max-w-md"
                                />
                                <p className="text-xs text-gray-500 flex items-center gap-1">
                                    <ExternalLink className="h-3 w-3" />
                                    <a 
                                        href="https://oauth.yandex.ru/client/new" 
                                        target="_blank" 
                                        rel="noreferrer"
                                        className="text-blue-500 hover:underline"
                                    >
                                        Получить токен (выберите «Доступ к папке приложения»)
                                    </a>
                                </p>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="root" className="flex items-center gap-2">
                                    <Database className="h-4 w-4 text-blue-500" />
                                    Путь к папке в облаке
                                </Label>
                                <Input
                                    id="root"
                                    placeholder="app:/"
                                    value={root}
                                    onChange={(e) => setRoot(e.target.value)}
                                    className="bg-white dark:bg-gray-900 max-w-md"
                                />
                                <p className="text-xs text-gray-500">
                                    Используйте <strong>app:/</strong> для папки приложения (рекомендуется) или путь от корня (например, <i>Obsidian/Vault</i>).
                                </p>
                            </div>

                            <div className="pt-4 flex justify-end">
                                <Button 
                                    onClick={handleSave} 
                                    className="bg-blue-600 hover:bg-blue-700 text-white"
                                    disabled={saveMutation.isPending}
                                >
                                    <Save className="h-4 w-4 mr-2" />
                                    {saveMutation.isPending ? "Сохранение..." : "Сохранить настройки"}
                                </Button>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Status & Sync */}
                    <Card className="shadow-lg border-none bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-gray-800 dark:to-gray-900">
                        <CardHeader>
                            <CardTitle className="text-lg">Статус</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="flex flex-col items-center gap-2 py-4">
                                <div className={`h-16 w-16 rounded-full flex items-center justify-center ${settings?.isConnected ? 'bg-green-100 text-green-600' : settings?.connectionError ? 'bg-red-100 text-red-500' : 'bg-gray-100 text-gray-400'}`}>
                                    <Cloud className="h-8 w-8" />
                                </div>
                                <Badge variant={settings?.isConnected ? "default" : "secondary"} className={settings?.isConnected ? "bg-green-600" : settings?.connectionError ? "bg-red-500 text-white" : ""}>
                                    {settings?.isConnected ? "Подключено" : settings?.connectionError ? "Ошибка" : "Не настроено"}
                                </Badge>
                                {settings?.isConnected && settings.connectionUser && (
                                    <p className="text-xs text-green-600 font-medium text-center">{settings.connectionUser}</p>
                                )}
                                {settings?.connectionError && (
                                    <p className="text-xs text-red-500 text-center mt-1">{settings.connectionError}</p>
                                )}
                            </div>

                            {settings?.isConnected && (
                                <div className="space-y-3">
                                    <Button 
                                        variant="outline" 
                                        className="w-full bg-white dark:bg-gray-800"
                                        onClick={() => syncMutation.mutate()}
                                        disabled={syncMutation.isPending}
                                    >
                                        <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
                                        Выгрузить всё в облако
                                    </Button>
                                    <p className="text-[10px] text-center text-gray-500 leading-tight">
                                        Полная выгрузка всех заметок из БД → облако.
                                    </p>
                                </div>
                            )}

                            <div className="pt-4 space-y-2">
                                <div className="flex items-center gap-2 text-xs font-medium text-gray-500">
                                    <FileText className="h-3 w-3" />
                                    ЛОКАЛЬНОЕ ХРАНИЛИЩЕ
                                </div>
                                <div className="text-xs p-2 bg-gray-100 dark:bg-gray-800 rounded font-mono">
                                    /root/projects/.../vault/
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* ========== ОБРАТНАЯ СИНХРОНИЗАЦИЯ (Stage 3) ========== */}
                {settings?.isConnected && (
                    <Card className="mt-6 shadow-xl border-none bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm">
                        <CardHeader>
                            <CardTitle className="text-xl flex items-center gap-2">
                                <Download className="h-5 w-5 text-purple-500" />
                                Обратная синхронизация
                            </CardTitle>
                            <CardDescription>
                                Получайте изменения из Obsidian обратно в Assistant
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                {/* Watcher Status */}
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="text-sm font-medium">Фоновый мониторинг</div>
                                            <div className="text-xs text-gray-500">Автоматическая проверка каждые 5 мин</div>
                                        </div>
                                        <Badge variant={syncStatus?.running ? "default" : "secondary"} className={syncStatus?.running ? "bg-green-600" : ""}>
                                            {syncStatus?.running ? "Активен" : "Выключен"}
                                        </Badge>
                                    </div>

                                    <Button
                                        variant="outline"
                                        className="w-full"
                                        onClick={() => watcherMutation.mutate(!syncStatus?.running)}
                                        disabled={watcherMutation.isPending}
                                    >
                                        {syncStatus?.running ? (
                                            <><Pause className="h-4 w-4 mr-2" /> Остановить мониторинг</>
                                        ) : (
                                            <><Play className="h-4 w-4 mr-2" /> Запустить мониторинг</>
                                        )}
                                    </Button>

                                    {syncStatus?.lastSyncAt && (
                                        <div className="text-xs text-gray-500 space-y-1">
                                            <div>Последняя проверка: {new Date(syncStatus.lastSyncAt).toLocaleString("ru-RU")}</div>
                                            <div>Отслеживается файлов: {syncStatus.trackedFiles}</div>
                                        </div>
                                    )}
                                </div>

                                {/* Manual Actions */}
                                <div className="space-y-3">
                                    <Button
                                        variant="outline"
                                        className="w-full bg-white dark:bg-gray-800"
                                        onClick={() => checkChangesMutation.mutate()}
                                        disabled={checkChangesMutation.isPending}
                                    >
                                        <Eye className={`h-4 w-4 mr-2 ${checkChangesMutation.isPending ? 'animate-pulse' : ''}`} />
                                        {checkChangesMutation.isPending ? "Проверка..." : "Проверить изменения"}
                                    </Button>

                                    <Button
                                        className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                                        onClick={() => pullMutation.mutate()}
                                        disabled={pullMutation.isPending}
                                    >
                                        <Download className={`h-4 w-4 mr-2 ${pullMutation.isPending ? 'animate-bounce' : ''}`} />
                                        {pullMutation.isPending ? "Загрузка..." : "Синхронизировать из облака"}
                                    </Button>

                                    {pullMutation.data && (
                                        <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg text-xs space-y-1">
                                            <div className="font-medium text-purple-700 dark:text-purple-300">Результат pull:</div>
                                            <div>✨ Создано: {pullMutation.data.created}</div>
                                            <div>🔄 Обновлено: {pullMutation.data.updated}</div>
                                            <div>⏭️ Пропущено: {pullMutation.data.skipped}</div>
                                            {pullMutation.data.errors.length > 0 && (
                                                <div className="text-red-500">❌ Ошибки: {pullMutation.data.errors.length}</div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                )}

                <div className="mt-12">
                    <h2 className="text-xl font-bold mb-4">Архитектура Bridge</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg shadow sm">
                            <div className="font-bold text-blue-500 mb-1">1. База Данных</div>
                            <p className="text-xs text-gray-500">Используется как скоростной кэш, индекс для поиска и связей.</p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg shadow sm">
                            <div className="font-bold text-green-500 mb-1">2. Яндекс.Диск</div>
                            <p className="text-xs text-gray-500">Облачное хранилище Markdown-файлов. Двунаправленный обмен.</p>
                        </div>
                        <div className="p-4 bg-white dark:bg-gray-800 rounded-lg shadow sm">
                            <div className="font-bold text-purple-500 mb-1">3. Obsidian</div>
                            <p className="text-xs text-gray-500">Ваш интерфейс для визуализации графа и богатого редактирования.</p>
                        </div>
                    </div>
                </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
