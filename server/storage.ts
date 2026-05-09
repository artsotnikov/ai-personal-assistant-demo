import {
  messages, conversations, appSettings, aiPrompts, summaries,
  type Message, type InsertMessage,
  type Conversation, type InsertConversation,
  type AppSettings, type InsertAppSettings,
  type AiPrompt, type InsertAiPrompt,
  type Summary, type InsertSummary
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, sql, asc } from "drizzle-orm";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

export interface IStorage {
  // Messages
  getMessages(): Promise<Message[]>;
  getMessagesPaginated(limit: number, offset: number): Promise<{
    messages: Message[];
    totalCount: number;
    hasMore: boolean;
  }>;
  getMessage(id: number): Promise<Message | undefined>;
  getRecentMessages(limit: number): Promise<Message[]>;
  createMessage(message: InsertMessage): Promise<Message>;
  updateMessageStatus(id: number, status: string): Promise<Message | undefined>;

  // Conversations
  getConversations(): Promise<Conversation[]>;
  getConversation(id: number): Promise<Conversation | undefined>;
  createConversation(conversation: InsertConversation): Promise<Conversation>;
  updateConversation(id: number, updates: Partial<Conversation>): Promise<Conversation | undefined>;

  // Auth
  setPassword(password: string): Promise<void>;
  verifyPassword(password: string): Promise<boolean>;
  hasPassword(): Promise<boolean>;

  // Settings
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  deleteSetting(key: string): Promise<void>;

  // AI Prompts
  getAiPrompts(): Promise<AiPrompt[]>;
  getAiPrompt(id: number): Promise<AiPrompt | undefined>;
  getActiveAiPrompt(name: string): Promise<AiPrompt | undefined>;
  createAiPrompt(prompt: InsertAiPrompt): Promise<AiPrompt>;
  updateAiPrompt(id: number, updates: Partial<AiPrompt>): Promise<AiPrompt | undefined>;
  deleteAiPrompt(id: number): Promise<boolean>;

  // Summaries
  getSummaries(): Promise<Summary[]>;
  getLatestSummary(): Promise<Summary | undefined>;
  createSummary(summary: InsertSummary): Promise<Summary>;
}

export class MemStorage implements IStorage {
  private messages: Map<number, Message>;
  private conversations: Map<number, Conversation>;
  private prompts: Map<number, AiPrompt>;
  private summariesStore: Map<number, Summary>;
  private settings: Map<string, string>;
  private currentMessageId: number;
  private currentConversationId: number;
  private currentPromptId: number;
  private currentSummaryId: number;
  private password: string | null = null;

  constructor() {
    this.messages = new Map();
    this.conversations = new Map();
    this.prompts = new Map();
    this.summariesStore = new Map();
    this.settings = new Map();
    this.currentMessageId = 1;
    this.currentConversationId = 1;
    this.currentPromptId = 1;
    this.currentSummaryId = 1;

    // Create default conversation
    this.createConversation({
      title: "Новый чат",
      lastMessage: "Начните общение с ИИ-ассистентом",
      isActive: true,
    });
  }

  async getMessages(): Promise<Message[]> {
    return Array.from(this.messages.values()).sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
  }

  async getMessagesPaginated(limit: number, offset: number): Promise<{
    messages: Message[];
    totalCount: number;
    hasMore: boolean;
  }> {
    const allMessages = Array.from(this.messages.values()).sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() // Новые первыми
    );

    const totalCount = allMessages.length;
    const messages = allMessages.slice(offset, offset + limit);
    const hasMore = offset + limit < totalCount;

    return { messages, totalCount, hasMore };
  }

  async getMessage(id: number): Promise<Message | undefined> {
    return this.messages.get(id);
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const id = this.currentMessageId++;
    const message: Message = {
      ...insertMessage,
      id,
      timestamp: new Date(),
      status: insertMessage.status || 'sent',
      excludeFromContext: insertMessage.excludeFromContext ?? false,
      fileUrl: insertMessage.fileUrl || null,
      fileName: insertMessage.fileName || null,
      fileSize: insertMessage.fileSize || null,
    };
    this.messages.set(id, message);
    return message;
  }

  async updateMessageStatus(id: number, status: string): Promise<Message | undefined> {
    const message = this.messages.get(id);
    if (message) {
      message.status = status;
      this.messages.set(id, message);
    }
    return message;
  }

  async getConversations(): Promise<Conversation[]> {
    return Array.from(this.conversations.values()).sort((a, b) =>
      new Date(b.lastMessageTime).getTime() - new Date(a.lastMessageTime).getTime()
    );
  }

  async getConversation(id: number): Promise<Conversation | undefined> {
    return this.conversations.get(id);
  }

  async createConversation(insertConversation: InsertConversation): Promise<Conversation> {
    const id = this.currentConversationId++;
    const conversation: Conversation = {
      ...insertConversation,
      id,
      lastMessageTime: new Date(),
      title: insertConversation.title || null,
      lastMessage: insertConversation.lastMessage || null,
      isActive: insertConversation.isActive ?? true,
    };
    this.conversations.set(id, conversation);
    return conversation;
  }

  async updateConversation(id: number, updates: Partial<Conversation>): Promise<Conversation | undefined> {
    const conversation = this.conversations.get(id);
    if (conversation) {
      Object.assign(conversation, updates);
      this.conversations.set(id, conversation);
    }
    return conversation;
  }

  async setPassword(password: string): Promise<void> {
    this.password = password;
  }

  async verifyPassword(password: string): Promise<boolean> {
    return this.password === password;
  }

  async hasPassword(): Promise<boolean> {
    return this.password !== null;
  }

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) || null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async deleteSetting(key: string): Promise<void> {
    this.settings.delete(key);
  }

  async getRecentMessages(limit: number): Promise<Message[]> {
    const allMessages = Array.from(this.messages.values()).sort((a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return allMessages.slice(0, limit).reverse();
  }

  // AI Prompts
  async getAiPrompts(): Promise<AiPrompt[]> {
    return Array.from(this.prompts.values());
  }

  async getAiPrompt(id: number): Promise<AiPrompt | undefined> {
    return this.prompts.get(id);
  }

  async getActiveAiPrompt(name: string): Promise<AiPrompt | undefined> {
    return Array.from(this.prompts.values()).find(p => p.name === name && p.isActive);
  }

  async createAiPrompt(prompt: InsertAiPrompt): Promise<AiPrompt> {
    const id = this.currentPromptId++;
    const newPrompt: AiPrompt = {
      ...prompt,
      id,
      description: prompt.description || null,
      isActive: prompt.isActive ?? true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.prompts.set(id, newPrompt);
    return newPrompt;
  }

  async updateAiPrompt(id: number, updates: Partial<AiPrompt>): Promise<AiPrompt | undefined> {
    const prompt = this.prompts.get(id);
    if (prompt) {
      Object.assign(prompt, updates, { updatedAt: new Date() });
      this.prompts.set(id, prompt);
    }
    return prompt;
  }

  async deleteAiPrompt(id: number): Promise<boolean> {
    return this.prompts.delete(id);
  }

  // Summaries
  async getSummaries(): Promise<Summary[]> {
    return Array.from(this.summariesStore.values()).sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  async getLatestSummary(): Promise<Summary | undefined> {
    const all = await this.getSummaries();
    return all[0];
  }

  async createSummary(summary: InsertSummary): Promise<Summary> {
    const id = this.currentSummaryId++;
    const newSummary: Summary = {
      ...summary,
      id,
      startMessageId: summary.startMessageId || null,
      endMessageId: summary.endMessageId || null,
      createdAt: new Date(),
    };
    this.summariesStore.set(id, newSummary);
    return newSummary;
  }
}

export class DatabaseStorage implements IStorage {
  // Messages
  async getMessages(): Promise<Message[]> {
    return await db.select().from(messages).orderBy(messages.timestamp);
  }

  async getMessagesPaginated(limit: number, offset: number): Promise<{
    messages: Message[];
    totalCount: number;
    hasMore: boolean;
  }> {
    // Получаем общее количество сообщений
    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(messages);
    const totalCount = Number(count);

    // Получаем сообщения в обратном порядке (новые первыми), затем реверсируем для правильного отображения
    const messagesResult = await db
      .select()
      .from(messages)
      .orderBy(desc(messages.timestamp))
      .limit(limit)
      .offset(offset);

    const hasMore = offset + limit < totalCount;

    return {
      messages: messagesResult.reverse(), // Реверсируем для хронологического порядка в чате
      totalCount,
      hasMore
    };
  }

  async getMessage(id: number): Promise<Message | undefined> {
    const [message] = await db.select().from(messages).where(eq(messages.id, id));
    return message || undefined;
  }

  async createMessage(insertMessage: InsertMessage): Promise<Message> {
    const [message] = await db
      .insert(messages)
      .values(insertMessage)
      .returning();
    return message;
  }

  async updateMessageStatus(id: number, status: string): Promise<Message | undefined> {
    const [message] = await db
      .update(messages)
      .set({ status })
      .where(eq(messages.id, id))
      .returning();
    return message || undefined;
  }

  // Conversations
  async getConversations(): Promise<Conversation[]> {
    return await db.select().from(conversations).orderBy(desc(conversations.lastMessageTime));
  }

  async getConversation(id: number): Promise<Conversation | undefined> {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id));
    return conversation || undefined;
  }

  async createConversation(insertConversation: InsertConversation): Promise<Conversation> {
    const [conversation] = await db
      .insert(conversations)
      .values(insertConversation)
      .returning();
    return conversation;
  }

  async updateConversation(id: number, updates: Partial<Conversation>): Promise<Conversation | undefined> {
    const [conversation] = await db
      .update(conversations)
      .set(updates)
      .where(eq(conversations.id, id))
      .returning();
    return conversation || undefined;
  }

  // Утилиты для хеширования паролей
  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString("hex");
    const buf = (await scryptAsync(password, salt, 64)) as Buffer;
    return `${buf.toString("hex")}.${salt}`;
  }

  private async comparePasswords(supplied: string, stored: string): Promise<boolean> {
    const [hashed, salt] = stored.split(".");
    const hashedBuf = Buffer.from(hashed, "hex");
    const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
    return timingSafeEqual(hashedBuf, suppliedBuf);
  }

  // Auth - используем базу данных для постоянного хранения
  async setPassword(password: string): Promise<void> {
    const hashedPassword = await this.hashPassword(password);
    await this.setSetting('auth_password', hashedPassword);
  }

  async verifyPassword(password: string): Promise<boolean> {
    const storedHash = await this.getSetting('auth_password');
    if (!storedHash) return false;
    return await this.comparePasswords(password, storedHash);
  }

  async hasPassword(): Promise<boolean> {
    const password = await this.getSetting('auth_password');
    return password !== null;
  }

  // Settings - работа с настройками в базе данных
  async getSetting(key: string): Promise<string | null> {
    const [setting] = await db.select().from(appSettings).where(eq(appSettings.key, key));
    return setting?.value || null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await db
      .insert(appSettings)
      .values({ key, value })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }

  async deleteSetting(key: string): Promise<void> {
    await db.delete(appSettings).where(eq(appSettings.key, key));
  }

  // Get recent messages for AI context
  async getRecentMessages(limit: number): Promise<Message[]> {
    const messagesResult = await db
      .select()
      .from(messages)
      .orderBy(desc(messages.timestamp))
      .limit(limit);

    return messagesResult.reverse(); // Return in chronological order
  }

  // AI Prompts
  async getAiPrompts(): Promise<AiPrompt[]> {
    return await db.select().from(aiPrompts).orderBy(desc(aiPrompts.updatedAt));
  }

  async getAiPrompt(id: number): Promise<AiPrompt | undefined> {
    const [prompt] = await db.select().from(aiPrompts).where(eq(aiPrompts.id, id));
    return prompt || undefined;
  }

  async getActiveAiPrompt(name: string): Promise<AiPrompt | undefined> {
    const [prompt] = await db
      .select()
      .from(aiPrompts)
      .where(eq(aiPrompts.name, name));
    return prompt?.isActive ? prompt : undefined;
  }

  async createAiPrompt(prompt: InsertAiPrompt): Promise<AiPrompt> {
    const [newPrompt] = await db
      .insert(aiPrompts)
      .values(prompt)
      .returning();
    return newPrompt;
  }

  async updateAiPrompt(id: number, updates: Partial<AiPrompt>): Promise<AiPrompt | undefined> {
    const [prompt] = await db
      .update(aiPrompts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(aiPrompts.id, id))
      .returning();
    return prompt || undefined;
  }

  async deleteAiPrompt(id: number): Promise<boolean> {
    const result = await db.delete(aiPrompts).where(eq(aiPrompts.id, id));
    return true;
  }

  // Summaries
  async getSummaries(): Promise<Summary[]> {
    return await db.select().from(summaries).orderBy(desc(summaries.createdAt));
  }

  async getLatestSummary(): Promise<Summary | undefined> {
    const [summary] = await db
      .select()
      .from(summaries)
      .orderBy(desc(summaries.createdAt))
      .limit(1);
    return summary || undefined;
  }

  async createSummary(summary: InsertSummary): Promise<Summary> {
    const [newSummary] = await db
      .insert(summaries)
      .values(summary)
      .returning();
    return newSummary;
  }
}

export const storage = new DatabaseStorage();
