import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import {
    Brain,
    FolderTree,
    Lightbulb,
    Search,
    Trash2,
    ChevronRight,
    ChevronDown,
    Hash,
    RefreshCw
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

// Types
interface Topic {
    id: number;
    name: string;
    parentId: number | null;
    factCount: number;
    createdAt: string;
    updatedAt: string;
}

interface TopicNode {
    id: number;
    name: string;
    factCount: number;
    children: TopicNode[];
}

interface Fact {
    id: number;
    topicId: number;
    content: string;
    confidence: 'high' | 'medium' | 'low';
    version: number;
    isCurrent: boolean;
    sourceMessageId: number | null;
    createdAt: string;
    updatedAt: string;
}

interface SearchResult {
    id: number;
    name?: string;
    content?: string;
    similarity: number;
}

// Topic tree component
function TopicTreeItem({
    node,
    selectedTopicId,
    onSelect
}: {
    node: TopicNode;
    selectedTopicId: number | null;
    onSelect: (id: number) => void;
}) {
    const [isExpanded, setIsExpanded] = useState(true);
    const hasChildren = node.children.length > 0;
    const isSelected = selectedTopicId === node.id;

    return (
        <div>
            <div
                className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${isSelected
                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`}
                onClick={() => onSelect(node.id)}
            >
                {hasChildren ? (
                    <button
                        onClick={(e) => { e.stopPropagation(); setIsExpanded(!isExpanded); }}
                        className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                    >
                        {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                        ) : (
                            <ChevronRight className="h-4 w-4" />
                        )}
                    </button>
                ) : (
                    <span className="w-5" />
                )}
                <FolderTree className="h-4 w-4 text-gray-500" />
                <span className="flex-1 text-sm font-medium truncate">{node.name}</span>
                <Badge variant="secondary" className="text-xs">
                    {node.factCount}
                </Badge>
            </div>
            {hasChildren && isExpanded && (
                <div className="ml-4 border-l border-gray-200 dark:border-gray-700 pl-2">
                    {node.children.map(child => (
                        <TopicTreeItem
                            key={child.id}
                            node={child}
                            selectedTopicId={selectedTopicId}
                            onSelect={onSelect}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

// Confidence badge component
function ConfidenceBadge({ confidence }: { confidence: string }) {
    const variants: Record<string, { color: string; label: string }> = {
        high: { color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', label: 'Высокая' },
        medium: { color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400', label: 'Средняя' },
        low: { color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400', label: 'Низкая' },
    };
    const variant = variants[confidence] || variants.medium;

    return (
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${variant.color}`}>
            {variant.label}
        </span>
    );
}

export default function MemoryPage() {
    const [, setLocation] = useLocation();
    const { toast } = useToast();
    const queryClient = useQueryClient();

    const [selectedTopicId, setSelectedTopicId] = useState<number | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [isSearching, setIsSearching] = useState(false);
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

    // Fetch topics tree
    const { data: topicsTree, isLoading: isLoadingTree, refetch: refetchTree } = useQuery<TopicNode[]>({
        queryKey: ["/api/memory/topics/tree"],
    });

    // Fetch all facts
    const { data: allFacts, isLoading: isLoadingFacts, refetch: refetchFacts } = useQuery<Fact[]>({
        queryKey: ["/api/memory/facts"],
    });

    // Fetch facts for selected topic
    const { data: topicFacts } = useQuery<Fact[]>({
        queryKey: ["/api/memory/topics", selectedTopicId, "facts"],
        queryFn: async () => {
            if (!selectedTopicId) return [];
            const response = await fetch(`/api/memory/topics/${selectedTopicId}/facts`);
            return response.json();
        },
        enabled: !!selectedTopicId,
    });

    // Delete fact mutation
    const deleteFactMutation = useMutation({
        mutationFn: async (factId: number) => {
            const response = await apiRequest("DELETE", `/api/memory/facts/${factId}`);
            return response.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/memory/facts"] });
            queryClient.invalidateQueries({ queryKey: ["/api/memory/topics/tree"] });
            if (selectedTopicId) {
                queryClient.invalidateQueries({ queryKey: ["/api/memory/topics", selectedTopicId, "facts"] });
            }
            toast({
                title: "Удалено",
                description: "Факт успешно удалён",
            });
        },
        onError: () => {
            toast({
                title: "Ошибка",
                description: "Не удалось удалить факт",
                variant: "destructive",
            });
        },
    });

    // Search handler
    const handleSearch = async () => {
        if (!searchQuery.trim()) {
            setSearchResults([]);
            return;
        }

        setIsSearching(true);
        try {
            const response = await fetch(`/api/memory/facts/search?q=${encodeURIComponent(searchQuery)}&limit=10`);
            const results = await response.json();
            setSearchResults(results);
        } catch (error) {
            toast({
                title: "Ошибка поиска",
                description: "Не удалось выполнить поиск",
                variant: "destructive",
            });
        } finally {
            setIsSearching(false);
        }
    };

    // Get facts to display
    const displayFacts = selectedTopicId ? topicFacts : allFacts;
    const totalFacts = allFacts?.length || 0;
    const totalTopics = topicsTree?.reduce((acc, node) => {
        const countNodes = (n: TopicNode): number => 1 + n.children.reduce((a, c) => a + countNodes(c), 0);
        return acc + countNodes(node);
    }, 0) || 0;

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>

            <div className="flex-1 flex flex-col h-full overflow-hidden">
                {/* Sub-header */}
                <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4 shrink-0">
                    <div className="flex items-center justify-between max-w-7xl mx-auto w-full">
                        <div className="flex items-center gap-3">
                            <Brain className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                                    Память ассистента
                                </h1>
                                <p className="text-sm text-gray-500 dark:text-gray-400">
                                    {totalTopics} тем · {totalFacts} фактов
                                </p>
                            </div>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => { refetchTree(); refetchFacts(); }}
                        >
                            <RefreshCw className="h-4 w-4 mr-2" />
                            Обновить
                        </Button>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 sm:p-6">
                    <div className="max-w-7xl mx-auto">

                {/* Search */}
                <Card className="mb-6">
                    <CardContent className="pt-6">
                        <div className="flex gap-2">
                            <div className="relative flex-1">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                                <Input
                                    placeholder="Семантический поиск по фактам..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                                    className="pl-10"
                                />
                            </div>
                            <Button onClick={handleSearch} disabled={isSearching}>
                                {isSearching ? "Поиск..." : "Найти"}
                            </Button>
                        </div>

                        {searchResults.length > 0 && (
                            <div className="mt-4 space-y-2">
                                <p className="text-sm text-gray-500">Результаты поиска:</p>
                                {searchResults.map((result) => (
                                    <div
                                        key={result.id}
                                        className="p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800"
                                    >
                                        <div className="flex items-start justify-between">
                                            <p className="text-sm text-gray-800 dark:text-gray-200">
                                                {result.content || result.name}
                                            </p>
                                            <Badge variant="outline" className="ml-2 shrink-0">
                                                {(result.similarity * 100).toFixed(0)}%
                                            </Badge>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                </Card>

                {/* Main content */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    {/* Topics tree */}
                    <Card className="lg:col-span-1">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-lg">
                                <FolderTree className="h-5 w-5" />
                                Темы
                            </CardTitle>
                            <CardDescription>
                                Иерархия категорий знаний
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {isLoadingTree ? (
                                <div className="flex items-center justify-center py-8">
                                    <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                </div>
                            ) : topicsTree && topicsTree.length > 0 ? (
                                <div className="space-y-1">
                                    <div
                                        className={`flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${selectedTopicId === null
                                                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                                                : 'hover:bg-gray-100 dark:hover:bg-gray-800'
                                            }`}
                                        onClick={() => setSelectedTopicId(null)}
                                    >
                                        <Hash className="h-4 w-4" />
                                        <span className="text-sm font-medium">Все факты</span>
                                        <Badge variant="secondary" className="ml-auto text-xs">
                                            {totalFacts}
                                        </Badge>
                                    </div>
                                    <Separator className="my-2" />
                                    {topicsTree.map(node => (
                                        <TopicTreeItem
                                            key={node.id}
                                            node={node}
                                            selectedTopicId={selectedTopicId}
                                            onSelect={setSelectedTopicId}
                                        />
                                    ))}
                                </div>
                            ) : (
                                <div className="text-center py-8 text-gray-500">
                                    <Brain className="h-12 w-12 mx-auto mb-3 opacity-30" />
                                    <p className="text-sm">Пока нет тем</p>
                                    <p className="text-xs mt-1">Напишите что-нибудь в чат</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>

                    {/* Facts list */}
                    <Card className="lg:col-span-2">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2 text-lg">
                                <Lightbulb className="h-5 w-5" />
                                Факты
                                {selectedTopicId && (
                                    <Badge variant="outline" className="ml-2">
                                        Фильтр: тема #{selectedTopicId}
                                    </Badge>
                                )}
                            </CardTitle>
                            <CardDescription>
                                Извлечённые знания о пользователе
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            {isLoadingFacts ? (
                                <div className="flex items-center justify-center py-8">
                                    <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                                </div>
                            ) : displayFacts && displayFacts.length > 0 ? (
                                <div className="space-y-3">
                                    {displayFacts.map((fact) => (
                                        <div
                                            key={fact.id}
                                            className="p-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm"
                                        >
                                            <div className="flex items-start justify-between gap-4">
                                                <div className="flex-1">
                                                    <p className="text-gray-900 dark:text-white">
                                                        {fact.content}
                                                    </p>
                                                    <div className="flex items-center gap-3 mt-2 text-xs text-gray-500">
                                                        <ConfidenceBadge confidence={fact.confidence} />
                                                        <span>v{fact.version}</span>
                                                        <span>
                                                            {new Date(fact.createdAt).toLocaleDateString('ru-RU', {
                                                                day: 'numeric',
                                                                month: 'short',
                                                                year: 'numeric',
                                                            })}
                                                        </span>
                                                    </div>
                                                </div>
                                                <AlertDialog>
                                                    <AlertDialogTrigger asChild>
                                                        <Button variant="ghost" size="icon" className="shrink-0 text-gray-400 hover:text-red-500">
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    </AlertDialogTrigger>
                                                    <AlertDialogContent>
                                                        <AlertDialogHeader>
                                                            <AlertDialogTitle>Удалить факт?</AlertDialogTitle>
                                                            <AlertDialogDescription>
                                                                Факт будет помечен как неактуальный и больше не будет использоваться в контексте.
                                                            </AlertDialogDescription>
                                                        </AlertDialogHeader>
                                                        <AlertDialogFooter>
                                                            <AlertDialogCancel>Отмена</AlertDialogCancel>
                                                            <AlertDialogAction
                                                                onClick={() => deleteFactMutation.mutate(fact.id)}
                                                                className="bg-red-500 hover:bg-red-600"
                                                            >
                                                                Удалить
                                                            </AlertDialogAction>
                                                        </AlertDialogFooter>
                                                    </AlertDialogContent>
                                                </AlertDialog>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-center py-8 text-gray-500">
                                    <Lightbulb className="h-12 w-12 mx-auto mb-3 opacity-30" />
                                    <p className="text-sm">Нет сохранённых фактов</p>
                                    <p className="text-xs mt-1">Расскажите о себе или своём бизнесе в чате</p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
