import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { type Server } from "http";

// В production не загружаем vite - этот файл не должен использоваться
// setupVite экспортируется только для типизации, реально вызывается только в dev
export async function setupVite(app: Express, server: Server) {
  // Динамически импортируем vite только когда функция реально вызывается (в dev)
  const viteModule = await import("vite");
  const { createServer: createViteServer, createLogger } = viteModule;
  const viteConfigModule = await import("../vite.config");
  const viteConfig = viteConfigModule.default;
  const nanoidModule = await import("nanoid");
  const { nanoid } = nanoidModule;

  const viteLogger = createLogger();

  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const viteServer = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(viteServer.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await viteServer.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      viteServer.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
