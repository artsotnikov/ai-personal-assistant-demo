import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Agent } from "http";
import { imageToBase64DataUrl } from "./imageUtils";

// AI Provider types (также экспортируется из schema.ts)
export type AIProvider = 'openai' | 'deepseek' | 'openrouter' | 'custom' | 'antigravity';

export interface AIConfig {
  provider: AIProvider;
  model?: string;
  systemPrompt?: string;
}

// Кэш для прокси-агента
let cachedProxyAgent: Agent | null = null;

function getProxyAgent(): Agent | undefined {
  const proxyUrl = process.env.OPENAI_PROXY;
  if (!proxyUrl) return undefined;

  if (!cachedProxyAgent) {
    if (proxyUrl.startsWith('socks://') || proxyUrl.startsWith('socks5://') || proxyUrl.startsWith('socks4://')) {
      console.log("🔄 AI Service: настроен SOCKS прокси");
      cachedProxyAgent = new SocksProxyAgent(proxyUrl);
    } else {
      console.log("🔄 AI Service: настроен HTTP прокси");
      cachedProxyAgent = new HttpsProxyAgent(proxyUrl);
    }
  }
  return cachedProxyAgent;
}

// OpenAI client for transcription (with proxy support)
function getOpenAIClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY не настроен. Добавьте ключ в секреты.");
  }

  const proxyAgent = getProxyAgent();
  if (proxyAgent) {
    return new OpenAI({
      apiKey,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const nodeFetch = (await import('node-fetch')).default;
        const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        return nodeFetch(urlString, {
          ...init as any,
          agent: proxyAgent,
        }) as unknown as Response;
      }) as typeof fetch,
    });
  }

  return new OpenAI({ apiKey });
}

// Get OpenRouter client
function getOpenRouterClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY не настроен. Добавьте ключ в .env");
  }
  return new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultHeaders: {
      'HTTP-Referer': process.env.APP_URL || 'https://ai-assistant.app',
      'X-Title': 'AI Personal Assistant',
    },
  });
}

// Get Groq client for transcription (with proxy support)
function getGroqClient(): OpenAI {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY не настроен. Добавьте ключ в .env");
  }

  const proxyAgent = getProxyAgent();
  if (proxyAgent) {
    return new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey,
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        const nodeFetch = (await import('node-fetch')).default;
        const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
        return nodeFetch(urlString, {
          ...init as any,
          agent: proxyAgent,
        }) as unknown as Response;
      }) as typeof fetch,
    });
  }

  return new OpenAI({
    baseURL: 'https://api.groq.com/openai/v1',
    apiKey,
  });
}

// Get DeepSeek client
function getDeepSeekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY не настроен. Добавьте ключ в секреты.");
  }
  return new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey,
  });
}

// Get Custom API client (OpenAI-compatible endpoints)
function getCustomClient(): OpenAI {
  const apiKey = process.env.CUSTOM_API_KEY;
  const baseURL = process.env.CUSTOM_API_URL;
  if (!apiKey || !baseURL) {
    throw new Error("CUSTOM_API_KEY и CUSTOM_API_URL не настроены. Добавьте ключи в .env");
  }
  return new OpenAI({
    baseURL,
    apiKey,
  });
}

// Get AI client based on provider
function getAIClient(provider: AIProvider): any {
  // В новом aiConfigService есть централизованная логика получения клиентов
  const { getAIClientForTask } = require('./aiConfigService');
  
  switch (provider) {
    case 'openrouter':
      return getOpenRouterClient();
    case 'deepseek':
      return getDeepSeekClient();
    case 'custom':
      return getCustomClient();
    case 'antigravity':
      // Перенаправляем на централизованный AntigravityClient
      const { createClientForProvider } = require('./aiConfigService');
      return createClientForProvider('antigravity');
    case 'openai':
    default:
      return getOpenAIClient();
  }
}

// Get model name based on provider
function getModelName(provider: AIProvider, customModel?: string): string {
  if (customModel) return customModel;

  switch (provider) {
    case 'openrouter':
      return 'openai/gpt-4.1-mini';
    case 'deepseek':
      return 'deepseek-v4-flash';
    case 'antigravity':
      return 'gemini-3.1-pro-high';
    case 'custom':
      return process.env.CUSTOM_DEFAULT_MODEL || 'gpt-4o-mini';
    case 'openai':
    default:
      return 'gpt-4o-mini';
  }
}

// Prompt-подсказка для Whisper — улучшает пунктуацию и снижает галлюцинации
const WHISPER_PROMPT = 'Деловой разговор на русском языке. Расставляй знаки препинания: точки, запятые, вопросительные и восклицательные знаки. Перепубликация, Авито, Google Таблицы, личный кабинет, клиенты, техподдержка.';

// LLM-пост-обработка: исправляет ошибки распознавания, добавляет пунктуацию и структуру
async function polishTranscription(rawText: string): Promise<string> {
  // Не обрабатываем слишком короткие тексты — LLM не нужен
  if (rawText.length < 20) return rawText;

  try {
    // Определяем доступного LLM-провайдера для пост-обработки
    let client: OpenAI;
    let model: string;

    if (process.env.CUSTOM_API_KEY && process.env.CUSTOM_API_URL) {
      client = getCustomClient();
      model = process.env.CUSTOM_DEFAULT_MODEL || 'gpt-4o-mini';
    } else if (process.env.OPENROUTER_API_KEY) {
      client = getOpenRouterClient();
      model = 'openai/gpt-4.1-mini';
    } else if (process.env.DEEPSEEK_API_KEY) {
      client = getDeepSeekClient();
      model = 'deepseek-v4-flash';
    } else if (process.env.OPENAI_API_KEY) {
      client = getOpenAIClient();
      model = 'gpt-4o-mini';
    } else {
      // Нет LLM-провайдера — возвращаем сырой текст
      console.log('⚠️ Нет LLM-провайдера для пост-обработки транскрибации');
      return rawText;
    }

    console.log(`✨ Пост-обработка транскрибации через ${model}...`);

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: `Ты — редактор транскрибированного текста. Твоя задача — исправить текст, полученный из системы распознавания речи.

Правила:
1. Исправь очевидные ошибки распознавания (например, "на пир публика" → "на перепубликацию", "днс" → "DNS").
2. Расставь знаки препинания: точки, запятые, вопросительные и восклицательные знаки.
3. Раздели текст на предложения.
4. НЕ меняй смысл, НЕ добавляй новую информацию, НЕ сокращай текст.
5. НЕ удаляй части текста — сохрани всё, что было сказано.
6. Убери артефакты распознавания (например, "Продолжение следует...", повторяющиеся фрагменты).
7. Верни ТОЛЬКО исправленный текст, без комментариев и пояснений.`
        },
        {
          role: 'user',
          content: rawText
        }
      ],
      max_completion_tokens: Math.min(rawText.length * 3, 4096),
      temperature: 0.3,
    });

    const polished = response.choices[0]?.message?.content;
    if (polished && polished.trim()) {
      console.log('✅ Пост-обработка завершена:', polished.substring(0, 100));
      return polished.trim();
    }

    // Если LLM вернул пустой результат — используем сырой текст
    return rawText;
  } catch (error: any) {
    // Пост-обработка — необязательный шаг, при ошибке возвращаем сырой текст
    console.warn('⚠️ Ошибка пост-обработки транскрибации:', error.message || error);
    return rawText;
  }
}

// Transcribe audio file - prefer Groq (works from Russia), fallback to OpenAI
export async function transcribeAudio(audioFilePath: string): Promise<string> {
  // Ensure the file exists
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Аудио файл не найден: ${audioFilePath}`);
  }

  const errors: string[] = [];
  let rawText: string | null = null;

  // Try Groq first (no regional restrictions, works from Russia)
  if (process.env.GROQ_API_KEY) {
    try {
      console.log('🎤 Транскрибация через Groq Whisper...');
      const client = getGroqClient();
      const audioReadStream = fs.createReadStream(audioFilePath);

      const transcription = await client.audio.transcriptions.create({
        file: audioReadStream,
        model: "whisper-large-v3",  // Groq's Whisper model
        language: "ru",
        prompt: WHISPER_PROMPT,
        temperature: 0,
      });

      if (transcription.text && transcription.text.trim()) {
        console.log('✅ Groq транскрибация успешна:', transcription.text.substring(0, 100));
        rawText = transcription.text;
      } else {
        throw new Error('Пустой результат транскрибации');
      }
    } catch (error: any) {
      const errorMsg = `Groq: ${error.message || error}`;
      console.warn('⚠️ Groq транскрибация не удалась:', errorMsg);
      errors.push(errorMsg);
    }
  }

  // Fallback to OpenAI Whisper
  if (!rawText && process.env.OPENAI_API_KEY) {
    try {
      console.log('🎤 Транскрибация через OpenAI Whisper (fallback)...');
      const client = getOpenAIClient();
      const audioReadStream = fs.createReadStream(audioFilePath);

      const transcription = await client.audio.transcriptions.create({
        file: audioReadStream,
        model: "whisper-1",
        language: "ru",
        prompt: WHISPER_PROMPT,
        temperature: 0,
      });

      if (transcription.text && transcription.text.trim()) {
        console.log('✅ OpenAI транскрибация успешна:', transcription.text.substring(0, 100));
        rawText = transcription.text;
      } else {
        throw new Error('Пустой результат транскрибации');
      }
    } catch (error: any) {
      const errorMsg = `OpenAI: ${error.message || error}`;
      console.warn('⚠️ OpenAI транскрибация не удалась:', errorMsg);
      errors.push(errorMsg);
    }
  }

  // All attempts failed — no raw text
  if (!rawText) {
    if (errors.length === 0) {
      throw new Error('Ни Groq, ни OpenAI API не настроены для транскрибации аудио. Добавьте GROQ_API_KEY в .env');
    }
    throw new Error(`Не удалось транскрибировать аудио. Ошибки: ${errors.join('; ')}`);
  }

  // Пост-обработка LLM: исправление ошибок, пунктуация, структурирование
  const polishedText = await polishTranscription(rawText);
  return polishedText;
}

// Generate AI response with conversation history
export async function generateAIResponse(
  userMessage: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
  config: AIConfig = { provider: 'openai' },
  memoryContext?: string // Новый параметр: форматированный контекст из памяти
): Promise<string> {
  try {
    const client = getAIClient(config.provider);
    const model = getModelName(config.provider, config.model);

    // Формируем системный промпт с контекстом памяти
    let systemPrompt = config.systemPrompt || '';

    if (memoryContext) {
      systemPrompt = `${systemPrompt}

${memoryContext}

ВАЖНО: Используй контекст из памяти для персонализированных ответов. Если есть факты о пользователе или его бизнесе — учитывай их при ответе.`;
    }

    // Build messages array with system prompt, history, and current message
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];

    const contextInfo = memoryContext ? ' + memory context' : '';
    console.log(`Generating response with ${config.provider} (${model}), history: ${conversationHistory.length} messages${contextInfo}`);

    const response = await client.chat.completions.create({
      model,
      messages,
      max_completion_tokens: 4096,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Пустой ответ от AI");
    }

    return content;
  } catch (error: any) {
    console.error("Ошибка генерации ответа AI:", error);
    throw new Error(`Не удалось получить ответ от AI: ${error.message}`);
  }
}

// Generate summary of conversation
export async function generateSummary(
  messages: Array<{ sender: string; content: string }>,
  config: AIConfig = { provider: 'openai' }
): Promise<string> {
  try {
    const client = getAIClient(config.provider);
    const model = getModelName(config.provider, config.model);

    // Format messages for summary
    const conversationText = messages
      .map(m => `${m.sender === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`)
      .join('\n\n');

    const summaryPrompt = `Создай краткое саммари следующего разговора. Выдели ключевые темы, решения и важные моменты. Саммари должно быть кратким, но информативным.

Разговор:
${conversationText}

Саммари:`;

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content: 'Ты — помощник для создания кратких саммари разговоров. Пиши структурированно и по делу.'
        },
        { role: 'user', content: summaryPrompt },
      ],
      max_completion_tokens: 1024,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error("Пустой ответ при генерации саммари");
    }

    return content;
  } catch (error: any) {
    console.error("Ошибка генерации саммари:", error);
    throw new Error(`Не удалось создать саммари: ${error.message}`);
  }
}

// Check if AI providers are configured
export function checkAIConfiguration(): {
  openai: boolean;
  deepseek: boolean;
  openrouter: boolean;
  custom: boolean;
  groq: boolean;
  canTranscribe: boolean;
  defaultProvider: AIProvider | null;
} {
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasDeepSeek = !!process.env.DEEPSEEK_API_KEY;
  const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
  const hasCustom = !!(process.env.CUSTOM_API_KEY && process.env.CUSTOM_API_URL);
  const hasGroq = !!process.env.GROQ_API_KEY;

  // Приоритет: Custom > OpenRouter > DeepSeek > OpenAI
  let defaultProvider: AIProvider | null = null;
  if (hasCustom) defaultProvider = 'custom';
  else if (hasOpenRouter) defaultProvider = 'openrouter';
  else if (hasDeepSeek) defaultProvider = 'deepseek';
  else if (hasOpenAI) defaultProvider = 'openai';

  return {
    openai: hasOpenAI,
    deepseek: hasDeepSeek,
    openrouter: hasOpenRouter,
    custom: hasCustom,
    groq: hasGroq,
    canTranscribe: hasGroq || hasOpenAI,  // Groq or OpenAI can transcribe
    defaultProvider,
  };
}

// Get default AI configuration from settings
export async function getDefaultAIConfig(
  getSetting: (key: string) => Promise<string | null>
): Promise<AIConfig> {
  const providerSetting = await getSetting('ai_provider');
  const modelSetting = await getSetting('ai_model');
  const systemPromptSetting = await getSetting('ai_system_prompt');

  const config = checkAIConfiguration();

  // Use saved provider or fall back to first available
  let provider: AIProvider = 'custom'; // Default changed to custom
  if (providerSetting === 'custom' && config.custom) {
    provider = 'custom';
  } else if (providerSetting === 'openrouter' && config.openrouter) {
    provider = 'openrouter';
  } else if (providerSetting === 'deepseek' && config.deepseek) {
    provider = 'deepseek';
  } else if (providerSetting === 'openai' && config.openai) {
    provider = 'openai';
  } else if (config.defaultProvider) {
    provider = config.defaultProvider;
  }

  return {
    provider,
    model: modelSetting || undefined,
    systemPrompt: systemPromptSetting || undefined,
  };
}

// Describe an image using the configured vision_analysis model
export async function describeImage(imageFilePath: string): Promise<string | null> {
  // Ensure the file exists
  if (!fs.existsSync(imageFilePath)) {
    throw new Error(`Изображение не найдено: ${imageFilePath}`);
  }

  const base64Url = imageToBase64DataUrl(imageFilePath);
  if (!base64Url) {
    throw new Error('Не удалось конвертировать изображение в base64');
  }

  try {
    const { getAIClientForTask, callWithFallback: callAI } = await import('./aiConfigService');
    const visionConfig = await getAIClientForTask('vision_analysis');

    const visionMessages = [
      {
        role: 'system' as const,
        content: 'Ты — AI-помощник с функцией зрения. Опиши подробно, что ты видишь на этом изображении. Твое текстовое описание будет сохранено в историю для текстовых моделей (которые не умеют видеть), поэтому важно передать весь смысл, надписи (если есть) и ключевые детали. Будь информативен и точен.',
      },
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: 'Опиши детально это изображение для включения в текстовый контекст:'
          },
          {
            type: 'image_url' as const,
            image_url: { url: base64Url, detail: 'auto' as const }
          }
        ]
      }
    ];

    console.log(`🖼️ Анализ изображения через ${visionConfig.provider}...`);
    const visionResult = await callAI(visionConfig, visionMessages);
    const interpretation = visionResult.content;

    if (interpretation && interpretation.trim()) {
      return interpretation.trim();
    }
    return null;
  } catch (error: any) {
    console.warn('⚠️ Ошибка vision-анализа:', error.message || error);
    throw error;
  }
}

