import { useRef, useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Image, FileText, Camera, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

export default function FileUpload() {
  const [dragOver, setDragOver] = useState(false);
  const [dragCounter, setDragCounter] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('content', file.type.startsWith('image/') ? 'Изображение' : 'Файл');

      const response = await apiRequest("POST", "/api/upload", formData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      toast({
        title: "Успех",
        description: "Файл успешно отправлен",
      });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось загрузить файл",
        variant: "destructive",
      });
    },
  });

  const handleFileUpload = (file: File) => {
    // Validate file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "Ошибка",
        description: "Размер файла не должен превышать 10MB",
        variant: "destructive",
      });
      return;
    }

    // Validate file type
    const allowedTypes = /\.(jpeg|jpg|png|gif|webp|webm|mp3|wav|ogg|heic|heif)$/i;
    if (!allowedTypes.test(file.name)) {
      toast({
        title: "Ошибка",
        description: "Неподдерживаемый тип файла",
        variant: "destructive",
      });
      return;
    }

    uploadFileMutation.mutate(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragCounter(0);
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileUpload(files[0]);
    }
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    setDragCounter(prev => prev + 1);
    if (dragCounter === 0) {
      setDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragCounter(prev => prev - 1);
    if (dragCounter <= 1) {
      setDragOver(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const openFileDialog = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      handleFileUpload(files[0]);
    }
    // Reset input
    e.target.value = '';
  };

  // Global drag and drop handlers - только для предотвращения случайного дропа файлов в браузере
  useEffect(() => {
    const handleGlobalDragOver = (e: DragEvent) => {
      // Только предотвращаем default behavior для файлов
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
      }
    };

    const handleGlobalDrop = (e: DragEvent) => {
      // Только предотвращаем default behavior для файлов
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        setDragCounter(0);
        setDragOver(false);
      }
    };

    document.addEventListener('dragover', handleGlobalDragOver);
    document.addEventListener('drop', handleGlobalDrop);

    return () => {
      document.removeEventListener('dragover', handleGlobalDragOver);
      document.removeEventListener('drop', handleGlobalDrop);
    };
  }, []);

  return (
    <>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,audio/*"
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Drag & Drop Overlay */}
      {dragOver && (
        <div
          className="fixed inset-0 bg-blue-500 bg-opacity-10 z-50 flex items-center justify-center"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
        >
          <div className="border-2 border-dashed border-blue-500 rounded-xl p-6 bg-white shadow-lg text-center max-w-md">
            <Upload className="text-4xl text-blue-500 mb-3 mx-auto" />
            <p className="text-blue-700 mb-2 font-medium">Отпустите файл для загрузки</p>
            <p className="text-sm text-blue-600">
              Поддерживаются изображения и аудио (до 10MB)
            </p>
          </div>
        </div>
      )}

      {/* Upload progress indicator */}
      {uploadFileMutation.isPending && (
        <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-xl">
          <div className="flex items-center space-x-3">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <span className="text-blue-700">Загрузка файла...</span>
          </div>
        </div>
      )}
    </>
  );
}

// Sub-components for attachment menu
FileUpload.ImageButton = function ImageButton() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const uploadImageMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('content', 'Изображение');

      const response = await apiRequest("POST", "/api/upload", formData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось загрузить изображение",
        variant: "destructive",
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      uploadImageMutation.mutate(files[0]);
    }
    e.target.value = '';
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        className="flex flex-col items-center p-3 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
        disabled={uploadImageMutation.isPending}
      >
        <Image className="text-2xl text-blue-500 mb-2" />
        <span className="text-sm text-gray-700 dark:text-gray-300">Изображение</span>
      </button>
    </>
  );
};

FileUpload.DocumentButton = function DocumentButton() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const uploadDocumentMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);

      const response = await apiRequest("POST", "/api/upload-document-file", formData);
      return response.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      toast({
        title: "Документ сохранён",
        description: data.document?.title
          ? `📄 ${data.document.title} (${data.document.documentType})`
          : "Документ успешно обработан",
      });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось загрузить документ",
        variant: "destructive",
      });
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const file = files[0];

      // Validate file size (10MB limit)
      if (file.size > 10 * 1024 * 1024) {
        toast({
          title: "Ошибка",
          description: "Размер файла не должен превышать 10MB",
          variant: "destructive",
        });
        return;
      }

      uploadDocumentMutation.mutate(file);
    }
    e.target.value = '';
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.doc,.docx,.txt,.rtf"
        onChange={handleFileChange}
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        className="flex flex-col items-center p-3 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
        disabled={uploadDocumentMutation.isPending}
      >
        <FileText className="text-2xl text-green-500 mb-2" />
        <span className="text-sm text-gray-700 dark:text-gray-300">Документ</span>
      </button>
    </>
  );
};

FileUpload.CameraButton = function CameraButton() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const uploadCameraMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('content', 'Фото с камеры');

      const response = await apiRequest("POST", "/api/upload", formData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
      toast({
        title: "Успех",
        description: "Фото с камеры отправлено",
      });
    },
    onError: () => {
      toast({
        title: "Ошибка",
        description: "Не удалось сделать фото",
        variant: "destructive",
      });
    },
  });

  const handleCameraCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        }
      });

      // Create video element
      const video = document.createElement('video');
      video.srcObject = stream;
      video.autoplay = true;

      // Create canvas for capture
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // Create modal for camera interface
      const modal = document.createElement('div');
      modal.className = 'fixed inset-0 bg-black bg-opacity-75 z-50 flex items-center justify-center p-4';

      const content = document.createElement('div');
      content.className = 'bg-white rounded-xl p-6 max-w-md w-full text-center';

      video.className = 'w-full rounded-lg mb-4';
      content.appendChild(video);

      const buttonContainer = document.createElement('div');
      buttonContainer.className = 'flex space-x-3 justify-center';

      const captureBtn = document.createElement('button');
      captureBtn.textContent = 'Сделать фото';
      captureBtn.className = 'px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700';

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Отмена';
      cancelBtn.className = 'px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400';

      buttonContainer.appendChild(captureBtn);
      buttonContainer.appendChild(cancelBtn);
      content.appendChild(buttonContainer);
      modal.appendChild(content);
      document.body.appendChild(modal);

      video.addEventListener('loadedmetadata', () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      });

      captureBtn.onclick = () => {
        if (ctx) {
          ctx.drawImage(video, 0, 0);
          canvas.toBlob((blob) => {
            if (blob) {
              const file = new File([blob], 'camera-photo.jpg', { type: 'image/jpeg' });
              uploadCameraMutation.mutate(file);
            }
          }, 'image/jpeg', 0.8);
        }
        stream.getTracks().forEach(track => track.stop());
        document.body.removeChild(modal);
      };

      cancelBtn.onclick = () => {
        stream.getTracks().forEach(track => track.stop());
        document.body.removeChild(modal);
      };

    } catch (error) {
      toast({
        title: "Ошибка",
        description: "Не удалось получить доступ к камере",
        variant: "destructive",
      });
    }
  };

  return (
    <button
      onClick={handleCameraCapture}
      className="flex flex-col items-center p-3 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
      disabled={uploadCameraMutation.isPending}
    >
      <Camera className="text-2xl text-purple-500 mb-2" />
      <span className="text-sm text-gray-700 dark:text-gray-300">Камера</span>
    </button>
  );
};