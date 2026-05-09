import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import ChatHeader from "@/components/chat/ChatHeader";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { NoteEditor } from "@/components/notes/NoteEditor";

export default function NoteNewPage() {
    const [, setLocation] = useLocation();
    const { toast } = useToast();
    const queryClient = useQueryClient();

    const createMutation = useMutation({
        mutationFn: async (data: any) => {
            const res = await fetch(`/api/notes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data),
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(errData.message || "Не удалось создать заметку");
            }
            return res.json();
        },
        onSuccess: (newNote) => {
            queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
            toast({ title: "Успех", description: "Заметка создана" });
            setLocation(`/notes/${newNote.id}`);
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
                        <Button variant="ghost" size="icon" onClick={() => setLocation(`/notes`)}>
                            <ArrowLeft className="h-5 w-5" />
                        </Button>
                        <h1 className="text-2xl font-bold truncate">Новая заметка</h1>
                    </div>
                </header>

                <main className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
                    <div className="max-w-4xl mx-auto">
                        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6 md:p-8">
                            <NoteEditor
                                onSubmit={(data) => createMutation.mutate(data)}
                                onCancel={() => setLocation(`/notes`)}
                                isLoading={createMutation.isPending}
                            />
                        </div>
                    </div>
                </main>
            </div>
        </div>
    );
}
