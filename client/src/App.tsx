import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { InstallPrompt } from "@/components/InstallPrompt";
import NotFound from "@/pages/not-found";
import Chat from "@/pages/chat";

import AIConfigPage from "@/pages/ai-config";
import AuthPage from "@/pages/auth";
import MemoryPage from "@/pages/memory";
import ProfilePage from "@/pages/profile";
import GoalsPage from "@/pages/goals";
import RemindersPage from "@/pages/reminders";
import ScheduledTasksPage from "@/pages/ScheduledTasksPage";
import GraphPage from "@/pages/graph";
import NotificationsPage from "@/pages/NotificationsPage";
import SkillsPage from "@/pages/SkillsPage";
import ExpertisesPage from "@/pages/ExpertisesPage";
import NotesPage from "@/pages/notes";
import NoteDetailPage from "@/pages/note-detail";
import NoteNewPage from "@/pages/note-new";
import NoteEditPage from "@/pages/note-edit";
import ObsidianSettingsPage from "@/pages/ObsidianSettings";
import { useAuth } from "@/hooks/useAuth";

function Router() {
  const { isAuthenticated, isLoading, login } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Загрузка...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AuthPage onAuthenticated={login} />;
  }

  return (
    <Switch>
      <Route path="/" component={Chat} />

      <Route path="/settings/ai" component={AIConfigPage} />
      <Route path="/notifications" component={NotificationsPage} />
      <Route path="/memory" component={MemoryPage} />
      <Route path="/profile" component={ProfilePage} />
      <Route path="/goals" component={GoalsPage} />
      <Route path="/reminders" component={RemindersPage} />
      <Route path="/scheduled-tasks" component={ScheduledTasksPage} />
      <Route path="/graph" component={GraphPage} />
      <Route path="/skills" component={SkillsPage} />
      <Route path="/expertises" component={ExpertisesPage} />
      <Route path="/notes/new" component={NoteNewPage} />
      <Route path="/notes/:id/edit" component={NoteEditPage} />
      <Route path="/notes/:id" component={NoteDetailPage} />
      <Route path="/notes" component={NotesPage} />
      <Route path="/settings/obsidian" component={ObsidianSettingsPage} />
      <Route component={NotFound} />
    </Switch>
  );
}


function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <InstallPrompt />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
