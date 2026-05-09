import { useState, useEffect } from "react";
import { Link } from "wouter";
import ChatHeader from "@/components/chat/ChatHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { User, Plus, Trash2, Sparkles, Save } from "lucide-react";

interface ProfileEntry {
    id: number;
    key: string;
    value: string;
    category: string | null;
    updatedAt: string;
}

interface StructuredProfile {
    personality: Record<string, string>;
    values: string[];
    strengths: string[];
    weaknesses: string[];
    communicationStyle: string;
    summary: string;
}

const CATEGORIES = [
    { value: "personality", label: "Личность", color: "bg-purple-500" },
    { value: "values", label: "Ценности", color: "bg-blue-500" },
    { value: "strengths", label: "Сильные стороны", color: "bg-green-500" },
    { value: "weaknesses", label: "Области развития", color: "bg-amber-500" },
    { value: "communication", label: "Коммуникация", color: "bg-pink-500" },
];

export default function ProfilePage() {
    const [entries, setEntries] = useState<ProfileEntry[]>([]);
    const [profile, setProfile] = useState<StructuredProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [analyzing, setAnalyzing] = useState(false);

    // New entry form
    const [newKey, setNewKey] = useState("");
    const [newValue, setNewValue] = useState("");
    const [newCategory, setNewCategory] = useState("values");

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            const [entriesRes, profileRes] = await Promise.all([
                fetch("/api/profile/entries"),
                fetch("/api/profile")
            ]);

            const entriesData = await entriesRes.json();
            const profileData = await profileRes.json();

            setEntries(entriesData);
            setProfile(profileData);
        } catch (error) {
            console.error("Error fetching profile:", error);
        } finally {
            setLoading(false);
        }
    };

    const handleAddEntry = async () => {
        if (!newKey.trim() || !newValue.trim()) return;

        try {
            const res = await fetch("/api/profile", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: newKey, value: newValue, category: newCategory }),
            });

            if (res.ok) {
                setNewKey("");
                setNewValue("");
                fetchData();
            }
        } catch (error) {
            console.error("Error adding entry:", error);
        }
    };

    const handleDeleteEntry = async (key: string) => {
        try {
            await fetch(`/api/profile/${encodeURIComponent(key)}`, { method: "DELETE" });
            fetchData();
        } catch (error) {
            console.error("Error deleting entry:", error);
        }
    };

    const handleAnalyze = async () => {
        setAnalyzing(true);
        try {
            const res = await fetch("/api/profile/analyze", { method: "POST" });
            const data = await res.json();
            alert(data.message);
            fetchData();
        } catch (error) {
            console.error("Error analyzing profile:", error);
        } finally {
            setAnalyzing(false);
        }
    };

    const getCategoryInfo = (category: string | null) => {
        return CATEGORIES.find(c => c.value === category) || CATEGORIES[0];
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-500"></div>
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
                                <User className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                            </div>
                            <div>
                                <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                                    Профиль
                                </h1>
                                <p className="text-gray-500 dark:text-gray-400 text-sm">
                                    Характеристики, влияющие на стиль общения AI
                                </p>
                            </div>
                        </div>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 md:p-8">
                    <div className="max-w-4xl mx-auto">

                {/* Summary Cards */}
                {profile && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
                        {profile.values.length > 0 && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm text-blue-600">Ценности</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex flex-wrap gap-1">
                                        {profile.values.slice(0, 5).map((v, i) => (
                                            <Badge key={i} variant="secondary">{v}</Badge>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        )}

                        {profile.strengths.length > 0 && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm text-green-600">Сильные стороны</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex flex-wrap gap-1">
                                        {profile.strengths.slice(0, 5).map((s, i) => (
                                            <Badge key={i} variant="secondary" className="bg-green-100 text-green-700">{s}</Badge>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        )}

                        {profile.weaknesses.length > 0 && (
                            <Card>
                                <CardHeader className="pb-2">
                                    <CardTitle className="text-sm text-amber-600">Области развития</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="flex flex-wrap gap-1">
                                        {profile.weaknesses.slice(0, 5).map((w, i) => (
                                            <Badge key={i} variant="secondary" className="bg-amber-100 text-amber-700">{w}</Badge>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </div>
                )}

                {/* AI Analyze Button */}
                <Card className="mb-6">
                    <CardContent className="p-4 flex items-center justify-between">
                        <div>
                            <h3 className="font-medium">Автоматический анализ</h3>
                            <p className="text-sm text-gray-500">
                                Извлечь характеристики профиля из ваших сообщений
                            </p>
                        </div>
                        <Button onClick={handleAnalyze} disabled={analyzing}>
                            <Sparkles className="h-4 w-4 mr-2" />
                            {analyzing ? "Анализ..." : "Анализировать"}
                        </Button>
                    </CardContent>
                </Card>

                {/* Add Entry Form */}
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle className="text-lg">Добавить запись</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-col md:flex-row gap-3">
                            <Select value={newCategory} onValueChange={setNewCategory}>
                                <SelectTrigger className="w-full md:w-48">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {CATEGORIES.map(cat => (
                                        <SelectItem key={cat.value} value={cat.value}>
                                            {cat.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>

                            <Input
                                placeholder="Ключ (напр. хобби)"
                                value={newKey}
                                onChange={(e) => setNewKey(e.target.value)}
                                className="flex-1"
                            />

                            <Input
                                placeholder="Значение (напр. программирование)"
                                value={newValue}
                                onChange={(e) => setNewValue(e.target.value)}
                                className="flex-1"
                            />

                            <Button onClick={handleAddEntry} disabled={!newKey.trim() || !newValue.trim()}>
                                <Plus className="h-4 w-4 mr-2" />
                                Добавить
                            </Button>
                        </div>
                    </CardContent>
                </Card>

                {/* Entries List */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">Все записи профиля</CardTitle>
                        <CardDescription>{entries.length} записей</CardDescription>
                    </CardHeader>
                    <CardContent>
                        {entries.length === 0 ? (
                            <p className="text-center text-gray-500 py-8">
                                Записей пока нет. Добавьте вручную или запустите анализ.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {entries.map((entry) => {
                                    const catInfo = getCategoryInfo(entry.category);
                                    return (
                                        <div
                                            key={entry.id}
                                            className="flex items-center justify-between p-3 rounded-lg bg-gray-50 dark:bg-gray-800/50"
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`w-2 h-2 rounded-full ${catInfo.color}`} />
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-medium">{entry.key}</span>
                                                        <Badge variant="outline" className="text-xs">
                                                            {catInfo.label}
                                                        </Badge>
                                                    </div>
                                                    <p className="text-sm text-gray-600 dark:text-gray-400">
                                                        {entry.value}
                                                    </p>
                                                </div>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => handleDeleteEntry(entry.key)}
                                                className="text-red-500 hover:text-red-600 hover:bg-red-50"
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </CardContent>
                </Card>
                    </div>
                </main>
            </div>
        </div>
    );
}
