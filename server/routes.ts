import type { Express, Request } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import {
  insertMessageSchema,
  insertAiPromptSchema,
  reminders,
  type AITaskType
} from "@shared/schema";
import type { Message, ProcessingStep } from "@shared/schema";
import { db } from "./db";
import { eq } from "drizzle-orm";

import multer from "multer";
import path from "path";
import fs from "fs";
import { z } from "zod";
import { getWorkflowForMessage, getRecentWorkflows, getWorkflowsForMessages } from "./services/workflowLogger";

// Auto-cleanup old files (older than 7 days)
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const FILE_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

function cleanupOldFiles() {
  const uploadsDir = 'uploads';
  if (!fs.existsSync(uploadsDir)) return;

  const now = Date.now();
  const files = fs.readdirSync(uploadsDir);
  let deletedCount = 0;

  for (const file of files) {
    const filePath = path.join(uploadsDir, file);
    try {
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > FILE_MAX_AGE) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    } catch (err) {
      console.error(`Ошибка при удалении файла ${file}:`, err);
    }
  }

  if (deletedCount > 0) {
    console.log(`Автоочистка: удалено ${deletedCount} файлов старше 7 дней`);
  }
}

// Run cleanup on startup and every 24 hours
cleanupOldFiles();
setInterval(cleanupOldFiles, CLEANUP_INTERVAL);
import {
  transcribeAudio,
  generateAIResponse,
  generateSummary,
  describeImage,
  checkAIConfiguration,
  getDefaultAIConfig,
  type AIConfig
} from "./aiService";
// Memory system imports
import { buildContext, formatContextForPrompt, getContextSummary } from "./contextBuilder";
import { extractAndSaveFacts } from "./factExtractor";
// Multi-agent system
import * as agentOrchestrator from "./agentOrchestrator";
// Profile and Goals
import * as profileManager from "./profileManager";
import * as goalManager from "./goalManager";
import * as noteManager from "./noteManager";
import { getModelsByProvider, getAvailableProviders } from "./aiModelsApi";
import { getAllConfigs, updateConfig, createConfig, bulkUpdateProvider } from "./aiConfigService";
import { startProactiveScheduler, setWebSocketClients, getPendingNotifications } from "./proactiveScheduler";
import * as aiTaskScheduler from "./aiTaskScheduler";
import * as subagentRegistry from "./subagentRegistry";
import { handleExternalEvent, setEventRouterWSClients, type ExternalEvent } from "./eventRouter";
import { createMessageEmbedding } from "./embeddingService";
import { syncNoteToVault } from "./vault/VaultManager";
import { YandexDiskService } from "./vault/YandexDiskService";
import { getRemoteChanges, pullFromCloud, getWatcherStatus, startWatcher, stopWatcher } from "./vault/CloudSyncWatcher";
import { notes as notesTable } from "@shared/schema";
import { tickTickService } from "./services/tickTickService";
import { diagInfo, diagWarn, diagError } from "./services/diagnosticLogger";

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

// Configure multer for file uploads
const fileStorage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname);
    cb(null, `${timestamp}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')}`);
  }
});

const upload = multer({
  storage: fileStorage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit (Whisper max)
  },
  fileFilter: (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp|webm|mp3|wav|ogg|pdf|doc|docx|txt|rtf|heic|heif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimeTypeCheck = /^(image\/|audio\/|application\/(pdf|msword|vnd\.openxmlformats-officedocument\.wordprocessingml\.document)|text\/)/.test(file.mimetype);

    if (mimeTypeCheck || extname) {
      return cb(null, true);
    } else {
      cb(new Error('Неподдерживаемый тип файла'));
    }
  }
});

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // Store connected clients
  const connectedClients = new Set<WebSocket>();

  // Function to broadcast new messages to all connected clients
  function broadcastMessage(message: any) {
    const messageData = JSON.stringify({
      type: 'new_message',
      message: message
    });

    console.log(`Broadcasting message to ${connectedClients.size} clients:`, message.content);

    connectedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageData);
      }
    });
  }

  // Broadcast processing step updates for timeline visualization
  function broadcastProcessingStep(step: ProcessingStep) {
    const stepData = JSON.stringify(step);
    connectedClients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(stepData);
      }
    });
  }

  // Initialize multi-agent system
  agentOrchestrator.initializeAgents().then(() => {
    console.log('🤖 Мульти-агентная система инициализирована');
  }).catch(err => {
    console.error('Ошибка инициализации агентов:', err);
  });

  // Get all messages (legacy endpoint)
  app.get("/api/messages", async (req, res) => {
    try {
      const messages = await storage.getMessages();
      res.json(messages);
    } catch (error) {
      res.status(500).json({ message: "Ошибка получения сообщений" });
    }
  });

  // Get paginated messages with workflow data
  app.get("/api/messages/paginated", async (req, res) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await storage.getMessagesPaginated(limit, offset);

      // Получаем ID user-сообщений для загрузки их workflows
      const userMessageIds = result.messages
        .filter(m => m.sender === 'user')
        .map(m => m.id);

      // Загружаем workflows для user-сообщений
      const workflowsMap = await getWorkflowsForMessages(userMessageIds);

      // Преобразуем Map в объект для JSON ответа
      const workflows: Record<number, any> = {};
      workflowsMap.forEach((workflow, messageId) => {
        workflows[messageId] = workflow;
      });

      res.json({
        ...result,
        workflows, // Добавляем workflows к ответу
      });
    } catch (error) {
      console.error("Error fetching paginated messages:", error);
      res.status(500).json({ message: "Ошибка получения сообщений" });
    }
  });

  // Send text message
  app.post("/api/messages", async (req, res) => {
    try {
      const messageData = insertMessageSchema.parse(req.body);
      const message = await storage.createMessage(messageData);

      // Fire-and-forget: генерация embedding для семантического поиска
      if (message.sender === 'user' && message.content.length >= 30) {
        createMessageEmbedding(message.id, message.content).catch(() => { });
      }

      // Broadcast new message to all connected WebSocket clients
      broadcastMessage(message);

      // Process with AI if it's a user message
      if (message.sender === 'user') {
        // Check if AI is configured
        const aiConfig = checkAIConfiguration();
        if (aiConfig.defaultProvider) {
          // Process asynchronously so we don't block the response
          processMessageWithAI(message, broadcastMessage, undefined, broadcastProcessingStep).catch(err => {
            console.error('Ошибка обработки AI:', err);
          });
        } else {
          console.warn('AI не настроен. Добавьте OPENAI_API_KEY или DEEPSEEK_API_KEY.');
        }
      }

      res.status(201).json(message);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Неверные данные сообщения", errors: error.errors });
      } else {
        res.status(500).json({ message: "Ошибка создания сообщения" });
      }
    }
  });

  // Upload file (image/audio)
  app.post("/api/upload", upload.single('file'), async (req: MulterRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Файл не найден" });
      }

      const fileUrl = `/uploads/${req.file.filename}`;
      let messageType: 'image' | 'audio' | 'document' | 'text' = 'text';

      if (req.file.mimetype.startsWith('image/')) {
        messageType = 'image';
      } else if (req.file.mimetype.startsWith('audio/')) {
        messageType = 'audio';
      } else if (req.file.mimetype.startsWith('application/') || req.file.mimetype.startsWith('text/')) {
        messageType = 'document';
      }

      // For audio files, try to transcribe first
      let content = req.body.content || (messageType === 'image' ? 'Изображение' : messageType === 'audio' ? 'Голосовое сообщение' : messageType === 'document' ? 'Документ' : 'Файл');
      let transcriptionFailed = false;
      let transcriptionError = '';

      // Transcribe audio if transcription providers are configured
      if (messageType === 'audio') {
        const aiConfig = checkAIConfiguration();
        if (aiConfig.canTranscribe) {
          try {
            const transcribedText = await transcribeAudio(`uploads/${req.file.filename}`);
            content = transcribedText || content;
            console.log('✅ Транскрибация завершена:', content.substring(0, 100));
          } catch (err: any) {
            console.error('❌ Ошибка транскрибации:', err?.message || err);
            transcriptionFailed = true;
            transcriptionError = err?.message || 'Неизвестная ошибка транскрибации';
            // Сохраняем сообщение с информацией об ошибке
            content = `[⚠️ Не удалось распознать голосовое сообщение: ${transcriptionError}]`;
          }
        } else {
          transcriptionFailed = true;
          transcriptionError = 'Нет настроенных провайдеров для транскрибации (GROQ_API_KEY или OPENAI_API_KEY)';
          content = `[⚠️ Транскрибация недоступна: ${transcriptionError}]`;
        }
      } else if (messageType === 'image') {
        // Automatic vision analysis for images
        try {
          const visionDesc = await describeImage(`uploads/${req.file.filename}`);
          if (visionDesc) {
            content = `[Изображение]: ${visionDesc}`;
            console.log('✅ Описание изображения сгенерировано:', content.substring(0, 100));
          }
        } catch (err: any) {
          console.warn('⚠️ Ошибка автоматического описания изображения. Файл будет загружен без AI описания:', err.message || err);
          // Don't fail the message, just no description
          content = req.body.content || 'Изображение';
        }
      }

      const message = await storage.createMessage({
        content,
        type: messageType,
        sender: 'user',
        fileUrl,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        status: transcriptionFailed ? 'error' : 'sent',
      });

      // Broadcast new message to all connected WebSocket clients
      broadcastMessage(message);

      // Транскрипция голосового сообщения хранится в поле content того же audio-сообщения
      // UI показывает транскрипцию под аудио-плеером — дублирование в БД не требуется

      // Process with AI ONLY if it's not a failed audio transcription
      // AI обрабатывает оригинальное аудио-сообщение (content уже содержит транскрипцию)
      // Дополнительное текстовое сообщение с транскрипцией — только для визуального отображения
      const aiConfig = checkAIConfiguration();
      if (aiConfig.defaultProvider && !transcriptionFailed) {
        processMessageWithAI(message, broadcastMessage, undefined, broadcastProcessingStep).catch(err => {
          console.error('Ошибка обработки AI:', err);
        });
      } else if (transcriptionFailed) {
        // Отправляем системное сообщение об ошибке транскрибации
        const errorMessage = await storage.createMessage({
          content: `🚫 **Не удалось распознать голосовое сообщение**\n\nОшибка: ${transcriptionError}\n\nПожалуйста, попробуйте:\n1. Записать сообщение заново с более чётким звуком\n2. Отправить текстовое сообщение\n3. Проверить подключение к интернету`,
          type: 'text',
          sender: 'assistant',
          status: 'delivered',
        });
        broadcastMessage(errorMessage);
      }

      res.status(201).json(message);
    } catch (error) {
      console.error('Ошибка загрузки файла:', error);
      res.status(500).json({ message: "Ошибка загрузки файла" });
    }
  });

  // Transcribe audio without creating a message (for voice captions)
  app.post("/api/transcribe", upload.single('file'), async (req: MulterRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Аудио файл не найден" });
      }

      const aiConfig = checkAIConfiguration();
      if (!aiConfig.canTranscribe) {
        // Cleanup temp file
        try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
        return res.status(503).json({ message: "Транскрибация недоступна: нет настроенных провайдеров" });
      }

      const filePath = `uploads/${req.file.filename}`;
      try {
        const text = await transcribeAudio(filePath);
        res.json({ text: text || '' });
      } finally {
        // Cleanup temp file
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    } catch (error: any) {
      console.error('Ошибка транскрибации:', error);
      res.status(500).json({ message: error?.message || "Ошибка транскрибации" });
    }
  });


  // ========== DOCUMENT UPLOAD API ==========

  // Upload document as text (no file needed)
  app.post("/api/upload-document", async (req, res) => {
    try {
      const { content, title, contentType, documentType } = req.body;

      if (!content || typeof content !== 'string' || content.trim().length === 0) {
        return res.status(400).json({ message: "Содержимое документа обязательно (поле content)" });
      }

      const { saveDocument } = await import("./documentManager");
      const result = await saveDocument({
        content: content.trim(),
        title: title || undefined,
        contentType: contentType || 'plain_text',
        documentType: documentType || undefined,
      });

      res.status(201).json({
        message: "Документ сохранён",
        document: result,
      });
    } catch (error) {
      console.error('Ошибка загрузки документа:', error);
      res.status(500).json({ message: "Ошибка сохранения документа" });
    }
  });

  // Upload document file (pdf/txt/doc/docx/rtf) and save through pipeline
  app.post("/api/upload-document-file", upload.single('file'), async (req: MulterRequest, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "Файл не найден" });
      }

      // Read file content
      const filePath = path.join('uploads', req.file.filename);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        return res.status(400).json({ message: "Не удалось прочитать файл. Поддерживаются только текстовые форматы." });
      }

      if (!content || content.trim().length === 0) {
        return res.status(400).json({ message: "Файл пуст" });
      }

      const { saveDocument } = await import("./documentManager");
      const result = await saveDocument({
        content: content.trim(),
        title: req.file.originalname,
        contentType: req.file.mimetype.includes('text/') ? 'plain_text' : 'markdown',
        metadata: {
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
        },
      });

      // Cleanup uploaded file after processing
      try {
        fs.unlinkSync(filePath);
      } catch { /* ignore */ }

      res.status(201).json({
        message: "Документ загружен и обработан",
        document: result,
      });
    } catch (error) {
      console.error('Ошибка загрузки документа:', error);
      res.status(500).json({ message: "Ошибка загрузки документа" });
    }
  });

  // Serve uploaded files
  app.use('/uploads', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
  });

  // Update message status
  app.patch("/api/messages/:id/status", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { status } = req.body;

      const message = await storage.updateMessageStatus(id, status);
      if (!message) {
        return res.status(404).json({ message: "Сообщение не найдено" });
      }

      res.json(message);
    } catch (error) {
      res.status(500).json({ message: "Ошибка обновления статуса сообщения" });
    }
  });

  // Auth endpoints
  app.post("/api/auth/setup", async (req, res) => {
    try {
      // Разрешить создание пароля только в режиме разработки ИЛИ если пароля еще нет
      const hasPassword = await storage.hasPassword();
      const isDevelopment = process.env.NODE_ENV !== 'production';

      if (!isDevelopment && hasPassword) {
        return res.status(403).json({ message: "Создание пароля запрещено в продакшене" });
      }

      const { password } = req.body;

      if (!password || password.length < 4) {
        return res.status(400).json({ message: "Пароль должен содержать минимум 4 символа" });
      }

      // В продакшене нельзя установить пароль, если он уже есть
      if (!isDevelopment && hasPassword) {
        return res.status(400).json({ message: "Пароль уже установлен" });
      }

      await storage.setPassword(password);
      res.json({ message: "Пароль установлен успешно" });
    } catch (error) {
      res.status(500).json({ message: "Ошибка установки пароля" });
    }
  });

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { password } = req.body;

      if (!password) {
        return res.status(400).json({ message: "Пароль обязателен" });
      }

      const isValid = await storage.verifyPassword(password);
      if (!isValid) {
        return res.status(401).json({ message: "Неверный пароль" });
      }

      // Generate a simple session token
      const sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);

      res.json({
        message: "Вход выполнен успешно",
        token: sessionToken
      });
    } catch (error) {
      res.status(500).json({ message: "Ошибка входа" });
    }
  });

  // ============================================================================
  // Workflow Logging API — доступ к сохранённым workflow обработки
  // ============================================================================

  // Получить workflow для конкретного сообщения
  app.get("/api/messages/:id/workflow", async (req, res) => {
    try {
      const messageId = parseInt(req.params.id);
      if (isNaN(messageId)) {
        return res.status(400).json({ message: "Некорректный ID сообщения" });
      }

      const workflow = await getWorkflowForMessage(messageId);
      if (!workflow) {
        return res.status(404).json({ message: "Workflow не найден" });
      }

      res.json(workflow);
    } catch (error) {
      console.error("Ошибка получения workflow:", error);
      res.status(500).json({ message: "Ошибка получения workflow" });
    }
  });

  // Получить список последних workflows (для диагностики)
  app.get("/api/workflows", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const workflows = await getRecentWorkflows(limit);
      res.json(workflows);
    } catch (error) {
      console.error("Ошибка получения списка workflows:", error);
      res.status(500).json({ message: "Ошибка получения списка workflows" });
    }
  });

  app.get("/api/auth/status", async (req, res) => {
    try {
      const hasPassword = await storage.hasPassword();
      const isDevelopment = process.env.NODE_ENV !== 'production';

      res.json({
        hasPassword,
        allowSetup: isDevelopment || !hasPassword
      });
    } catch (error) {
      res.status(500).json({ message: "Ошибка проверки статуса" });
    }
  });

  // AI Configuration endpoints
  app.get("/api/ai/config", async (req, res) => {
    try {
      const config = checkAIConfiguration();
      const provider = await storage.getSetting('ai_provider');
      const model = await storage.getSetting('ai_model');
      const systemPrompt = await storage.getSetting('ai_system_prompt');

      res.json({
        availableProviders: {
          openai: config.openai,
          deepseek: config.deepseek,
        },
        currentProvider: provider || config.defaultProvider || 'none',
        currentModel: model || null,
        systemPrompt: systemPrompt || null,
        isConfigured: config.defaultProvider !== null,
      });
    } catch (error) {
      res.status(500).json({ message: "Ошибка получения конфигурации AI" });
    }
  });

  app.post("/api/ai/config", async (req, res) => {
    try {
      const { provider, model, systemPrompt } = req.body;

      if (provider) {
        await storage.setSetting('ai_provider', provider);
      }
      if (model !== undefined) {
        await storage.setSetting('ai_model', model || '');
      }
      if (systemPrompt !== undefined) {
        await storage.setSetting('ai_system_prompt', systemPrompt || '');
      }

      res.json({ message: "Конфигурация сохранена" });
    } catch (error) {
      res.status(500).json({ message: "Ошибка сохранения конфигурации AI" });
    }
  });

  // AI Prompts CRUD endpoints
  app.get("/api/ai/prompts", async (req, res) => {
    try {
      const prompts = await storage.getAiPrompts();
      res.json(prompts);
    } catch (error) {
      res.status(500).json({ message: "Ошибка получения промптов" });
    }
  });

  app.post("/api/ai/prompts", async (req, res) => {
    try {
      const promptData = insertAiPromptSchema.parse(req.body);
      const prompt = await storage.createAiPrompt(promptData);
      res.status(201).json(prompt);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ message: "Неверные данные промпта", errors: error.errors });
      } else {
        res.status(500).json({ message: "Ошибка создания промпта" });
      }
    }
  });

  app.patch("/api/ai/prompts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const prompt = await storage.updateAiPrompt(id, req.body);
      if (!prompt) {
        return res.status(404).json({ message: "Промпт не найден" });
      }
      res.json(prompt);
    } catch (error) {
      res.status(500).json({ message: "Ошибка обновления промпта" });
    }
  });

  app.delete("/api/ai/prompts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const deleted = await storage.deleteAiPrompt(id);
      if (!deleted) {
        return res.status(404).json({ message: "Промпт не найден" });
      }
      res.json({ message: "Промпт удален" });
    } catch (error) {
      res.status(500).json({ message: "Ошибка удаления промпта" });
    }
  });

  // Summaries endpoints
  app.get("/api/summaries", async (req, res) => {
    try {
      const summariesList = await storage.getSummaries();
      res.json(summariesList);
    } catch (error) {
      res.status(500).json({ message: "Ошибка получения саммари" });
    }
  });

  // ========== MEMORY API ==========

  // Import memory-related modules for routes
  const topicManagerModule = await import("./topicManager");
  const factExtractorModule = await import("./factExtractor");
  const embeddingServiceModule = await import("./embeddingService");

  // Get all topics
  app.get("/api/memory/topics", async (req, res) => {
    try {
      const topicsList = await topicManagerModule.getAllTopics();
      res.json(topicsList);
    } catch (error) {
      console.error("Error fetching topics:", error);
      res.status(500).json({ message: "Ошибка получения тем" });
    }
  });

  // Get topics tree (hierarchical)
  app.get("/api/memory/topics/tree", async (req, res) => {
    try {
      const tree = await topicManagerModule.getTopicsTree();
      res.json(tree);
    } catch (error) {
      console.error("Error fetching topics tree:", error);
      res.status(500).json({ message: "Ошибка получения дерева тем" });
    }
  });

  // Get topic by ID
  app.get("/api/memory/topics/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const topic = await topicManagerModule.getTopicById(id);
      if (!topic) {
        return res.status(404).json({ message: "Тема не найдена" });
      }
      res.json(topic);
    } catch (error) {
      res.status(500).json({ message: "Ошибка получения темы" });
    }
  });

  // Get facts by topic
  app.get("/api/memory/topics/:id/facts", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const includeOld = req.query.includeOld === 'true';
      const factsList = await factExtractorModule.getFactsByTopicId(id, includeOld);
      res.json(factsList);
    } catch (error) {
      res.status(500).json({ message: "Ошибка получения фактов" });
    }
  });

  // Get all current facts
  app.get("/api/memory/facts", async (req, res) => {
    try {
      const factsList = await factExtractorModule.getAllCurrentFacts();
      res.json(factsList);
    } catch (error) {
      res.status(500).json({ message: "Ошибка получения фактов" });
    }
  });

  // Search facts semantically
  app.get("/api/memory/facts/search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ message: "Параметр q обязателен" });
      }
      const limit = parseInt(req.query.limit as string) || 10;
      const minSimilarity = parseFloat(req.query.minSimilarity as string) || 0.4;

      const results = await embeddingServiceModule.searchFactsByQuery(query, limit, minSimilarity);
      res.json(results);
    } catch (error) {
      console.error("Error searching facts:", error);
      res.status(500).json({ message: "Ошибка поиска фактов" });
    }
  });

  // Delete (soft) a fact
  app.delete("/api/memory/facts/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await factExtractorModule.deleteFact(id);
      res.json({ message: "Факт удалён" });
    } catch (error) {
      res.status(500).json({ message: "Ошибка удаления факта" });
    }
  });

  // ========== AGENTS API ==========

  // Get all agents
  app.get("/api/agents", async (req, res) => {
    try {
      const agentsList = await agentOrchestrator.getAvailableAgents();
      res.json(agentsList);
    } catch (error) {
      console.error("Error fetching agents:", error);
      res.status(500).json({ message: "Ошибка получения агентов" });
    }
  });

  // Toggle agent active status
  app.post("/api/agents/:slug/toggle", async (req, res) => {
    try {
      const { slug } = req.params;
      const { isActive } = req.body;

      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ message: "isActive должен быть boolean" });
      }

      await agentOrchestrator.toggleAgent(slug, isActive);
      res.json({ message: `Агент ${slug} ${isActive ? 'активирован' : 'деактивирован'}` });
    } catch (error) {
      console.error("Error toggling agent:", error);
      res.status(500).json({ message: "Ошибка переключения агента" });
    }
  });

  // ========== PROFILE API ==========

  // Get user profile
  app.get("/api/profile", async (req, res) => {
    try {
      const profile = await profileManager.getStructuredProfile();
      res.json(profile);
    } catch (error) {
      console.error("Error fetching profile:", error);
      res.status(500).json({ message: "Ошибка получения профиля" });
    }
  });

  // Get all profile entries
  app.get("/api/profile/entries", async (req, res) => {
    try {
      const entries = await profileManager.getAllProfileEntries();
      res.json(entries);
    } catch (error) {
      console.error("Error fetching profile entries:", error);
      res.status(500).json({ message: "Ошибка получения записей профиля" });
    }
  });

  // Set profile value
  app.post("/api/profile", async (req, res) => {
    try {
      const { key, value, category } = req.body;

      if (!key || !value || !category) {
        return res.status(400).json({ message: "Требуются key, value и category" });
      }

      const entry = await profileManager.setProfileValue(key, value, category);
      res.json(entry);
    } catch (error) {
      console.error("Error setting profile value:", error);
      res.status(500).json({ message: "Ошибка сохранения профиля" });
    }
  });

  // Delete profile entry
  app.delete("/api/profile/:key", async (req, res) => {
    try {
      await profileManager.deleteProfileEntry(req.params.key);
      res.json({ message: "Запись удалена" });
    } catch (error) {
      console.error("Error deleting profile entry:", error);
      res.status(500).json({ message: "Ошибка удаления записи профиля" });
    }
  });

  // Update profile from facts (AI extraction)
  app.post("/api/profile/analyze", async (req, res) => {
    try {
      const count = await profileManager.updateProfileFromFacts();
      res.json({ message: `Извлечено ${count} записей профиля`, count });
    } catch (error) {
      console.error("Error analyzing profile:", error);
      res.status(500).json({ message: "Ошибка анализа профиля" });
    }
  });

  // ========== GOALS API ==========

  // Get all goals
  app.get("/api/goals", async (req, res) => {
    try {
      const activeOnly = req.query.active === 'true';
      const goalsList = activeOnly
        ? await goalManager.getActiveGoals()
        : await goalManager.getAllGoals();
      res.json(goalsList);
    } catch (error) {
      console.error("Error fetching goals:", error);
      res.status(500).json({ message: "Ошибка получения целей" });
    }
  });

  // Get progress report (MUST be before /:id)
  app.get("/api/goals/report/progress", async (req, res) => {
    try {
      const report = await goalManager.generateProgressReport();
      res.json({ report });
    } catch (error) {
      console.error("Error generating progress report:", error);
      res.status(500).json({ message: "Ошибка генерации отчёта" });
    }
  });

  // Get focus goals (MUST be before /:id)
  app.get("/api/goals/focus", async (req, res) => {
    try {
      const focusGoals = await goalManager.getFocusGoals();
      res.json(focusGoals);
    } catch (error) {
      console.error("Error fetching focus goals:", error);
      res.status(500).json({ message: "Ошибка получения целей в фокусе" });
    }
  });

  // Get goal by ID
  app.get("/api/goals/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const goal = await goalManager.getGoalById(id);

      if (!goal) {
        return res.status(404).json({ message: "Цель не найдена" });
      }

      res.json(goal);
    } catch (error) {
      console.error("Error fetching goal:", error);
      res.status(500).json({ message: "Ошибка получения цели" });
    }
  });

  // Create goal
  app.post("/api/goals", async (req, res) => {
    try {
      const { title, description, deadline, category, priority, smartDescription } = req.body;

      if (!title) {
        return res.status(400).json({ message: "Требуется title" });
      }

      const goal = await goalManager.createGoal({
        title,
        description: description || null,
        deadline: deadline ? new Date(deadline) : null,
        status: "active",
        progress: 0,
        category: category || null,
        priority: priority || 'medium',
        smartDescription: smartDescription || null,
      });

      res.status(201).json(goal);
    } catch (error) {
      console.error("Error creating goal:", error);
      res.status(500).json({ message: "Ошибка создания цели" });
    }
  });

  // Update goal
  app.put("/api/goals/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const updates = req.body;

      // Convert deadline if provided
      if (updates.deadline) {
        updates.deadline = new Date(updates.deadline);
      }

      const goal = await goalManager.updateGoal(id, updates);

      if (!goal) {
        return res.status(404).json({ message: "Цель не найдена" });
      }

      res.json(goal);
    } catch (error) {
      console.error("Error updating goal:", error);
      res.status(500).json({ message: "Ошибка обновления цели" });
    }
  });

  // Update goal progress
  app.patch("/api/goals/:id/progress", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const { progress } = req.body;

      if (typeof progress !== 'number') {
        return res.status(400).json({ message: "progress должен быть числом" });
      }

      const goal = await goalManager.updateGoalProgress(id, progress);

      if (!goal) {
        return res.status(404).json({ message: "Цель не найдена" });
      }

      res.json(goal);
    } catch (error) {
      console.error("Error updating goal progress:", error);
      res.status(500).json({ message: "Ошибка обновления прогресса" });
    }
  });

  // Delete goal
  app.delete("/api/goals/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      await goalManager.deleteGoal(id);
      res.json({ message: "Цель удалена" });
    } catch (error) {
      console.error("Error deleting goal:", error);
      res.status(500).json({ message: "Ошибка удаления цели" });
    }
  });


  // Get full goal details (goal + milestones + tasks + key results + activity)
  app.get("/api/goals/:id/details", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const details = await goalManager.getFullGoalDetails(id);
      if (!details) {
        return res.status(404).json({ message: "Цель не найдена" });
      }
      res.json(details);
    } catch (error) {
      console.error("Error fetching goal details:", error);
      res.status(500).json({ message: "Ошибка получения деталей цели" });
    }
  });

  // Get milestones for a goal
  app.get("/api/goals/:id/milestones", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const milestonesList = await goalManager.getMilestonesForGoal(id);
      res.json(milestonesList);
    } catch (error) {
      console.error("Error fetching milestones:", error);
      res.status(500).json({ message: "Ошибка получения вех" });
    }
  });

  // Get tasks for a goal
  app.get("/api/goals/:id/tasks", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const tasksList = await goalManager.getTasksForGoal(id);
      res.json(tasksList);
    } catch (error) {
      console.error("Error fetching tasks:", error);
      res.status(500).json({ message: "Ошибка получения задач" });
    }
  });

  // Get key results for a goal
  app.get("/api/goals/:id/key-results", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const keyResults = await goalManager.getKeyResultsForGoal(id);
      res.json(keyResults);
    } catch (error) {
      console.error("Error fetching key results:", error);
      res.status(500).json({ message: "Ошибка получения ключевых результатов" });
    }
  });

  // Get activity log for a goal
  app.get("/api/goals/:id/activity", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const limit = parseInt(req.query.limit as string) || 20;
      const activity = await goalManager.getGoalActivityLogEntries(id, limit);
      res.json(activity);
    } catch (error) {
      console.error("Error fetching goal activity:", error);
      res.status(500).json({ message: "Ошибка получения журнала активности" });
    }
  });

  // ========== REMINDERS API ==========

  // Get all reminders
  app.get("/api/reminders", async (req, res) => {
    try {
      const remindersList = await db.select().from(reminders).orderBy(reminders.remindAt);
      res.json(remindersList);
    } catch (error) {
      console.error("Error fetching reminders:", error);
      res.status(500).json({ message: "Ошибка получения напоминаний" });
    }
  });

  // Create reminder
  app.post("/api/reminders", async (req, res) => {
    try {
      const { title, description, remindAt, priority } = req.body;
      const [reminder] = await db.insert(reminders).values({
        title,
        description,
        remindAt: new Date(remindAt),
        priority: priority || 'medium',
      }).returning();
      res.json(reminder);
    } catch (error) {
      console.error("Error creating reminder:", error);
      res.status(500).json({ message: "Ошибка создания напоминания" });
    }
  });

  // Update reminder
  app.patch("/api/reminders/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const updates = req.body;

      const [updated] = await db.update(reminders)
        .set(updates)
        .where(eq(reminders.id, id))
        .returning();

      if (!updated) {
        return res.status(404).json({ message: "Напоминание не найдено" });
      }
      res.json(updated);
    } catch (error) {
      console.error("Error updating reminder:", error);
      res.status(500).json({ message: "Ошибка обновления напоминания" });
    }
  });

  // ========== NOTES API ==========

  // Получить заметки (по желанию с фильтрацией)
  app.get("/api/notes", async (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === 'true';
      const type = req.query.type as string | undefined;
      const tag = req.query.tag as string | undefined;
      const pinnedOnly = req.query.pinnedOnly === 'true';
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

      const notesList = await noteManager.getNotes({
        includeArchived,
        type,
        tag,
        pinnedOnly,
        limit
      });

      res.json(notesList);
    } catch (error) {
      console.error("Error fetching notes:", error);
      res.status(500).json({ message: "Ошибка получения заметок" });
    }
  });

  // Получить одну заметку по ID
  app.get("/api/notes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const note = await noteManager.getNote(id);

      if (!note) {
        return res.status(404).json({ message: "Заметка не найдена" });
      }

      res.json(note);
    } catch (error) {
      console.error("Error fetching note:", error);
      res.status(500).json({ message: "Ошибка получения заметки" });
    }
  });

  // Создать заметку
  app.post("/api/notes", async (req, res) => {
    try {
      const { title, type, content, items, blocks, tags, isPinned, isImmutable, sourceUrl, sourceMessageId } = req.body;

      if (!title) {
        return res.status(400).json({ message: "Требуется title" });
      }

      const note = await noteManager.createNote({
        title,
        type,
        content,
        items,
        blocks,
        tags,
        isPinned,
        isImmutable,
        sourceUrl,
        sourceMessageId
      });

      res.status(201).json(note);
    } catch (error) {
      console.error("Error creating note:", error);
      res.status(500).json({ message: "Ошибка создания заметки" });
    }
  });

  // Обновить заметку
  app.patch("/api/notes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const updates = req.body;

      const updated = await noteManager.updateNote(id, updates);

      if (!updated) {
        return res.status(404).json({ message: "Заметка не найдена" });
      }

      res.json(updated);
    } catch (error) {
      console.error("Error updating note:", error);
      res.status(500).json({ message: "Ошибка обновления заметки" });
    }
  });

  // Удалить заметку
  app.delete("/api/notes/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const success = await noteManager.deleteNote(id);

      if (!success) {
        return res.status(404).json({ message: "Заметка не найдена" });
      }

      res.json({ success: true, message: "Заметка удалена" });
    } catch (error) {
      console.error("Error deleting note:", error);
      res.status(500).json({ message: "Ошибка удаления заметки" });
    }
  });

  // Snooze reminder
  app.post("/api/reminders/:id/snooze", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { minutes } = req.body;

      const newRemindAt = new Date(Date.now() + (minutes || 30) * 60 * 1000);

      const [updated] = await db.update(reminders)
        .set({
          remindAt: newRemindAt,
          status: 'snoozed' as any,
        })
        .where(eq(reminders.id, id))
        .returning();

      if (!updated) {
        return res.status(404).json({ message: "Напоминание не найдено" });
      }

      // Reset to pending so it triggers again
      await db.update(reminders)
        .set({ status: 'pending' as any })
        .where(eq(reminders.id, id));

      res.json(updated);
    } catch (error) {
      console.error("Error snoozing reminder:", error);
      res.status(500).json({ message: "Ошибка отсрочки напоминания" });
    }
  });

  // Delete reminder
  app.delete("/api/reminders/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      await db.delete(reminders).where(eq(reminders.id, id));
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting reminder:", error);
      res.status(500).json({ message: "Ошибка удаления напоминания" });
    }
  });

  // Handle reminder action (from notification buttons)
  app.post("/api/reminders/action", async (req, res) => {
    try {
      const { actionId, reminderId } = req.body;

      if (!actionId || !reminderId) {
        return res.status(400).json({ message: "actionId и reminderId обязательны" });
      }

      const id = parseInt(reminderId, 10);

      switch (actionId) {
        case 'snooze_15':
          await db.update(reminders)
            .set({
              remindAt: new Date(Date.now() + 15 * 60 * 1000),
              status: 'pending' as any,
            })
            .where(eq(reminders.id, id));
          break;

        case 'snooze_60':
          await db.update(reminders)
            .set({
              remindAt: new Date(Date.now() + 60 * 60 * 1000),
              status: 'pending' as any,
            })
            .where(eq(reminders.id, id));
          break;

        case 'done':
          await db.update(reminders)
            .set({
              status: 'sent' as any,
              sentAt: new Date(),
            })
            .where(eq(reminders.id, id));
          break;

        case 'cancel':
          await db.update(reminders)
            .set({ status: 'cancelled' as any })
            .where(eq(reminders.id, id));
          break;

        default:
          return res.status(400).json({ message: "Неизвестное действие" });
      }

      console.log(`🔔 Reminder ${id} action: ${actionId}`);
      res.json({ success: true, actionId, reminderId: id });
    } catch (error) {
      console.error("Error handling reminder action:", error);
      res.status(500).json({ message: "Ошибка выполнения действия" });
    }
  });

  // ========== ADVISOR FEEDBACK API ==========

  /**
   * POST /api/advisor/feedback — записать реакцию пользователя на стратегический совет.
   * Используется для фиксации реакции пользователя: discuss / accepted / not_now / dismissed
   */
  app.post("/api/advisor/feedback", async (req, res) => {
    try {
      const { adviceType, adviceTitle, adviceContent, reaction, responseNotes, profileBasis, relatedGoalIds, proactiveMessageId } = req.body;

      if (!adviceType || !reaction) {
        return res.status(400).json({ message: "adviceType и reaction обязательны" });
      }

      const validReactions = ['discuss', 'accepted', 'not_now', 'dismissed'];
      if (!validReactions.includes(reaction)) {
        return res.status(400).json({ message: `reaction должен быть одним из: ${validReactions.join(', ')}` });
      }

      const { advisorFeedback } = await import("@shared/schema");
      const [feedback] = await db.insert(advisorFeedback).values({
        proactiveMessageId: proactiveMessageId || null,
        adviceType,
        adviceTitle: adviceTitle || null,
        adviceContent: adviceContent || null,
        reaction,
        responseNotes: responseNotes || null,
        profileBasis: profileBasis || null,
        relatedGoalIds: relatedGoalIds || null,
      }).returning();

      console.log(`🎯 Advisor feedback: ${reaction} для ${adviceType} (id=${feedback.id})`);

      // Если пользователь хочет обсудить — отправляем follow-up промпт в чат
      if (reaction === 'discuss' && adviceContent) {
        const followUpContent = `Я хочу обсудить подробнее стратегический совет:\n\n**${adviceTitle || adviceType}**\n${adviceContent}\n\nПомоги мне разобраться в этом детальнее.`;

        // Создаём user-сообщение от имени пользователя для продолжения диалога
        const message = await storage.createMessage({
          content: followUpContent,
          type: 'text',
          sender: 'user',
          status: 'sent',
        });

        // Broadcast и обработка AI
        broadcastMessage(message);

        const aiConfig = checkAIConfiguration();
        if (aiConfig.defaultProvider) {
          processMessageWithAI(message, broadcastMessage, undefined, broadcastProcessingStep).catch(err => {
            console.error('Ошибка обработки AI при обсуждении совета:', err);
          });
        }
      }

      res.json({ success: true, feedback });
    } catch (error) {
      console.error("Error saving advisor feedback:", error);
      res.status(500).json({ message: "Ошибка сохранения обратной связи" });
    }
  });

  /**
   * GET /api/advisor/history — история реакций на стратегические советы.
   * Используется advisorEngine для адаптации контента и частоты.
   */
  app.get("/api/advisor/history", async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
      const { advisorFeedback } = await import("@shared/schema");
      const { desc } = await import("drizzle-orm");
      const history = await db.select()
        .from(advisorFeedback)
        .orderBy(desc(advisorFeedback.createdAt))
        .limit(limit);

      // Агрегация для обзора
      const stats = {
        total: history.length,
        discuss: history.filter(h => h.reaction === 'discuss').length,
        accepted: history.filter(h => h.reaction === 'accepted').length,
        not_now: history.filter(h => h.reaction === 'not_now').length,
        dismissed: history.filter(h => h.reaction === 'dismissed').length,
      };

      res.json({ history, stats });
    } catch (error) {
      console.error("Error fetching advisor history:", error);
      res.status(500).json({ message: "Ошибка получения истории советов" });
    }
  });

  // Setup WebSocket server for real-time notifications
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws'
  });

  wss.on('connection', (ws: WebSocket, req) => {
    console.log('New WebSocket client connected');
    connectedClients.add(ws);

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connection',
      message: 'WebSocket connected successfully'
    }));

    // Setup heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(heartbeat);
      }
    }, 30000); // Ping every 30 seconds

    ws.on('pong', () => {
      // Connection is alive
    });

    ws.on('close', () => {
      console.log('WebSocket client disconnected');
      connectedClients.delete(ws);
      clearInterval(heartbeat);
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      connectedClients.delete(ws);
      clearInterval(heartbeat);
    });
  });

  // =========================================================
  // Proactive Scheduler Integration
  // =========================================================

  // Передаём WebSocket клиентов scheduler'у
  setWebSocketClients(connectedClients);
  aiTaskScheduler.setWebSocketClients(connectedClients);
  subagentRegistry.setWebSocketClients(connectedClients);
  setEventRouterWSClients(connectedClients);

  // API Health Monitor: подключаем WS broadcast для уведомлений о сбоях провайдеров
  const { setWsBroadcast } = await import("./apiHealthMonitor");
  setWsBroadcast((event, data) => {
    const payload = JSON.stringify({ type: event, ...data });
    for (const client of Array.from(connectedClients)) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  });

  // Запускаем proactive scheduler
  startProactiveScheduler();

  // API: Получить непоказанные напоминания
  app.get("/api/proactive/pending", async (req, res) => {
    try {
      const pending = await getPendingNotifications();
      res.json(pending);
    } catch (error) {
      console.error('Error getting pending notifications:', error);
      res.status(500).json({ message: "Ошибка получения напоминаний" });
    }
  });

  // =========================================================
  // Notification Settings API
  // =========================================================

  const notificationService = await import("./notificationSettingsService");

  // API: Получить настройки уведомлений
  app.get("/api/notifications/settings", async (req, res) => {
    try {
      const settings = await notificationService.getSettings();
      // Маскируем токен для безопасности
      let response: any = { ...settings };
      if (settings.telegramBotToken) {
        const token = settings.telegramBotToken;
        response.telegramBotToken = token.substring(0, 10) + '...' + token.substring(token.length - 4);
        response.hasTelegramToken = true;
      } else {
        response.hasTelegramToken = false;
      }
      res.json(response);
    } catch (error) {
      console.error('Error getting notification settings:', error);
      res.status(500).json({ message: "Ошибка получения настроек" });
    }
  });

  // API: Сохранить настройки уведомлений
  app.put("/api/notifications/settings", async (req, res) => {
    try {
      const settings = await notificationService.saveSettings(req.body);
      res.json({ success: true, settings });
    } catch (error) {
      console.error('Error saving notification settings:', error);
      res.status(500).json({ message: "Ошибка сохранения настроек" });
    }
  });

  // API: Валидация Telegram
  app.post("/api/notifications/telegram/validate", async (req, res) => {
    try {
      const { botToken, chatId } = req.body;
      if (!botToken || !chatId) {
        return res.status(400).json({ valid: false, error: "Укажите токен и Chat ID" });
      }
      const result = await notificationService.validateTelegram(botToken, chatId);
      res.json(result);
    } catch (error) {
      console.error('Error validating Telegram:', error);
      res.status(500).json({ valid: false, error: "Ошибка валидации" });
    }
  });

  // API: Тестовое уведомление
  app.post("/api/notifications/test/:type", async (req, res) => {
    try {
      const { type } = req.params;
      const settings = await notificationService.getSettings();

      if (type === 'telegram') {
        if (!settings.telegramEnabled || !settings.telegramBotToken) {
          return res.status(400).json({ success: false, error: "Telegram не настроен" });
        }
        const sent = await notificationService.sendTelegramMessage("🧪 Тестовое уведомление от AI Assistant");
        res.json({ success: sent });
      } else {
        res.status(400).json({ success: false, error: "Неизвестный тип" });
      }
    } catch (error) {
      console.error('Error sending test notification:', error);
      res.status(500).json({ success: false, error: "Ошибка отправки" });
    }
  });

  // Telegram Webhook для обработки callback_query (inline кнопки)
  app.post("/api/telegram/webhook", async (req, res) => {
    try {
      const update = req.body;

      // Обработка callback_query от inline кнопок
      if (update.callback_query) {
        const callbackQuery = update.callback_query;
        const data = callbackQuery.data; // Формат: "action:reminderId"
        const [actionId, reminderIdStr] = data.split(':');
        const reminderId = parseInt(reminderIdStr, 10);

        if (!actionId || !reminderId) {
          return res.json({ ok: true });
        }

        // Выполнить действие
        switch (actionId) {
          case 'snooze_15':
            await db.update(reminders)
              .set({
                remindAt: new Date(Date.now() + 15 * 60 * 1000),
                status: 'pending' as any,
              })
              .where(eq(reminders.id, reminderId));
            break;
          case 'snooze_60':
            await db.update(reminders)
              .set({
                remindAt: new Date(Date.now() + 60 * 60 * 1000),
                status: 'pending' as any,
              })
              .where(eq(reminders.id, reminderId));
            break;
          case 'done':
            await db.update(reminders)
              .set({
                status: 'sent' as any,
                sentAt: new Date(),
              })
              .where(eq(reminders.id, reminderId));
            break;
          case 'cancel':
            await db.update(reminders)
              .set({ status: 'cancelled' as any })
              .where(eq(reminders.id, reminderId));
            break;
        }

        // Ответить на callback_query (убрать loading state на кнопке)
        const settings = await notificationService.getSettings();
        if (settings.telegramBotToken) {
          const actionTextMap: Record<string, string> = {
            'snooze_15': '⏸️ Отложено на 15 минут',
            'snooze_60': '⏰ Отложено на 1 час',
            'done': '✅ Отмечено как выполнено',
            'cancel': '❌ Напоминание отменено',
          };
          const actionText = actionTextMap[actionId] || 'Действие выполнено';

          await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              callback_query_id: callbackQuery.id,
              text: actionText,
            }),
          });

          // Обновить сообщение чтобы убрать кнопки
          await fetch(`https://api.telegram.org/bot${settings.telegramBotToken}/editMessageReplyMarkup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: callbackQuery.message.chat.id,
              message_id: callbackQuery.message.message_id,
              reply_markup: { inline_keyboard: [] },
            }),
          });
        }

        console.log(`📱 Telegram callback: ${actionId} for reminder ${reminderId}`);
      }

      res.json({ ok: true });
    } catch (error) {
      console.error('Telegram webhook error:', error);
      res.json({ ok: true }); // Всегда возвращаем 200 для Telegram
    }
  });

  // =========================================================
  // Web Push API
  // =========================================================

  const webPushService = await import("./webPushService");

  // Получить публичный VAPID ключ
  app.get("/api/push/vapid-key", (req, res) => {
    const key = webPushService.getVapidPublicKey();
    if (key) {
      res.json({ publicKey: key });
    } else {
      res.status(503).json({ message: "Web Push не настроен" });
    }
  });

  // Подписаться на push-уведомления
  app.post("/api/push/subscribe", async (req, res) => {
    try {
      const { subscription } = req.body;
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return res.status(400).json({ message: "Некорректная подписка" });
      }
      await webPushService.saveSubscription({
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        userAgent: req.headers["user-agent"],
      });
      res.json({ ok: true });
    } catch (error) {
      console.error("Push subscribe error:", error);
      res.status(500).json({ message: "Ошибка сохранения подписки" });
    }
  });

  // Отписаться от push-уведомлений
  app.delete("/api/push/subscribe", async (req, res) => {
    try {
      const { endpoint } = req.body;
      if (!endpoint) {
        return res.status(400).json({ message: "Не указан endpoint" });
      }
      await webPushService.removeSubscription(endpoint);
      res.json({ ok: true });
    } catch (error) {
      console.error("Push unsubscribe error:", error);
      res.status(500).json({ message: "Ошибка удаления подписки" });
    }
  });

  // =========================================================
  // AI Configuration API
  // =========================================================

  /**
   * List available AI providers
   */
  app.get("/api/ai/providers", async (req, res) => {
    try {
      const providers = getAvailableProviders();
      res.json(providers);
    } catch (error) {
      console.error('Error getting providers:', error);
      res.status(500).json({ message: "Ошибка получения провайдеров" });
    }
  });

  /**
   * List models for a provider
   */
  app.get("/api/ai/models", async (req, res) => {
    try {
      const provider = (req.query.provider as string) || 'openrouter';
      const models = await getModelsByProvider(provider);
      res.json(models);
    } catch (error) {
      console.error('Error getting models:', error);
      res.status(500).json({ message: "Ошибка получения моделей" });
    }
  });

  /**
   * Get all AI configs
   */
  app.get("/api/ai-configs", async (req, res) => {
    try {
      const configs = await getAllConfigs();
      res.json(configs);
    } catch (error) {
      console.error('Error getting AI configs:', error);
      res.status(500).json({ message: "Ошибка получения конфигураций" });
    }
  });

  /**
   * Update AI config by taskType
   */
  app.put("/api/ai-configs/:taskType", async (req, res) => {
    try {
      const { taskType } = req.params;
      const updates = req.body;

      const updated = await updateConfig(taskType as AITaskType, updates);
      if (!updated) {

        res.status(404).json({ message: "Конфигурация не найдена" });
        return;
      }

      res.json(updated);
    } catch (error) {
      console.error('Error updating AI config:', error);
      res.status(500).json({ message: "Ошибка обновления конфигурации" });
    }
  });

  /**
   * Bulk update provider/model across all configs with matching provider
   * POST /api/ai-configs/bulk-update
   * Body: { fromProvider, toProvider, toModel, taskTypes? }
   */
  app.post("/api/ai-configs/bulk-update", async (req, res) => {
    try {
      const { fromProvider, toProvider, toModel, taskTypes } = req.body;
      if (!fromProvider || !toProvider || !toModel) {
        res.status(400).json({ message: "Требуются fromProvider, toProvider и toModel" });
        return;
      }

      const result = await bulkUpdateProvider({ fromProvider, toProvider, toModel, taskTypes });

      if (result.updated === 0) {
        res.json({ updated: 0, taskTypes: [], message: `Нет конфигов с провайдером "${fromProvider}"` });
        return;
      }

      res.json({
        updated: result.updated,
        taskTypes: result.taskTypes,
        message: `Обновлено ${result.updated} конфигураций: ${fromProvider} → ${toProvider}/${toModel}`,
      });
    } catch (error) {
      console.error('Error bulk updating AI configs:', error);
      res.status(500).json({ message: "Ошибка массового обновления конфигураций" });
    }
  });

  /**
   * Create new AI config
   */
  app.post("/api/ai-configs", async (req, res) => {
    try {
      const { taskType, provider, model, temperature, maxTokens, systemPrompt, description, contextWindow } = req.body;
      if (!taskType || !provider || !model) {
        res.status(400).json({ message: "Требуются taskType, provider и model" });
        return;
      }

      const config = await createConfig({
        taskType: taskType as AITaskType,
        provider,
        model,
        temperature,
        maxTokens,
        contextWindow,
        systemPrompt,
        description,
      });

      res.status(201).json(config);
    } catch (error: any) {
      console.error('Error creating AI config:', error);
      if (error?.message?.includes('UNIQUE') || error?.code === '23505') {
        res.status(409).json({ message: "Конфигурация для этого taskType уже существует" });
      } else {
        res.status(500).json({ message: "Ошибка создания конфигурации" });
      }
    }
  });

  // ============================================================================
  // Model Health API — Трекинг здоровья моделей
  // ============================================================================

  const modelHealthModule = await import("./modelHealthTracker");

  /**
   * GET /api/ai/model-health — статус здоровья всех моделей
   */
  app.get("/api/ai/model-health", async (req, res) => {
    try {
      const status = modelHealthModule.modelHealth.getStatus();
      res.json(status);
    } catch (error) {
      console.error('Error getting model health:', error);
      res.status(500).json({ message: "Ошибка получения статуса моделей" });
    }
  });

  /**
   * POST /api/ai/model-health/reset — принудительный сброс cooldown модели
   * Body: { modelId: "antigravity/gemini-3-flash" }
   */
  app.post("/api/ai/model-health/reset", async (req, res) => {
    try {
      const { modelId } = req.body;
      if (!modelId) {
        res.status(400).json({ message: "Требуется modelId" });
        return;
      }
      modelHealthModule.modelHealth.reset(modelId);
      res.json({ success: true, message: `Model ${modelId} reset` });
    } catch (error) {
      console.error('Error resetting model health:', error);
      res.status(500).json({ message: "Ошибка сброса состояния модели" });
    }
  });

  // ============================================================================
  // Knowledge Graph API — Граф знаний
  // ============================================================================

  /**
   * Get full graph (nodes and edges)
   */
  app.get("/api/graph/full", async (req, res) => {
    try {
      const { getFullGraph } = await import("./entityExtractor");
      const graph = await getFullGraph();
      res.json(graph);
    } catch (error) {
      console.error('Error getting full graph:', error);
      res.status(500).json({ message: "Ошибка получения графа знаний" });
    }
  });

  /**
   * Get entities list, optionally filter by type
   */
  app.get("/api/graph/entities", async (req, res) => {
    try {
      const { getEntitiesByType, searchEntities } = await import("./entityExtractor");
      const type = req.query.type as string | undefined;
      const search = req.query.search as string | undefined;

      if (search) {
        const results = await searchEntities(search, 20);
        res.json(results);
      } else if (type) {
        const entities = await getEntitiesByType(type as any);
        res.json(entities);
      } else {
        const { getFullGraph } = await import("./entityExtractor");
        const { nodes } = await getFullGraph();
        res.json(nodes);
      }
    } catch (error) {
      console.error('Error getting entities:', error);
      res.status(500).json({ message: "Ошибка получения сущностей" });
    }
  });

  /**
   * Get entity by ID with its relations
   */
  app.get("/api/graph/entity/:id", async (req, res) => {
    try {
      const { getEntityRelations } = await import("./entityExtractor");
      const entityId = parseInt(req.params.id);

      if (isNaN(entityId)) {
        res.status(400).json({ message: "Некорректный ID сущности" });
        return;
      }

      const relations = await getEntityRelations(entityId);
      res.json(relations);
    } catch (error) {
      console.error('Error getting entity relations:', error);
      res.status(500).json({ message: "Ошибка получения связей сущности" });
    }
  });

  /**
   * Get graph overview statistics (for dashboard tab)
   */
  app.get("/api/graph/overview", async (req, res) => {
    try {
      const { getGraphOverview } = await import("./entityExtractor");
      const overview = await getGraphOverview();
      res.json(overview);
    } catch (error) {
      console.error('Error getting graph overview:', error);
      res.status(500).json({ message: "Ошибка получения обзора графа" });
    }
  });

  /**
   * Get ego-graph data for a specific entity (for relations tab)
   */
  app.get("/api/graph/ego/:entityId", async (req, res) => {
    try {
      const { getEgoGraph } = await import("./entityExtractor");
      const entityId = parseInt(req.params.entityId);

      if (isNaN(entityId)) {
        res.status(400).json({ message: "Некорректный ID сущности" });
        return;
      }

      // Parse categories from query params (e.g. ?categories=goals,tools)
      const categoriesParam = req.query.categories as string | undefined;
      const categories = categoriesParam ? categoriesParam.split(',').filter(Boolean) : undefined;

      const egoGraph = await getEgoGraph(entityId, categories);
      res.json(egoGraph);
    } catch (error) {
      console.error('Error getting ego graph:', error);
      res.status(500).json({ message: "Ошибка получения эго-графа" });
    }
  });

  /**
   * Get paginated relations list with filters (for facts tab)
   */
  app.get("/api/graph/relations", async (req, res) => {
    try {
      const { getRelationsList } = await import("./entityExtractor");
      const filters = {
        page: req.query.page ? parseInt(req.query.page as string) : undefined,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
        category: req.query.category as string | undefined,
        entityType: req.query.entityType as string | undefined,
        importance: req.query.importance as string | undefined,
        search: req.query.search as string | undefined,
      };

      const result = await getRelationsList(filters);
      res.json(result);
    } catch (error) {
      console.error('Error getting relations list:', error);
      res.status(500).json({ message: "Ошибка получения списка связей" });
    }
  });

  // ============================================================================
  // AI Scheduled Tasks API — Cron-задачи
  // ============================================================================

  /**
   * Список задач
   */
  app.get("/api/scheduled-tasks", async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const tasks = await aiTaskScheduler.listTasks(status ? { status } : undefined);
      res.json(tasks);
    } catch (error) {
      console.error('Error listing scheduled tasks:', error);
      res.status(500).json({ message: "Ошибка получения задач" });
    }
  });

  /**
   * Создать задачу
   */
  app.post("/api/scheduled-tasks", async (req, res) => {
    try {
      const { title, prompt, cronExpression, timezone, maxRuns } = req.body;
      if (!title || !prompt || !cronExpression) {
        res.status(400).json({ message: "Требуются title, prompt и cronExpression" });
        return;
      }
      const task = await aiTaskScheduler.createTask({
        title, prompt, cronExpression, timezone, maxRuns,
        createdByAi: false,
      });
      res.status(201).json(task);
    } catch (error: any) {
      console.error('Error creating scheduled task:', error);
      res.status(400).json({ message: error.message || "Ошибка создания задачи" });
    }
  });

  /**
   * Обновить задачу (пауза/возобновление)
   */
  app.patch("/api/scheduled-tasks/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ message: "Некорректный ID" }); return; }

      const { status } = req.body;
      let task;
      if (status === 'paused') task = await aiTaskScheduler.pauseTask(id);
      else if (status === 'active') task = await aiTaskScheduler.resumeTask(id);
      else if (status === 'cancelled') task = await aiTaskScheduler.cancelTask(id);
      else { res.status(400).json({ message: "Некорректный статус" }); return; }

      if (!task) { res.status(404).json({ message: "Задача не найдена" }); return; }
      res.json(task);
    } catch (error) {
      console.error('Error updating scheduled task:', error);
      res.status(500).json({ message: "Ошибка обновления задачи" });
    }
  });

  /**
   * Удалить задачу
   */
  app.delete("/api/scheduled-tasks/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ message: "Некорректный ID" }); return; }
      await aiTaskScheduler.deleteTask(id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting scheduled task:', error);
      res.status(500).json({ message: "Ошибка удаления задачи" });
    }
  });

  /**
   * Принудительный запуск задачи
   */
  app.post("/api/scheduled-tasks/:id/run", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ message: "Некорректный ID" }); return; }
      const success = await aiTaskScheduler.forceRunTask(id);
      if (!success) { res.status(404).json({ message: "Задача не найдена" }); return; }
      res.json({ success: true });
    } catch (error) {
      console.error('Error running scheduled task:', error);
      res.status(500).json({ message: "Ошибка запуска задачи" });
    }
  });

  /**
   * Журнал выполнений задачи
   */
  app.get("/api/scheduled-tasks/:id/logs", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ message: "Некорректный ID" }); return; }
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const logs = await aiTaskScheduler.getExecutionLogs(id, limit);
      res.json(logs);
    } catch (error) {
      console.error('Error fetching execution logs:', error);
      res.status(500).json({ message: "Ошибка получения журнала" });
    }
  });

  // ============================================================================
  // Skills API — Управление навыками AI
  // ============================================================================

  const skillManager = await import("./skillManager");

  /**
   * Список всех навыков
   */
  app.get("/api/skills", async (req, res) => {
    try {
      const allSkills = await skillManager.getAllSkills();
      res.json(allSkills);
    } catch (error) {
      console.error('Error listing skills:', error);
      res.status(500).json({ message: "Ошибка получения навыков" });
    }
  });

  /**
   * Создать пользовательский навык
   */
  app.post("/api/skills", async (req, res) => {
    try {
      const { name, description, content, category, triggerKeywords, icon } = req.body;
      if (!name || !description || !content) {
        res.status(400).json({ message: "Требуются name, description и content" });
        return;
      }
      const skill = await skillManager.createSkill({
        name, description, content, category, triggerKeywords, icon,
      });
      res.status(201).json(skill);
    } catch (error: any) {
      console.error('Error creating skill:', error);
      res.status(400).json({ message: error.message || "Ошибка создания навыка" });
    }
  });

  /**
   * Обновить навык
   */
  app.patch("/api/skills/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ message: "Некорректный ID" }); return; }
      const updated = await skillManager.updateSkill(id, req.body);
      if (!updated) { res.status(404).json({ message: "Навык не найден" }); return; }
      res.json(updated);
    } catch (error) {
      console.error('Error updating skill:', error);
      res.status(500).json({ message: "Ошибка обновления навыка" });
    }
  });

  /**
   * Переключить навык (вкл/выкл)
   */
  app.patch("/api/skills/:id/toggle", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ message: "Некорректный ID" }); return; }
      const { isEnabled } = req.body;
      if (typeof isEnabled !== 'boolean') {
        res.status(400).json({ message: "Требуется isEnabled (boolean)" });
        return;
      }
      await skillManager.toggleSkill(id, isEnabled);
      res.json({ success: true });
    } catch (error) {
      console.error('Error toggling skill:', error);
      res.status(500).json({ message: "Ошибка переключения навыка" });
    }
  });

  /**
   * Удалить навык (только пользовательские)
   */
  app.delete("/api/skills/:id", async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) { res.status(400).json({ message: "Некорректный ID" }); return; }
      const deleted = await skillManager.deleteSkill(id);
      if (!deleted) {
        res.status(400).json({ message: "Невозможно удалить встроенный навык" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting skill:', error);
      res.status(500).json({ message: "Ошибка удаления навыка" });
    }
  });

  // ============================================================================
  // Tool Packs API — Метаданные пакетов инструментов
  // ============================================================================

  /**
   * Список всех tool packs с описаниями и инструментами
   * GET /api/tool-packs
   */
  app.get("/api/tool-packs", async (_req, res) => {
    try {
      const { getToolPacksInfo } = await import("./tools");
      const packs = getToolPacksInfo();
      res.json(packs);
    } catch (error) {
      console.error("Error getting tool packs:", error);
      res.status(500).json({ message: "Ошибка получения tool packs" });
    }
  });

  // ============================================================================
  // Expertises API — Управление экспертизами Universal Agent
  // ============================================================================

  const expertiseService = await import("./expertiseRegistry");


  /**
   * Список всех экспертиз
   * GET /api/expertises?all=true — включая неактивные
   */
  app.get("/api/expertises", async (req, res) => {
    try {
      const showAll = req.query.all === "true";
      const list = await expertiseService.getAllExpertises(!showAll);
      res.json(list);
    } catch (error) {
      console.error("Error listing expertises:", error);
      res.status(500).json({ message: "Ошибка получения экспертиз" });
    }
  });

  /**
   * Получить экспертизу по slug
   */
  app.get("/api/expertises/:slug", async (req, res) => {
    try {
      const expertise = await expertiseService.getExpertiseBySlug(req.params.slug);
      if (!expertise) {
        res.status(404).json({ message: "Экспертиза не найдена" });
        return;
      }
      res.json(expertise);
    } catch (error) {
      console.error("Error getting expertise:", error);
      res.status(500).json({ message: "Ошибка получения экспертизы" });
    }
  });

  /**
   * Создать экспертизу
   */
  app.post("/api/expertises", async (req, res) => {
    try {
      const { slug, name, promptTemplate, toolPacks, triggerDomains, contextPreferences, priority } = req.body;
      if (!slug || !name || !promptTemplate) {
        res.status(400).json({ message: "Требуются slug, name и promptTemplate" });
        return;
      }
      const expertise = await expertiseService.createExpertise({
        slug, name, promptTemplate,
        toolPacks: toolPacks || ["core"],
        triggerDomains: triggerDomains || [],
        contextPreferences: contextPreferences || {},
        priority: priority ?? 0,
        isActive: true,
      });
      res.status(201).json(expertise);
    } catch (error: any) {
      console.error("Error creating expertise:", error);
      if (error?.message?.includes("UNIQUE") || error?.code === "23505") {
        res.status(409).json({ message: "Экспертиза с таким slug уже существует" });
      } else {
        res.status(500).json({ message: "Ошибка создания экспертизы" });
      }
    }
  });

  /**
   * Обновить экспертизу
   */
  app.patch("/api/expertises/:slug", async (req, res) => {
    try {
      const updated = await expertiseService.updateExpertise(req.params.slug, req.body);
      if (!updated) {
        res.status(404).json({ message: "Экспертиза не найдена" });
        return;
      }
      res.json(updated);
    } catch (error) {
      console.error("Error updating expertise:", error);
      res.status(500).json({ message: "Ошибка обновления экспертизы" });
    }
  });

  /**
   * Переключить isActive
   */
  app.patch("/api/expertises/:slug/toggle", async (req, res) => {
    try {
      const { isActive } = req.body;
      if (typeof isActive !== "boolean") {
        res.status(400).json({ message: "Требуется isActive (boolean)" });
        return;
      }
      const updated = await expertiseService.updateExpertise(req.params.slug, { isActive });
      if (!updated) {
        res.status(404).json({ message: "Экспертиза не найдена" });
        return;
      }
      res.json(updated);
    } catch (error) {
      console.error("Error toggling expertise:", error);
      res.status(500).json({ message: "Ошибка переключения экспертизы" });
    }
  });

  /**
   * Удалить экспертизу
   */
  app.delete("/api/expertises/:slug", async (req, res) => {
    try {
      const deleted = await expertiseService.deleteExpertise(req.params.slug);
      if (!deleted) {
        res.status(404).json({ message: "Экспертиза не найдена" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting expertise:", error);
      res.status(500).json({ message: "Ошибка удаления экспертизы" });
    }
  });

  // =========================================================
  // Webhook Endpoint — Event-Driven Architecture (Stage 3c)
  // =========================================================

  /**
   * POST /api/webhooks/:source — приём внешних событий.
   * 
   * Обработка асинхронная — webhook отвечает мгновенно,
   * AI обрабатывает событие в фоне.
   */
  app.post("/api/webhooks/:source", async (req, res) => {
    // Security check
    const secret = req.headers['x-webhook-secret'];
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      console.warn(`🚫 [Webhook] Unauthorized access attempt from ${req.ip}`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const event: ExternalEvent = {
      type: req.body.type || 'custom',
      source: req.params.source,
      data: req.body,
      timestamp: new Date(),
    };

    // Асинхронная обработка — не блокируем webhook
    handleExternalEvent(event).catch(err => {
      console.error('❌ [Webhook] Event handler error:', err);
    });

    res.json({ ok: true });
  });


  // ========== VAULT / YANDEX DISK API ==========

  app.get("/api/vault/settings", async (req, res) => {
    try {
      const token = await storage.getSetting("yandex_disk_token");
      const root = await storage.getSetting("yandex_disk_root") || "app:/";
      
      let isConnected = false;
      let connectionUser: string | undefined;
      let connectionError: string | undefined;
      if (token) {
        const yDisk = new YandexDiskService({ token, remoteRoot: root });
        const result = await yDisk.checkConnection();
        isConnected = result.connected;
        connectionUser = result.user;
        connectionError = result.error;
      }

      res.json({ 
        token: token ? "********" : null, 
        hasToken: !!token, 
        root, 
        isConnected,
        connectionUser,
        connectionError,
      });
    } catch (error) {
      res.status(500).json({ message: "Ошибка получения настроек Vault" });
    }
  });

  app.post("/api/vault/settings", async (req, res) => {
    try {
      const { token, root } = req.body;
      if (token !== undefined && token !== "********") {
        await storage.setSetting("yandex_disk_token", token);
      }
      if (root !== undefined) {
        await storage.setSetting("yandex_disk_root", root);
      }

      // Проверяем подключение сразу после сохранения
      const savedToken = await storage.getSetting("yandex_disk_token");
      const savedRoot = await storage.getSetting("yandex_disk_root") || "app:/";
      
      let isConnected = false;
      let connectionUser: string | undefined;
      let connectionError: string | undefined;
      if (savedToken) {
        const yDisk = new YandexDiskService({ token: savedToken, remoteRoot: savedRoot });
        const result = await yDisk.checkConnection();
        isConnected = result.connected;
        connectionUser = result.user;
        connectionError = result.error;
      }

      res.json({ 
        message: "Настройки сохранены", 
        isConnected,
        connectionUser,
        connectionError,
      });
    } catch (error) {
      res.status(500).json({ message: "Ошибка сохранения настроек Vault" });
    }
  });

  app.post("/api/vault/sync", async (req, res) => {
    try {
      const allNotes = await db.select().from(notesTable).where(eq(notesTable.isActive, true));
      let successCount = 0;
      for (const note of allNotes) {
        try {
          await syncNoteToVault(note);
          successCount++;
        } catch (e) {
          console.error(`Failed to sync note ${note.id}:`, e);
        }
      }
      res.json({ message: `Синхронизация завершена: ${successCount}/${allNotes.length}` });
    } catch (error) {
      res.status(500).json({ message: "Ошибка запуска синхронизации" });
    }
  });

  // ========== ОБРАТНАЯ СИНХРОНИЗАЦИЯ (Stage 3) ==========

  /**
   * Получить список изменённых файлов на Yandex Disk
   */
  app.get("/api/vault/remote-changes", async (req, res) => {
    try {
      const changes = await getRemoteChanges();
      res.json(changes);
    } catch (error: any) {
      console.error("Error getting remote changes:", error);
      res.status(500).json({ message: error.message || "Ошибка получения изменений" });
    }
  });

  /**
   * Pull: скачать и применить изменения из облака
   */
  app.post("/api/vault/pull", async (req, res) => {
    try {
      const result = await pullFromCloud();
      const message = `Pull завершён: создано ${result.created}, обновлено ${result.updated}, пропущено ${result.skipped}`;
      res.json({ ...result, message });
    } catch (error: any) {
      console.error("Error pulling from cloud:", error);
      res.status(500).json({ message: error.message || "Ошибка pull из облака" });
    }
  });

  /**
   * Статус фонового watcher'а
   */
  app.get("/api/vault/sync-status", async (req, res) => {
    try {
      const status = await getWatcherStatus();
      res.json(status);
    } catch (error: any) {
      console.error("Error getting sync status:", error);
      res.status(500).json({ message: error.message || "Ошибка получения статуса" });
    }
  });

  /**
   * Включить/выключить фоновый watcher
   */
  app.post("/api/vault/watcher", async (req, res) => {
    try {
      const { enabled, intervalMinutes } = req.body;
      if (enabled) {
        const interval = (intervalMinutes || 5) * 60 * 1000;
        startWatcher(interval);
        res.json({ message: "Watcher запущен", running: true });
      } else {
        stopWatcher();
        res.json({ message: "Watcher остановлен", running: false });
      }
    } catch (error) {
      res.status(500).json({ message: "Ошибка запуска синхронизации" });
    }
  });

  // ========== TICKTICK API — Планировщик задач ==========

  // Инициализация TickTick service при запуске (если есть env-переменные)
  if (process.env.TICKTICK_CLIENT_ID && process.env.TICKTICK_CLIENT_SECRET) {
    const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
    tickTickService.initialize({
      clientId: process.env.TICKTICK_CLIENT_ID,
      clientSecret: process.env.TICKTICK_CLIENT_SECRET,
      redirectUri: `${baseUrl}/api/ticktick/callback`,
      onTokensRefreshed: async (tokens) => {
        await storage.setSetting('ticktick_tokens', JSON.stringify(tokens));
      },
      onInboxDiscovered: async (inboxId) => {
        await storage.setSetting('ticktick_inbox_id', inboxId);
      },
    });

    // Восстанавливаем токены из БД если есть
    try {
      const savedTokens = await storage.getSetting('ticktick_tokens');
      if (savedTokens) {
        const tokens = JSON.parse(savedTokens);
        tickTickService.setTokens(tokens);
      }
      // Восстанавливаем Inbox ID из БД
      const savedInboxId = await storage.getSetting('ticktick_inbox_id');
      if (savedInboxId) {
        tickTickService.setInboxId(savedInboxId);
        console.log(`[TickTick] 📥 Inbox ID восстановлен из БД: ${savedInboxId}`);
      }
    } catch (err) {
      console.warn('[TickTick] ⚠️ Не удалось восстановить токены:', err);
    }

    console.log('[TickTick] ✅ Сервис инициализирован');
    diagInfo('ticktick', 'startup_complete', 'TickTick service fully initialized', {
      hasTokens: !!(await storage.getSetting('ticktick_tokens')),
      hasInboxId: !!(await storage.getSetting('ticktick_inbox_id')),
      isAuthenticated: tickTickService.isAuthenticated(),
    });
  } else {
    console.log('[TickTick] ⚠️ TICKTICK_CLIENT_ID / TICKTICK_CLIENT_SECRET не заданы — интеграция отключена');
    diagWarn('ticktick', 'init_skipped', 'TickTick credentials not found in environment', {
      hasClientId: !!process.env.TICKTICK_CLIENT_ID,
      hasClientSecret: !!process.env.TICKTICK_CLIENT_SECRET,
      nodeEnv: process.env.NODE_ENV,
    });
  }

  /**
   * Начало OAuth авторизации — редирект на TickTick
   */
  app.get("/api/ticktick/auth", async (req, res) => {
    if (!tickTickService.isConfigured()) {
      return res.status(503).json({ message: "TickTick не сконфигурирован. Задайте TICKTICK_CLIENT_ID и TICKTICK_CLIENT_SECRET." });
    }
    const authUrl = tickTickService.getAuthorizationUrl();
    res.redirect(authUrl);
  });

  /**
   * OAuth callback — обмен кода на токен
   */
  app.get("/api/ticktick/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      if (!code) {
        return res.status(400).json({ message: "Код авторизации не получен" });
      }

      const tokens = await tickTickService.exchangeCodeForToken(code);

      // Сохраняем токены в БД
      await storage.setSetting('ticktick_tokens', JSON.stringify(tokens));

      // Редиректим обратно на UI
      res.send(`
        <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2>✅ TickTick подключён!</h2>
          <p>Авторизация прошла успешно. Можете закрыть эту вкладку.</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        </body></html>
      `);
    } catch (error: any) {
      console.error('[TickTick] OAuth callback error:', error);
      res.status(500).send(`
        <html><body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h2>❌ Ошибка авторизации TickTick</h2>
          <p>${error?.message || 'Неизвестная ошибка'}</p>
        </body></html>
      `);
    }
  });

  /**
   * Статус подключения TickTick
   */
  app.get("/api/ticktick/status", async (req, res) => {
    res.json({
      configured: tickTickService.isConfigured(),
      authenticated: tickTickService.isAuthenticated(),
    });
  });

  /**
   * Отключить TickTick (удалить токены)
   */
  app.post("/api/ticktick/disconnect", async (req, res) => {
    try {
      tickTickService.setTokens({ accessToken: '' });
      await storage.setSetting('ticktick_tokens', '');
      res.json({ message: "TickTick отключён" });
    } catch (error) {
      res.status(500).json({ message: "Ошибка отключения TickTick" });
    }
  });

  return httpServer;
}

// AI Message Processing Pipeline
async function processMessageWithAI(
  userMessage: Message,
  broadcastMessage: (message: any) => void,
  broadcastData?: (data: any) => void,
  broadcastProcessingStep?: (step: ProcessingStep) => void
): Promise<void> {
  try {
    console.log('Начало обработки сообщения AI через агентную систему...');

    // ========== MULTI-AGENT ORCHESTRATOR ==========
    // Обработка через агентную систему: маршрутизация, генерация ответа, 
    // извлечение фактов и целей — всё в одном месте

    const sessionId = `default-session`;

    const result = await agentOrchestrator.processMessage(
      userMessage.content,
      sessionId,
      userMessage.id,
      broadcastProcessingStep  // NEW: передаём callback для визуализации
    );

    // ⚡ Data-only: системное уведомление (не засоряет контекст AI)
    if (result.isDataOnly) {
      const systemMessage = await storage.createMessage({
        content: result.response,
        type: 'text',
        sender: 'ai',
        status: 'delivered',
        excludeFromContext: true,
      });
      broadcastMessage(systemMessage);
      console.log(`⚡ Data-only ответ: ${result.response.substring(0, 100)}`);
      return;
    }

    // 🛡️ Валидация: не сохраняем пустые ответы
    if (!result.response?.trim()) {
      console.error('❌ AI вернул пустой ответ, генерируем системное сообщение');
      result.response = '⚠️ Не удалось сформировать ответ. Пожалуйста, попробуйте задать вопрос ещё раз.';
    }

    // Save AI response to database
    const aiMessage = await storage.createMessage({
      content: result.response,
      type: 'text',
      sender: 'ai',
      status: 'delivered',
    });

    // Fire-and-forget: генерация embedding для семантического поиска
    if (aiMessage.content.length >= 30) {
      createMessageEmbedding(aiMessage.id, aiMessage.content).catch(() => { });
    }

    // Broadcast AI response to all clients
    broadcastMessage(aiMessage);
    console.log(`AI ответ от ${result.agentName}: ${result.response.substring(0, 100)}`);
    console.log(`Использовано токенов: ${result.tokensUsed}, извлечено фактов: ${result.factsExtracted}`);

    // Generate summary every 10 messages
    const allMessages = await storage.getMessages();
    const lastSummary = await storage.getLatestSummary();
    const messagesSinceLastSummary = lastSummary
      ? allMessages.filter(m => m.id > (lastSummary.endMessageId || 0)).length
      : allMessages.length;

    if (messagesSinceLastSummary >= 10) {
      try {
        const config = await getDefaultAIConfig(storage.getSetting.bind(storage));
        const messagesToSummarize = allMessages.slice(-20);
        const summaryText = await generateSummary(
          messagesToSummarize.map(m => ({ sender: m.sender, content: m.content })),
          config
        );

        await storage.createSummary({
          content: summaryText,
          messageCount: messagesToSummarize.length,
          startMessageId: messagesToSummarize[0]?.id,
          endMessageId: messagesToSummarize[messagesToSummarize.length - 1]?.id,
        });

        console.log('Summary создан:', summaryText.substring(0, 100));
      } catch (summaryErr) {
        console.error('Ошибка создания summary:', summaryErr);
      }
    }

  } catch (error) {
    // Подробное логирование с полным stack trace для диагностики
    const errorName = error instanceof Error ? error.constructor.name : 'Unknown';
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : '';
    console.error(`❌ Ошибка в AI pipeline [${errorName}]: ${errorMsg}`);
    if (errorStack) console.error('Stack trace:', errorStack);

    // Логируем в tool_call_logs для видимости в UI диагностики
    try {
      const { logToolCall } = await import('./lib/logger');
      await logToolCall({
        toolName: '__pipeline_crash__',
        input: { userMessageId: userMessage.id, content: userMessage.content?.substring(0, 200) },
        result: { error: `${errorName}: ${errorMsg}` },
        success: false,
        error: `Pipeline crash [${errorName}]: ${errorMsg}`,
        durationMs: 0,
        agentSlug: 'system',
        messageId: userMessage.id,
        sessionId: 'default-session',
        iteration: 0,
        displayText: `🔴 PIPELINE CRASH: ${errorMsg}`,
      });
    } catch {} // Не блокируем отправку ошибки пользователю

    // User-friendly сообщение — без технических деталей
    const errorMessage = await storage.createMessage({
      content: 'Извини, произошла техническая ошибка при обработке запроса. Попробуй отправить сообщение ещё раз.',
      type: 'text',
      sender: 'ai',
      status: 'error',
    });

    broadcastMessage(errorMessage);
  }
}
