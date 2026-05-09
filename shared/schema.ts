import { pgTable, text, serial, timestamp, integer, boolean, jsonb, vector } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  type: text("type").notNull(), // 'text', 'image', 'audio', 'document'
  sender: text("sender").notNull(), // 'user', 'ai', 'system'
  excludeFromContext: boolean("exclude_from_context").default(false).notNull(), // Не включать в контекст AI
  fileUrl: text("file_url"),
  fileName: text("file_name"),
  fileSize: integer("file_size"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  status: text("status").default("sent").notNull(), // 'sent', 'delivered', 'error'
});

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title"),
  lastMessage: text("last_message"),
  lastMessageTime: timestamp("last_message_time").defaultNow().notNull(),
  isActive: boolean("is_active").default(true).notNull(),
});

export const appSettings = pgTable("app_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  timestamp: true,
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  lastMessageTime: true,
});

export const insertAppSettingsSchema = createInsertSchema(appSettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type Conversation = typeof conversations.$inferSelect;
export type InsertAppSettings = z.infer<typeof insertAppSettingsSchema>;
export type AppSettings = typeof appSettings.$inferSelect;

// AI Prompts table for storing system prompts
export const aiPrompts = pgTable("ai_prompts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  content: text("content").notNull(),
  description: text("description"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAiPromptSchema = createInsertSchema(aiPrompts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAiPrompt = z.infer<typeof insertAiPromptSchema>;
export type AiPrompt = typeof aiPrompts.$inferSelect;

// Summaries table for storing conversation summaries
export const summaries = pgTable("summaries", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  messageCount: integer("message_count").notNull(),
  startMessageId: integer("start_message_id"),
  endMessageId: integer("end_message_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSummarySchema = createInsertSchema(summaries).omit({
  id: true,
  createdAt: true,
});

export type InsertSummary = z.infer<typeof insertSummarySchema>;
export type Summary = typeof summaries.$inferSelect;

// ============================================================================
// Memory System - Система семантической памяти
// ============================================================================

// Динамическое дерево тем
export const topics = pgTable("topics", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  parentId: integer("parent_id"),
  embedding: text("embedding"), // JSON-строка вектора - legacy
  embeddingVector: vector("embedding_vector", { dimensions: 1536 }), // pgvector (native) - для быстрого поиска
  factCount: integer("fact_count").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Факты о пользователе и бизнесе
export const facts = pgTable("facts", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id").notNull(),
  content: text("content").notNull(),
  embedding: text("embedding"), // JSON-строка вектора - legacy
  embeddingVector: vector("embedding_vector", { dimensions: 1536 }), // pgvector (native) - для быстрого поиска
  confidence: text("confidence").default("medium").notNull(), // "high", "medium", "low"
  version: integer("version").default(1).notNull(),
  isCurrent: boolean("is_current").default(true).notNull(),
  sourceMessageId: integer("source_message_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Связи между фактами
export const factRelations = pgTable("fact_relations", {
  id: serial("id").primaryKey(),
  sourceFactId: integer("source_fact_id").notNull(),
  targetFactId: integer("target_fact_id").notNull(),
  relationType: text("relation_type").notNull(), // "contradicts", "supports", "relates_to"
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Сводки по темам
export const topicSummaries = pgTable("topic_summaries", {
  id: serial("id").primaryKey(),
  topicId: integer("topic_id").notNull(),
  summary: text("summary").notNull(),
  factIds: jsonb("fact_ids").$type<number[]>(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Профиль пользователя
export const userProfile = pgTable("user_profile", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  // Categories: personality, values, ambitions (core)
  //             cognitive_patterns, strengths, weaknesses, expertise, emotional_triggers, communication (dynamic)
  category: text("category"),
  previousValue: text("previous_value"),           // Предыдущее значение (для аудита)
  version: integer("version").default(1).notNull(), // Счётчик версий
  updatedBy: text("updated_by").default("agent"),   // "agent" | "background" | "manual" | "profile_from_facts" | "synthesis"
  embedding: text("embedding"),                     // JSON-строка вектора ключа+значения
  embeddingVector: vector("embedding_vector", { dimensions: 1536 }),        // pgvector (native) для семантического поиска
  isCurrent: boolean("is_current").default(true).notNull(), // false = archived (synthesized out)
  stabilityLevel: text("stability_level").default("dynamic").notNull(), // "core" | "dynamic"
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Цели пользователя — система «Живые цели»
export const goals = pgTable("goals", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  smartDescription: text("smart_description"),                        // SMART-формулировка цели
  category: text("category"),                                         // "business", "personal", "financial", "health"
  priority: text("priority").default("medium"),                       // "focus", "high", "medium", "low", "someday"
  parentGoalId: integer("parent_goal_id"),                            // Для иерархии подцелей
  reviewFrequency: text("review_frequency").default("weekly"),        // "daily", "weekly", "monthly"
  targetReviewDate: timestamp("target_review_date"),                  // Дата следующего обзора
  deadline: timestamp("deadline"),
  status: text("status").default("active").notNull(),                 // "active", "completed", "abandoned", "paused", "deferred"
  progress: integer("progress").default(0).notNull(),                 // 0-100%
  embedding: text("embedding"),                                       // JSON-строка вектора - legacy
  embeddingVector: vector("embedding_vector", { dimensions: 1536 }),                          // pgvector (native) - для быстрого поиска
  syncTag: text("sync_tag"),                                          // Тег для синхронизации с TickTick (например, "goal_marathon")
  resumeDate: timestamp("resume_date"),                                // Дата автоматического возврата из deferred в active
  blockedReason: text("blocked_reason"),                               // Причина блокировки (для status=paused)
  blockedByGoalId: integer("blocked_by_goal_id"),                     // ID цели-блокера (для автоматического разблокирования)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Goal Key Results — измеримые метрики цели
export const goalKeyResults = pgTable("goal_key_results", {
  id: serial("id").primaryKey(),
  goalId: integer("goal_id").notNull(),
  title: text("title").notNull(),                       // "Привлечь 50 новых клиентов"
  metric: text("metric"),                               // "клиенты"
  targetValue: integer("target_value"),                 // 50
  currentValue: integer("current_value").default(0),    // 12
  unit: text("unit"),                                   // "шт", "руб", "%"
  autoQuery: text("auto_query"),                        // SQL/метод для автоматического обновления
  status: text("status").default("active").notNull(),   // "active", "completed", "abandoned"
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Goal Milestones — вехи цели
export const goalMilestones = pgTable("goal_milestones", {
  id: serial("id").primaryKey(),
  goalId: integer("goal_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").default(0).notNull(),
  weight: integer("weight").default(1).notNull(),              // Вес для взвешенного прогресса (1-10)
  deadline: timestamp("deadline"),
  status: text("status").default("pending").notNull(),   // "pending", "in_progress", "completed"
  completedAt: timestamp("completed_at"),
  progress: integer("progress").default(0).notNull(),           // Прогресс вехи (0-100%)
  syncTag: text("sync_tag"),                                          // Тег для синхронизации вехи с TickTick
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Goal Tasks — задачи внутри milestones
export const goalTasks = pgTable("goal_tasks", {
  id: serial("id").primaryKey(),
  milestoneId: integer("milestone_id").notNull(),
  goalId: integer("goal_id").notNull(),                  // Денормализация для быстрых запросов
  title: text("title").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").default(0).notNull(),
  status: text("status").default("todo").notNull(),      // "todo", "in_progress", "done", "skipped"
  priority: text("priority").default("medium"),          // "high", "medium", "low"
  dueDate: timestamp("due_date"),
  completedAt: timestamp("completed_at"),
  ticktickTaskId: text("ticktick_task_id"),                          // Прямая ссылка на ID в TickTick
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Goal Activity Log — журнал активности
export const goalActivityLog = pgTable("goal_activity_log", {
  id: serial("id").primaryKey(),
  goalId: integer("goal_id").notNull(),
  activityType: text("activity_type").notNull(),         // "progress_update", "task_completed", "note", "review", "milestone_reached"
  description: text("description").notNull(),
  metadata: jsonb("metadata").$type<Record<string, any>>(), // {oldProgress: 20, newProgress: 35}
  sourceMessageId: integer("source_message_id"),         // Связь с разговором
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Tool Call Logs — Логирование вызовов инструментов AI агентами
export const toolCallLogs = pgTable("tool_call_logs", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id"),
  messageId: integer("message_id"),
  agentSlug: text("agent_slug").notNull(),
  toolName: text("tool_name").notNull(),
  input: jsonb("input").notNull().$type<unknown>(),
  success: boolean("success").notNull(),
  resultData: jsonb("result_data").$type<unknown>(),
  error: text("error"),
  displayText: text("display_text"),
  durationMs: integer("duration_ms").default(0).notNull(),
  iteration: integer("iteration").default(1).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const ticktickTasks = pgTable("ticktick_tasks", {
  id: serial("id").primaryKey(),
  taskId: text("task_id").notNull().unique(),
  projectId: text("project_id").notNull(),
  parentId: text("parent_id"),
  title: text("title").notNull(),
  content: text("content"),
  priority: integer("priority").default(0).notNull(),
  status: integer("status").default(0).notNull(),
  dueDate: timestamp("due_date"),
  tags: jsonb("tags").$type<string[]>().default([]).notNull(),
  items: jsonb("items").$type<any[]>().default([]).notNull(),
  embedding: text("embedding"),
  embeddingVector: vector("embedding_vector", { dimensions: 1536 }),
  lastModified: timestamp("last_modified"),
  syncedAt: timestamp("synced_at").defaultNow().notNull(),
});

// LLM Call Logs — Логирование всех вызовов языковых моделей
export const llmCallLogs = pgTable("llm_call_logs", {
  id: serial("id").primaryKey(),
  taskType: text("task_type").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  messages: jsonb("messages").notNull().$type<any[]>(),
  response: text("response"),
  error: text("error"),
  durationMs: integer("duration_ms").default(0).notNull(),
  tokensUsed: integer("tokens_used").default(0),
  cachedTokensUsed: integer("cached_tokens_used").default(0),
  status: text("status").notNull(), // 'success', 'error', 'empty'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertLlmCallLogSchema = createInsertSchema(llmCallLogs).omit({
  id: true,
  createdAt: true,
});

export type InsertLlmCallLog = z.infer<typeof insertLlmCallLogSchema>;
export type LlmCallLog = typeof llmCallLogs.$inferSelect;


// ============================================================================
// Knowledge Graph - Граф знаний (гибридная архитектура)
// ============================================================================

// Сущности (люди, компании, проекты, продукты и т.д.)
// Гибридный подход: baseType (для UI) + subType (AI-генерируемый)
export const entities = pgTable("entities", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),                                      // "Илон Маск", "ООО Рога и Копыта"

  // Базовый тип (для фильтрации в UI) — ограниченный набор
  baseType: text("base_type").notNull(),                             // "person", "organization", "concept", "artifact", "event"

  // AI-генерируемый подтип (свободная строка) — неограничен
  subType: text("sub_type"),                                         // "инвестор", "SaaS-продукт", "конкурент", "ментор"

  // Роль сущности в графе знаний (для v2)
  role: text("role"),                                                // "owner", "person", "tool", "project", "goal", "problem", "fear", "habit"

  description: text("description"),                                  // Краткое описание
  embedding: text("embedding"),                                      // Векторное представление (JSON) - legacy
  embeddingVector: vector("embedding_vector", { dimensions: 1536 }),                         // pgvector (native) - для быстрого поиска
  metadata: jsonb("metadata").$type<Record<string, any>>(),          // Дополнительные данные: {role: "CEO", salary: 100000}

  // Для кластеризации похожих сущностей
  clusterId: integer("cluster_id"),                                  // Группа похожих сущностей (заполняется при нормализации)

  sourceFactId: integer("source_fact_id"),                           // Откуда извлечена сущность
  confidence: text("confidence").default("medium").notNull(),        // "high", "medium", "low"
  mentionCount: integer("mention_count").default(1).notNull(),       // Сколько раз упоминалась (для важности)
  lastMentioned: timestamp("last_mentioned").defaultNow().notNull(), // Когда последний раз упоминалась
  isActive: boolean("is_active").default(true).notNull(),            // Для мягкого удаления
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});





// Смысловые связи (триплеты) — Knowledge Graph v2
// Subject → relationType → Object с атрибутами и контекстом
export const knowledgeRelations = pgTable("knowledge_relations", {
  id: serial("id").primaryKey(),

  // Триплет: Subject → Relation → Object
  subjectId: integer("subject_id").notNull(),                    // Исходная сущность (часто owner)
  relationType: text("relation_type").notNull(),                 // "планирует_купить", "использует", "работает_над"
  objectId: integer("object_id").notNull(),                      // Целевая сущность

  // Категория связи (для группировки в UI)
  relationCategory: text("relation_category"),                   // "goals", "tools", "projects", "people", "problems"

  // Атрибуты связи (контекст хранится здесь, не на сущности!)
  attributes: jsonb("attributes").$type<Record<string, string>>(), // {бюджет: "500к", дедлайн: "1 мая"}

  // Контекст — откуда и почему создана связь
  context: text("context"),                                      // "Обсуждали цели на 2026 год"

  // Провенанс
  sourceFactId: integer("source_fact_id"),                       // Ссылка на исходный факт
  sourceMessageId: integer("source_message_id"),                 // Или на сообщение

  // Семантика
  importance: text("importance").default("normal").notNull(),    // "critical", "normal", "detail"
  confidence: text("confidence").default("medium").notNull(),    // "high", "medium", "low"

  // Версионирование  
  validFrom: timestamp("valid_from").defaultNow().notNull(),
  validUntil: timestamp("valid_until"),                          // NULL = актуально

  // Метаданные
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================================
// Multi-Agent System - Мульти-агентная система
// ============================================================================

// Конфигурация агентов
export const agents = pgTable("agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),              // "Бизнес-консультант"
  slug: text("slug").notNull().unique(),     // "business"
  description: text("description"),          // Краткое описание агента
  systemPrompt: text("system_prompt").notNull(),
  triggerKeywords: text("trigger_keywords"), // JSON: ["тариф", "SaaS", "клиенты"]
  relatedTopics: text("related_topics"),     // JSON: ["Бизнес/*"]
  isActive: boolean("is_active").default(true).notNull(),
  priority: integer("priority").default(0).notNull(), // выше = приоритетнее
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================================
// AI Model Configurations — Централизованная конфигурация моделей
// ============================================================================

export const aiModelConfigs = pgTable("ai_model_configs", {
  id: serial("id").primaryKey(),
  taskType: text("task_type").notNull().unique(), // "goal_extraction", "fact_extraction", "routing" и т.д.
  provider: text("provider").notNull(),            // "openai", "deepseek", "openrouter", "custom"
  model: text("model").notNull(),                  // "gpt-4o-mini", "openai/o3-mini" и т.д.
  systemPrompt: text("system_prompt"),             // Опциональный кастомный промпт
  temperature: text("temperature").default("0.3"), // Параметр креативности (строка для гибкости)
  maxTokens: integer("max_tokens").default(500),
  contextWindow: integer("context_window"),        // Размер контекстного окна (токены). null = автоопределение (32K дефолт)
  reasoningEffort: text("reasoning_effort"),       // "low" | "medium" | "high" | null (для моделей с thinking)
  isActive: boolean("is_active").default(true).notNull(),
  description: text("description"),                // Описание для UI
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================================
// User Preferences — Автоматическое накопление предпочтений пользователя
// ============================================================================

/**
 * Предпочтения пользователя — автоматически извлекаемые паттерны поведения.
 * В отличие от userProfile (декларативные факты: "живёт в Москве"),
 * preferences — это стилевые и поведенческие паттерны:
 * "любит краткие ответы", "предпочитает metric-first подход".
 */
export const userPreferences = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),              // "response_style", "analysis_depth", "language_formality"
  value: text("value").notNull(),                   // "краткий и по делу", "deep_with_metrics"
  category: text("category"),                       // "communication", "analysis", "workflow", "formatting"
  confidence: integer("confidence").default(50).notNull(), // 0-100, растёт с каждым подтверждением
  mentionCount: integer("mention_count").default(1).notNull(), // Сколько раз подтверждено
  source: text("source").default("auto"),            // "auto" | "explicit" | "inferred"
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Контекст текущей сессии
export const sessionContext = pgTable("session_context", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  currentTopics: text("current_topics"),         // JSON: ["Бизнес/Тарифы"]
  mood: text("mood"),                            // "neutral", "stressed", "excited"
  activeAgentSlug: text("active_agent_slug"),    // Текущий активный агент
  openQuestions: text("open_questions"),         // JSON: ["Какой у вас бюджет?"]
  mentionedEntities: text("mentioned_entities"), // JSON: {"company": "ООО Рога"}
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Insert schemas для Memory System
export const insertTopicSchema = createInsertSchema(topics).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertFactSchema = createInsertSchema(facts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertFactRelationSchema = createInsertSchema(factRelations).omit({
  id: true,
  createdAt: true,
});

export const insertTopicSummarySchema = createInsertSchema(topicSummaries).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserProfileSchema = createInsertSchema(userProfile).omit({
  id: true,
  updatedAt: true,
});

export const insertGoalSchema = createInsertSchema(goals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Insert schemas для Goal System
export const insertGoalKeyResultSchema = createInsertSchema(goalKeyResults).omit({ id: true, createdAt: true, updatedAt: true });
export const insertGoalMilestoneSchema = createInsertSchema(goalMilestones).omit({ id: true, createdAt: true, updatedAt: true });
export const insertGoalTaskSchema = createInsertSchema(goalTasks).omit({ id: true, createdAt: true, updatedAt: true });
export const insertGoalActivityLogSchema = createInsertSchema(goalActivityLog).omit({ id: true, createdAt: true });

// Insert schemas для Knowledge Graph
export const insertEntitySchema = createInsertSchema(entities).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});



// Types для Memory System
export type InsertTopic = z.infer<typeof insertTopicSchema>;
export type Topic = typeof topics.$inferSelect;
export type InsertFact = z.infer<typeof insertFactSchema>;
export type Fact = typeof facts.$inferSelect;
export type InsertFactRelation = z.infer<typeof insertFactRelationSchema>;
export type FactRelation = typeof factRelations.$inferSelect;
export type InsertTopicSummary = z.infer<typeof insertTopicSummarySchema>;
export type TopicSummary = typeof topicSummaries.$inferSelect;
export type InsertUserProfile = z.infer<typeof insertUserProfileSchema>;
export type UserProfile = typeof userProfile.$inferSelect;
export type InsertGoal = z.infer<typeof insertGoalSchema>;
export type Goal = typeof goals.$inferSelect;

// Types для Goal System
export type InsertGoalKeyResult = z.infer<typeof insertGoalKeyResultSchema>;
export type GoalKeyResult = typeof goalKeyResults.$inferSelect;
export type InsertGoalMilestone = z.infer<typeof insertGoalMilestoneSchema>;
export type GoalMilestone = typeof goalMilestones.$inferSelect;
export type InsertGoalTask = z.infer<typeof insertGoalTaskSchema>;
export type GoalTask = typeof goalTasks.$inferSelect;
export type InsertGoalActivityLog = z.infer<typeof insertGoalActivityLogSchema>;
export type GoalActivityLog = typeof goalActivityLog.$inferSelect;

export type GoalStatus = 'active' | 'completed' | 'abandoned' | 'paused' | 'deferred';
export type GoalCategory = 'business' | 'personal' | 'financial' | 'health' | 'career' | 'lifestyle';
export type GoalPriority = 'focus' | 'high' | 'medium' | 'low' | 'someday';
export type GoalReviewFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';
export type MilestoneStatus = 'pending' | 'in_progress' | 'completed';
export type GoalTaskStatus = 'todo' | 'in_progress' | 'done' | 'skipped';
export type GoalActivityType = 'progress_update' | 'task_completed' | 'note' | 'review' | 'milestone_reached' | 'status_change';

// Types для Knowledge Graph
export type InsertEntity = z.infer<typeof insertEntitySchema>;
export type Entity = typeof entities.$inferSelect;


// Типы для атрибутов сущностей
export type AttributeValueType = 'text' | 'number' | 'date' | 'boolean' | 'json';
export type AttributeImportance = 'critical' | 'normal' | 'detail';

// ============================================================================
// Гибридные типы для Knowledge Graph
// ============================================================================

// Базовые типы сущностей (ограниченный набор для UI)
export type BaseEntityType =
  | 'person'        // Люди: сотрудники, клиенты, партнёры, знакомые
  | 'organization'  // Организации: компании, команды, сообщества
  | 'concept'       // Концепции: идеи, навыки, ценности, цели
  | 'artifact'      // Артефакты: продукты, документы, проекты
  | 'event'         // События: встречи, дедлайны, вехи
  | 'location'      // Места: города, офисы, страны
  | 'other';        // Прочее: когда ничего не подходит

// Категории связей (ограниченный набор для UI группировки)
export type RelationCategory =
  | 'ownership'     // Владение: владеет, создал, основал
  | 'employment'    // Работа: работает в, управляет, подчиняется
  | 'social'        // Социальные: знает, дружит, конкурирует
  | 'temporal'      // Временные: предшествует, следует за, происходит во время
  | 'semantic'      // Семантические: связано с, является частью, похоже на
  | 'action';       // Действия: использует, инвестирует, покупает

// AI-генерируемые подтипы (примеры, не ограничены)
// subType: "инвестор", "ментор", "конкурент", "SaaS", "MVP", "стартап"...

// AI-генерируемые типы связей (примеры, не ограничены)
// relationType: "инвестировал в", "критикует", "вдохновил", "обучил"...

// Insert schemas для Multi-Agent System
export const insertAgentSchema = createInsertSchema(agents).omit({
  id: true,
  createdAt: true,
});

export const insertSessionContextSchema = createInsertSchema(sessionContext).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types для Multi-Agent System
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agents.$inferSelect;
export type InsertSessionContext = z.infer<typeof insertSessionContextSchema>;
export type SessionContext = typeof sessionContext.$inferSelect;

// ============================================================================
// Universal Agent — Expertise Registry (Реестр экспертиз)
// ============================================================================

/**
 * Экспертизы — динамические "роли" Core Agent.
 * Каждая экспертиза определяет prompt_template, набор tool_packs,
 * trigger-домены для matching и предпочтения контекста.
 */
export const expertises = pgTable("expertises", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),                      // "business", "finance", "psychology", "general"
  name: text("name").notNull(),                               // "Бизнес-консультант"
  promptTemplate: text("prompt_template").notNull(),           // Полный системный промпт экспертизы
  toolPacks: jsonb("tool_packs").$type<string[]>().default(["core"]).notNull(), // ["core", "business_metrics"]
  triggerDomains: jsonb("trigger_domains").$type<string[]>().default([]).notNull(), // ["business", "saas", "marketing"]
  contextPreferences: jsonb("context_preferences").$type<{
    loadGoals?: boolean;
    loadMetrics?: boolean;
    loadCompetitors?: boolean;
    factSearchDepth?: 'shallow' | 'deep';
    maxFacts?: number;
  }>().default({}),
  isActive: boolean("is_active").default(true).notNull(),
  priority: integer("priority").default(0).notNull(),          // выше = приоритетнее при matching
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Insert schema для Expertise Registry
export const insertExpertiseSchema = createInsertSchema(expertises).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types для Expertise Registry
export type InsertExpertise = z.infer<typeof insertExpertiseSchema>;
export type Expertise = typeof expertises.$inferSelect;

// Insert schema и types для AI Model Configs
export const insertAiModelConfigSchema = createInsertSchema(aiModelConfigs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAiModelConfig = z.infer<typeof insertAiModelConfigSchema>;
export type AiModelConfig = typeof aiModelConfigs.$inferSelect;
export type ReasoningEffort = 'low' | 'medium' | 'high';

// Insert schema и types для User Preferences
export const insertUserPreferenceSchema = createInsertSchema(userPreferences).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertUserPreference = z.infer<typeof insertUserPreferenceSchema>;
export type UserPreference = typeof userPreferences.$inferSelect;

// Типы задач для централизованного конфига
export type AITaskType =
  | 'goal_extraction'
  | 'fact_extraction'
  | 'fact_judge'           // AI-судья для дедупликации фактов
  | 'profile_judge'        // AI-судья для дедупликации профильных записей
  | 'profile_extraction'   // Инкрементальное извлечение профиля
  | 'profile_synthesis'    // Синтез (консолидация) профильных категорий
  | 'profile_analysis'
  | 'topic_detection'
  | 'topic_normalization'  // AI-нормализация категорий тем
  | 'entity_extraction'   // Извлечение сущностей для графа знаний
  | 'insight_analysis'    // AI-анализ инсайтов (противоречия, связи)
  | 'reminder_extraction' // Извлечение напоминаний из сообщений
  | 'query_planning'      // Планирование контекстных запросов
  | 'data_classification'  // Классификация типа данных в сообщении
  | 'data_ingestion'       // Парсинг данных для сохранения
  | 'ai_cron_extraction'   // Извлечение cron-задач из сообщений
  | 'ai_cron_execution'    // Выполнение cron-задач по расписанию
  | 'subagent_execution'   // Выполнение фоновых суб-агентов
  | 'proactive_check'      // Проактивные проверки (briefing, recap, smart checks)
  | 'event_handling'       // Обработка внешних событий (webhooks)
  | 'intent_classification' // Классификация интента (domain, intent, complexity)
  | 'intent_planning'      // Генерация плана для complexity: high
  | 'agent_core'           // Universal Agent: основная модель для генерации ответа
  | 'browser_agent'        // Веб-агент: бюджетная модель для browser_open/act/read задач
  | 'agent_final_answer'  // Model Cascade: дорогая модель для финального ответа
  | 'agent_reflection'    // Reflective Context Loop: рефлексия перед ответом
  | 'vision_analysis'     // Анализ изображений (Vision API)
  | 'preference_extraction' // Извлечение предпочтений из диалога
  | 'conversation_summary'
  | 'default';



// Провайдеры AI
export type AIProvider = 'openai' | 'deepseek' | 'openrouter' | 'custom' | 'antigravity';

// ============================================================================
// Proactive Agent - Память инсайтов
// ============================================================================

/**
 * Типы инсайтов для проактивного агента
 */
export type InsightType =
  | 'goal_deadline'       // Приближается дедлайн цели
  | 'goal_stalled'        // Нет прогресса по цели
  | 'graph_connection'    // Связь из графа знаний
  | 'fact_contradiction'  // Противоречие в фактах
  | 'fact_update'         // Факт обновился
  | 'pattern_detected'    // Обнаружен паттерн поведения
  | 'reminder';           // Общее напоминание

/**
 * Статус инсайта
 */
export type InsightStatus =
  | 'active'      // Активен, показывается с учётом cooldown
  | 'dismissed'   // Отложен пользователем
  | 'resolved'    // Решён (цель достигнута, противоречие разрешено)
  | 'expired';    // Больше не актуален

/**
 * Реакция пользователя на инсайт
 */
export type InsightReaction =
  | 'positive'    // Поблагодарил, развил тему
  | 'neutral'     // Нейтральная реакция
  | 'ignored'     // Проигнорировал
  | 'rejected';   // Отверг ("не об этом")

/**
 * Память инсайтов — для cooldown, persistence и обучения
 */
export const insightMemory = pgTable("insight_memory", {
  id: serial("id").primaryKey(),

  // Тип и связь
  insightType: text("insight_type").notNull().$type<InsightType>(),
  relatedEntityId: integer("related_entity_id"),        // ID связанной сущности/цели
  relatedEntityType: text("related_entity_type"),       // 'goal', 'entity', 'fact'
  contentHash: text("content_hash"),                    // Хеш контента для дедупликации

  // Текст инсайта
  content: text("content").notNull(),

  // Статус и управление
  status: text("status").default("active").notNull().$type<InsightStatus>(),
  persistenceLevel: integer("persistence_level").default(1).notNull(), // 1-4: мягкий → настойчивый

  // Cooldown и timing
  lastMentionedAt: timestamp("last_mentioned_at"),
  mentionCount: integer("mention_count").default(0).notNull(),
  nextRemindAt: timestamp("next_remind_at"),

  // Обратная связь
  userReaction: text("user_reaction").$type<InsightReaction>(),
  usefulnessScore: integer("usefulness_score").default(50), // 0-100, обучается

  // Причина откладывания
  dismissalReason: text("dismissal_reason"),

  // Метаданные
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Insert schema и types для Insight Memory
export const insertInsightMemorySchema = createInsertSchema(insightMemory).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertInsightMemory = z.infer<typeof insertInsightMemorySchema>;
export type InsightMemory = typeof insightMemory.$inferSelect;

// ============================================================================
// Proactive Messages — Логирование асинхронных напоминаний
// ============================================================================

/**
 * Типы проактивных сообщений
 */
export type ProactiveMessageType =
  | 'deadline_today'
  | 'deadline_soon'
  | 'morning_briefing'
  | 'evening_recap'
  | 'personal_reminder'
  | 'weekly_review'
  | 'strategic_advice';

/**
 * Таблица проактивных сообщений — для cooldown и логирования
 */
export const proactiveMessages = pgTable("proactive_messages", {
  id: serial("id").primaryKey(),

  // Тип и контент
  messageType: text("message_type").notNull().$type<ProactiveMessageType>(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  priority: text("priority").notNull().default("medium"), // high, medium, low

  // Связанная сущность
  relatedEntityId: integer("related_entity_id"),
  relatedEntityType: text("related_entity_type"), // goal, topic

  // Доставка
  delivered: boolean("delivered").default(false).notNull(),
  deliveredAt: timestamp("delivered_at"),

  // Реакция пользователя
  dismissed: boolean("dismissed").default(false).notNull(),
  dismissedAt: timestamp("dismissed_at"),
  clickedAction: boolean("clicked_action").default(false),

  // Метаданные
  sentAt: timestamp("sent_at").defaultNow().notNull(),
});

// Insert schema и types для Proactive Messages
export const insertProactiveMessageSchema = createInsertSchema(proactiveMessages).omit({
  id: true,
});

export type InsertProactiveMessage = z.infer<typeof insertProactiveMessageSchema>;
export type ProactiveMessage = typeof proactiveMessages.$inferSelect;

// ============================================================================
// Notification Settings — Настройки уведомлений
// ============================================================================

export const notificationSettings = pgTable("notification_settings", {
  id: serial("id").primaryKey(),

  // === Расписание ===
  morningBriefingHour: integer("morning_briefing_hour").default(9).notNull(),
  morningBriefingMinute: integer("morning_briefing_minute").default(0).notNull(),
  eveningRecapHour: integer("evening_recap_hour").default(21).notNull(),
  eveningRecapMinute: integer("evening_recap_minute").default(0).notNull(),
  checkIntervalMinutes: integer("check_interval_minutes").default(15).notNull(),
  maxDailyReminders: integer("max_daily_reminders").default(5).notNull(),
  cooldownHours: integer("cooldown_hours").default(4).notNull(),

  // === Типы уведомлений ===
  enableMorningBriefing: boolean("enable_morning_briefing").default(true).notNull(),
  enableEveningRecap: boolean("enable_evening_recap").default(true).notNull(),
  enableDeadlineAlerts: boolean("enable_deadline_alerts").default(true).notNull(),
  enableGoalReminders: boolean("enable_goal_reminders").default(true).notNull(),
  enableTopicReminders: boolean("enable_topic_reminders").default(true).notNull(),
  goalStalledDays: integer("goal_stalled_days").default(14).notNull(),
  topicAbandonedDays: integer("topic_abandoned_days").default(21).notNull(),

  // === Telegram ===
  telegramEnabled: boolean("telegram_enabled").default(false).notNull(),
  telegramBotToken: text("telegram_bot_token"),
  telegramChatId: text("telegram_chat_id"),

  // === Тихие часы ===
  quietHoursEnabled: boolean("quiet_hours_enabled").default(false).notNull(),
  quietHoursStart: integer("quiet_hours_start").default(22).notNull(),
  quietHoursEnd: integer("quiet_hours_end").default(8).notNull(),
  quietHoursWeekendOnly: boolean("quiet_hours_weekend_only").default(false).notNull(),

  // === Браузер ===
  browserPushEnabled: boolean("browser_push_enabled").default(true).notNull(),
  browserSoundEnabled: boolean("browser_sound_enabled").default(true).notNull(),
  browserSoundType: text("browser_sound_type").default("soft").notNull(),

  // Метаданные
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertNotificationSettingsSchema = createInsertSchema(notificationSettings).omit({
  id: true,
  updatedAt: true,
});

export type InsertNotificationSettings = z.infer<typeof insertNotificationSettingsSchema>;
export type NotificationSettings = typeof notificationSettings.$inferSelect;

// ============================================================================
// Reminders — Персональные напоминания
// ============================================================================

export const reminders = pgTable("reminders", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  remindAt: timestamp("remind_at").notNull(),
  status: text("status").notNull().default("pending"), // pending | sent | snoozed | cancelled
  priority: text("priority").default("medium"), // low | medium | high
  sourceMessageId: integer("source_message_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  sentAt: timestamp("sent_at"),
});

export const insertReminderSchema = createInsertSchema(reminders).omit({
  id: true,
  createdAt: true,
  sentAt: true,
});

export type InsertReminder = z.infer<typeof insertReminderSchema>;
export type Reminder = typeof reminders.$inferSelect;

// ============================================================================
// AI Scheduled Tasks — ИИ-управляемые периодические задачи (Cron)
// ============================================================================

/**
 * Задачи, создаваемые AI по запросу пользователя.
 * Повторяются по cron-расписанию, при срабатывании AI выполняет prompt.
 */
export const aiScheduledTasks = pgTable("ai_scheduled_tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),                    // "Проверить метрики"
  prompt: text("prompt").notNull(),                  // Промпт для AI при срабатывании
  cronExpression: text("cron_expression").notNull(), // "0 9 * * *"
  timezone: text("timezone").default("Europe/Moscow").notNull(),
  status: text("status").default("active").notNull(), // active | paused | cancelled | error_paused
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),
  runCount: integer("run_count").default(0).notNull(),
  maxRuns: integer("max_runs"),                      // null = бесконечно
  createdByAi: boolean("created_by_ai").default(true).notNull(),
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  // Backoff (Этап 2 OpenClaw)
  consecutiveErrors: integer("consecutive_errors").default(0).notNull(),
  lastErrorAt: timestamp("last_error_at"),
  backoffUntil: timestamp("backoff_until"),           // null = нет backoff
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAiScheduledTaskSchema = createInsertSchema(aiScheduledTasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAiScheduledTask = z.infer<typeof insertAiScheduledTaskSchema>;
export type AiScheduledTask = typeof aiScheduledTasks.$inferSelect;

// ============================================================================
// Cron Execution Log — Журнал выполнений cron-задач
// ============================================================================

/**
 * Журнал каждого запуска cron-задачи.
 * Хранит статус, ответ AI, использованный агент, tool calls, длительность.
 */
export const cronExecutionLog = pgTable("cron_execution_log", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id").notNull(),                    // FK → ai_scheduled_tasks.id
  status: text("status").notNull(),                         // "success" | "error" | "timeout"
  response: text("response"),                               // Полный ответ AI
  agentUsed: text("agent_used"),                            // Экспертиза/агент (slug)
  agentName: text("agent_name"),                            // Человекочитаемое имя агента
  tokensUsed: integer("tokens_used").default(0),
  toolCalls: jsonb("tool_calls").$type<Array<{ toolName: string; success: boolean; durationMs: number }>>(),
  durationMs: integer("duration_ms"),                       // Время выполнения (мс)
  error: text("error"),                                     // Текст ошибки (если status=error)
  executedAt: timestamp("executed_at").defaultNow().notNull(),
});

export const insertCronExecutionLogSchema = createInsertSchema(cronExecutionLog).omit({
  id: true,
});

export type InsertCronExecutionLog = z.infer<typeof insertCronExecutionLogSchema>;
export type CronExecutionLog = typeof cronExecutionLog.$inferSelect;

// ============================================================================
// Subagent Runs — Фоновые AI-задачи (суб-агенты)
// ============================================================================

/**
 * Запуски суб-агентов — фоновые AI-задачи, делегированные основным агентом.
 * Выполняются асинхронно, результат доставляется через WebSocket.
 */
export const subagentRuns = pgTable("subagent_runs", {
  id: serial("id").primaryKey(),
  parentMessageId: integer("parent_message_id").notNull(), // Сообщение, инициировавшее запуск
  taskType: text("task_type").notNull(),                   // deep_analysis | research | content_creation | planning | custom
  taskPrompt: text("task_prompt").notNull(),               // Промпт для суб-агента
  systemPrompt: text("system_prompt"),                     // Специализированный системный промпт
  status: text("status").default("pending").notNull(),      // pending | running | completed | failed | cancelled
  result: text("result"),                                  // Результат выполнения
  error: text("error"),                                    // Текст ошибки (если failed)
  durationMs: integer("duration_ms"),                      // Время выполнения
  tokensUsed: integer("tokens_used"),                      // Потраченные токены
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSubagentRunSchema = createInsertSchema(subagentRuns).omit({
  id: true,
  createdAt: true,
});

export type InsertSubagentRun = z.infer<typeof insertSubagentRunSchema>;
export type SubagentRun = typeof subagentRuns.$inferSelect;

// ============================================================================
// Push Subscriptions — Web Push уведомления
// ============================================================================

export const pushSubscriptions = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type PushSubscription = typeof pushSubscriptions.$inferSelect;

// ============================================================================
// Skills — Модульные навыки AI-ассистента
// ============================================================================

/**
 * Навыки — Markdown-инструкции, динамически подключаемые к промпту AI.
 * Встроенные навыки создаются при seed, пользовательские — через UI.
 */
export const skills = pgTable("skills", {
  id: serial("id").primaryKey(),
  slug: text("slug").notNull().unique(),              // url-friendly идентификатор
  name: text("name").notNull(),                       // "Анализ Avito"
  description: text("description").notNull(),         // Краткое описание для UI и AI
  content: text("content").notNull(),                 // Markdown-инструкции для AI
  category: text("category").notNull().default("custom"), // business | analytics | coaching | custom
  isBuiltin: boolean("is_builtin").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(), // Включен по умолчанию
  triggerKeywords: jsonb("trigger_keywords").$type<string[]>().default([]).notNull(), // Ключевые слова
  icon: text("icon").default("🧩"),                   // Emoji-иконка
  embedding: text("embedding"),                        // JSON-сериализованный embedding вектор для semantic matching
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Пользовательские настройки навыков — переопределение isActive
 */
export const userSkillSettings = pgTable("user_skill_settings", {
  id: serial("id").primaryKey(),
  skillId: integer("skill_id").notNull(),
  isEnabled: boolean("is_enabled").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Insert schemas для Skills
export const insertSkillSchema = createInsertSchema(skills).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertUserSkillSettingSchema = createInsertSchema(userSkillSettings).omit({
  id: true,
  updatedAt: true,
});

// Types для Skills
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type Skill = typeof skills.$inferSelect;
export type InsertUserSkillSetting = z.infer<typeof insertUserSkillSettingSchema>;
export type UserSkillSetting = typeof userSkillSettings.$inferSelect;

// ============================================================================
// Processing Timeline — Визуализация workflow обработки сообщений
// ============================================================================

/**
 * Статус шага обработки
 */
export type ProcessingStepStatus = 'pending' | 'running' | 'completed' | 'error' | 'skipped';

/**
 * Выходные данные шага обработки
 */
export interface ProcessingStepOutput {
  summary: string;                    // Краткое описание результата для timeline
  data?: Record<string, any>;         // Полные данные для детального просмотра
  // Reasoning Chain fields
  thinking?: string;                  // Дословный текст мышления AI (перед tool calls)
  toolInput?: Record<string, any>;    // Аргументы tool call
  toolOutput?: string;                // Полный результат tool (без обрезки)
  iteration?: number;                 // Номер итерации ReAct Loop
  kind?: 'thinking' | 'tool_call' | 'model_cascade' | 'response_phase';    // Тип шага для reasoning chain UI
  phase?: 'reflection' | 'response';  // Фаза пайплайна — для разделения блоков мышления
}

/**
 * Шаг обработки сообщения — отправляется через WebSocket
 */
export interface ProcessingStep {
  type: 'processing_step';
  messageId: number;                  // ID сообщения пользователя
  stepId: string;                     // Уникальный ID шага: 'routing', 'context', 'insights', etc.
  stepName: string;                   // Человекочитаемое название: 'Маршрутизация'
  stepIcon: string;                   // Emoji для визуализации: '🧭'
  status: ProcessingStepStatus;
  duration?: number;                  // Время выполнения в ms
  output?: ProcessingStepOutput;
  error?: string;
  timestamp: string;
}

/**
 * Определение шага оркестратора
 */
export interface OrchestratorStepDef {
  id: string;
  name: string;
  icon: string;
}

/**
 * Все шаги оркестратора — типизированный объект
 */
export const ORCHESTRATOR_STEPS = {
  routing: { id: 'routing', name: 'Классификация интента', icon: '🎯' },
  planning: { id: 'planning', name: 'Планирование', icon: '📋' },
  context: { id: 'context', name: 'Сбор контекста', icon: '📚' },
  queryPlanning: { id: 'queryPlanning', name: 'Планирование запросов', icon: '🔍' },
  contextEnrich: { id: 'contextEnrich', name: 'Обогащение контекста', icon: '✨' },
  reflection: { id: 'reflection', name: 'Рефлексия контекста', icon: '🤔' },
  // insights, reminders, scheduledTasks, facts, goals, profile — 
  // теперь обрабатываются AI через tools в ReAct Loop
  knowledge: { id: 'knowledge', name: 'Извлечение знаний', icon: '🧠' },
  factExtraction: { id: 'factExtraction', name: 'Извлечение фактов', icon: '📝' },
  factJudge: { id: 'factJudge', name: 'AI-судья фактов', icon: '🧑‍⚖️' },
  profileUpdate: { id: 'profileUpdate', name: 'Обновление профиля', icon: '👤' },
  preferenceExtraction: { id: 'preferenceExtraction', name: 'Извлечение предпочтений', icon: '⚙️' },
  response: { id: 'response', name: 'Генерация ответа', icon: '🤖' },
} as const;

export type OrchestratorStepId = keyof typeof ORCHESTRATOR_STEPS;

/**
 * Иконки для tool calls в Processing Timeline
 */
export const TOOL_ICONS: Record<string, string> = {
  search_facts: '🔍',
  search_knowledge: '🔍',
  search_documents: '📄',
  remember_fact: '💾',
  get_goals: '🎯',
  update_goal: '🎯',
  create_goal: '🎯',
  create_reminder: '⏰',
  get_recent_messages: '💬',
  update_profile: '👤',
  get_metrics: '📊',
  save_document: '📝',
  schedule_task: '📅',
  list_scheduled_tasks: '📅',
  delete_scheduled_task: '🗑️',
  update_scheduled_task: '📅',
  delegate_task: '🤖',
  create_skill: '🧩',
  get_skills: '🔍',
  update_skill: '🧩',
  delete_skill: '🗑️',
  web_search: '🌐',
  // Goal System v2 — «Живые цели»
  refine_goal: '🎯',
  complete_task: '✅',
  add_milestone: '📌',
  log_goal_activity: '📝',
  set_goal_focus: '🔥',
  review_goals: '📊',
  merge_goals: '🔀',
  update_key_result: '📈',
  get_goal_details: '🎯',
  // Notes System
  get_notes: '📝',
  get_note_detail: '📝',
  search_notes: '🔍',
  create_note: '📝',
  update_note: '📝',
  delete_note: '🗑️',
};

/**
 * Создаёт OrchestratorStepDef для tool call
 */
export function createToolCallStepDef(toolName: string, iteration: number, phase?: 'reflection' | 'response'): OrchestratorStepDef {
  const prefix = phase ? `${phase}_` : '';
  return {
    id: `${prefix}tool_${iteration}_${toolName}`,
    name: toolName,
    icon: TOOL_ICONS[toolName] || '🔧',
  };
}

// ============================================================================
// Workflow Logging — Сохранение полного workflow в БД
// ============================================================================

/**
 * Запись полного workflow обработки сообщения
 * Хранит все шаги, решения и данные для анализа и отладки
 */
export const messageProcessingRuns = pgTable("message_processing_runs", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull(),

  // Timing
  startedAt: timestamp("started_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  totalDurationMs: integer("total_duration_ms"),

  // Result
  status: text("status").default("running").notNull(), // 'running', 'completed', 'error'
  errorMessage: text("error_message"),

  // Full workflow data (JSONB for querying)
  steps: jsonb("steps").default([]).notNull(),

  // Summary for quick overview
  agentUsed: text("agent_used"),
  tokensUsed: integer("tokens_used"),
  factsCount: integer("facts_count"),
  contextSummary: jsonb("context_summary"),

  // Metadata
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertMessageProcessingRunSchema = createInsertSchema(messageProcessingRuns).omit({
  id: true,
  createdAt: true,
});

export type InsertMessageProcessingRun = z.infer<typeof insertMessageProcessingRunSchema>;
export type MessageProcessingRun = typeof messageProcessingRuns.$inferSelect;

/**
 * Структура шага для сохранения в БД (расширенная версия ProcessingStep)
 */
export interface ProcessingStepRecord {
  stepId: string;
  stepName: string;
  stepIcon: string;
  status: ProcessingStepStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  input?: Record<string, any>;  // Входные данные шага
  output?: ProcessingStepOutput;
  error?: string;
}

// ============================================================================
// Document Storage — Структурированное хранение документов
// ============================================================================

/**
 * Документы — полные тексты (отчёты, анализы, стратегии)
 * Хранятся целиком с AI-summary и embedding для семантического поиска
 */
export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  contentType: text("content_type").notNull(),    // 'markdown', 'plain_text', 'csv', 'report'
  documentType: text("document_type").notNull(),  // 'competitor_analysis', 'financial_report', 'strategy', 'general'
  summary: text("summary"),                       // AI-сгенерированное краткое описание
  embeddingVector: vector("embedding_vector", { dimensions: 1536 }),       // pgvector для семантического поиска
  metadata: jsonb("metadata").$type<Record<string, any>>(),
  sourceMessageId: integer("source_message_id"),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ============================================================================
// Competitor Registry — Реестр конкурентов
// ============================================================================

/**
 * Конкуренты — фиксированные поля + гибкие атрибуты
 */
export const competitors = pgTable("competitors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),           // url-safe идентификатор
  aliases: jsonb("aliases").$type<string[]>().default([]).notNull(), // Альтернативные написания (транскрипция)
  website: text("website"),
  summary: text("summary"),                        // AI-summary
  embeddingVector: vector("embedding_vector", { dimensions: 1536 }),
  isActive: boolean("is_active").default(true).notNull(),
  lastUpdated: timestamp("last_updated").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Гибкие атрибуты конкурентов — версионирование через validUntil
 * validUntil = NULL означает актуальный атрибут
 */
export const competitorAttributes = pgTable("competitor_attributes", {
  id: serial("id").primaryKey(),
  competitorId: integer("competitor_id").notNull(),
  key: text("key").notNull(),                      // "тариф_500", "технология", "плюсы"
  value: text("value").notNull(),                   // "2000 руб/мес"
  category: text("category"),                      // "pricing", "features", "technology"
  sourceDocumentId: integer("source_document_id"),
  validFrom: timestamp("valid_from").defaultNow().notNull(),
  validUntil: timestamp("valid_until"),             // NULL = актуально
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ============================================================================
// Metrics Tracker — Бизнес-метрики (снэпшоты)
// ============================================================================

/**
 * Снэпшоты бизнес-метрик — хранят пакет метрик за период
 * Автоматически рассчитываются `changes` при сохранении нового снэпшота
 */
export const metricSnapshots = pgTable("metric_snapshots", {
  id: serial("id").primaryKey(),
  period: text("period").notNull(),                 // "2026-01", "2026-01-15"
  periodType: text("period_type").notNull(),        // "monthly", "daily", "instant"
  metrics: jsonb("metrics").$type<Record<string, number | string>>().notNull(),
  rawContent: text("raw_content"),                  // Исходный текст для контекста
  changes: jsonb("changes").$type<Record<string, { prev: number; curr: number; delta: number; pct: number }>>(),
  summary: text("summary"),                        // AI-summary изменений
  sourceMessageId: integer("source_message_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Insert schemas для Document Storage
export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCompetitorSchema = createInsertSchema(competitors).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertCompetitorAttributeSchema = createInsertSchema(competitorAttributes).omit({
  id: true,
  createdAt: true,
});

export const insertMetricSnapshotSchema = createInsertSchema(metricSnapshots).omit({
  id: true,
  createdAt: true,
});

// Types для Document Storage
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;
export type InsertCompetitor = z.infer<typeof insertCompetitorSchema>;
export type Competitor = typeof competitors.$inferSelect;
export type InsertCompetitorAttribute = z.infer<typeof insertCompetitorAttributeSchema>;
export type CompetitorAttribute = typeof competitorAttributes.$inferSelect;
export type InsertMetricSnapshot = z.infer<typeof insertMetricSnapshotSchema>;
export type MetricSnapshot = typeof metricSnapshots.$inferSelect;

// Data classification types
export type DataClassificationType = 'competitor_info' | 'financial_metrics' | 'document' | 'none';

export interface DataClassification {
  hasStructuredData: boolean;
  dataType: DataClassificationType;
  confidence: number;
}

// ============================================================================
// Notes System — Универсальная система заметок
// ============================================================================

/**
 * Блок заметки — базовая единица контента.
 * type='text'  — текстовый параграф или markdown
 * type='check' — пункт чеклиста (с checked-состоянием)
 * 
 * Заметка может содержать блоки в любом порядке и количестве,
 * что позволяет смешивать текст и чеклисты в одной заметке.
 */
export interface NoteBlock {
  id: string;           // UUID для точного таргетинга
  type: 'text' | 'check';
  content: string;      // Для text: параграф текста; для check: текст пункта
  checked?: boolean;    // Только для type='check'
  addedAt: string;      // ISO timestamp
}

/** @deprecated Используйте NoteBlock вместо NoteItem */
export interface NoteItem {
  id: string;
  text: string;
  checked: boolean;
  addedAt: string;
}

/**
 * Заметки — универсальное хранилище записей пользователя.
 * 
 * type='note'     — пользовательская заметка (с блоками: текст + чеклисты)
 * type='document' — сохранённый внешний текст/отчёт (is_immutable=true)
 * 
 * Категоризация через теги: #покупки, #черновик, #документ, #финансы и т.д.
 */
export const notes = pgTable("notes", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type").notNull().default("note"),                            // 'note' | 'document'
  blocks: jsonb("blocks").$type<NoteBlock[]>().default([]),                // единый массив блоков контента
  content: text("content"),                                                // @deprecated — устаревшее поле, используйте blocks
  items: jsonb("items").$type<NoteItem[]>().default([]),                   // @deprecated — устаревшее поле, используйте blocks
  tags: jsonb("tags").$type<string[]>().default([]),                       // ['покупки', 'срочно', 'документ']
  isPinned: boolean("is_pinned").default(false).notNull(),
  isArchived: boolean("is_archived").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  isImmutable: boolean("is_immutable").default(false).notNull(),           // true для документов (нельзя редактировать блоки)
  sourceMessageId: integer("source_message_id"),
  sourceUrl: text("source_url"),                                           // для сохранённых веб-страниц
  embedding: text("embedding"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/** Типы заметок */
export type NoteType = 'note' | 'document';

// Insert schema для Notes
export const insertNoteSchema = createInsertSchema(notes).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Types для Notes
export type InsertNote = z.infer<typeof insertNoteSchema>;
export type Note = typeof notes.$inferSelect;

// TickTick Tasks Schema & Types
export const insertTicktickTaskSchema = createInsertSchema(ticktickTasks).omit({
  id: true,
  syncedAt: true,
});

export type InsertTicktickTask = z.infer<typeof insertTicktickTaskSchema>;
export type TicktickTaskRecord = typeof ticktickTasks.$inferSelect;

// ============================================================================
// Advisor Feedback — Обратная связь на стратегические советы
// ============================================================================

/**
 * Реакция пользователя на стратегический совет
 */
export type AdvisorReaction = 'discuss' | 'accepted' | 'not_now' | 'dismissed';

/**
 * Обратная связь на стратегические советы — для адаптации частоты и типа советов.
 * Feedback loop: advisorEngine загружает историю реакций перед генерацией новых советов.
 */
export const advisorFeedback = pgTable("advisor_feedback", {
  id: serial("id").primaryKey(),

  // Связь с проактивным сообщением (optional — совет мог быть из промпт-инъекции)
  proactiveMessageId: integer("proactive_message_id"),

  // Тип совета
  adviceType: text("advice_type").notNull(), // strategic_focus, balance_check, reevaluation, etc.
  adviceTitle: text("advice_title"),         // Заголовок совета для контекста
  adviceContent: text("advice_content"),     // Содержание совета

  // Реакция пользователя
  reaction: text("reaction").notNull().$type<AdvisorReaction>(),
  responseNotes: text("response_notes"),     // Необязательный комментарий

  // Метаданные для аналитики
  profileBasis: jsonb("profile_basis").$type<string[]>(),  // На каких аспектах профиля основан совет
  relatedGoalIds: jsonb("related_goal_ids").$type<number[]>(),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Insert schema и types для Advisor Feedback
export const insertAdvisorFeedbackSchema = createInsertSchema(advisorFeedback).omit({
  id: true,
  createdAt: true,
});

export type InsertAdvisorFeedback = z.infer<typeof insertAdvisorFeedbackSchema>;
export type AdvisorFeedback = typeof advisorFeedback.$inferSelect;

// ============================================================================
// Session Compactions — Сжатие длинных диалогов (Этап 3 OpenClaw)
// ============================================================================

/**
 * Хранит резюме сжатых частей диалога.
 * Оригинальные сообщения НЕ удаляются — помечаются excludeFromContext = true.
 * Summary вставляется как первый блок в контекст при сборке промпта.
 */
export const sessionCompactions = pgTable("session_compactions", {
  id: serial("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  summary: text("summary").notNull(),                           // LLM-сгенерированное резюме
  compactedMessageIds: jsonb("compacted_message_ids").$type<number[]>(), // ID помеченных сообщений
  originalTokens: integer("original_tokens"),                   // Оценка токенов до сжатия
  compactedTokens: integer("compacted_tokens"),                 // Оценка токенов после
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSessionCompactionSchema = createInsertSchema(sessionCompactions).omit({
  id: true,
  createdAt: true,
});

export type InsertSessionCompaction = z.infer<typeof insertSessionCompactionSchema>;
export type SessionCompaction = typeof sessionCompactions.$inferSelect;

