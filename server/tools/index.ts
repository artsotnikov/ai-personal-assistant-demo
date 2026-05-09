/**
 * Tool System — Точка входа
 * 
 * Инициализация builtin tools и hooks.
 * Экспорт основных компонентов.
 */

import { toolRegistry } from './toolRegistry';
import { loggingHook, validationHook } from './hooks';

// Builtin tools
import { createReminderTool } from './builtin/createReminder';
import { createGoalTool } from './builtin/createGoal';
import { searchFactsTool } from './builtin/searchFacts';
import { getMetricsTool } from './builtin/getMetrics';
import { createSkillTool } from './builtin/createSkill';
import { getSkillsTool } from './builtin/getSkills';
import { updateSkillTool } from './builtin/updateSkill';
import { deleteSkillTool } from './builtin/deleteSkill';
import { searchKnowledgeTool } from './builtin/searchKnowledge';
import { scheduleTaskTool } from './builtin/scheduleTask';
import { listScheduledTasksTool } from './builtin/listScheduledTasks';
import { deleteScheduledTaskTool } from './builtin/deleteScheduledTask';
import { updateScheduledTaskTool } from './builtin/updateScheduledTask';
import { delegateTaskTool } from './builtin/delegateTask';

// Новые tools (Этап 1a)
import { rememberFactTool } from './builtin/rememberFact';
import { getGoalsTool } from './builtin/getGoals';
import { updateGoalTool } from './builtin/updateGoal';

import { getRecentMessagesTool } from './builtin/getRecentMessages';
import { updateProfileTool } from './builtin/updateProfile';
import { webSearchTool } from './builtin/webSearch';
import { refineGoalTool } from './builtin/refineGoal';
import { completeTaskTool } from './builtin/completeTask';
import { addMilestoneTool } from './builtin/addMilestone';
import { logGoalActivityTool } from './builtin/logGoalActivity';
import { setGoalFocusTool } from './builtin/setGoalFocus';
// Goal System v2 — Фаза 3: Review и коучинг
import { reviewGoalsTool } from './builtin/reviewGoals';
import { mergeGoalsTool } from './builtin/mergeGoals';
import { updateKeyResultTool } from './builtin/updateKeyResult';
import { getGoalDetailsTool } from './builtin/getGoalDetails';
import { deleteGoalTool } from './builtin/deleteGoal';
import { searchMessagesTool } from './builtin/searchMessages';
// Notes System — Заметки, списки, чеклисты, черновики
import { createNoteTool } from './builtin/createNote';
import { updateNoteTool } from './builtin/updateNote';
import { deleteNoteTool } from './builtin/deleteNote';
import { getNotesTool } from './builtin/getNotes';
import { getNoteDetailTool } from './builtin/getNoteDetail';

import { searchNotesTool } from './builtin/searchNotes';
// Web Access — Perplexity Sonar + Jina Reader
import { perplexitySearchTool } from './builtin/perplexitySearch';
import { readWebPageTool } from './builtin/readWebPage';
// Web Browser — Scraper Service (remote browser)
import { browserOpenTool } from './builtin/browserOpen';
import { browserActTool } from './builtin/browserAct';
import { browserReadTool } from './builtin/browserRead';
import { browserProfilesTool } from './builtin/browserProfiles';
// Google Calendar (MCP)
import { calendarListEventsTool } from './builtin/calendarListEvents';
import { calendarCreateEventTool } from './builtin/calendarCreateEvent';
import { calendarUpdateEventTool } from './builtin/calendarUpdateEvent';
import { calendarDeleteEventTool } from './builtin/calendarDeleteEvent';
// TickTick — планировщик задач
import { ticktickGetProjectsTool } from './builtin/ticktickGetProjects';
import { ticktickGetTasksTool } from './builtin/ticktickGetTasks';
import { ticktickCreateTaskTool } from './builtin/ticktickCreateTask';
import { ticktickUpdateTaskTool } from './builtin/ticktickUpdateTask';
import { ticktickCompleteTaskTool } from './builtin/ticktickCompleteTask';
import { ticktickCreateProjectTool } from './builtin/ticktickCreateProject';
import { ticktickDeleteTaskTool } from './builtin/ticktickDeleteTask';
import { ticktickSearchTasksTool } from './builtin/ticktickSearchTasks';
import { ticktickAddChecklistItemTool } from './builtin/ticktickAddChecklistItem';
import { ticktickSmartUpdateTool } from './builtin/ticktickSmartUpdate';
import { ticktickSmartAddChecklistTool } from './builtin/ticktickSmartAddChecklist';
import { ticktickSmartCompleteTool } from './builtin/ticktickSmartComplete';
import { ticktickOverviewTool } from './builtin/ticktickOverview';

/**
 * Инициализация — регистрация всех builtin tools и hooks
 * Вызывается при старте приложения из agentOrchestrator.initializeAgents()
 */
export function initializeBuiltinTools(): void {
    // Регистрация hooks
    toolRegistry.registerHook(validationHook);
    toolRegistry.registerHook(loggingHook);

    // Регистрация builtin tools
    const builtinTools = [
        createReminderTool,
        createGoalTool,
        searchFactsTool,

        getMetricsTool,
        createSkillTool,
        getSkillsTool,
        updateSkillTool,
        deleteSkillTool,
        searchKnowledgeTool,
        scheduleTaskTool,
        listScheduledTasksTool,
        deleteScheduledTaskTool,
        updateScheduledTaskTool,
        delegateTaskTool,
        // Новые tools (Этап 1a)
        rememberFactTool,
        getGoalsTool,
        updateGoalTool,

        getRecentMessagesTool,
        updateProfileTool,
        // Web Search (Tavily API)
        webSearchTool,
        // Web Access — Perplexity Sonar + Jina Reader
        perplexitySearchTool,
        readWebPageTool,
        // Web Browser — Scraper Service (remote browser)
        browserOpenTool,
        browserActTool,
        browserReadTool,
        browserProfilesTool,
        // Goal System v2 — «Живые цели»
        refineGoalTool,
        // Goal System v2 — Фаза 2: Автоматизация
        completeTaskTool,
        addMilestoneTool,
        logGoalActivityTool,
        setGoalFocusTool,
        // Goal System v2 — Фаза 3: Review и коучинг
        reviewGoalsTool,
        mergeGoalsTool,
        updateKeyResultTool,
        getGoalDetailsTool,
        // Goal Management — удаление целей
        deleteGoalTool,
        // Message Search — поиск по истории сообщений
        searchMessagesTool,
        // Notes System — заметки, списки, чеклисты, черновики
        createNoteTool,
        updateNoteTool,
        deleteNoteTool,
        getNotesTool,
        getNoteDetailTool,

        searchNotesTool,
        // Google Calendar (MCP)
        calendarListEventsTool,
        calendarCreateEventTool,
        calendarUpdateEventTool,
        calendarDeleteEventTool,
        // TickTick — планировщик задач
        ticktickGetProjectsTool,
        ticktickGetTasksTool,
        ticktickCreateTaskTool,
        ticktickUpdateTaskTool,
        ticktickCompleteTaskTool,
        ticktickCreateProjectTool,
        ticktickDeleteTaskTool,
        ticktickSearchTasksTool,
        ticktickAddChecklistItemTool,
        ticktickSmartUpdateTool,
        ticktickSmartAddChecklistTool,
        ticktickSmartCompleteTool,
        ticktickOverviewTool,
    ];

    for (const tool of builtinTools) {
        toolRegistry.register(tool);
    }

    console.log(`[ToolSystem] ✅ Зарегистрировано ${toolRegistry.size} tools, ${toolRegistry.getHooks().length} hooks`);
}

// Re-exports
export { toolRegistry } from './toolRegistry';
export { executeReActLoop } from './executionEngine';
export { resolveToolsForRequest, resolveToolsByPacks, setAgentToolProfile, getAgentToolProfile } from './toolResolver';
export { formatToolsForOpenAI } from './llmAdapter';
export type { ToolDefinition, ToolPack, ReActResult, ToolCallLog, ToolResult } from './types';
export { TOOL_PACK_META, ALL_TOOL_PACKS, getToolPacksInfo, getAlwaysIncludePacks } from './toolPackMeta';

