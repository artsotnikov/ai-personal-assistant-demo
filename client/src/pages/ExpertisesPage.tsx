/**
 * ExpertisesPage — Управление экспертизами Universal Agent
 * 
 * CRUD: просмотр, создание, редактирование, удаление, вкл/выкл экспертиз.
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    ArrowLeft,
    Plus,
    Pencil,
    Trash2,
    Sparkles,
    Tag,
    Wrench,
    BrainCircuit,
    Loader2,
    Search,
    ArrowUpDown,
    Lock,
} from "lucide-react";

import ChatHeader from "@/components/chat/ChatHeader";

// ============================================================================
// Types
// ============================================================================

interface Expertise {
    id: number;
    slug: string;
    name: string;
    promptTemplate: string;
    toolPacks: string[];
    triggerDomains: string[];
    contextPreferences: {
        loadGoals?: boolean;
        loadMetrics?: boolean;
        loadCompetitors?: boolean;
        factSearchDepth?: "shallow" | "deep";
        maxFacts?: number;
    };
    isActive: boolean;
    priority: number;
    createdAt: string;
    updatedAt: string;
}

interface ExpertiseFormData {
    slug: string;
    name: string;
    promptTemplate: string;
    toolPacks: string[];
    triggerDomains: string[];
    contextPreferences: {
        loadGoals: boolean;
        loadMetrics: boolean;
        loadCompetitors: boolean;
        factSearchDepth: "shallow" | "deep";
        maxFacts: number;
    };
    priority: number;
}

/** Метаданные пака инструментов (с сервера) */
interface ToolPackInfo {
    id: string;
    name: string;
    description: string;
    icon: string;
    alwaysInclude: boolean;
    tools: Array<{ name: string; description: string }>;
    toolCount: number;
}

const DEFAULT_FORM: ExpertiseFormData = {
    slug: "",
    name: "",
    promptTemplate: "",
    toolPacks: ["core"],
    triggerDomains: [],
    contextPreferences: {
        loadGoals: true,
        loadMetrics: false,
        loadCompetitors: false,
        factSearchDepth: "shallow",
        maxFacts: 10,
    },
    priority: 0,
};

// ============================================================================
// ExpertiseCard
// ============================================================================

function ExpertiseCard({
    expertise,
    onEdit,
    onDelete,
    onToggle,
    toolPacksMap,
}: {
    expertise: Expertise;
    onEdit: () => void;
    onDelete: () => void;
    onToggle: (isActive: boolean) => void;
    toolPacksMap: Record<string, ToolPackInfo>;
}) {
    return (
        <Card className={`h-full hover:shadow-xl transition-all duration-300 border border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm flex flex-col group ${!expertise.isActive ? "opacity-60 grayscale-[0.8] hover:opacity-100 hover:grayscale-0" : "hover:-translate-y-1"}`}>
            <CardHeader className="pb-4 pt-5 px-5 border-b border-slate-100 dark:border-slate-800/50">
                <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                        <div className="p-2.5 rounded-2xl bg-gradient-to-br from-orange-100 to-orange-50 dark:from-orange-500/20 dark:to-orange-500/5 text-orange-600 dark:text-orange-500 shrink-0 shadow-sm border border-orange-200/50 dark:border-orange-500/20">
                            <Sparkles className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 pt-0.5">
                            <CardTitle className="text-lg font-semibold tracking-tight truncate text-slate-900 dark:text-slate-100">
                                {expertise.name}
                            </CardTitle>
                            <CardDescription className="text-xs font-mono mt-1 text-slate-500 dark:text-slate-400">
                                {expertise.slug}
                            </CardDescription>
                        </div>
                    </div>
                    <div className="flex items-center shrink-0 pt-1">
                        <Switch
                            checked={expertise.isActive}
                            onCheckedChange={onToggle}
                        />
                    </div>
                </div>
            </CardHeader>
            <CardContent className="px-5 py-4 flex-grow space-y-5">
                {/* Tool Packs */}
                <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                        <Wrench className="h-3.5 w-3.5" />
                        Инструменты
                    </div>
                    <TooltipProvider delayDuration={200}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            {expertise.toolPacks?.length > 0 ? (
                                expertise.toolPacks.map((pack) => {
                                    const meta = toolPacksMap[pack];
                                    return (
                                        <Tooltip key={pack}>
                                            <TooltipTrigger asChild>
                                                <Badge
                                                    variant="secondary"
                                                    className="px-2 py-0.5 text-[11px] font-medium bg-slate-100 hover:bg-slate-200 text-slate-700 dark:bg-slate-800 dark:hover:bg-slate-700 dark:text-slate-300 border-transparent transition-colors cursor-default"
                                                >
                                                    {meta?.icon ?? '📦'} {meta?.name ?? pack}
                                                </Badge>
                                            </TooltipTrigger>
                                            {meta && (
                                                <TooltipContent side="top" className="max-w-[260px] p-3">
                                                    <p className="font-semibold text-xs mb-1">{meta.icon} {meta.name}</p>
                                                    <p className="text-xs text-muted-foreground mb-2">{meta.description}</p>
                                                    {meta.tools.length > 0 && (
                                                        <div className="flex flex-wrap gap-1">
                                                            {meta.tools.slice(0, 6).map(t => (
                                                                <span key={t.name} className="text-[10px] font-mono bg-muted px-1 py-0.5 rounded">{t.name}</span>
                                                            ))}
                                                            {meta.tools.length > 6 && (
                                                                <span className="text-[10px] text-muted-foreground">+{meta.tools.length - 6}</span>
                                                            )}
                                                        </div>
                                                    )}
                                                </TooltipContent>
                                            )}
                                        </Tooltip>
                                    );
                                })
                            ) : (
                                <span className="text-xs text-slate-400 italic">Нет инструментов</span>
                            )}
                        </div>
                    </TooltipProvider>
                </div>


                {/* Trigger Domains */}
                {expertise.triggerDomains?.length > 0 && (
                    <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                            <Tag className="h-3.5 w-3.5" />
                            Триггеры
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            {expertise.triggerDomains.slice(0, 5).map((domain) => (
                                <Badge key={domain} variant="outline" className="px-2 py-0.5 text-[11px] font-normal border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 bg-white dark:bg-slate-900">
                                    {domain}
                                </Badge>
                            ))}
                            {expertise.triggerDomains.length > 5 && (
                                <Badge variant="outline" className="px-2 py-0.5 text-[11px] font-normal border-dashed border-slate-300 dark:border-slate-600 text-slate-500">
                                    +{expertise.triggerDomains.length - 5}
                                </Badge>
                            )}
                        </div>
                    </div>
                )}

                {/* Context Preferences */}
                <div className="flex flex-col gap-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 p-3.5 border border-slate-100 dark:border-slate-800/80">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                        <BrainCircuit className="h-3.5 w-3.5" />
                        Контекст
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {expertise.contextPreferences?.loadGoals && (
                            <Badge variant="secondary" className="text-[10px] uppercase font-bold tracking-wider bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:hover:bg-emerald-500/20 border-transparent">Цели</Badge>
                        )}
                        {expertise.contextPreferences?.loadMetrics && (
                            <Badge variant="secondary" className="text-[10px] uppercase font-bold tracking-wider bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-500/10 dark:text-blue-400 dark:hover:bg-blue-500/20 border-transparent">Метрики</Badge>
                        )}
                        {expertise.contextPreferences?.loadCompetitors && (
                            <Badge variant="secondary" className="text-[10px] uppercase font-bold tracking-wider bg-purple-100 text-purple-700 hover:bg-purple-200 dark:bg-purple-500/10 dark:text-purple-400 dark:hover:bg-purple-500/20 border-transparent">Конкуренты</Badge>
                        )}
                        {!(expertise.contextPreferences?.loadGoals || expertise.contextPreferences?.loadMetrics || expertise.contextPreferences?.loadCompetitors) && (
                            <span className="text-xs text-slate-400 italic">Без обогащения</span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 pt-1 mt-1 border-t border-slate-200/50 dark:border-slate-700/50">
                        <Search className="h-3.5 w-3.5 text-slate-400" />
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                            <span className="font-medium text-slate-700 dark:text-slate-300">
                                {expertise.contextPreferences?.factSearchDepth === "deep" ? "Глубокий" : "Поверхностный"}
                            </span>
                            {" "}поиск, max <span className="font-medium text-slate-700 dark:text-slate-300">{expertise.contextPreferences?.maxFacts ?? 10}</span> фактов
                        </span>
                    </div>
                </div>

                {/* Priority + Prompt preview */}
                <div className="flex items-center justify-between pt-1">
                    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-xs font-semibold text-slate-600 dark:text-slate-300 ring-1 ring-slate-200/50 dark:ring-slate-700/50">
                        <ArrowUpDown className="h-3.5 w-3.5" />
                        P{expertise.priority}
                    </div>
                    <span className="text-xs text-slate-400 font-medium truncate max-w-[150px] cursor-help" title={expertise.promptTemplate}>
                        {expertise.promptTemplate?.substring(0, 35)}{expertise.promptTemplate?.length > 35 ? "..." : ""}
                    </span>
                </div>
            </CardContent>

            <div className="p-5 pt-0 mt-auto">
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={onEdit} className="flex-1 bg-white hover:bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800 dark:border-slate-800 dark:text-slate-300 transition-colors shadow-sm">
                        <Pencil className="h-3.5 w-3.5 mr-2" />
                        Редактировать
                    </Button>
                    <Button variant="outline" size="sm" onClick={onDelete}
                        className="w-10 px-0 flex-shrink-0 border-slate-200 hover:border-red-200 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:border-slate-800 dark:hover:border-red-900/50 dark:hover:text-red-400 dark:hover:bg-red-900/20 dark:bg-slate-900 transition-colors shadow-sm">
                        <Trash2 className="h-4 w-4" />
                    </Button>
                </div>
            </div>
        </Card>
    );
}

// ============================================================================
// ExpertiseFormDialog
// ============================================================================

function ExpertiseFormDialog({
    open,
    onOpenChange,
    initialData,
    isEditing,
    onSubmit,
    isSubmitting,
    toolPacks,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    initialData: ExpertiseFormData;
    isEditing: boolean;
    onSubmit: (data: ExpertiseFormData) => void;
    isSubmitting: boolean;
    toolPacks: ToolPackInfo[];
}) {
    const [form, setForm] = useState<ExpertiseFormData>(initialData);
    const [triggerDomainsStr, setTriggerDomainsStr] = useState(
        initialData.triggerDomains?.join(", ") || ""
    );

    // Sync form state when dialog opens or initialData changes
    useEffect(() => {
        if (open) {
            setForm(initialData);
            setTriggerDomainsStr(initialData.triggerDomains?.join(", ") || "");
        }
    }, [open, initialData]);

    // Reset form when dialog opens with new data
    const handleOpenChange = (isOpen: boolean) => {
        if (isOpen) {
            setForm(initialData);
            setTriggerDomainsStr(initialData.triggerDomains?.join(", ") || "");
        }
        onOpenChange(isOpen);
    };

    const handleSubmit = () => {
        const domains = triggerDomainsStr
            .split(",")
            .map(d => d.trim())
            .filter(Boolean);
        onSubmit({ ...form, triggerDomains: domains });
    };

    const toggleToolPack = (pack: string) => {
        setForm(prev => ({
            ...prev,
            toolPacks: prev.toolPacks.includes(pack)
                ? prev.toolPacks.filter(p => p !== pack)
                : [...prev.toolPacks, pack],
        }));
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>
                        {isEditing ? "Редактировать экспертизу" : "Создать экспертизу"}
                    </DialogTitle>
                    <DialogDescription>
                        {isEditing
                            ? "Измените параметры экспертизы"
                            : "Заполните данные для новой экспертизы"}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-2">
                    {/* Slug */}
                    <div className="space-y-1.5">
                        <Label htmlFor="slug">Slug (идентификатор)</Label>
                        <Input
                            id="slug"
                            value={form.slug}
                            onChange={e => setForm(prev => ({ ...prev, slug: e.target.value }))}
                            placeholder="travel"
                            disabled={isEditing}
                        />
                    </div>

                    {/* Name */}
                    <div className="space-y-1.5">
                        <Label htmlFor="name">Название</Label>
                        <Input
                            id="name"
                            value={form.name}
                            onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))}
                            placeholder="Консультант по путешествиям"
                        />
                    </div>

                    {/* Prompt Template */}
                    <div className="space-y-1.5">
                        <Label htmlFor="promptTemplate">Системный промпт</Label>
                        <Textarea
                            id="promptTemplate"
                            value={form.promptTemplate}
                            onChange={e => setForm(prev => ({ ...prev, promptTemplate: e.target.value }))}
                            placeholder="Ты — эксперт по..."
                            rows={8}
                            className="font-mono text-sm"
                        />
                    </div>

                    {/* Tool Packs */}
                    <div className="space-y-1.5">
                        <Label>Пакеты инструментов</Label>
                        <div className="grid gap-2 pt-1">
                            {toolPacks.map(pack => {
                                const isActive = form.toolPacks.includes(pack.id) || pack.alwaysInclude;
                                return (
                                    <div
                                        key={pack.id}
                                        onClick={() => !pack.alwaysInclude && toggleToolPack(pack.id)}
                                        className={`flex items-start gap-3 p-3 rounded-lg border transition-all ${
                                            pack.alwaysInclude
                                                ? 'border-orange-200 bg-orange-50/60 dark:border-orange-800/50 dark:bg-orange-900/10 cursor-default'
                                                : isActive
                                                    ? 'border-blue-200 bg-blue-50/60 dark:border-blue-800/50 dark:bg-blue-900/10 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-900/20'
                                                    : 'border-slate-200 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 opacity-60 hover:opacity-90'
                                        }`}
                                    >
                                        <span className="text-xl shrink-0 mt-0.5">{pack.icon}</span>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-sm font-semibold">{pack.name}</span>
                                                {pack.alwaysInclude && (
                                                    <Badge variant="secondary" className="text-[10px] gap-1 bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-transparent">
                                                        <Lock className="h-2.5 w-2.5" />
                                                        Обязательный
                                                    </Badge>
                                                )}
                                                <span className="text-[10px] text-muted-foreground ml-auto">{pack.toolCount} инстр.</span>
                                            </div>
                                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{pack.description}</p>
                                            {isActive && pack.tools.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-1.5">
                                                    {pack.tools.slice(0, 5).map(t => (
                                                        <span key={t.name} className="text-[9px] font-mono bg-muted px-1 py-0.5 rounded opacity-80">{t.name}</span>
                                                    ))}
                                                    {pack.tools.length > 5 && (
                                                        <span className="text-[9px] text-muted-foreground">+{pack.tools.length - 5}</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className={`w-4 h-4 rounded border-2 shrink-0 mt-1 transition-colors ${
                                            isActive
                                                ? pack.alwaysInclude ? 'bg-orange-500 border-orange-500' : 'bg-blue-500 border-blue-500'
                                                : 'border-slate-300 dark:border-slate-600'
                                        }`} />
                                    </div>
                                );
                            })}
                        </div>
                    </div>


                    {/* Trigger Domains */}
                    <div className="space-y-1.5">
                        <Label htmlFor="triggerDomains">Trigger Domains (через запятую)</Label>
                        <Input
                            id="triggerDomains"
                            value={triggerDomainsStr}
                            onChange={e => setTriggerDomainsStr(e.target.value)}
                            placeholder="travel, hotel, flight, отпуск, визы"
                        />
                    </div>

                    {/* Priority */}
                    <div className="space-y-1.5">
                        <Label htmlFor="priority">Приоритет (выше = приоритетнее)</Label>
                        <Input
                            id="priority"
                            type="number"
                            value={form.priority}
                            onChange={e => setForm(prev => ({ ...prev, priority: parseInt(e.target.value) || 0 }))}
                        />
                    </div>

                    {/* Context Preferences */}
                    <div className="space-y-2">
                        <Label>Контекстные предпочтения</Label>
                        <div className="grid grid-cols-2 gap-3 p-3 rounded-lg border bg-muted/30">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <Switch
                                    checked={form.contextPreferences.loadGoals}
                                    onCheckedChange={v => setForm(prev => ({
                                        ...prev,
                                        contextPreferences: { ...prev.contextPreferences, loadGoals: v },
                                    }))}
                                />
                                <span className="text-sm">Загружать цели</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <Switch
                                    checked={form.contextPreferences.loadMetrics}
                                    onCheckedChange={v => setForm(prev => ({
                                        ...prev,
                                        contextPreferences: { ...prev.contextPreferences, loadMetrics: v },
                                    }))}
                                />
                                <span className="text-sm">Загружать метрики</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <Switch
                                    checked={form.contextPreferences.loadCompetitors}
                                    onCheckedChange={v => setForm(prev => ({
                                        ...prev,
                                        contextPreferences: { ...prev.contextPreferences, loadCompetitors: v },
                                    }))}
                                />
                                <span className="text-sm">Загружать конкурентов</span>
                            </label>
                            <div className="flex items-center gap-2">
                                <select
                                    className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                                    value={form.contextPreferences.factSearchDepth}
                                    onChange={e => setForm(prev => ({
                                        ...prev,
                                        contextPreferences: {
                                            ...prev.contextPreferences,
                                            factSearchDepth: e.target.value as "shallow" | "deep",
                                        },
                                    }))}
                                >
                                    <option value="shallow">Поверхностный</option>
                                    <option value="deep">Глубокий</option>
                                </select>
                                <span className="text-sm">поиск</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <Input
                                    type="number"
                                    className="h-8 w-20"
                                    value={form.contextPreferences.maxFacts}
                                    onChange={e => setForm(prev => ({
                                        ...prev,
                                        contextPreferences: {
                                            ...prev.contextPreferences,
                                            maxFacts: parseInt(e.target.value) || 10,
                                        },
                                    }))}
                                />
                                <span className="text-sm">макс. фактов</span>
                            </div>
                        </div>
                    </div>
                </div>

                <DialogFooter>
                    <Button variant="outline" onClick={() => onOpenChange(false)}>
                        Отмена
                    </Button>
                    <Button onClick={handleSubmit} disabled={isSubmitting || !form.slug || !form.name || !form.promptTemplate}>
                        {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                        {isEditing ? "Сохранить" : "Создать"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

// ============================================================================
// Main Page
// ============================================================================

export default function ExpertisesPage() {
    const [, setLocation] = useLocation();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [searchQuery, setSearchQuery] = useState("");
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingExpertise, setEditingExpertise] = useState<Expertise | null>(null);
    const [deleteSlug, setDeleteSlug] = useState<string | null>(null);

    // Fetch all expertises (including inactive)
    const { data: expertises = [], isLoading } = useQuery<Expertise[]>({
        queryKey: ["/api/expertises?all=true"],
    });

    // Fetch tool packs metadata
    const { data: toolPacksList = [] } = useQuery<ToolPackInfo[]>({
        queryKey: ["/api/tool-packs"],
        staleTime: Infinity, // Паки не меняются без перезапуска сервера
    });

    // Map для быстрого доступа по id
    const toolPacksMap: Record<string, ToolPackInfo> = {};
    for (const p of toolPacksList) toolPacksMap[p.id] = p;

    // Mutations
    const createMutation = useMutation({
        mutationFn: async (data: ExpertiseFormData) => {
            const res = await apiRequest("POST", "/api/expertises", data);
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/expertises?all=true"] });
            setDialogOpen(false);
            toast({ title: "Экспертиза создана" });
        },
        onError: (e: Error) => {
            toast({ title: "Ошибка", description: e.message, variant: "destructive" });
        },
    });

    const updateMutation = useMutation({
        mutationFn: async ({ slug, data }: { slug: string; data: Partial<ExpertiseFormData> }) => {
            const res = await apiRequest("PATCH", `/api/expertises/${slug}`, data);
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/expertises?all=true"] });
            setDialogOpen(false);
            setEditingExpertise(null);
            toast({ title: "Экспертиза обновлена" });
        },
        onError: (e: Error) => {
            toast({ title: "Ошибка", description: e.message, variant: "destructive" });
        },
    });

    const toggleMutation = useMutation({
        mutationFn: async ({ slug, isActive }: { slug: string; isActive: boolean }) => {
            const res = await apiRequest("PATCH", `/api/expertises/${slug}/toggle`, { isActive });
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/expertises?all=true"] });
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (slug: string) => {
            await apiRequest("DELETE", `/api/expertises/${slug}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/expertises?all=true"] });
            setDeleteSlug(null);
            toast({ title: "Экспертиза удалена" });
        },
        onError: (e: Error) => {
            toast({ title: "Ошибка", description: e.message, variant: "destructive" });
        },
    });

    // Filter
    const filtered = expertises.filter(e =>
        e.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.slug.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const handleCreate = () => {
        setEditingExpertise(null);
        setDialogOpen(true);
    };

    const handleEdit = (expertise: Expertise) => {
        setEditingExpertise(expertise);
        setDialogOpen(true);
    };

    const handleFormSubmit = (data: ExpertiseFormData) => {
        if (editingExpertise) {
            const { slug, ...rest } = data;
            updateMutation.mutate({ slug: editingExpertise.slug, data: rest });
        } else {
            createMutation.mutate(data);
        }
    };

    const formInitialData: ExpertiseFormData = editingExpertise
        ? {
            slug: editingExpertise.slug,
            name: editingExpertise.name,
            promptTemplate: editingExpertise.promptTemplate,
            toolPacks: editingExpertise.toolPacks || ["core"],
            triggerDomains: editingExpertise.triggerDomains || [],
            contextPreferences: {
                loadGoals: editingExpertise.contextPreferences?.loadGoals ?? true,
                loadMetrics: editingExpertise.contextPreferences?.loadMetrics ?? false,
                loadCompetitors: editingExpertise.contextPreferences?.loadCompetitors ?? false,
                factSearchDepth: editingExpertise.contextPreferences?.factSearchDepth ?? "shallow",
                maxFacts: editingExpertise.contextPreferences?.maxFacts ?? 10,
            },
            priority: editingExpertise.priority,
        }
        : DEFAULT_FORM;

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>

            <div className="flex-1 flex flex-col h-full overflow-hidden">
                {/* Header */}
                <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4 shrink-0">
                    <div className="flex items-center justify-between max-w-6xl mx-auto w-full">
                        <div className="flex items-center gap-3">
                            <h1 className="text-2xl font-bold flex items-center gap-2">
                                <Sparkles className="h-6 w-6 text-orange-500" />
                                Экспертизы AI
                            </h1>
                            <Badge variant="secondary" className="mt-1">{expertises.length}</Badge>
                        </div>
                        <Button onClick={handleCreate}>
                            <Plus className="h-4 w-4 mr-2" />
                            Создать
                        </Button>
                    </div>
                </header>

                {/* Content */}
                <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                    <div className="max-w-6xl mx-auto space-y-4">
                        {/* Search */}
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Поиск экспертиз..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="pl-9"
                            />
                        </div>

                        {/* Loading */}
                        {isLoading && (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                            </div>
                        )}

                        {/* Grid */}
                        {!isLoading && (
                            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
                                {filtered.map(expertise => (
                                    <ExpertiseCard
                                        key={expertise.slug}
                                        expertise={expertise}
                                        toolPacksMap={toolPacksMap}
                                        onEdit={() => handleEdit(expertise)}
                                        onDelete={() => setDeleteSlug(expertise.slug)}
                                        onToggle={(isActive) =>
                                            toggleMutation.mutate({ slug: expertise.slug, isActive })
                                        }
                                    />
                                ))}
                            </div>
                        )}

                        {/* Empty state */}
                        {!isLoading && filtered.length === 0 && (
                            <div className="text-center py-12 text-muted-foreground">
                                <Sparkles className="h-12 w-12 mx-auto mb-3 opacity-30" />
                                <p>{searchQuery ? "Ничего не найдено" : "Нет экспертиз"}</p>
                            </div>
                        )}
                    </div>
                </main>
            </div>

            {/* Create/Edit Dialog */}
            <ExpertiseFormDialog
                open={dialogOpen}
                onOpenChange={(open) => {
                    setDialogOpen(open);
                    if (!open) setEditingExpertise(null);
                }}
                initialData={formInitialData}
                isEditing={!!editingExpertise}
                onSubmit={handleFormSubmit}
                isSubmitting={createMutation.isPending || updateMutation.isPending}
                toolPacks={toolPacksList}
            />

            {/* Delete Confirmation */}
            <Dialog open={!!deleteSlug} onOpenChange={() => setDeleteSlug(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Удалить экспертизу?</DialogTitle>
                        <DialogDescription>
                            Экспертиза <strong>{deleteSlug}</strong> будет удалена безвозвратно.
                            Это может повлиять на работу агента, если эта экспертиза используется.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteSlug(null)}>
                            Отмена
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={() => deleteSlug && deleteMutation.mutate(deleteSlug)}
                            disabled={deleteMutation.isPending}
                        >
                            {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                            Удалить
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
