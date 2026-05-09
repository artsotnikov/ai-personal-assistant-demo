import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import {
    ReactFlow,
    Controls,
    Background,
    useNodesState,
    useEdgesState,
    Node,
    Edge,
    MarkerType,
    BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
    Network,
    Search,
    X,
    User,
    Building2,
    Lightbulb,
    Package,
    Calendar,
    MapPin,
    HelpCircle,
    LucideIcon,
    Target,
    AlertTriangle,
    Wrench,
    FolderOpen,
    Users,
    Sparkles,
    Heart,
    Repeat,
    ChevronLeft,
    ChevronRight,
    Clock,
    ArrowRight,
    Activity,
    Hash,
    TrendingUp,
    Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";

// ============================================================================
// Types
// ============================================================================

interface Entity {
    id: number;
    name: string;
    baseType: string;
    subType: string | null;
    role: string | null;
    description: string | null;
    confidence: string;
    mentionCount: number;
    lastMentioned: string;
    metadata: Record<string, any> | null;
}

interface OverviewData {
    entityCountsByType: Array<{ baseType: string; count: number }>;
    relationCountsByCategory: Array<{ category: string; count: number }>;
    recentRelations: Array<{
        id: number;
        subjectId: number;
        subjectName: string;
        relationType: string;
        objectName: string;
        category: string | null;
        importance: string;
        createdAt: string;
    }>;
    totals: {
        entities: number;
        relations: number;
        avgConfidence: string;
    };
}

interface EgoGraphData {
    centerEntity: Entity | null;
    nodes: Entity[];
    edges: Array<{
        id: number;
        subjectId: number;
        objectId: number;
        relationType: string;
        relationCategory: string | null;
        context: string | null;
        importance: string;
        attributes: Record<string, string> | null;
    }>;
}

interface RelationsListData {
    relations: Array<{
        id: number;
        subjectId: number;
        subjectName: string;
        subjectType: string;
        relationType: string;
        objectId: number;
        objectName: string;
        objectType: string;
        category: string | null;
        importance: string;
        context: string | null;
        attributes: Record<string, string> | null;
        createdAt: string;
    }>;
    total: number;
    page: number;
    limit: number;
}

// ============================================================================
// Constants & Colors
// ============================================================================

const baseTypeColors: Record<string, { bg: string; border: string; text: string }> = {
    person: { bg: "#1e3a5f", border: "#3b82f6", text: "#93c5fd" },
    organization: { bg: "#3b1f5e", border: "#a855f7", text: "#d8b4fe" },
    concept: { bg: "#14432a", border: "#22c55e", text: "#86efac" },
    artifact: { bg: "#4a2c17", border: "#f97316", text: "#fdba74" },
    event: { bg: "#4c1d1d", border: "#ef4444", text: "#fca5a5" },
    location: { bg: "#164e63", border: "#06b6d4", text: "#67e8f9" },
    other: { bg: "#1f2937", border: "#6b7280", text: "#d1d5db" },
};

const baseTypeIcons: Record<string, LucideIcon> = {
    person: User,
    organization: Building2,
    concept: Lightbulb,
    artifact: Package,
    event: Calendar,
    location: MapPin,
    other: HelpCircle,
};

const baseTypeLabels: Record<string, string> = {
    person: "Люди",
    organization: "Организации",
    concept: "Концепции",
    artifact: "Артефакты",
    event: "События",
    location: "Места",
    other: "Прочее",
};

const categoryColors: Record<string, { bg: string; border: string; text: string; icon: LucideIcon }> = {
    goals: { bg: "#2d1b69", border: "#a855f7", text: "#d8b4fe", icon: Target },
    problems: { bg: "#4c1d1d", border: "#ef4444", text: "#fca5a5", icon: AlertTriangle },
    tools: { bg: "#1e3a5f", border: "#3b82f6", text: "#93c5fd", icon: Wrench },
    projects: { bg: "#14432a", border: "#22c55e", text: "#86efac", icon: FolderOpen },
    people: { bg: "#4a3728", border: "#f59e0b", text: "#fde68a", icon: Users },
    skills: { bg: "#164e63", border: "#06b6d4", text: "#67e8f9", icon: Sparkles },
    fears: { bg: "#4a1942", border: "#f43f5e", text: "#fda4af", icon: Heart },
    habits: { bg: "#2d1b69", border: "#8b5cf6", text: "#c4b5fd", icon: Repeat },
    other: { bg: "#1f2937", border: "#6b7280", text: "#d1d5db", icon: HelpCircle },
};

const importanceBadge: Record<string, string> = {
    critical: "bg-red-500/20 text-red-300 border-red-500/30",
    high: "bg-orange-500/20 text-orange-300 border-orange-500/30",
    normal: "bg-blue-500/20 text-blue-300 border-blue-500/30",
    detail: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

// ============================================================================
// Custom Node Component (for Ego Graph)
// ============================================================================

function EgoNode({ data }: { data: Entity & { isCenter: boolean } }) {
    const colors = baseTypeColors[data.baseType] || baseTypeColors.other;
    const Icon = baseTypeIcons[data.baseType] || baseTypeIcons.other;

    return (
        <div
            className={`px-4 py-3 rounded-xl shadow-lg border-2 transition-all cursor-pointer hover:scale-105 ${data.isCenter ? "ring-2 ring-offset-2 ring-offset-gray-900 ring-purple-400 scale-110" : ""
                }`}
            style={{
                backgroundColor: colors.bg,
                borderColor: colors.border,
                minWidth: data.isCenter ? 160 : 120,
                maxWidth: 220,
            }}
        >
            <div className="flex items-center gap-2 mb-1">
                <Icon className="w-4 h-4 shrink-0" style={{ color: colors.text }} />
                <span className="font-semibold text-sm truncate" style={{ color: colors.text }}>
                    {data.name}
                </span>
            </div>
            {data.subType && (
                <div className="text-xs opacity-70 truncate" style={{ color: colors.text }}>
                    {data.subType}
                </div>
            )}
            {data.mentionCount > 1 && (
                <div className="flex items-center gap-1 mt-1">
                    <Hash className="w-3 h-3 text-gray-400" />
                    <span className="text-xs text-gray-400">{data.mentionCount}</span>
                </div>
            )}
        </div>
    );
}

const nodeTypes = { ego: EgoNode };

// ============================================================================
// Overview Tab
// ============================================================================

function OverviewTab({ onNavigate }: {
    onNavigate: (tab: string, filters?: { category?: string; entityType?: string; entityId?: number }) => void;
}) {
    const { data, isLoading } = useQuery<OverviewData>({
        queryKey: ["/api/graph/overview"],
        queryFn: async () => {
            const res = await fetch("/api/graph/overview");
            if (!res.ok) throw new Error("Failed to fetch overview");
            return res.json();
        },
    });

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-96">
                <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    if (!data) return null;

    return (
        <ScrollArea className="h-[calc(100vh-140px)]">
            <div className="p-6 space-y-6 max-w-6xl mx-auto">
                {/* Stats Cards */}
                <div className="grid grid-cols-3 gap-4">
                    <Card className="bg-gradient-to-br from-purple-900/40 to-purple-800/20 border-purple-500/30">
                        <CardContent className="p-5">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm text-purple-300/70">Сущности</p>
                                    <p className="text-3xl font-bold text-purple-200">{data.totals.entities}</p>
                                </div>
                                <Network className="w-10 h-10 text-purple-400/40" />
                            </div>
                        </CardContent>
                    </Card>
                    <Card className="bg-gradient-to-br from-blue-900/40 to-blue-800/20 border-blue-500/30">
                        <CardContent className="p-5">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm text-blue-300/70">Связи</p>
                                    <p className="text-3xl font-bold text-blue-200">{data.totals.relations}</p>
                                </div>
                                <Activity className="w-10 h-10 text-blue-400/40" />
                            </div>
                        </CardContent>
                    </Card>
                    <Card className="bg-gradient-to-br from-green-900/40 to-green-800/20 border-green-500/30">
                        <CardContent className="p-5">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm text-green-300/70">Уверенность</p>
                                    <p className="text-3xl font-bold text-green-200 capitalize">{data.totals.avgConfidence}</p>
                                </div>
                                <TrendingUp className="w-10 h-10 text-green-400/40" />
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* Entity Types & Relation Categories */}
                <div className="grid grid-cols-2 gap-6">
                    {/* Entity Types */}
                    <div>
                        <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                            <Eye className="w-4 h-4" /> Типы сущностей
                        </h3>
                        <div className="grid grid-cols-2 gap-2">
                            {data.entityCountsByType.map(({ baseType, count }) => {
                                const colors = baseTypeColors[baseType] || baseTypeColors.other;
                                const Icon = baseTypeIcons[baseType] || baseTypeIcons.other;
                                const label = baseTypeLabels[baseType] || baseType;
                                return (
                                    <Card
                                        key={baseType}
                                        className="border transition-all hover:brightness-125 cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                                        style={{ backgroundColor: colors.bg + "80", borderColor: colors.border + "40" }}
                                        onClick={() => onNavigate('facts', { entityType: baseType })}
                                    >
                                        <CardContent className="p-3 flex items-center gap-3">
                                            <Icon className="w-5 h-5 shrink-0" style={{ color: colors.border }} />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs truncate" style={{ color: colors.text + "99" }}>{label}</p>
                                                <p className="text-lg font-bold" style={{ color: colors.text }}>{count}</p>
                                            </div>
                                        </CardContent>
                                    </Card>
                                );
                            })}
                        </div>
                    </div>

                    {/* Relation Categories */}
                    <div>
                        <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                            <Activity className="w-4 h-4" /> Категории связей
                        </h3>
                        <div className="grid grid-cols-2 gap-2">
                            {data.relationCountsByCategory.map(({ category, count }) => {
                                const cat = categoryColors[category] || categoryColors.other;
                                const CatIcon = cat.icon;
                                return (
                                    <Card
                                        key={category}
                                        className="border transition-all hover:brightness-125 cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                                        style={{ backgroundColor: cat.bg + "80", borderColor: cat.border + "40" }}
                                        onClick={() => onNavigate('facts', { category })}
                                    >
                                        <CardContent className="p-3 flex items-center gap-3">
                                            <CatIcon className="w-5 h-5 shrink-0" style={{ color: cat.border }} />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-xs truncate" style={{ color: cat.text + "99" }}>{category}</p>
                                                <p className="text-lg font-bold" style={{ color: cat.text }}>{count}</p>
                                            </div>
                                        </CardContent>
                                    </Card>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* Recent Relations Timeline */}
                <div>
                    <h3 className="text-sm font-medium text-gray-400 mb-3 flex items-center gap-2">
                        <Clock className="w-4 h-4" /> Последние связи
                    </h3>
                    <Card className="bg-gray-800/50 border-gray-700/50">
                        <CardContent className="p-0">
                            <div className="divide-y divide-gray-700/50">
                                {data.recentRelations.map((rel) => {
                                    const cat = categoryColors[rel.category || "other"] || categoryColors.other;
                                    return (
                                        <div key={rel.id} className="px-4 py-3 flex items-center gap-3 hover:bg-gray-700/30 transition-colors cursor-pointer" onClick={() => {
                                            // Navigate to ego-graph centered on the subject
                                            onNavigate('relations', { entityId: rel.subjectId });
                                        }}>
                                            <div
                                                className="w-2 h-2 rounded-full shrink-0"
                                                style={{ backgroundColor: cat.border }}
                                            />
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 text-sm">
                                                    <span className="font-medium text-gray-200 truncate">{rel.subjectName}</span>
                                                    <ArrowRight className="w-3 h-3 text-gray-500 shrink-0" />
                                                    <span className="text-gray-400 truncate">{rel.relationType}</span>
                                                    <ArrowRight className="w-3 h-3 text-gray-500 shrink-0" />
                                                    <span className="font-medium text-gray-200 truncate">{rel.objectName}</span>
                                                </div>
                                            </div>
                                            <Badge
                                                variant="outline"
                                                className="text-xs shrink-0"
                                                style={{ borderColor: cat.border + "60", color: cat.text }}
                                            >
                                                {rel.category || "other"}
                                            </Badge>
                                            <span className="text-xs text-gray-500 shrink-0">
                                                {new Date(rel.createdAt).toLocaleDateString("ru-RU")}
                                            </span>
                                        </div>
                                    );
                                })}
                                {data.recentRelations.length === 0 && (
                                    <div className="px-4 py-8 text-center text-gray-500">Связей пока нет</div>
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </ScrollArea>
    );
}

// ============================================================================
// Ego Graph Tab
// ============================================================================

function EgoGraphTab({ initialEntityId }: { initialEntityId?: number | null }) {
    const [centerEntityId, setCenterEntityId] = useState<number | null>(initialEntityId ?? null);
    const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());

    const [searchQuery, setSearchQuery] = useState("");
    const [debouncedSearch, setDebouncedSearch] = useState("");
    const [isSearchOpen, setIsSearchOpen] = useState(false);
    const searchRef = useRef<HTMLDivElement>(null);

    // Update center when parent sends new initialEntityId
    useEffect(() => {
        if (initialEntityId != null) {
            setCenterEntityId(initialEntityId);
        }
    }, [initialEntityId]);
    const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Close search on click outside
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (searchRef.current && !searchRef.current.contains(event.target as globalThis.Node)) {
                setIsSearchOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const { data: searchResults, isLoading: isSearchLoading } = useQuery<Entity[]>({
        queryKey: ["/api/graph/entities", debouncedSearch],
        queryFn: async () => {
            if (!debouncedSearch) return [];
            const res = await fetch(`/api/graph/entities?search=${encodeURIComponent(debouncedSearch)}`);
            if (!res.ok) throw new Error("Search failed");
            return res.json();
        },
        enabled: debouncedSearch.length > 0,
    });

    // Find default entity (owner or most mentioned)
    const { data: defaultEntity } = useQuery<{ nodes: Entity[] }>({
        queryKey: ["/api/graph/full"],
        queryFn: async () => {
            const res = await fetch("/api/graph/full");
            if (!res.ok) throw new Error("Failed");
            return res.json();
        },
        enabled: centerEntityId === null,
    });

    useEffect(() => {
        if (centerEntityId === null && defaultEntity?.nodes?.length) {
            // Find "Артём" or entity with highest mentionCount
            const owner = defaultEntity.nodes.find(n =>
                n.name.toLowerCase() === "артём" || n.name.toLowerCase() === "artem"
            );
            if (owner) {
                setCenterEntityId(owner.id);
            } else {
                const sorted = [...defaultEntity.nodes].sort((a, b) => b.mentionCount - a.mentionCount);
                if (sorted[0]) setCenterEntityId(sorted[0].id);
            }
        }
    }, [defaultEntity, centerEntityId]);

    // Fetch ego graph
    const categoriesParam = selectedCategories.size > 0
        ? `?categories=${Array.from(selectedCategories).join(",")}`
        : "";

    const { data: egoData, isLoading } = useQuery<EgoGraphData>({
        queryKey: ["/api/graph/ego", centerEntityId, Array.from(selectedCategories).sort().join(",")],
        queryFn: async () => {
            const res = await fetch(`/api/graph/ego/${centerEntityId}${categoriesParam}`);
            if (!res.ok) throw new Error("Failed");
            return res.json();
        },
        enabled: centerEntityId !== null,
    });

    // Build ReactFlow nodes & edges
    const { flowNodes, flowEdges } = useMemo(() => {
        if (!egoData?.centerEntity) return { flowNodes: [], flowEdges: [] };

        const centerX = 400;
        const centerY = 300;
        const otherNodes = egoData.nodes.filter(n => n.id !== egoData.centerEntity!.id);
        const radius = Math.max(200, otherNodes.length * 20);

        const nodes: Node[] = [
            {
                id: String(egoData.centerEntity.id),
                type: "ego",
                position: { x: centerX, y: centerY },
                data: { ...egoData.centerEntity, isCenter: true },
            },
            ...otherNodes.map((entity, i) => {
                const angle = (2 * Math.PI * i) / otherNodes.length - Math.PI / 2;
                return {
                    id: String(entity.id),
                    type: "ego",
                    position: {
                        x: centerX + radius * Math.cos(angle),
                        y: centerY + radius * Math.sin(angle),
                    },
                    data: { ...entity, isCenter: false },
                };
            }),
        ];

        const edges: Edge[] = egoData.edges.map((edge) => {
            const cat = categoryColors[edge.relationCategory || "other"] || categoryColors.other;
            return {
                id: `e${edge.id}`,
                source: String(edge.subjectId),
                target: String(edge.objectId),
                label: edge.relationType,
                type: "smoothstep",
                animated: edge.importance === "critical",
                style: {
                    stroke: cat.border,
                    strokeWidth: edge.importance === "critical" ? 3 : edge.importance === "high" ? 2 : 1.5,
                },
                labelStyle: { fontSize: 10, fill: cat.text },
                markerEnd: { type: MarkerType.ArrowClosed, color: cat.border },
            };
        });

        return { flowNodes: nodes, flowEdges: edges };
    }, [egoData]);

    const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

    useEffect(() => {
        setNodes(flowNodes);
        setEdges(flowEdges);
    }, [flowNodes, flowEdges, setNodes, setEdges]);

    const onNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
        const nodeId = Number(node.id);
        setSelectedNodeId(nodeId);
    }, []);

    const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: Node) => {
        setCenterEntityId(Number(node.id));
        setSelectedNodeId(null);
    }, []);

    const toggleCategory = (cat: string) => {
        setSelectedCategories(prev => {
            const next = new Set(prev);
            if (next.has(cat)) next.delete(cat);
            else next.add(cat);
            return next;
        });
    };

    const selectedEntity = egoData?.nodes.find(n => n.id === selectedNodeId);
    const selectedRelations = egoData?.edges.filter(
        e => e.subjectId === selectedNodeId || e.objectId === selectedNodeId
    );

    // All unique categories from edges
    const availableCategories = useMemo(() => {
        if (!egoData?.edges) return [];
        const cats = new Set(egoData.edges.map(e => e.relationCategory || "other"));
        return Array.from(cats);
    }, [egoData]);

    if (!centerEntityId) {
        return (
            <div className="flex items-center justify-center h-96">
                <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
            </div>
        );
    }

    return (
        <div className="flex h-[calc(100vh-140px)]">
            {/* Filters sidebar */}
            <div className="w-56 bg-gray-800/50 border-r border-gray-700/50 p-4 flex flex-col gap-4">

                {/* Search */}
                <div className="relative" ref={searchRef}>
                    <div className="relative">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-500" />
                        <Input
                            placeholder="Поиск узла..."
                            className="bg-gray-900 border-gray-700 text-sm pl-9 h-9"
                            value={searchQuery}
                            onChange={(e) => {
                                setSearchQuery(e.target.value);
                                setIsSearchOpen(true);
                            }}
                            onFocus={() => setIsSearchOpen(true)}
                        />
                    </div>
                    {isSearchOpen && debouncedSearch.length > 0 && (
                        <div className="absolute top-10 left-0 right-0 max-h-60 overflow-y-auto bg-gray-800 border border-gray-700 rounded-md shadow-xl z-50 p-1">
                            {isSearchLoading ? (
                                <div className="p-2 text-center text-xs text-gray-400 py-4">Поиск...</div>
                            ) : searchResults && searchResults.length > 0 ? (
                                searchResults.map(entity => {
                                    const Icon = baseTypeIcons[entity.baseType] || HelpCircle;
                                    const colors = baseTypeColors[entity.baseType] || baseTypeColors.other;
                                    return (
                                        <div
                                            key={entity.id}
                                            className="px-2 py-1.5 hover:bg-gray-700 rounded cursor-pointer text-sm text-gray-200 flex items-center gap-2"
                                            onClick={() => {
                                                setCenterEntityId(entity.id);
                                                setSelectedNodeId(null);
                                                setIsSearchOpen(false);
                                                setSearchQuery("");
                                            }}
                                        >
                                            <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: colors.border }} />
                                            <span className="truncate">{entity.name}</span>
                                        </div>
                                    )
                                })
                            ) : (
                                <div className="p-2 text-center text-xs text-gray-400 py-4">Ничего не найдено</div>
                            )}
                        </div>
                    )}
                </div>

                <div>
                    <p className="text-xs text-gray-400 mb-2 uppercase tracking-wider">Центр графа</p>
                    <Badge variant="outline" className="text-purple-300 border-purple-500/50 w-full justify-center py-1">
                        {egoData?.centerEntity?.name || "..."}
                    </Badge>
                </div>

                <div>
                    <p className="text-xs text-gray-400 mb-2 uppercase tracking-wider">Категории</p>
                    <div className="space-y-1.5">
                        {Object.entries(categoryColors).filter(([key]) => key !== 'other' || availableCategories.includes('other')).map(([key, cat]) => {
                            const CatIcon = cat.icon;
                            const isActive = selectedCategories.size === 0 || selectedCategories.has(key);
                            return (
                                <button
                                    key={key}
                                    onClick={() => toggleCategory(key)}
                                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-all ${isActive
                                        ? "bg-opacity-30 border"
                                        : "opacity-40 hover:opacity-70"
                                        }`}
                                    style={{
                                        backgroundColor: isActive ? cat.bg : "transparent",
                                        borderColor: isActive ? cat.border + "40" : "transparent",
                                        color: cat.text,
                                    }}
                                >
                                    <CatIcon className="w-3.5 h-3.5" />
                                    <span className="truncate">{key}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>

                <div className="mt-auto text-xs text-gray-500 space-y-1">
                    <p>Клик → выбрать узел</p>
                    <p>Двойной клик → новый центр</p>
                    <p>Связей: {egoData?.edges.length || 0}</p>
                </div>
            </div>

            {/* Graph Canvas */}
            <div className="flex-1 relative">
                {isLoading ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : flowNodes.length === 0 ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="text-center">
                            <Network className="h-12 w-12 text-gray-600 mx-auto mb-3" />
                            <p className="text-gray-500">У этой сущности нет связей</p>
                        </div>
                    </div>
                ) : (
                    <ReactFlow
                        nodes={nodes}
                        edges={edges}
                        onNodesChange={onNodesChange}
                        onEdgesChange={onEdgesChange}
                        onNodeClick={onNodeClick}
                        onNodeDoubleClick={onNodeDoubleClick}
                        nodeTypes={nodeTypes}
                        fitView
                        attributionPosition="bottom-left"
                        className="bg-gray-900"
                    >
                        <Controls className="!bg-gray-800 !border-gray-700 !shadow-xl [&_button]:!bg-gray-700 [&_button]:!border-gray-600 [&_button]:!text-gray-300 [&_button:hover]:!bg-gray-600" />
                        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#374151" />
                    </ReactFlow>
                )}
            </div>

            {/* Detail panel */}
            {selectedEntity && (
                <div className="w-72 bg-gray-800/50 border-l border-gray-700/50 flex flex-col">
                    <div className="p-3 border-b border-gray-700/50 flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-300">Детали</span>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setSelectedNodeId(null)}>
                            <X className="h-3.5 w-3.5" />
                        </Button>
                    </div>
                    <ScrollArea className="flex-1 p-3">
                        <div className="space-y-3">
                            {/* Entity Info */}
                            <div>
                                <div className="flex items-center gap-2 mb-2">
                                    {(() => {
                                        const Icon = baseTypeIcons[selectedEntity.baseType] || HelpCircle;
                                        const colors = baseTypeColors[selectedEntity.baseType] || baseTypeColors.other;
                                        return <Icon className="h-5 w-5" style={{ color: colors.border }} />;
                                    })()}
                                    <span className="font-semibold text-gray-200">{selectedEntity.name}</span>
                                </div>
                                <div className="flex gap-1.5 flex-wrap mb-2">
                                    <Badge variant="outline" className="text-xs" style={{
                                        borderColor: (baseTypeColors[selectedEntity.baseType] || baseTypeColors.other).border + "60",
                                        color: (baseTypeColors[selectedEntity.baseType] || baseTypeColors.other).text,
                                    }}>
                                        {baseTypeLabels[selectedEntity.baseType] || selectedEntity.baseType}
                                    </Badge>
                                    {selectedEntity.subType && (
                                        <Badge variant="outline" className="text-xs text-gray-400 border-gray-600">{selectedEntity.subType}</Badge>
                                    )}
                                </div>
                                {selectedEntity.description && (
                                    <p className="text-xs text-gray-400 mb-2">{selectedEntity.description}</p>
                                )}
                                <div className="text-xs text-gray-500 space-y-0.5">
                                    <p>Упоминаний: {selectedEntity.mentionCount}</p>
                                    <p>Уверенность: {selectedEntity.confidence}</p>
                                </div>
                            </div>

                            {/* Relations */}
                            {selectedRelations && selectedRelations.length > 0 && (
                                <div>
                                    <p className="text-xs text-gray-400 mb-1.5 uppercase tracking-wider">Связи ({selectedRelations.length})</p>
                                    <div className="space-y-1.5">
                                        {selectedRelations.map(rel => {
                                            const isSource = rel.subjectId === selectedNodeId;
                                            const otherId = isSource ? rel.objectId : rel.subjectId;
                                            const other = egoData?.nodes.find(n => n.id === otherId);
                                            const cat = categoryColors[rel.relationCategory || "other"] || categoryColors.other;
                                            return (
                                                <div
                                                    key={rel.id}
                                                    className="p-2 rounded-lg bg-gray-700/30 hover:bg-gray-700/50 cursor-pointer transition-colors text-xs"
                                                    onClick={() => {
                                                        setCenterEntityId(otherId);
                                                        setSelectedNodeId(null);
                                                    }}
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <span className="text-gray-500">{isSource ? "→" : "←"}</span>
                                                        <span className="font-medium text-gray-300">{other?.name}</span>
                                                    </div>
                                                    <div className="mt-1 flex items-center gap-1.5">
                                                        <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: cat.border }} />
                                                        <span style={{ color: cat.text }}>{rel.relationType}</span>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}

                            {/* Navigate button */}
                            <Button
                                variant="outline"
                                size="sm"
                                className="w-full text-xs border-purple-500/30 text-purple-300 hover:bg-purple-900/30"
                                onClick={() => {
                                    setCenterEntityId(selectedEntity.id);
                                    setSelectedNodeId(null);
                                }}
                            >
                                <Target className="w-3 h-3 mr-1" />
                                Сделать центром
                            </Button>
                        </div>
                    </ScrollArea>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// Relations Table Tab
// ============================================================================

function RelationsTableTab({ initialCategory, initialEntityType }: {
    initialCategory?: string;
    initialEntityType?: string;
}) {
    const [page, setPage] = useState(1);
    const [searchQuery, setSearchQuery] = useState("");
    const [categoryFilter, setCategoryFilter] = useState<string>(initialCategory || "all");
    const [entityTypeFilter, setEntityTypeFilter] = useState<string>(initialEntityType || "all");
    const [importanceFilter, setImportanceFilter] = useState<string>("all");
    const [debouncedSearch, setDebouncedSearch] = useState("");

    // Update filters when parent sends new initial values
    useEffect(() => {
        if (initialCategory) setCategoryFilter(initialCategory);
    }, [initialCategory]);
    useEffect(() => {
        if (initialEntityType) setEntityTypeFilter(initialEntityType);
    }, [initialEntityType]);

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
        return () => clearTimeout(timer);
    }, [searchQuery]);

    // Reset page on filter change
    useEffect(() => {
        setPage(1);
    }, [debouncedSearch, categoryFilter, entityTypeFilter, importanceFilter]);

    const queryParams = new URLSearchParams();
    queryParams.set("page", String(page));
    queryParams.set("limit", "20");
    if (categoryFilter !== "all") queryParams.set("category", categoryFilter);
    if (entityTypeFilter !== "all") queryParams.set("entityType", entityTypeFilter);
    if (importanceFilter !== "all") queryParams.set("importance", importanceFilter);
    if (debouncedSearch) queryParams.set("search", debouncedSearch);

    const { data, isLoading } = useQuery<RelationsListData>({
        queryKey: ["/api/graph/relations", page, categoryFilter, entityTypeFilter, importanceFilter, debouncedSearch],
        queryFn: async () => {
            const res = await fetch(`/api/graph/relations?${queryParams.toString()}`);
            if (!res.ok) throw new Error("Failed");
            return res.json();
        },
    });

    const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

    return (
        <div className="flex flex-col h-[calc(100vh-140px)]">
            {/* Toolbar */}
            <div className="p-4 border-b border-gray-700/50 flex items-center gap-3 flex-wrap">
                <div className="relative flex-1 min-w-[200px] max-w-md">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500" />
                    <Input
                        placeholder="Поиск по сущностям и связям..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="pl-10 bg-gray-800 border-gray-700 text-gray-200 placeholder:text-gray-500"
                    />
                    {searchQuery && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6"
                            onClick={() => setSearchQuery("")}
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    )}
                </div>

                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                    <SelectTrigger className="w-[160px] bg-gray-800 border-gray-700 text-gray-300">
                        <SelectValue placeholder="Категория" />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700">
                        <SelectItem value="all">Все категории</SelectItem>
                        {Object.keys(categoryColors).map(cat => (
                            <SelectItem key={cat} value={cat}>{cat}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
                    <SelectTrigger className="w-[160px] bg-gray-800 border-gray-700 text-gray-300">
                        <SelectValue placeholder="Тип сущности" />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700">
                        <SelectItem value="all">Все типы</SelectItem>
                        {Object.entries(baseTypeLabels).map(([key, label]) => (
                            <SelectItem key={key} value={key}>{label}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>

                <Select value={importanceFilter} onValueChange={setImportanceFilter}>
                    <SelectTrigger className="w-[160px] bg-gray-800 border-gray-700 text-gray-300">
                        <SelectValue placeholder="Важность" />
                    </SelectTrigger>
                    <SelectContent className="bg-gray-800 border-gray-700">
                        <SelectItem value="all">Любая важность</SelectItem>
                        <SelectItem value="critical">Critical</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                        <SelectItem value="normal">Normal</SelectItem>
                        <SelectItem value="detail">Detail</SelectItem>
                    </SelectContent>
                </Select>

                <div className="text-xs text-gray-500 ml-auto">
                    {data ? `${data.total} записей` : "..."}
                </div>
            </div>

            {/* Table */}
            <ScrollArea className="flex-1">
                {isLoading ? (
                    <div className="flex items-center justify-center h-48">
                        <div className="w-8 h-8 border-4 border-purple-500 border-t-transparent rounded-full animate-spin" />
                    </div>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow className="border-gray-700/50 hover:bg-transparent">
                                <TableHead className="text-gray-400">Субъект</TableHead>
                                <TableHead className="text-gray-400">Связь</TableHead>
                                <TableHead className="text-gray-400">Объект</TableHead>
                                <TableHead className="text-gray-400">Категория</TableHead>
                                <TableHead className="text-gray-400">Важность</TableHead>
                                <TableHead className="text-gray-400">Дата</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {data?.relations.map((rel) => {
                                const cat = categoryColors[rel.category || "other"] || categoryColors.other;
                                const subjectColors = baseTypeColors[rel.subjectType] || baseTypeColors.other;
                                const objectColors = baseTypeColors[rel.objectType] || baseTypeColors.other;
                                return (
                                    <TableRow key={rel.id} className="border-gray-700/30 hover:bg-gray-800/50">
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: subjectColors.border }} />
                                                <span className="text-gray-200 font-medium text-sm">{rel.subjectName}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-gray-400 text-sm">{rel.relationType}</span>
                                        </TableCell>
                                        <TableCell>
                                            <div className="flex items-center gap-2">
                                                <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: objectColors.border }} />
                                                <span className="text-gray-200 font-medium text-sm">{rel.objectName}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell>
                                            <Badge
                                                variant="outline"
                                                className="text-xs"
                                                style={{ borderColor: cat.border + "60", color: cat.text }}
                                            >
                                                {rel.category || "other"}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className={`text-xs ${importanceBadge[rel.importance] || importanceBadge.normal}`}>
                                                {rel.importance}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            <span className="text-xs text-gray-500">
                                                {new Date(rel.createdAt).toLocaleDateString("ru-RU")}
                                            </span>
                                        </TableCell>
                                    </TableRow>
                                );
                            })}
                            {(!data?.relations || data.relations.length === 0) && (
                                <TableRow>
                                    <TableCell colSpan={6} className="text-center text-gray-500 py-12">
                                        {debouncedSearch ? "Ничего не найдено" : "Связей пока нет"}
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                )}
            </ScrollArea>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className="p-3 border-t border-gray-700/50 flex items-center justify-center gap-2">
                    <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 border-gray-700 text-gray-400"
                        disabled={page <= 1}
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <span className="text-sm text-gray-400 min-w-[80px] text-center">
                        {page} / {totalPages}
                    </span>
                    <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 border-gray-700 text-gray-400"
                        disabled={page >= totalPages}
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                    >
                        <ChevronRight className="h-4 w-4" />
                    </Button>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// Main Page Component
// ============================================================================

export default function GraphPage() {
    const [, setLocation] = useLocation();
    const [activeTab, setActiveTab] = useState("overview");

    // Cross-tab navigation state
    const [navEntityId, setNavEntityId] = useState<number | undefined>();
    const [navCategory, setNavCategory] = useState<string | undefined>();
    const [navEntityType, setNavEntityType] = useState<string | undefined>();

    const handleNavigate = useCallback((tab: string, filters?: { category?: string; entityType?: string; entityId?: number }) => {
        if (filters?.category) setNavCategory(filters.category);
        if (filters?.entityType) setNavEntityType(filters.entityType);
        if (filters?.entityId) setNavEntityId(filters.entityId);

        // Reset irrelevant state when switching
        if (tab === 'facts') {
            if (!filters?.category) setNavCategory(undefined);
            if (!filters?.entityType) setNavEntityType(undefined);
        }
        if (tab === 'relations') {
            setNavCategory(undefined);
            setNavEntityType(undefined);
        }

        setActiveTab(tab);
    }, []);

    return (
        <div className="h-screen bg-gray-900 text-gray-100 flex flex-col overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>

            {/* Tabs */}
            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
                <div className="bg-gray-800/40 border-b border-gray-700/50 px-4">
                    <TabsList className="bg-transparent h-auto p-0 gap-1">
                        <TabsTrigger
                            value="overview"
                            className="rounded-none border-b-2 border-transparent data-[state=active]:border-purple-400 data-[state=active]:bg-transparent data-[state=active]:text-purple-300 text-gray-400 px-4 py-2.5 text-sm"
                        >
                            <Eye className="w-4 h-4 mr-1.5" />
                            Обзор
                        </TabsTrigger>
                        <TabsTrigger
                            value="relations"
                            className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:text-blue-300 text-gray-400 px-4 py-2.5 text-sm"
                        >
                            <Network className="w-4 h-4 mr-1.5" />
                            Связи
                        </TabsTrigger>
                        <TabsTrigger
                            value="facts"
                            className="rounded-none border-b-2 border-transparent data-[state=active]:border-green-400 data-[state=active]:bg-transparent data-[state=active]:text-green-300 text-gray-400 px-4 py-2.5 text-sm"
                        >
                            <Activity className="w-4 h-4 mr-1.5" />
                            Факты
                        </TabsTrigger>
                    </TabsList>
                </div>

                <TabsContent value="overview" className="flex-1 m-0 mt-0">
                    <OverviewTab onNavigate={handleNavigate} />
                </TabsContent>
                <TabsContent value="relations" className="flex-1 m-0 mt-0">
                    <EgoGraphTab initialEntityId={navEntityId} />
                </TabsContent>
                <TabsContent value="facts" className="flex-1 m-0 mt-0">
                    <RelationsTableTab initialCategory={navCategory} initialEntityType={navEntityType} />
                </TabsContent>
            </Tabs>
        </div>
    );
}
