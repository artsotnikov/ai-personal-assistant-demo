import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, FileText, Trash2 } from "lucide-react";
import ChatHeader from "@/components/chat/ChatHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel,
    AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
    AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";

export default function NoteDetailPage() {
    const { id } = useParams<{ id: string }>();
    const [, setLocation] = useLocation();
    const { toast } = useToast();
    const queryClient = useQueryClient();

    const { data: note, isLoading } = useQuery({
        queryKey: ["/api/notes", id],
        queryFn: async () => {
            const res = await fetch(`/api/notes/${id}`);
            if (!res.ok) {
                if (res.status === 404) setLocation('/notes');
                throw new Error("Заметка не найдена");
            }
            return res.json();
        }
    });

    const toggleBlockMutation = useMutation({
        mutationFn: async ({ noteId, blockId, checked }: { noteId: number, blockId: string, checked: boolean }) => {
            const res = await fetch(`/api/notes/${noteId}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    blocks: note?.blocks?.map((block: any) =>
                        block.id === blockId ? { ...block, checked } : block
                    )
                })
            });
            if (!res.ok) throw new Error("Не удалось обновить статус");
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/notes", id] });
        },
        onError: () => {
            toast({ title: "Ошибка", description: "Не удалось обновить статус пункта", variant: "destructive" });
        }
    });

    const deleteMutation = useMutation({
        mutationFn: async (noteId: number) => {
            const res = await fetch(`/api/notes/${noteId}`, { method: "DELETE" });
            if (!res.ok) throw new Error("Не удалось удалить заметку");
            return res.json();
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
            toast({ title: "Успех", description: "Заметка удалена" });
            setLocation('/notes');
        },
        onError: () => {
            toast({ title: "Ошибка", description: "Не удалось удалить заметку", variant: "destructive" });
        }
    });

    const getIconForType = (type: string) => {
        if (type === 'document') return <FileText className="h-6 w-6 text-blue-500" />;
        return <FileText className="h-6 w-6 text-gray-500" />;
    };

    const getTypeName = (type: string) => {
        if (type === 'document') return "Документ";
        return "Заметка";
    };

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>
            <div className="flex-1 flex flex-col h-full overflow-hidden">
                <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4">
                    <div className="flex items-center gap-4 max-w-4xl mx-auto w-full">
                        <Button variant="ghost" size="icon" onClick={() => setLocation('/notes')}>
                            <ArrowLeft className="h-5 w-5" />
                        </Button>

                        {isLoading ? (
                            <Skeleton className="h-8 w-64" />
                        ) : (
                            <div className="flex items-center gap-3 flex-1 overflow-hidden">
                                {getIconForType(note?.type)}
                                <h1 className="text-2xl font-bold truncate" title={note?.title}>
                                    {note?.title}
                                </h1>
                            </div>
                        )}

                        <Badge className="hidden sm:inline-flex ml-auto flex-shrink-0" variant="secondary">
                            {isLoading ? "..." : getTypeName(note?.type)}
                        </Badge>

                        {!isLoading && note && (
                            <div className="flex items-center gap-2 ml-2 flex-shrink-0">
                                <Button variant="outline" size="sm" onClick={() => setLocation(`/notes/${id}/edit`)}>
                                    Редактировать
                                </Button>
                                <AlertDialog>
                                    <AlertDialogTrigger asChild>
                                        <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-700 hover:bg-red-50">
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </AlertDialogTrigger>
                                    <AlertDialogContent>
                                        <AlertDialogHeader>
                                            <AlertDialogTitle>Удалить заметку?</AlertDialogTitle>
                                            <AlertDialogDescription>
                                                Это действие необратимо. Заметка "{note.title}" будет удалена вместе со всем её содержимым.
                                            </AlertDialogDescription>
                                        </AlertDialogHeader>
                                        <AlertDialogFooter>
                                            <AlertDialogCancel>Отмена</AlertDialogCancel>
                                            <AlertDialogAction
                                                onClick={() => deleteMutation.mutate(note.id)}
                                                className="bg-red-500 hover:bg-red-600"
                                                disabled={deleteMutation.isPending}
                                            >
                                                {deleteMutation.isPending ? "Удаление..." : "Удалить"}
                                            </AlertDialogAction>
                                        </AlertDialogFooter>
                                    </AlertDialogContent>
                                </AlertDialog>
                            </div>
                        )}
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                    <div className="max-w-4xl mx-auto">
                        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="p-6 md:p-8">
                                {isLoading ? (
                                    <div className="space-y-4">
                                        <Skeleton className="h-4 w-full" />
                                        <Skeleton className="h-4 w-5/6" />
                                        <Skeleton className="h-4 w-full" />
                                        <Skeleton className="h-4 w-4/6" />
                                    </div>
                                ) : (
                                    <>
                                        {/* Tags section */}
                                        {note?.tags && note.tags.length > 0 && (
                                            <div className="flex flex-wrap gap-2 mb-6 pb-6 border-b border-gray-100 dark:border-gray-700">
                                                {note.tags.map((tag: string, i: number) => (
                                                    <Badge key={i} variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/20 dark:text-blue-300 dark:border-blue-800">
                                                        #{tag}
                                                    </Badge>
                                                ))}
                                            </div>
                                        )}

                                        {/* Blocks Section */}
                                        {note?.blocks && note.blocks.length > 0 ? (
                                            <div className="space-y-3">
                                                {note.blocks.map((block: any) => (
                                                    <div key={block.id}>
                                                        {block.type === 'text' ? (
                                                            <div className="prose dark:prose-invert max-w-none whitespace-pre-wrap selectable-text">
                                                                {block.content}
                                                            </div>
                                                        ) : (
                                                            <div
                                                                className={`flex items-start gap-3 p-3 rounded-md transition-colors cursor-pointer ${block.checked
                                                                    ? 'bg-gray-50 dark:bg-gray-900/50'
                                                                    : 'hover:bg-gray-50 dark:hover:bg-gray-800/80'
                                                                    }`}
                                                                onClick={() => toggleBlockMutation.mutate({
                                                                    noteId: note.id,
                                                                    blockId: block.id,
                                                                    checked: !block.checked
                                                                })}
                                                            >
                                                                <Checkbox
                                                                    checked={block.checked}
                                                                    onCheckedChange={(checked) => {
                                                                        toggleBlockMutation.mutate({
                                                                            noteId: note.id,
                                                                            blockId: block.id,
                                                                            checked: checked === true
                                                                        });
                                                                    }}
                                                                    className="mt-1"
                                                                />
                                                                <p className={`text-base break-words ${block.checked
                                                                    ? 'line-through text-gray-400 dark:text-gray-500'
                                                                    : 'text-gray-900 dark:text-gray-100'
                                                                    }`}>
                                                                    {block.content}
                                                                </p>
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        ) : (
                                            // Fallback: legacy content/items
                                            <>
                                                {note?.content && (
                                                    <div className="prose dark:prose-invert max-w-none whitespace-pre-wrap selectable-text">{note.content}</div>
                                                )}
                                                {note?.items && note.items.length > 0 && (
                                                    <div className="mt-4 space-y-2">
                                                        {note.items.map((item: any) => (
                                                            <div key={item.id} className="flex items-center gap-3">
                                                                <Checkbox checked={item.checked} className="mt-0.5" />
                                                                <span className={item.checked ? 'line-through text-gray-400' : ''}>{item.text}</span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                    </>
                                )}
                            </div>

                            {!isLoading && (
                                <div className="bg-gray-50 dark:bg-gray-900 p-4 border-t border-gray-200 dark:border-gray-700 text-sm text-gray-500 flex justify-between">
                                    <span>Создано: {new Date(note?.createdAt).toLocaleString()}</span>
                                    <span>Обновлено: {new Date(note?.updatedAt).toLocaleString()}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
