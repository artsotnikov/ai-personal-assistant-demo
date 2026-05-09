import { useState, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock, Eye, EyeOff } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface AuthPageProps {
  onAuthenticated: () => void;
}

export default function AuthPage({ onAuthenticated }: AuthPageProps) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isSetupMode, setIsSetupMode] = useState(false);
  const { toast } = useToast();

  const { data: authStatus } = useQuery({
    queryKey: ["/api/auth/status"],
  });

  useEffect(() => {
    if (authStatus && typeof authStatus === 'object' && 'hasPassword' in authStatus && 'allowSetup' in authStatus) {
      const status = authStatus as { hasPassword: boolean; allowSetup: boolean };
      
      // Если пароль уже есть, всегда режим логина, независимо от allowSetup
      if (status.hasPassword) {
        setIsSetupMode(false);
      } else {
        // Если пароля нет, показываем setup только если разрешено
        setIsSetupMode(status.allowSetup);
      }
      
      // Если в продакшене нет пароля, показать критическую ошибку
      if (!status.hasPassword && !status.allowSetup) {
        toast({
          title: "Критическая ошибка безопасности!",
          description: "Система не настроена. Обратитесь к администратору.",
          variant: "destructive",
          duration: 0, // Не скрывать автоматически
        });
      }
    }
  }, [authStatus, toast]);

  const setupMutation = useMutation({
    mutationFn: async (password: string) => {
      const response = await apiRequest("POST", "/api/auth/setup", { password });
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Успешно",
        description: "Пароль установлен успешно",
      });
      setIsSetupMode(false);
      setPassword("");
    },
    onError: (error) => {
      toast({
        title: "Ошибка",
        description: error.message || "Не удалось установить пароль",
        variant: "destructive",
      });
    },
  });

  const loginMutation = useMutation({
    mutationFn: async (password: string) => {
      const response = await apiRequest("POST", "/api/auth/login", { password });
      return response.json();
    },
    onSuccess: (data) => {
      localStorage.setItem('auth_token', data.token);
      localStorage.setItem('auth_time', Date.now().toString());
      toast({
        title: "Добро пожаловать!",
        description: "Вход выполнен успешно",
      });
      onAuthenticated();
    },
    onError: (error) => {
      toast({
        title: "Ошибка",
        description: error.message || "Неверный пароль",
        variant: "destructive",
      });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    
    if (isSetupMode) {
      setupMutation.mutate(password);
    } else {
      loginMutation.mutate(password);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto w-12 h-12 bg-blue-100 dark:bg-blue-900 rounded-full flex items-center justify-center mb-4">
            <Lock className="w-6 h-6 text-blue-600 dark:text-blue-400" />
          </div>
          <CardTitle className="text-2xl">
            {isSetupMode ? "Настройка безопасности" : "Вход в систему"}
          </CardTitle>
          <CardDescription>
            {isSetupMode 
              ? "Установите пароль для защиты доступа к вашему ИИ-ассистенту"
              : "Введите пароль для доступа к ИИ-ассистенту"
            }
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(() => {
            if (authStatus && typeof authStatus === 'object' && 'hasPassword' in authStatus && 'allowSetup' in authStatus) {
              const status = authStatus as { hasPassword: boolean; allowSetup: boolean };
              if (!status.hasPassword && !status.allowSetup) {
                return (
                  <div className="text-center text-red-600 dark:text-red-400 p-4 bg-red-50 dark:bg-red-950 rounded-lg">
                    <p className="font-medium">Система не настроена</p>
                    <p className="text-sm mt-1">Пароль не установлен и создание новых паролей запрещено в продакшене.</p>
                  </div>
                );
              }
            }
            
            return (
              <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">
                {isSetupMode ? "Новый пароль" : "Пароль"}
              </Label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={isSetupMode ? "Минимум 4 символа" : "Введите пароль"}
                  className="pr-10"
                  disabled={setupMutation.isPending || loginMutation.isPending}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                  onClick={() => setShowPassword(!showPassword)}
                  disabled={setupMutation.isPending || loginMutation.isPending}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4 text-gray-400" />
                  ) : (
                    <Eye className="h-4 w-4 text-gray-400" />
                  )}
                </Button>
              </div>
              {isSetupMode && (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Этот пароль будет использоваться для входа в приложение
                </p>
              )}
            </div>
            <Button 
              type="submit" 
              className="w-full"
              disabled={!password.trim() || setupMutation.isPending || loginMutation.isPending}
            >
              {setupMutation.isPending || loginMutation.isPending 
                ? "Обработка..." 
                : isSetupMode 
                  ? "Установить пароль" 
                  : "Войти"
              }
            </Button>
          </form>
            );
          })()}
        </CardContent>
      </Card>
    </div>
  );
}