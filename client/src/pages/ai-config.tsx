import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import { Save, Bot, Settings2, Edit2, RefreshCw, Plus, Lock, Code2, Zap, ChevronDown, ChevronUp, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface AIConfig {
    id: number;
    taskType: string;
    provider: string;
    model: string;
    systemPrompt: string | null;
    temperature: string;
    maxTokens: number;
    contextWindow: number | null;
    isActive: boolean;
    description: string | null;
}

/** Форматирует размер контекстного окна: 128000 → "128K", 1048576 → "1M" */
function formatContextWindow(value: number | null | undefined): string {
    if (!value) return "—";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return value.toLocaleString();
}

interface AIProvider {
    id: string;
    name: string;
    available: boolean;
}

interface AIModel {
    id: string;
    name: string;
    provider: string;
    contextLength?: number;
}

const taskTypeLabels: Record<string, string> = {
    // === 🧠 Core Agent ===
    agent_core: "🧠 Core Agent (основная модель)",
    agent_final_answer: "🏆 Финальный ответ (Model Cascade)",
    agent_reflection: "🤔 Рефлексия контекста",
    intent_classification: "🎯 Классификация интента",
    intent_planning: "📋 Генерация плана (high complexity)",
    preference_extraction: "⚙️ Извлечение предпочтений",

    // === 📊 Извлечение данных ===
    goal_extraction: "🎯 Извлечение целей",
    fact_extraction: "📝 Извлечение фактов",
    fact_judge: "⚖️ AI-судья фактов",
    profile_judge: "⚖️ AI-судья профиля",
    profile_extraction: "👤 Извлечение профиля",
    profile_analysis: "👤 Анализ профиля",
    topic_detection: "📂 Определение темы",
    topic_normalization: "📂 Нормализация тем",
    entity_extraction: "🔗 Извлечение сущностей",
    insight_analysis: "💡 Анализ инсайтов",
    reminder_extraction: "🔔 Извлечение напоминаний",
    query_planning: "🔍 Планирование запросов",
    data_classification: "📋 Классификация данных",
    data_ingestion: "📥 Парсинг данных",

    // === 🤖 Автоматизация ===
    ai_cron_extraction: "⏰ Извлечение cron-задач",
    ai_cron_execution: "⏰ Выполнение cron-задач",
    subagent_execution: "🤖 Суб-агент (фоновые задачи)",
    proactive_check: "📡 Проактивные проверки",
    event_handling: "📨 Обработка событий",

    // === 🛠 Специальные ===
    vision_analysis: "🖼️ Анализ изображений (Vision)",
    conversation_summary: "📝 Саммари разговоров",
    default: "⚙️ По умолчанию",
};

/**
 * Захардкоженные промпты — read-only зеркало.
 * Показывают шаблон промпта из кода с плейсхолдерами динамических данных.
 */
const hardcodedPromptTemplates: Record<string, { template: string; source: string }> = {
    agent_core: {
        source: "promptAssembler.ts → assemblePrompt()",
        template: `[Собирается динамически из 5 слоёв]

┌─ Layer 1: Persona ─────────────────────┐
│ {{persona из БД или fallback}}         │
│ "AI-ассистент, персональный помощник"  │
├─ Layer 2: Expertise ───────────────────┤
│ {{expertise.promptTemplate}}           │
│ Берётся из таблицы expertises          │
├─ Layer 3: Workflow ────────────────────┤
│ {{TOOL_WORKFLOW_PROMPT}}               │
│ Инструкции по работе с tools           │
├─ Layer 4: Tools ───────────────────────┤
│ {{описание доступных инструментов}}    │
├─ Layer 5: Context ─────────────────────┤
│ {{профиль, факты, цели, сообщения}}    │
└────────────────────────────────────────┘

+ {{preferencesContext}} — предпочтения
+ {{plan}} — план (при complexity: high)`,
    },
    agent_final_answer: {
        source: "agentOrchestrator.ts → Model Cascade",
        template: `[Использует тот же собранный промпт из assemblePrompt()]

Вызывается как дорогая модель в Model Cascade:
1. agent_core генерирует черновик ответа
2. agent_final_answer получает тот же промпт
   + черновик от agent_core
   → и генерирует финальный, улучшенный ответ`,
    },
    agent_reflection: {
        source: "contextReflector.ts → REFLECTION_SYSTEM_PROMPT",
        template: `Ты — модуль рефлексии AI-ассистента.
Твоя задача — ПЕРЕД ответом пользователю проверить,
достаточно ли данных в контексте для качественного ответа.

ТЫ НЕ ОТВЕЧАЕШЬ ПОЛЬЗОВАТЕЛЮ. Ты только ищешь информацию.

АЛГОРИТМ:
1. Проанализируй вопрос и текущий контекст
2. Представь идеальный ответ (с цифрами, фактами)
3. Проверь, есть ли эти данные в контексте
4. ЕСЛИ ДАННЫХ НЕТ — ВЫЗОВИ ИНСТРУМЕНТЫ (Tools)
5. ЕСЛИ ДАННЫЕ ЕСТЬ — напиши "COMPLETE"

Доступные инструменты: search_facts, search_knowledge,
search_documents, get_metrics, get_goals (Read-Only)`,
    },
    intent_classification: {
        source: "intentClassifier.ts → buildClassifierPrompt()",
        template: `[System] Ты — интеллектуальный классификатор намерений.
Анализируй сообщения и определяй domain, intent и complexity.
Отвечай только валидным JSON.

[User prompt строится динамически:]
- {{список активных экспертиз с доменами и tool packs}}
- {{контекст сессии: тема, настроение, предыдущий агент}}
- {{сообщение пользователя}}

→ Ответ JSON:
{
  domain, intent, complexity (low|medium|high),
  detectedTopics, confidence, reasoning,
  hasQuestion, dataClassification
}`,
    },
    intent_planning: {
        source: "intentClassifier.ts → generatePlan()",
        template: `[System] Ты — планировщик задач.
Создаёшь краткие структурированные планы для сложных запросов.

[User prompt строится динамически:]
- Домен: {{classification.domain}}
- Намерение: {{classification.intent}}
- Темы: {{classification.detectedTopics}}
- Экспертиза: {{classification.expertiseSlugs}}
- Сообщение: {{userMessage}}

→ Нумерованный план 3-5 шагов, не более 200 слов`,
    },
    preference_extraction: {
        source: "preferencesManager.ts → extractPreferencesFromMessage()",
        template: `[System] Ты — точный экстрактор предпочтений пользователя.
Извлекай только стилевые и поведенческие паттерны.

[User prompt строится динамически:]
- {{текущие предпочтения для контекста}}
- Категории: communication, analysis, formatting, workflow, content
- Сообщение: {{userMessage}}
- Ответ AI: {{aiResponse (до 500 символов)}}

✅ Извлекай: стиль, формат, предпочтения по содержанию
❌ НЕ извлекай: биографию, задачи, эмоции, технологии

→ JSON: { preferences: [{category, key, value}] }`,
    },
    vision_analysis: {
        source: "contextBuilder.ts → buildMessagesWithImages()",
        template: `[Отдельного system prompt нет]

Изображения встраиваются как image_url content parts
в сообщения пользователя и обрабатываются
вместе с основным промптом agent_core.

Формат: base64 data URL, detail: 'low'
Модель получает и текст, и изображение одновременно.`,
    },
};

export default function AIConfigPage() {
    const [, setLocation] = useLocation();
    const { toast } = useToast();
    const queryClient = useQueryClient();

    const [editingConfig, setEditingConfig] = useState<AIConfig | null>(null);
    const [creatingConfig, setCreatingConfig] = useState(false);
    const [newTaskType, setNewTaskType] = useState<string>("");
    const [selectedProvider, setSelectedProvider] = useState<string>("");
    const [selectedModel, setSelectedModel] = useState<string>("");
    const [modelSearchQuery, setModelSearchQuery] = useState<string>("");
    const [temperature, setTemperature] = useState<number>(0.3);
    const [maxTokens, setMaxTokens] = useState<number>(500);
    const [systemPrompt, setSystemPrompt] = useState<string>("");
    const [selectedContextWindow, setSelectedContextWindow] = useState<number | null>(null);

    // Bulk replace state
    const [bulkOpen, setBulkOpen] = useState(false);
    const [bulkFromProvider, setBulkFromProvider] = useState<string>("");
    const [bulkToProvider, setBulkToProvider] = useState<string>("");
    const [bulkToModel, setBulkToModel] = useState<string>("");
    const [bulkModelSearch, setBulkModelSearch] = useState<string>("");

    // Fetch all configs
    const { data: configs, isLoading } = useQuery<AIConfig[]>({
        queryKey: ["/api/ai-configs"],
    });

    // Fetch providers
    const { data: providers } = useQuery<AIProvider[]>({
        queryKey: ["/api/ai/providers"],
    });

    // Fetch models for selected provider
    const { data: models, isLoading: modelsLoading, refetch: refetchModels } = useQuery<AIModel[]>({
        queryKey: ["/api/ai/models", selectedProvider],
        queryFn: async () => {
            if (!selectedProvider) return [];
            const res = await fetch(`/api/ai/models?provider=${selectedProvider}`);
            return res.json();
        },
        enabled: !!selectedProvider,
        staleTime: 0, // Всегда считать данные устаревшими, чтобы refetch работал
    });

    // Fetch models for bulk-replace target provider
    const { data: bulkModels, isLoading: bulkModelsLoading } = useQuery<AIModel[]>({
        queryKey: ["/api/ai/models", bulkToProvider],
        queryFn: async () => {
            if (!bulkToProvider) return [];
            const res = await fetch(`/api/ai/models?provider=${bulkToProvider}`);
            return res.json();
        },
        enabled: !!bulkToProvider,
        staleTime: 0,
    });

    // Принудительное обновление списка моделей с инвалидацией кэша
    const handleRefreshModels = async () => {
        await queryClient.invalidateQueries({ queryKey: ["/api/ai/models", selectedProvider] });
        try {
            await refetchModels();
            toast({ title: "Список обновлён", description: `Загружены актуальные модели ${selectedProvider}` });
        } catch {
            toast({ title: "Ошибка", description: "Не удалось загрузить модели с API", variant: "destructive" });
        }
    };

    // Bulk replace mutation
    const bulkUpdateMutation = useMutation({
        mutationFn: async (data: { fromProvider: string; toProvider: string; toModel: string }) => {
            const response = await apiRequest("POST", `/api/ai-configs/bulk-update`, data);
            return response.json();
        },
        onSuccess: (data) => {
            queryClient.invalidateQueries({ queryKey: ["/api/ai-configs"] });
            toast({
                title: "✅ Готово!",
                description: data.message || `Обновлено ${data.updated} конфигураций`,
            });
            setBulkOpen(false);
            setBulkFromProvider("");
            setBulkToProvider("");
            setBulkToModel("");
            setBulkModelSearch("");
        },
        onError: () => {
            toast({
                title: "Ошибка",
                description: "Не удалось выполнить массовую замену",
                variant: "destructive",
            });
        },
    });

    // Update config mutation
    const updateMutation = useMutation({
        mutationFn: async (data: { taskType: string; updates: Partial<AIConfig> }) => {
            const response = await apiRequest("PUT", `/api/ai-configs/${data.taskType}`, data.updates);
            return response.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/ai-configs"] });
            setEditingConfig(null);
            toast({
                title: "Сохранено",
                description: "Конфигурация обновлена",
            });
        },
        onError: () => {
            toast({
                title: "Ошибка",
                description: "Не удалось сохранить конфигурацию",
                variant: "destructive",
            });
        },
    });

    // Create config mutation
    const createMutation = useMutation({
        mutationFn: async (data: { taskType: string; provider: string; model: string; temperature: string; maxTokens: number; contextWindow?: number | null }) => {
            const response = await apiRequest("POST", `/api/ai-configs`, data);
            return response.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/ai-configs"] });
            setCreatingConfig(false);
            setNewTaskType("");
            toast({
                title: "Создано",
                description: "Новая конфигурация добавлена",
            });
        },
        onError: () => {
            toast({
                title: "Ошибка",
                description: "Не удалось создать конфигурацию",
                variant: "destructive",
            });
        },
    });

    // Available task types not yet configured
    const allTaskTypes = Object.keys(taskTypeLabels);
    const configuredTaskTypes = configs?.map(c => c.taskType) || [];
    const availableTaskTypes = allTaskTypes.filter(t => !configuredTaskTypes.includes(t));

    // Refetch models when provider changes
    useEffect(() => {
        if (selectedProvider && (editingConfig || creatingConfig)) {
            refetchModels();
        }
    }, [selectedProvider, editingConfig, creatingConfig]);

    // Open edit modal
    const handleEdit = (config: AIConfig) => {
        setEditingConfig(config);
        setSelectedProvider(config.provider);
        setSelectedModel(config.model);
        setModelSearchQuery("");
        setTemperature(parseFloat(config.temperature) || 0.3);
        setMaxTokens(config.maxTokens);
        setSystemPrompt(config.systemPrompt || "");
        setSelectedContextWindow(config.contextWindow);
    };

    // Save changes
    // Обновить selectedContextWindow при смене модели из dropdown
    useEffect(() => {
        if (selectedModel && models) {
            const found = models.find(m => m.id === selectedModel);
            if (found?.contextLength) {
                setSelectedContextWindow(found.contextLength);
            }
        }
    }, [selectedModel, models]);

    const handleSave = () => {
        if (!editingConfig) return;

        updateMutation.mutate({
            taskType: editingConfig.taskType,
            updates: {
                provider: selectedProvider,
                model: selectedModel,
                temperature: temperature.toString(),
                maxTokens,
                systemPrompt: systemPrompt || null,
                contextWindow: selectedContextWindow,
            },
        });
    };

    useEffect(() => {
        document.title = "AI Конфигуратор - ИИ Бизнес Ассистент";
    }, []);

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>

            <div className="flex-1 flex flex-col h-full overflow-hidden">
                {/* Sub-header */}
                <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4 shrink-0">
                    <div className="flex items-center justify-between max-w-6xl mx-auto w-full">
                        <div className="flex items-center gap-3">
                            <div className="p-2 bg-blue-500/10 rounded-lg">
                                <Settings2 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">AI Конфигуратор</h1>
                                <p className="text-sm text-gray-500 dark:text-gray-400">
                                    Управление моделями и промптами для каждой задачи
                                </p>
                            </div>
                        </div>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 sm:p-6">
                    <div className="max-w-6xl mx-auto">

                {/* Bulk Replace Card */}
                <Card className="mb-6 border-orange-200 dark:border-orange-900/50">
                    <CardHeader
                        className="cursor-pointer select-none"
                        onClick={() => setBulkOpen(v => !v)}
                    >
                        <div className="flex items-center justify-between">
                            <CardTitle className="flex items-center gap-2 text-lg">
                                <Zap className="h-5 w-5 text-orange-500" />
                                Массовая замена провайдера
                                <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
                                    — быстро переключить все задачи на другую модель
                                </span>
                            </CardTitle>
                            {bulkOpen
                                ? <ChevronUp className="h-4 w-4 text-gray-400" />
                                : <ChevronDown className="h-4 w-4 text-gray-400" />}
                        </div>
                    </CardHeader>

                    {bulkOpen && (
                        <CardContent>
                            <div className="bg-orange-50 dark:bg-orange-900/10 border border-orange-200 dark:border-orange-800 rounded-lg p-3 mb-4 flex items-start gap-2">
                                <AlertTriangle className="h-4 w-4 text-orange-500 mt-0.5 shrink-0" />
                                <p className="text-sm text-orange-700 dark:text-orange-300">
                                    Все конфигурации с выбранным провайдером <strong>«От»</strong> будут переключены на новый провайдер и модель.
                                    Температура и токены останутся без изменений.
                                </p>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                {/* From Provider */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-medium">От провайдера</Label>
                                    <Select value={bulkFromProvider} onValueChange={v => setBulkFromProvider(v)}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Текущий провайдер" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {/* Уникальные провайдеры из текущих конфигов */}
                                            {Array.from(new Set(configs?.map(c => c.provider) || [])).map(p => (
                                                <SelectItem key={p} value={p}>
                                                    {p}
                                                    <span className="ml-2 text-xs text-gray-400">
                                                        ({configs?.filter(c => c.provider === p).length} задач)
                                                    </span>
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                {/* To Provider */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-medium">На провайдера</Label>
                                    <Select value={bulkToProvider} onValueChange={v => { setBulkToProvider(v); setBulkToModel(""); setBulkModelSearch(""); }}>
                                        <SelectTrigger>
                                            <SelectValue placeholder="Новый провайдер" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {providers?.filter(p => p.available).map(p => (
                                                <SelectItem key={p.id} value={p.id}>
                                                    {p.name}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>

                                {/* To Model */}
                                <div className="space-y-2">
                                    <Label className="text-sm font-medium">Модель</Label>
                                    {bulkToProvider && (
                                        <Input
                                            type="search"
                                            placeholder="Поиск моделей..."
                                            value={bulkModelSearch}
                                            onChange={e => setBulkModelSearch(e.target.value)}
                                            className="mb-1"
                                        />
                                    )}
                                    <Select
                                        value={bulkToModel}
                                        onValueChange={setBulkToModel}
                                        disabled={!bulkToProvider}
                                    >
                                        <SelectTrigger>
                                            <SelectValue placeholder={bulkModelsLoading ? "Загрузка..." : "Выберите модель"} />
                                        </SelectTrigger>
                                        <SelectContent className="max-h-60">
                                            {bulkModels && bulkModels.length > 0 ? (
                                                bulkModels
                                                    .filter(m => !bulkModelSearch || m.id.toLowerCase().includes(bulkModelSearch.toLowerCase()) || (m.name && m.name.toLowerCase().includes(bulkModelSearch.toLowerCase())))
                                                    .map(m => (
                                                        <SelectItem key={m.id} value={m.id}>
                                                            <div className="flex flex-col">
                                                                <span>{m.name || m.id}</span>
                                                                {m.contextLength && (
                                                                    <span className="text-xs text-gray-400">{formatContextWindow(m.contextLength)}</span>
                                                                )}
                                                            </div>
                                                        </SelectItem>
                                                    ))
                                            ) : (
                                                <div className="p-3 text-sm text-gray-400 text-center">
                                                    {!bulkToProvider ? "Сначала выберите провайдера" : bulkModelsLoading ? "Загрузка..." : "Нет моделей"}
                                                </div>
                                            )}
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-gray-500">Или введите вручную:</p>
                                    <Input
                                        value={bulkToModel}
                                        onChange={e => setBulkToModel(e.target.value)}
                                        placeholder="provider/model-id"
                                        disabled={!bulkToProvider}
                                    />
                                </div>
                            </div>

                            {/* Preview */}
                            {bulkFromProvider && bulkToProvider && bulkToModel && (
                                <div className="mt-4 p-3 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700">
                                    <p className="text-sm font-medium mb-2">Затронутые конфигурации:</p>
                                    <div className="flex flex-wrap gap-1">
                                        {configs?.filter(c => c.provider === bulkFromProvider).map(c => (
                                            <Badge key={c.taskType} variant="outline" className="text-xs">
                                                {taskTypeLabels[c.taskType]?.split(' ').slice(0, 2).join(' ') || c.taskType}
                                            </Badge>
                                        ))}
                                        {(configs?.filter(c => c.provider === bulkFromProvider).length ?? 0) === 0 && (
                                            <span className="text-sm text-gray-400">Нет задач с провайдером «{bulkFromProvider}»</span>
                                        )}
                                    </div>
                                </div>
                            )}

                            <div className="mt-4 flex justify-end">
                                <Button
                                    onClick={() => {
                                        if (!bulkFromProvider || !bulkToProvider || !bulkToModel) return;
                                        bulkUpdateMutation.mutate({
                                            fromProvider: bulkFromProvider,
                                            toProvider: bulkToProvider,
                                            toModel: bulkToModel,
                                        });
                                    }}
                                    disabled={
                                        !bulkFromProvider || !bulkToProvider || !bulkToModel ||
                                        bulkUpdateMutation.isPending ||
                                        (configs?.filter(c => c.provider === bulkFromProvider).length ?? 0) === 0
                                    }
                                    className="bg-orange-500 hover:bg-orange-600 text-white"
                                >
                                    <Zap className="h-4 w-4 mr-2" />
                                    {bulkUpdateMutation.isPending ? "Применяем..." : "Применить массовую замену"}
                                </Button>
                            </div>
                        </CardContent>
                    )}
                </Card>

                {/* Provider Status */}
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-lg">
                            <Bot className="h-5 w-5" />
                            Доступные провайдеры
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-wrap gap-3">
                            {providers?.map((p) => (
                                <Badge
                                    key={p.id}
                                    variant={p.available ? "default" : "outline"}
                                    className={p.available ? "bg-green-600" : ""}
                                >
                                    {p.name}: {p.available ? "✓ Настроен" : "Не настроен"}
                                </Badge>
                            ))}
                        </div>
                    </CardContent>
                </Card>

                {/* Configs Table */}
                <Card>
                    <CardHeader>
                        <div className="flex items-center justify-between">
                            <div>
                                <CardTitle className="flex items-center gap-2 text-lg">
                                    <Settings2 className="h-5 w-5" />
                                    Конфигурации AI по задачам
                                </CardTitle>
                                <CardDescription>
                                    Нажмите на строку для редактирования
                                </CardDescription>
                            </div>
                            {availableTaskTypes.length > 0 && (
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        setCreatingConfig(true);
                                        setNewTaskType(availableTaskTypes[0]);
                                        setSelectedProvider("openrouter");
                                        setSelectedModel("");
                                        setTemperature(0.3);
                                        setMaxTokens(4096);
                                    }}
                                >
                                    <Plus className="h-4 w-4 mr-1" />
                                    Добавить
                                </Button>
                            )}
                        </div>
                    </CardHeader>
                    <CardContent>
                        {isLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-gray-200 dark:border-gray-700">
                                            <th className="text-left py-3 px-2 font-medium">Задача</th>
                                            <th className="text-left py-3 px-2 font-medium">Провайдер</th>
                                            <th className="text-left py-3 px-2 font-medium">Модель</th>
                                            <th className="text-left py-3 px-2 font-medium">Контекст</th>
                                            <th className="text-left py-3 px-2 font-medium">Temp</th>
                                            <th className="text-left py-3 px-2 font-medium">Токены</th>
                                            <th className="text-left py-3 px-2 font-medium">Промпт</th>
                                            <th className="text-right py-3 px-2"></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {configs?.map((config) => (
                                            <tr
                                                key={config.id}
                                                className="border-b border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer"
                                                onClick={() => handleEdit(config)}
                                            >
                                                <td className="py-3 px-2">
                                                    <div>
                                                        <div className="font-medium">{taskTypeLabels[config.taskType] || config.taskType}</div>
                                                        <div className="text-xs text-gray-500">{config.taskType}</div>
                                                    </div>
                                                </td>
                                                <td className="py-3 px-2">
                                                    <Badge variant="outline">{config.provider}</Badge>
                                                </td>
                                                <td className="py-3 px-2 font-mono text-xs max-w-[200px] truncate">
                                                    {config.model}
                                                </td>
                                                <td className="py-3 px-2">
                                                    <Badge variant="outline" className={config.contextWindow ? 'text-blue-600 border-blue-200 dark:text-blue-400 dark:border-blue-800' : 'text-gray-400'}>
                                                        {formatContextWindow(config.contextWindow)}
                                                    </Badge>
                                                </td>
                                                <td className="py-3 px-2">{config.temperature}</td>
                                                <td className="py-3 px-2">{config.maxTokens}</td>
                                                <td className="py-3 px-2">
                                                    {config.systemPrompt ? (
                                                        <span className="text-green-600" title="Промпт из БД (редактируемый)">✏️ БД</span>
                                                    ) : hardcodedPromptTemplates[config.taskType] ? (
                                                        <span className="text-blue-500" title="Промпт из кода (read-only)">🔒 Код</span>
                                                    ) : (
                                                        <span className="text-gray-400">—</span>
                                                    )}
                                                </td>
                                                <td className="py-3 px-2 text-right">
                                                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleEdit(config); }}>
                                                        <Edit2 className="h-4 w-4" />
                                                    </Button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Edit Dialog */}
                <Dialog open={!!editingConfig} onOpenChange={(open) => !open && setEditingConfig(null)}>
                    <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                        <DialogHeader>
                            <DialogTitle>
                                Редактирование: {editingConfig && (taskTypeLabels[editingConfig.taskType] || editingConfig.taskType)}
                            </DialogTitle>
                            <DialogDescription>
                                {editingConfig?.description}
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4 py-4">
                            {/* Provider */}
                            <div className="space-y-2">
                                <Label>Провайдер</Label>
                                <Select value={selectedProvider} onValueChange={(v) => { setSelectedProvider(v); setSelectedModel(""); }}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Выберите провайдера" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {providers?.map((p) => (
                                            <SelectItem key={p.id} value={p.id} disabled={!p.available}>
                                                {p.name} {!p.available && "- не настроен"}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Model */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label>Модель</Label>
                                    <Button variant="ghost" size="sm" onClick={handleRefreshModels} disabled={modelsLoading}>
                                        <RefreshCw className={`h-4 w-4 mr-1 ${modelsLoading ? 'animate-spin' : ''}`} />
                                        Обновить список
                                    </Button>
                                </div>
                                <Input
                                    type="search"
                                    placeholder="Поиск моделей..."
                                    value={modelSearchQuery}
                                    onChange={(e) => setModelSearchQuery(e.target.value)}
                                    className="mb-2"
                                />
                                <Select value={selectedModel} onValueChange={setSelectedModel}>
                                    <SelectTrigger>
                                        <SelectValue placeholder={modelsLoading ? "Загрузка..." : "Выберите модель"} />
                                    </SelectTrigger>
                                    <SelectContent className="max-h-60">
                                        {models && models.length > 0 ? (
                                            models.filter((m) => {
                                                if (!modelSearchQuery) return true;
                                                const query = modelSearchQuery.toLowerCase();
                                                return m.id.toLowerCase().includes(query) ||
                                                    (m.name && m.name.toLowerCase().includes(query));
                                            }).map((m) => (
                                                <SelectItem key={m.id} value={m.id}>
                                                    <div className="flex flex-col">
                                                        <span>{m.name || m.id}</span>
                                                        {m.contextLength && (
                                                            <span className="text-xs text-gray-500">{formatContextWindow(m.contextLength)} ({m.contextLength.toLocaleString()} tokens)</span>
                                                        )}
                                                    </div>
                                                </SelectItem>
                                            ))
                                        ) : (
                                            <div className="p-4 text-sm text-gray-500 text-center">
                                                {modelsLoading ? "Загрузка моделей..." : "Нет доступных моделей"}
                                            </div>
                                        )}
                                    </SelectContent>
                                </Select>
                                {/* Контекстное окно — read-only badge */}
                                {selectedContextWindow && (
                                    <div className="flex items-center gap-2 mt-1">
                                        <Badge variant="outline" className="text-blue-600 border-blue-200 dark:text-blue-400 dark:border-blue-800">
                                            📐 Контекстное окно: {formatContextWindow(selectedContextWindow)} ({selectedContextWindow.toLocaleString()} tokens)
                                        </Badge>
                                    </div>
                                )}
                                <p className="text-xs text-gray-500">
                                    Или введите вручную:
                                </p>
                                <Input
                                    value={selectedModel}
                                    onChange={(e) => setSelectedModel(e.target.value)}
                                    placeholder="openai/gpt-4o-mini-2024-07-18"
                                />
                            </div>

                            {/* Temperature */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <Label>Temperature: {temperature.toFixed(2)}</Label>
                                </div>
                                <Slider
                                    value={[temperature]}
                                    onValueChange={([v]) => setTemperature(v)}
                                    min={0}
                                    max={1}
                                    step={0.05}
                                />
                                <p className="text-xs text-gray-500">
                                    0 = точный, 1 = креативный
                                </p>
                            </div>

                            {/* Max Tokens */}
                            <div className="space-y-2">
                                <Label>Max Tokens</Label>
                                <Input
                                    type="number"
                                    value={maxTokens}
                                    onChange={(e) => setMaxTokens(parseInt(e.target.value) || 500)}
                                    min={100}
                                    max={16000}
                                />
                            </div>

                            {/* System Prompt */}
                            <div className="space-y-2">
                                {editingConfig && hardcodedPromptTemplates[editingConfig.taskType] ? (
                                    <>
                                        <div className="flex items-center gap-2">
                                            <Lock className="h-4 w-4 text-blue-500" />
                                            <Label className="text-blue-600">Промпт из кода (read-only)</Label>
                                        </div>
                                        <div className="flex items-center gap-1 text-xs text-gray-500">
                                            <Code2 className="h-3 w-3" />
                                            <span>{hardcodedPromptTemplates[editingConfig.taskType].source}</span>
                                        </div>
                                        <div className="bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-md p-3 font-mono text-xs whitespace-pre-wrap text-gray-700 dark:text-gray-300 max-h-[300px] overflow-y-auto">
                                            {hardcodedPromptTemplates[editingConfig.taskType].template}
                                        </div>
                                        <p className="text-xs text-gray-500">
                                            ⓘ Этот промпт собирается в коде с динамическими данными.
                                            Части в {"{{двойных скобках}}"} подставляются в runtime.
                                        </p>
                                    </>
                                ) : (
                                    <>
                                        <Label>System Prompt (редактируемый)</Label>
                                        <Textarea
                                            value={systemPrompt}
                                            onChange={(e) => setSystemPrompt(e.target.value)}
                                            placeholder="Промпт отправляется модели как system message"
                                            className="min-h-[150px] font-mono text-sm"
                                        />
                                        <p className="text-xs text-gray-500">
                                            ✏️ Этот промпт читается из БД и отправляется модели напрямую.
                                        </p>
                                    </>
                                )}
                            </div>
                        </div>

                        <DialogFooter>
                            <Button variant="outline" onClick={() => setEditingConfig(null)}>
                                Отмена
                            </Button>
                            <Button onClick={handleSave} disabled={updateMutation.isPending}>
                                <Save className="h-4 w-4 mr-2" />
                                {updateMutation.isPending ? "Сохранение..." : "Сохранить"}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>

                {/* Create Config Dialog */}
                <Dialog open={creatingConfig} onOpenChange={setCreatingConfig}>
                    <DialogContent className="max-w-lg">
                        <DialogHeader>
                            <DialogTitle>Добавить конфигурацию</DialogTitle>
                            <DialogDescription>
                                Создайте конфигурацию для новой задачи AI
                            </DialogDescription>
                        </DialogHeader>

                        <div className="space-y-4">
                            {/* Task Type */}
                            <div className="space-y-2">
                                <Label>Задача</Label>
                                <Select value={newTaskType} onValueChange={setNewTaskType}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {availableTaskTypes.map((t) => (
                                            <SelectItem key={t} value={t}>
                                                {taskTypeLabels[t] || t}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Provider */}
                            <div className="space-y-2">
                                <Label>Провайдер</Label>
                                <Select value={selectedProvider} onValueChange={setSelectedProvider}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {providers?.filter(p => p.available).map((p) => (
                                            <SelectItem key={p.id} value={p.id}>
                                                {p.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Model */}
                            <div className="space-y-2">
                                <Label>Модель</Label>
                                <Input
                                    placeholder="Поиск модели..."
                                    value={modelSearchQuery}
                                    onChange={(e) => setModelSearchQuery(e.target.value)}
                                    className="mb-2"
                                />
                                <Select value={selectedModel} onValueChange={setSelectedModel}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Выберите модель" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {(models || [])
                                            .filter(m => !modelSearchQuery || m.id.toLowerCase().includes(modelSearchQuery.toLowerCase()))
                                            .map((m) => (
                                                <SelectItem key={m.id} value={m.id}>
                                                    {m.id}
                                                </SelectItem>
                                            ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Temperature */}
                            <div className="space-y-2">
                                <Label>Temperature: {temperature.toFixed(2)}</Label>
                                <Slider
                                    value={[temperature]}
                                    onValueChange={([v]) => setTemperature(v)}
                                    min={0}
                                    max={1}
                                    step={0.05}
                                />
                            </div>

                            {/* Max Tokens */}
                            <div className="space-y-2">
                                <Label>Max Tokens</Label>
                                <Input
                                    type="number"
                                    value={maxTokens}
                                    onChange={(e) => setMaxTokens(parseInt(e.target.value) || 4096)}
                                    min={100}
                                    max={16000}
                                />
                            </div>
                        </div>

                        <DialogFooter>
                            <Button variant="outline" onClick={() => setCreatingConfig(false)}>
                                Отмена
                            </Button>
                            <Button
                                onClick={() => {
                                    if (!newTaskType || !selectedProvider || !selectedModel) return;
                                    createMutation.mutate({
                                        taskType: newTaskType,
                                        provider: selectedProvider,
                                        model: selectedModel,
                                        temperature: temperature.toString(),
                                        maxTokens,
                                        contextWindow: selectedContextWindow,
                                    });
                                }}
                                disabled={createMutation.isPending || !selectedModel}
                            >
                                <Plus className="h-4 w-4 mr-2" />
                                {createMutation.isPending ? "Создание..." : "Создать"}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
                    </div>
                </main>
            </div>
        </div>
    );
}
