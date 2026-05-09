import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { FileText, Search, ListTodo, Bookmark, FileStack, Archive, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ChatHeader from "@/components/chat/ChatHeader";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel,
    AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
    AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";

export default function NotesPage() {
    const [searchQuery, setSearchQuery] = useState("");
    const [filterType, setFilterType] = useState<string>("all");
    const [showArchived, setShowArchived] = useState(false);

    const { data: notes, isLoading } = useQuery({
        queryKey: ["/api/notes", { includeArchived: showArchived, type: filterType !== "all" ? filterType : undefined }],
        queryFn: async () => {
            const params = new URLSearchParams();
            if (showArchived) params.append("includeArchived", "true");
            if (filterType !== "all") params.append("type", filterType);

            const res = await fetch(`/api/notes?${params.toString()}`);
            if (!res.ok) throw new Error("Ошибка загрузки заметок");
            return res.json();
        }
    });

    const { toast } = useToast();
    const queryClient = useQueryClient();

    const deleteMutation = useMutation({
        mutationFn: async (noteId: number) => {
            const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Не удалось удалить заметку");
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
            toast({ title: "Успех", description: "Заметка удалена" });
        },
        onError: () => {
            toast({ title: "Ошибка", description: "Не удалось удалить заметку", variant: "destructive" });
        }
    });

    const getIconForType = (type: string) => {
        switch (type) {
            case 'shopping_list':
            case 'checklist':
                return <ListTodo className="h-5 w-5 text-blue-500" />;
            case 'bookmark':
                return <Bookmark className="h-5 w-5 text-purple-500" />;
            case 'tracker':
                return <FileStack className="h-5 w-5 text-green-500" />;
            default:
                return <FileText className="h-5 w-5 text-gray-500" />;
        }
    };

    const getTypeName = (type: string) => {
        switch (type) {
            case 'shopping_list': return "Список покупок";
            case 'checklist': return "Чеклист";
            case 'draft': return "Черновик";
            case 'bookmark': return "Закладка";
            case 'tracker': return "Трекер";
            default: return "Заметка";
        }
    };

    const filteredNotes = notes?.filter((note: any) =>
        note.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        note.tags?.some((tag: string) => tag.toLowerCase().includes(searchQuery.toLowerCase()))
    );

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>
            <div className="flex-1 flex flex-col h-full overflow-hidden">
                <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4 shrink-0">
                    <div className="flex items-center justify-between max-w-6xl mx-auto w-full">
                        <h1 className="text-2xl font-bold flex items-center gap-2">
                            <FileText className="h-6 w-6 text-blue-500" />
                            Мои заметки
                        </h1>
                        <Link href="/notes/new">
                            <Button>
                                <Plus className="h-4 w-4 mr-2" />
                                Создать заметку
                            </Button>
                        </Link>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                    <div className="max-w-6xl mx-auto space-y-6">

                        <div className="flex flex-col md:flex-row gap-4 justify-between items-start md:items-center bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
                            <div className="relative w-full md:w-96">
                                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                                <Input
                                    placeholder="Поиск по названию или тегам..."
                                    className="pl-9"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                            </div>

                            <div className="flex items-center gap-4 w-full md:w-auto">
                                <Select value={filterType} onValueChange={setFilterType}>
                                    <SelectTrigger className="w-full md:w-[180px]">
                                        <SelectValue placeholder="Все типы" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">Все типы</SelectItem>
                                        <SelectItem value="note">Заметки</SelectItem>
                                        <SelectItem value="shopping_list">Списки покупок</SelectItem>
                                        <SelectItem value="checklist">Чеклисты</SelectItem>
                                        <SelectItem value="bookmark">Закладки</SelectItem>
                                        <SelectItem value="draft">Черновики</SelectItem>
                                    </SelectContent>
                                </Select>

                                <Button
                                    variant={showArchived ? "default" : "outline"}
                                    onClick={() => setShowArchived(!showArchived)}
                                    className="whitespace-nowrap"
                                >
                                    <Archive className="h-4 w-4 mr-2" />
                                    {showArchived ? "Скрыть архив" : "Показать архив"}
                                </Button>
                            </div>
                        </div>

                        {isLoading ? (
                            <div className="flex justify-center items-center h-64">
                                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
                            </div>
                        ) : filteredNotes?.length === 0 ? (
                            <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700">
                                <FileText className="h-16 w-16 text-gray-300 mx-auto mb-4" />
                                <h3 className="text-xl font-medium text-gray-700 dark:text-gray-300 mb-2">Заметки не найдены</h3>
                                <p className="text-gray-500 dark:text-gray-400 mb-4">
                                    {searchQuery ? "По вашему запросу ничего не найдено" : "У вас пока нет заметок. Начните с создания первой!"}
                                </p>
                                {!searchQuery && (
                                    <Link href="/notes/new">
                                        <Button>
                                            <Plus className="h-4 w-4 mr-2" />
                                            Создать первую заметку
                                        </Button>
                                    </Link>
                                )}
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                {filteredNotes?.map((note: any) => (
                                    <Link key={note.id} href={`/notes/${note.id}`}>
                                        <Card className="group h-full cursor-pointer hover:shadow-md transition-shadow border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 opacity-90 hover:opacity-100 flex flex-col relative">
                                            <CardHeader className="pb-3 pt-4 px-4">
                                                <div className="flex justify-between items-start gap-2">
                                                    <CardTitle className="text-lg line-clamp-2 leading-tight pr-8">
                                                        {note.title}
                                                    </CardTitle>

                                                    <div className="absolute top-2 right-2 flex flex-col gap-2 items-center">
                                                        <div className="shrink-0 mt-0.5">
                                                            {getIconForType(note.type)}
                                                        </div>

                                                        <AlertDialog>
                                                            <AlertDialogTrigger asChild>
                                                                <Button
                                                                    variant="ghost"
                                                                    size="icon"
                                                                    className="h-7 w-7 text-red-400 hover:text-red-700 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-opacity"
                                                                    onClick={(e) => e.preventDefault()}
                                                                >
                                                                    <Trash2 className="h-4 w-4" />
                                                                </Button>
                                                            </AlertDialogTrigger>
                                                            <AlertDialogContent onClick={(e) => e.stopPropagation()}>
                                                                <AlertDialogHeader>
                                                                    <AlertDialogTitle>Удалить заметку?</AlertDialogTitle>
                                                                    <AlertDialogDescription>
                                                                        Заметка "{note.title}" будет удалена навсегда.
                                                                    </AlertDialogDescription>
                                                                </AlertDialogHeader>
                                                                <AlertDialogFooter>
                                                                    <AlertDialogCancel onClick={(e) => e.stopPropagation()}>Отмена</AlertDialogCancel>
                                                                    <AlertDialogAction
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            e.preventDefault();
                                                                            deleteMutation.mutate(note.id);
                                                                        }}
                                                                        className="bg-red-500 hover:bg-red-600"
                                                                    >
                                                                        Удалить
                                                                    </AlertDialogAction>
                                                                </AlertDialogFooter>
                                                            </AlertDialogContent>
                                                        </AlertDialog>
                                                    </div>
                                                </div>
                                                <CardDescription className="text-xs mt-1 flex items-center justify-between">
                                                    <span>{getTypeName(note.type)}</span>
                                                    {note.isPinned && <span className="text-amber-500">📌 Закреплена</span>}
                                                </CardDescription>
                                            </CardHeader>
                                            <CardContent className="px-4 py-2 flex-grow">
                                                {note.content ? (
                                                    <p className="text-sm text-gray-600 dark:text-gray-300 line-clamp-3 selectable-text">
                                                        {note.content}
                                                    </p>
                                                ) : note.items && note.items.length > 0 ? (
                                                    <div className="space-y-1">
                                                        {note.items.slice(0, 3).map((item: any, i: number) => (
                                                            <div key={item.id || i} className="flex items-start gap-2 text-sm text-gray-600 dark:text-gray-300">
                                                                <div className={`shrink-0 mt-1 h-3 w-3 rounded-sm border ${item.checked ? 'bg-blue-500 border-blue-500' : 'border-gray-300'}`}>
                                                                    {item.checked && (
                                                                        <svg className="h-3 w-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                                                        </svg>
                                                                    )}
                                                                </div>
                                                                <span className={`line-clamp-1 break-all ${item.checked ? 'line-through opacity-70' : ''}`}>
                                                                    {item.text}
                                                                </span>
                                                            </div>
                                                        ))}
                                                        {note.items.length > 3 && (
                                                            <p className="text-xs text-gray-400 mt-1 italic">
                                                                и еще {note.items.length - 3}...
                                                            </p>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <p className="text-sm text-gray-400 italic">Пустая заметка</p>
                                                )}
                                            </CardContent>
                                            <CardFooter className="px-4 pb-4 pt-2 flex flex-wrap gap-1 mt-auto">
                                                {note.tags?.slice(0, 3).map((tag: string, i: number) => (
                                                    <Badge key={i} variant="secondary" className="text-xs font-normal">
                                                        {tag}
                                                    </Badge>
                                                ))}
                                                {note.tags?.length > 3 && (
                                                    <Badge variant="outline" className="text-xs px-1">
                                                        +{note.tags.length - 3}
                                                    </Badge>
                                                )}
                                                <span className="text-xs text-gray-400 ml-auto whitespace-nowrap mt-1">
                                                    {new Date(note.updatedAt).toLocaleDateString()}
                                                </span>
                                            </CardFooter>
                                        </Card>
                                    </Link>
                                ))}
                            </div>
                        )}
                    </div>
                </main>
            </div>
        </div>
    );
}
