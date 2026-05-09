import { useState, useRef, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Mic, Send, X, Paperclip, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useWakeLock } from "@/hooks/useWakeLock";
import VoiceRecorder from "./VoiceRecorder";
import QuickCommands from "./QuickCommands";
import type { InsertMessage } from "@shared/schema";

export default function InputArea() {
  const [message, setMessage] = useState("");
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);

  // Unified attached image state (from paste, file picker, drag-n-drop)
  const [attachedImage, setAttachedImage] = useState<File | null>(null);
  const [attachedPreview, setAttachedPreview] = useState<string | null>(null);

  // Voice caption state
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isRecordingCaption, setIsRecordingCaption] = useState(false);
  const captionRecorderRef = useRef<MediaRecorder | null>(null);
  const captionChunksRef = useRef<Blob[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const wakeLock = useWakeLock();

  // --- Mutations ---

  // Send text-only message
  const sendMessageMutation = useMutation({
    mutationFn: async (messageData: InsertMessage) => {
      const response = await apiRequest("POST", "/api/messages", messageData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      resetInput();
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось отправить сообщение",
        variant: "destructive",
      });
    },
  });

  // Upload image (with optional text description)
  const uploadImageMutation = useMutation({
    mutationFn: async ({ file, content }: { file: File; content: string }) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('content', content);
      const response = await apiRequest("POST", "/api/upload", formData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      resetInput();
      toast({ title: "Успех", description: "Изображение отправлено" });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось отправить изображение",
        variant: "destructive",
      });
    },
  });

  // --- Helpers ---

  const resetInput = () => {
    setMessage("");
    setAttachedImage(null);
    setAttachedPreview(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = '44px';
      saveTextareaHeight();
    }
  };

  const autoResizeTextarea = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const scrollHeight = textareaRef.current.scrollHeight;
      const maxHeight = 150;
      const minHeight = 44;
      const newHeight = `${Math.min(Math.max(scrollHeight, minHeight), maxHeight)}px`;
      textareaRef.current.style.height = newHeight;
      saveTextareaHeight();
    }
  };

  const saveTextareaHeight = () => {
    if (textareaRef.current) {
      localStorage.setItem('textarea_height', textareaRef.current.style.height);
    }
  };

  // --- Attach image from any source ---

  const attachImage = (file: File) => {
    // Validate size
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Ошибка",
        description: "Изображение слишком большое (макс. 10MB)",
        variant: "destructive",
      });
      return;
    }

    // Validate type
    if (!file.type.startsWith('image/')) {
      toast({
        title: "Ошибка",
        description: "Поддерживаются только изображения",
        variant: "destructive",
      });
      return;
    }

    setAttachedImage(file);
    const reader = new FileReader();
    reader.onload = (ev) => setAttachedPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  };

  const removeAttachedImage = () => {
    setAttachedImage(null);
    setAttachedPreview(null);
  };

  // --- Send handler (unified: text only OR image+text) ---

  const handleSendMessage = () => {
    const trimmedMessage = message.trim();
    const isPending = sendMessageMutation.isPending || uploadImageMutation.isPending;
    if (isPending) return;

    if (attachedImage) {
      // Send image + text as single message
      uploadImageMutation.mutate({
        file: attachedImage,
        content: trimmedMessage || 'Изображение',
      });
    } else if (trimmedMessage) {
      // Send text-only message
      sendMessageMutation.mutate({
        content: trimmedMessage,
        type: 'text',
        sender: 'user',
        status: 'sent',
      });
    }
  };

  // --- Input handlers ---

  const handleCommandSelect = (command: string) => {
    if (sendMessageMutation.isPending) return;
    setShowActionMenu(false);
    sendMessageMutation.mutate({
      content: command,
      type: 'text',
      sender: 'user',
      status: 'sent',
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleInputChange = (value: string) => {
    setMessage(value);
    setTimeout(autoResizeTextarea, 0);
  };

  // --- Paste handler ---

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (!blob) return;

        const ext = blob.type.split('/')[1] || 'png';
        const file = new File([blob], `clipboard-${Date.now()}.${ext}`, { type: blob.type });
        attachImage(file);
        return;
      }
    }
  };

  // --- File picker ---

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      attachImage(files[0]);
    }
    e.target.value = '';
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  // --- Global drag-n-drop ---

  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        dragCounterRef.current++;
        if (dragCounterRef.current === 1) setDragOver(true);
      }
    };
    const handleDragLeave = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        dragCounterRef.current--;
        if (dragCounterRef.current <= 0) {
          dragCounterRef.current = 0;
          setDragOver(false);
        }
      }
    };
    const handleDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const file = files[0];
        if (file.type.startsWith('image/')) {
          attachImage(file);
        } else {
          toast({
            title: "Ошибка",
            description: "Поддерживаются только изображения. Перетащите картинку.",
            variant: "destructive",
          });
        }
      }
    };

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('drop', handleDrop);
    };
  }, []);

  // --- Voice caption (record → transcribe → insert text) ---

  const startVoiceCaption = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });

      captionRecorderRef.current = mediaRecorder;
      captionChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) captionChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        const blob = new Blob(captionChunksRef.current, { type: 'audio/webm' });
        setIsRecordingCaption(false);

        // Transcribe
        setIsTranscribing(true);
        try {
          const formData = new FormData();
          formData.append('file', blob, 'voice-caption.webm');
          const response = await apiRequest("POST", "/api/transcribe", formData);
          const data = await response.json();
          if (data.text) {
            setMessage(prev => {
              const separator = prev.trim() ? ' ' : '';
              return prev + separator + data.text;
            });
            setTimeout(autoResizeTextarea, 0);
          }
        } catch (err) {
          toast({
            title: "Ошибка",
            description: "Не удалось распознать голос",
            variant: "destructive",
          });
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start();
      setIsRecordingCaption(true);
      // Wake Lock чтобы экран не гас при диктовке описания
      await wakeLock.request();
    } catch {
      toast({
        title: "Ошибка",
        description: "Не удалось получить доступ к микрофону",
        variant: "destructive",
      });
    }
  };

  const stopVoiceCaption = () => {
    if (captionRecorderRef.current && isRecordingCaption) {
      captionRecorderRef.current.stop();
    }
    wakeLock.release();
  };

  // --- Restore textarea height ---

  useEffect(() => {
    const savedHeight = localStorage.getItem('textarea_height');
    if (savedHeight && textareaRef.current) {
      textareaRef.current.style.height = savedHeight;
    } else {
      autoResizeTextarea();
    }
  }, []);

  // --- Toggle handlers ---

  const toggleActionMenu = () => {
    setShowActionMenu(!showActionMenu);
    setShowVoiceRecorder(false);
  };

  const toggleVoiceRecorder = () => {
    setShowVoiceRecorder(!showVoiceRecorder);
    setShowActionMenu(false);
  };

  // --- Computed ---
  const isPending = sendMessageMutation.isPending || uploadImageMutation.isPending;
  const canSend = (message.trim() || attachedImage) && !isPending;

  return (
    <div className="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 px-3 py-3 md:px-4 md:py-4 input-area" style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}>
      {/* Drag-n-Drop Overlay */}
      {dragOver && (
        <div className="fixed inset-0 bg-blue-500/10 z-50 flex items-center justify-center backdrop-blur-sm">
          <div className="border-2 border-dashed border-blue-500 rounded-2xl p-8 bg-white/90 dark:bg-gray-900/90 shadow-2xl text-center max-w-sm">
            <Paperclip className="w-12 h-12 text-blue-500 mb-3 mx-auto" />
            <p className="text-blue-700 dark:text-blue-300 mb-1 font-semibold text-lg">Отпустите для прикрепления</p>
            <p className="text-sm text-blue-600/70 dark:text-blue-400/70">Поддерживаются изображения до 10MB</p>
          </div>
        </div>
      )}

      {/* Voice Recorder (for standalone voice messages) */}
      {showVoiceRecorder && (
        <div className="mb-4">
          <VoiceRecorder
            onRecordingComplete={() => setShowVoiceRecorder(false)}
            onCancel={() => setShowVoiceRecorder(false)}
          />
        </div>
      )}

      {/* Quick Commands Menu */}
      {showActionMenu && (
        <div className="mb-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg border animate-in slide-in-from-top-2 duration-200">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Быстрые команды</h4>
          <QuickCommands onCommandSelect={handleCommandSelect} />
        </div>
      )}

      {/* Main input area */}
      <div className="flex items-end space-x-2 md:space-x-3">
        {/* Action menu button (quick commands only) */}
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleActionMenu}
          className={`flex-shrink-0 p-2 md:p-3 rounded-full transition-colors ${showActionMenu
            ? 'text-blue-500 hover:text-blue-600 bg-blue-50 dark:bg-blue-900/20'
            : 'text-gray-500 dark:text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20'
            }`}
          title="Быстрые команды"
        >
          {showActionMenu ? <X className="w-5 h-5 md:w-6 md:h-6" /> : <Plus className="w-5 h-5 md:w-6 md:h-6" />}
        </Button>

        {/* Text input area with attached image preview */}
        <div className="flex-1 relative">
          {/* Attached image preview (unified — from any source) */}
          {attachedImage && attachedPreview && (
            <div className="mb-2 p-2.5 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl flex items-center gap-3 animate-in slide-in-from-bottom-2 duration-200">
              <img
                src={attachedPreview}
                alt="Прикреплённое изображение"
                className="w-14 h-14 object-cover rounded-lg flex-shrink-0 ring-1 ring-gray-200 dark:ring-gray-600"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-700 dark:text-gray-300 truncate">
                  {attachedImage.name}
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500">
                  {(attachedImage.size / 1024).toFixed(1)} KB
                </div>
              </div>

              {/* Voice caption button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={isRecordingCaption ? stopVoiceCaption : startVoiceCaption}
                disabled={isTranscribing}
                className={`p-1.5 h-auto rounded-full transition-all ${isRecordingCaption
                    ? 'text-red-500 bg-red-50 dark:bg-red-900/20 ring-2 ring-red-300 dark:ring-red-700 animate-pulse'
                    : isTranscribing
                      ? 'text-blue-400'
                      : 'text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20'
                  }`}
                title={isRecordingCaption ? "Остановить запись" : isTranscribing ? "Распознавание..." : "Голосовое описание"}
              >
                {isTranscribing ? (
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                ) : isRecordingCaption ? (
                  <MicOff className="w-4 h-4" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
              </Button>

              {/* Remove button */}
              <Button
                variant="ghost"
                size="sm"
                onClick={removeAttachedImage}
                className="text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 p-1.5 h-auto"
                title="Удалить"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          )}

          <div className="relative">
            <Textarea
              ref={textareaRef}
              value={message}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={attachedImage ? "Добавьте описание (необязательно)..." : "Введите сообщение..."}
              className="w-full resize-none border border-gray-300 dark:border-gray-600 rounded-xl px-4 py-3 pr-12 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent overflow-y-auto min-h-[52px] md:min-h-[56px] bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 leading-relaxed transition-all duration-200"
              rows={1}
            />

            {/* Attach file button (paperclip inside textarea) */}
            <Button
              variant="ghost"
              size="sm"
              onClick={openFilePicker}
              className="absolute right-3 top-3 text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 p-0 h-auto transition-colors"
              title="Прикрепить изображение"
            >
              <Paperclip className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileInputChange}
          className="hidden"
        />

        {/* Voice recording button */}
        <Button
          variant="ghost"
          size="lg"
          onClick={toggleVoiceRecorder}
          className={`flex-shrink-0 p-3 md:p-4 rounded-full transition-all duration-200 ${showVoiceRecorder
            ? 'text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 bg-red-50 dark:bg-red-900/10 ring-2 ring-red-200 dark:ring-red-800'
            : 'text-gray-500 dark:text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 hover:scale-105'
            }`}
          title="Записать голосовое сообщение"
        >
          <Mic className="w-5 h-5 md:w-6 md:h-6" />
        </Button>

        {/* Send button */}
        <Button
          onClick={handleSendMessage}
          disabled={!canSend}
          className="flex-shrink-0 p-3 md:p-4 bg-blue-600 text-white rounded-full hover:bg-blue-700 transition-colors disabled:bg-gray-300 dark:disabled:bg-gray-600"
        >
          <Send className="w-5 h-5 md:w-6 md:h-6" />
        </Button>
      </div>

      {/* Status indicator */}
      {isPending && (
        <div className="mt-2 flex items-center justify-center">
          <div className="flex items-center space-x-2 text-sm text-gray-500 dark:text-gray-400">
            <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-pulse"></div>
            <span>{uploadImageMutation.isPending ? 'Отправка изображения...' : 'Отправка сообщения...'}</span>
          </div>
        </div>
      )}
    </div>
  );
}
