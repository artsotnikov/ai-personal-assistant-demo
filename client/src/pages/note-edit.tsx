import { useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import ChatHeader from "@/components/chat/ChatHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { NoteEditor } from "@/components/notes/NoteEditor";

export default function NoteEditPage() {
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

    const updateMutation = useMutation({
        mutationFn: async (data: any) => {
            const res = await fetch(`/api/notes/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });
            if (!res.ok) throw new Error("Не удалось сохранить заметку");
            return res.json();
        },
        onSuccess: (updatedNote) => {
            queryClient.setQueryData(["/api/notes", id], updatedNote);
            queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
            toast({ title: "Успех", description: "Заметка сохранена" });
            setLocation(`/notes/${id}`);
        },
        onError: (error: any) => {
            toast({ title: "Ошибка", description: error.message, variant: "destructive" });
        }
    });

    return (
        <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900 overflow-hidden">
            <div className="flex-shrink-0">
                <ChatHeader />
            </div>
            <div className="flex-1 flex flex-col h-full overflow-hidden">
                <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 p-4">
                    <div className="flex items-center gap-4 max-w-4xl mx-auto w-full">
                        <Button variant="ghost" size="icon" onClick={() => setLocation(`/notes/${id}`)}>
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                        <h1 className="text-2xl font-bold truncate">Редактирование заметки</h1>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                    <div className="max-w-4xl mx-auto">
                        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6 md:p-8">
                            {isLoading ? (
                                <div className="space-y-4">
                                    <Skeleton className="h-10 w-full" />
                                    <Skeleton className="h-10 w-2/3" />
                                    <Skeleton className="h-32 w-full" />
                                </div>
                            ) : (
                                <NoteEditor
                                    initialData={note}
                                    onSubmit={(data) => updateMutation.mutate(data)}
                                    onCancel={() => setLocation(`/notes/${id}`)}
                                    isLoading={updateMutation.isPending}
                                />
                            )}
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
