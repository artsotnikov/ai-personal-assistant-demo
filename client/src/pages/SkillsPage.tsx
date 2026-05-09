/**
 * SkillsPage — Управление модульными навыками AI
 * 
 * Позволяет просматривать, включать/отключать, создавать и удалять навыки.
 */

import { useState } from "react";
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
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    ArrowLeft,
    Plus,
    Trash2,
    Edit,
    Puzzle,
    Tag,
    Sparkles,
} from "lucide-react";
import ChatHeader from "@/components/chat/ChatHeader";

// ============================================================================
// Types
// ============================================================================

interface Skill {
    id: number;
    slug: string;
    name: string;
    description: string;
    content: string;
    category: string;
    isBuiltin: boolean;
    isActive: boolean;
    triggerKeywords: string[];
    icon: string;
    effectiveEnabled: boolean;
    createdAt: string;
    updatedAt: string;
}

// ============================================================================
// Component
// ============================================================================

export default function SkillsPage() {
    const [, navigate] = useLocation();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [showCreateDialog, setShowCreateDialog] = useState(false);
    const [editingSkill, setEditingSkill] = useState<Skill | null>(null);

    // Form state
    const [formName, setFormName] = useState("");
    const [formDescription, setFormDescription] = useState("");
    const [formContent, setFormContent] = useState("");
    const [formCategory, setFormCategory] = useState("custom");
    const [formKeywords, setFormKeywords] = useState("");
    const [formIcon, setFormIcon] = useState("🧩");

    // --- Queries ---
    const { data: skills = [], isLoading } = useQuery<Skill[]>({
        queryKey: ["/api/skills"],
    });

    // --- Mutations ---
    const toggleMutation = useMutation({
        mutationFn: async ({ id, isEnabled }: { id: number; isEnabled: boolean }) => {
            await apiRequest("PATCH", `/api/skills/${id}/toggle`, { isEnabled });
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
        },
        onError: (error: any) => {
            toast({
                title: "Ошибка",
                description: error.message || "Не удалось переключить навык",
                variant: "destructive",
            });
        },
    });

    const createMutation = useMutation({
        mutationFn: async (data: any) => {
            const res = await apiRequest("POST", "/api/skills", data);
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
            setShowCreateDialog(false);
            resetForm();
            toast({ title: "Навык создан", description: "Новый навык успешно добавлен" });
        },
        onError: (error: any) => {
            toast({
                title: "Ошибка",
                description: error.message || "Не удалось создать навык",
                variant: "destructive",
            });
        },
    });

    const updateMutation = useMutation({
        mutationFn: async ({ id, data }: { id: number; data: any }) => {
            const res = await apiRequest("PATCH", `/api/skills/${id}`, data);
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
            setEditingSkill(null);
            resetForm();
            toast({ title: "Навык обновлён" });
        },
        onError: (error: any) => {
            toast({
                title: "Ошибка",
                description: error.message || "Не удалось обновить навык",
                variant: "destructive",
            });
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: number) => {
            await apiRequest("DELETE", `/api/skills/${id}`);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/skills"] });
            toast({ title: "Навык удалён" });
        },
        onError: (error: any) => {
            toast({
                title: "Ошибка",
                description: error.message || "Не удалось удалить навык",
                variant: "destructive",
            });
        },
    });

    // --- Helpers ---
    const resetForm = () => {
        setFormName("");
        setFormDescription("");
        setFormContent("");
        setFormCategory("custom");
        setFormKeywords("");
        setFormIcon("🧩");
    };

    const openEditDialog = (skill: Skill) => {
        setEditingSkill(skill);
        setFormName(skill.name);
        setFormDescription(skill.description);
        setFormContent(skill.content);
        setFormCategory(skill.category);
        setFormKeywords(skill.triggerKeywords.join(", "));
        setFormIcon(skill.icon);
    };

    const handleSubmit = () => {
        const data = {
            name: formName,
            description: formDescription,
            content: formContent,
            category: formCategory,
            triggerKeywords: formKeywords.split(",").map(k => k.trim()).filter(Boolean),
            icon: formIcon,
        };

        if (editingSkill) {
            updateMutation.mutate({ id: editingSkill.id, data });
        } else {
            createMutation.mutate(data);
        }
    };

    // --- Group by category ---
    const grouped = skills.reduce<Record<string, Skill[]>>((acc, skill) => {
        const cat = skill.category;
        if (!acc[cat]) acc[cat] = [];
        acc[cat].push(skill);
        return acc;
    }, {});

    const categoryLabels: Record<string, string> = {
        business: "🏢 Бизнес",
        analytics: "📊 Аналитика",
        coaching: "🎯 Коучинг",
        custom: "🧩 Пользовательские",
    };

    const categoryOrder = ["business", "analytics", "coaching", "custom"];

    // --- Render ---
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
                                <Puzzle className="h-6 w-6 text-purple-500" />
                                Навыки AI
                            </h1>
                        </div>
                        <Dialog open={showCreateDialog} onOpenChange={(open) => {
                            setShowCreateDialog(open);
                            if (!open) resetForm();
                        }}>
                            <DialogTrigger asChild>
                                <Button size="sm" className="gap-1.5">
                                    <Plus className="h-4 w-4" />
                                    Создать
                                </Button>
                            </DialogTrigger>
                            <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                                <DialogHeader>
                                    <DialogTitle>Новый навык</DialogTitle>
                                    <DialogDescription>
                                        Создайте пользовательский навык с инструкциями для AI
                                    </DialogDescription>
                                </DialogHeader>
                                <SkillForm
                                    name={formName} onNameChange={setFormName}
                                    description={formDescription} onDescriptionChange={setFormDescription}
                                    content={formContent} onContentChange={setFormContent}
                                    category={formCategory} onCategoryChange={setFormCategory}
                                    keywords={formKeywords} onKeywordsChange={setFormKeywords}
                                    icon={formIcon} onIconChange={setFormIcon}
                                />
                                <DialogFooter>
                                    <Button onClick={handleSubmit} disabled={createMutation.isPending || !formName || !formContent}>
                                        {createMutation.isPending ? "Создание..." : "Создать навык"}
                                    </Button>
                                </DialogFooter>
                            </DialogContent>
                        </Dialog>
                    </div>
                </header>

                {/* Content */}
                <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                    <div className="max-w-6xl mx-auto space-y-6">
                        {isLoading ? (
                            <div className="flex items-center justify-center py-20">
                                <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
                            </div>
                        ) : skills.length === 0 ? (
                            <Card className="border-dashed">
                                <CardContent className="py-12 text-center">
                                    <Sparkles className="h-12 w-12 text-gray-400 mx-auto mb-4" />
                                    <h3 className="text-lg font-medium text-gray-700 dark:text-gray-300 mb-2">
                                        Навыки ещё не созданы
                                    </h3>
                                    <p className="text-gray-500 mb-4">
                                        Запустите приложение для создания встроенных навыков
                                    </p>
                                </CardContent>
                            </Card>
                        ) : (
                            categoryOrder
                                .filter(cat => grouped[cat]?.length)
                                .map(category => (
                                    <div key={category} className="space-y-3">
                                        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-1">
                                            {categoryLabels[category] || category}
                                        </h2>
                                        <div className="grid gap-3">
                                            {grouped[category].map(skill => (
                                                <SkillCard
                                                    key={skill.id}
                                                    skill={skill}
                                                    onToggle={(enabled) => toggleMutation.mutate({ id: skill.id, isEnabled: enabled })}
                                                    onEdit={() => openEditDialog(skill)}
                                                    onDelete={() => {
                                                        if (confirm(`Удалить навык «${skill.name}»?`)) {
                                                            deleteMutation.mutate(skill.id);
                                                        }
                                                    }}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                ))
                        )}
                    </div>
                </main>
            </div>

            {/* Edit Dialog */}
            <Dialog open={!!editingSkill} onOpenChange={(open) => {
                if (!open) { setEditingSkill(null); resetForm(); }
            }}>
                <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                    <DialogHeader>
                        <DialogTitle>Редактирование навыка</DialogTitle>
                        <DialogDescription>
                            {editingSkill?.isBuiltin ? "Встроенный навык — можно менять содержимое" : "Пользовательский навык"}
                        </DialogDescription>
                    </DialogHeader>
                    <SkillForm
                        name={formName} onNameChange={setFormName}
                        description={formDescription} onDescriptionChange={setFormDescription}
                        content={formContent} onContentChange={setFormContent}
                        category={formCategory} onCategoryChange={setFormCategory}
                        keywords={formKeywords} onKeywordsChange={setFormKeywords}
                        icon={formIcon} onIconChange={setFormIcon}
                    />
                    <DialogFooter>
                        <Button onClick={handleSubmit} disabled={updateMutation.isPending || !formName || !formContent}>
                            {updateMutation.isPending ? "Сохранение..." : "Сохранить"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}

// ============================================================================
// Sub-components
// ============================================================================

function SkillCard({
    skill,
    onToggle,
    onEdit,
    onDelete,
}: {
    skill: Skill;
    onToggle: (enabled: boolean) => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    return (
        <Card className="group h-full hover:shadow-md transition-shadow border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 opacity-90 hover:opacity-100 flex flex-col">
            <CardContent className="p-4 flex flex-col h-full">
                <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                        <div className="text-2xl shrink-0">{skill.icon}</div>
                        <h3 className="font-semibold text-gray-900 dark:text-gray-100 truncate">
                            {skill.name}
                        </h3>
                        {skill.isBuiltin && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
                                встроенный
                            </Badge>
                        )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                        <Switch
                            checked={skill.effectiveEnabled}
                            onCheckedChange={onToggle}
                        />
                    </div>
                </div>

                <div className="flex-1 flex flex-col">
                    <p className="text-sm text-gray-500 dark:text-gray-400 line-clamp-3 mb-3">
                        {skill.description}
                    </p>

                    <div className="mt-auto pt-2 flex items-center justify-between border-t border-gray-100 dark:border-gray-800">
                        {skill.triggerKeywords.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                                {skill.triggerKeywords.slice(0, 3).map((kw, i) => (
                                    <span
                                        key={i}
                                        className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400"
                                    >
                                        <Tag className="h-2.5 w-2.5" />
                                        {kw}
                                    </span>
                                ))}
                                {skill.triggerKeywords.length > 3 && (
                                    <span className="text-[11px] text-gray-400">
                                        +{skill.triggerKeywords.length - 3}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <div />
                        )}

                        <div className="flex items-center gap-1 shrink-0 ml-2">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={onEdit}
                            >
                                <Edit className="h-4 w-4" />
                            </Button>
                            {!skill.isBuiltin && (
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-red-500 hover:text-red-600"
                                    onClick={onDelete}
                                >
                                    <Trash2 className="h-4 w-4" />
                                </Button>
                            )}
                        </div>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function SkillForm({
    name, onNameChange,
    description, onDescriptionChange,
    content, onContentChange,
    category, onCategoryChange,
    keywords, onKeywordsChange,
    icon, onIconChange,
}: {
    name: string; onNameChange: (v: string) => void;
    description: string; onDescriptionChange: (v: string) => void;
    content: string; onContentChange: (v: string) => void;
    category: string; onCategoryChange: (v: string) => void;
    keywords: string; onKeywordsChange: (v: string) => void;
    icon: string; onIconChange: (v: string) => void;
}) {
    return (
        <div className="space-y-4">
            <div className="grid grid-cols-[60px_1fr] gap-3">
                <div>
                    <Label htmlFor="icon">Иконка</Label>
                    <Input
                        id="icon"
                        value={icon}
                        onChange={(e) => onIconChange(e.target.value)}
                        className="text-center text-xl mt-1"
                        maxLength={4}
                    />
                </div>
                <div>
                    <Label htmlFor="name">Название</Label>
                    <Input
                        id="name"
                        value={name}
                        onChange={(e) => onNameChange(e.target.value)}
                        placeholder="Анализ продаж"
                        className="mt-1"
                    />
                </div>
            </div>

            <div>
                <Label htmlFor="description">Описание</Label>
                <Input
                    id="description"
                    value={description}
                    onChange={(e) => onDescriptionChange(e.target.value)}
                    placeholder="Краткое описание навыка для UI"
                    className="mt-1"
                />
            </div>

            <div>
                <Label htmlFor="content">Инструкции для AI (Markdown)</Label>
                <Textarea
                    id="content"
                    value={content}
                    onChange={(e) => onContentChange(e.target.value)}
                    placeholder="## Навык: ...&#10;&#10;Когда пользователь обсуждает ...&#10;&#10;### Подход&#10;- ..."
                    className="mt-1 min-h-[200px] font-mono text-sm"
                />
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <Label htmlFor="category">Категория</Label>
                    <select
                        id="category"
                        value={category}
                        onChange={(e) => onCategoryChange(e.target.value)}
                        className="mt-1 w-full rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 px-3 py-2 text-sm"
                    >
                        <option value="business">🏢 Бизнес</option>
                        <option value="analytics">📊 Аналитика</option>
                        <option value="coaching">🎯 Коучинг</option>
                        <option value="custom">🧩 Пользовательские</option>
                    </select>
                </div>
                <div>
                    <Label htmlFor="keywords">Ключевые слова</Label>
                    <Input
                        id="keywords"
                        value={keywords}
                        onChange={(e) => onKeywordsChange(e.target.value)}
                        placeholder="avito, продажи, цены"
                        className="mt-1"
                    />
                    <p className="text-[11px] text-gray-400 mt-1">Через запятую</p>
                </div>
            </div>
        </div>
    );
}
