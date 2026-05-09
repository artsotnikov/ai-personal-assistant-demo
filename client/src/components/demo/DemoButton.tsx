import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export default function DemoButton() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const sendDemoMessageMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/messages", {
        content: "Привет! Это тестовое сообщение для демонстрации работы чата.",
        type: 'text',
        sender: 'user',
        status: 'sent',
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      toast({
        title: "Сообщение отправлено",
        description: "ИИ обрабатывает ваш запрос...",
      });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось отправить демо сообщение",
        variant: "destructive",
      });
    },
  });

  return (
    <Button
      onClick={() => sendDemoMessageMutation.mutate()}
      disabled={sendDemoMessageMutation.isPending}
      className="bg-blue-600 text-white hover:bg-blue-700 px-6 py-2 rounded-lg"
      data-testid="button-demo"
    >
      {sendDemoMessageMutation.isPending ? (
        <>
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Отправка...
        </>
      ) : (
        <>
          <Play className="w-4 h-4 mr-2" />
          Попробовать демо
        </>
      )}
    </Button>
  );
}
