import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Mic, Square, X, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useWakeLock } from "@/hooks/useWakeLock";

interface VoiceRecorderProps {
  onRecordingComplete: () => void;
  onCancel: () => void;
}

export default function VoiceRecorder({ onRecordingComplete, onCancel }: VoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordingInterrupted, setRecordingInterrupted] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingStartTimeRef = useRef<number>(0);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const wakeLock = useWakeLock();

  const uploadAudioMutation = useMutation({
    mutationFn: async (audioBlob: Blob) => {
      const formData = new FormData();
      formData.append('file', audioBlob, 'voice-message.webm');
      formData.append('content', 'Голосовое сообщение');

      const response = await apiRequest("POST", "/api/upload", formData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      onRecordingComplete();
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось отправить голосовое сообщение",
        variant: "destructive",
      });
    },
  });

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });
      
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];
      setRecordingInterrupted(false);

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        setRecordedBlob(blob);
        stream.getTracks().forEach(track => track.stop());
        wakeLock.release();
      };

      // Используем timeslice для периодического получения данных (каждые 1 сек)
      // Это помогает не потерять данные при внезапной остановке
      mediaRecorder.start(1000);
      setIsRecording(true);
      setRecordingTime(0);
      recordingStartTimeRef.current = Date.now();

      // Таймер на основе реального времени
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordingStartTimeRef.current) / 1000);
        setRecordingTime(elapsed);
      }, 500);

      // Запрашиваем Wake Lock чтобы экран не гас автоматически
      // (делаем после старта записи, чтобы не блокировать основной функционал)
      wakeLock.request();

    } catch (error) {
      toast({
        title: "Ошибка",
        description: "Не удалось получить доступ к микрофону",
        variant: "destructive",
      });
    }
  };

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    wakeLock.release();
  }, [wakeLock]);

  const handleSendRecording = () => {
    if (recordedBlob) {
      uploadAudioMutation.mutate(recordedBlob);
    }
  };

  const handleCancel = () => {
    if (isRecording) {
      stopRecording();
    }
    setRecordedBlob(null);
    setRecordingTime(0);
    onCancel();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Детекция блокировки экрана / ухода со страницы во время записи
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && isRecording) {
        // Экран заблокирован или вкладка свёрнута во время записи
        setRecordingInterrupted(true);
        toast({
          title: "⚠️ Запись может быть прервана",
          description: "Экран заблокирован — аудио может не записываться. Разблокируйте экран.",
          variant: "destructive",
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isRecording, toast]);

  // Очистка при размонтировании
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      wakeLock.release();
    };
  }, [wakeLock]);

  if (!isRecording && !recordedBlob) {
    return (
      <div className="p-4 sm:p-6 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
          <div className="flex items-center space-x-3 sm:space-x-4">
            <Mic className="w-6 h-6 text-blue-600 dark:text-blue-400 flex-shrink-0" />
            <span className="text-blue-700 dark:text-blue-300 font-medium text-sm sm:text-base">Готов к записи голосового сообщения</span>
          </div>
          <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-3">
            <Button
              onClick={startRecording}
              className="w-full sm:w-auto px-4 sm:px-6 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-all duration-200 font-medium shadow-md hover:shadow-lg text-sm sm:text-base"
            >
              <Mic className="w-4 h-4 mr-2" />
              Начать запись
            </Button>
            <Button
              onClick={handleCancel}
              variant="outline"
              className="w-full sm:w-auto px-4 py-2.5 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors text-sm sm:text-base"
            >
              <X className="w-4 h-4 mr-1" />
              Отменить
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (isRecording) {
    return (
      <div className="p-4 sm:p-6 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl">
        <div className="flex flex-col space-y-4">
          {/* Recording status and timer */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-3 sm:space-y-0">
            <div className="flex items-center space-x-3 sm:space-x-4">
              <div className={`w-4 h-4 rounded-full flex-shrink-0 ${recordingInterrupted ? 'bg-yellow-500 animate-pulse' : 'bg-red-500 animate-pulse'}`}></div>
              <span className="text-red-700 dark:text-red-300 font-medium text-sm sm:text-base">
                {recordingInterrupted ? 'Запись могла прерваться!' : 'Идет запись...'}
              </span>
              <span className="text-red-600 dark:text-red-400 font-mono text-lg sm:text-xl font-bold">{formatTime(recordingTime)}</span>
            </div>
            {recordingInterrupted && (
              <div className="flex items-center space-x-2 mt-1">
                <AlertTriangle className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                <span className="text-yellow-600 dark:text-yellow-400 text-xs">Экран был заблокирован — рекомендуется перезаписать</span>
              </div>
            )}
            <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-3">
              <Button
                onClick={stopRecording}
                className="w-full sm:w-auto px-4 sm:px-6 py-2.5 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-all duration-200 font-medium shadow-md hover:shadow-lg text-sm sm:text-base"
              >
                <Square className="w-4 h-4 mr-2" />
                Остановить
              </Button>
              <Button
                onClick={handleCancel}
                variant="outline"
                className="w-full sm:w-auto px-4 py-2.5 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors text-sm sm:text-base"
              >
                <X className="w-4 h-4 mr-1" />
                Отменить
              </Button>
            </div>
          </div>
          
          {/* Visual recording indicator */}
          <div className="flex items-center justify-center space-x-2">
            <div className="flex space-x-1">
              <div className="w-1 h-4 bg-red-500 rounded-full animate-bounce" style={{animationDelay: '0ms'}}></div>
              <div className="w-1 h-4 bg-red-500 rounded-full animate-bounce" style={{animationDelay: '150ms'}}></div>
              <div className="w-1 h-4 bg-red-500 rounded-full animate-bounce" style={{animationDelay: '300ms'}}></div>
            </div>
            <span className="text-red-600 dark:text-red-400 text-sm font-medium">Запись в процессе</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
        <div className="flex items-center space-x-3 sm:space-x-4">
          <div className="w-4 h-4 bg-green-500 rounded-full flex-shrink-0"></div>
          <span className="text-green-700 dark:text-green-300 font-medium text-sm sm:text-base">Запись готова к отправке</span>
          <span className="text-green-600 dark:text-green-400 font-mono text-lg sm:text-xl font-bold">{formatTime(recordingTime)}</span>
        </div>
        <div className="flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-3">
          <Button
            onClick={handleSendRecording}
            disabled={uploadAudioMutation.isPending}
            className="w-full sm:w-auto px-4 sm:px-6 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-all duration-200 font-medium shadow-md hover:shadow-lg disabled:opacity-50 text-sm sm:text-base"
          >
            {uploadAudioMutation.isPending ? 'Отправка...' : 'Отправить'}
          </Button>
          <Button
            onClick={handleCancel}
            variant="outline"
            className="w-full sm:w-auto px-4 py-2.5 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors text-sm sm:text-base"
          >
            <X className="w-4 h-4 mr-1" />
            Отменить
          </Button>
        </div>
      </div>
    </div>
  );
}