/** Triggering server restart for Profile Synthesis migrations */
import "dotenv/config";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic, log } from "./static";
import { restoreSubagentRunsOnStart, startSubagentSweeper } from "./subagentRegistry";
import { runAutoMigrations } from "./db";
import { modelHealth } from "./modelHealthTracker";
import path from "path";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Serve static files from uploads directory
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + "…";
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Автоматические миграции БД (идемпотентные, безопасные при каждом запуске)
  await runAutoMigrations();

  const server = await registerRoutes(app);

  // Восстановить зависшие суб-агенты после перезапуска сервера
  await restoreSubagentRunsOnStart();
  // Запустить периодическую очистку старых subagent_runs
  startSubagentSweeper();

  // Запустить периодическую проверку cooldown'ов моделей (Model Health Tracker)
  modelHealth.startRecoveryCheck();

  // Автозапуск Cloud Sync Watcher (Obsidian Bridge Stage 3)
  (async () => {
    try {
      const { storage } = await import("./storage");
      const token = await storage.getSetting("yandex_disk_token");
      if (token) {
        const { startWatcher, pullFromCloud } = await import("./vault/CloudSyncWatcher");
        console.log("[CloudSync] 🚀 Auto-starting watcher (Yandex Disk token found)");
        // Первый pull при старте — подхватить изменения за время простоя
        pullFromCloud().catch(err => console.error("[CloudSync] Initial pull error:", err));
        startWatcher();
      }
    } catch (err) {
      console.error("[CloudSync] Auto-start failed:", err);
    }
  })();
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get("env") === "development") {
    // Dynamic import to avoid loading vite in production
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || '5000', 10);
  server.listen(port, "0.0.0.0", () => {
    log(`serving on port ${port}`);
  });
})();
