/**
 * Entry point. `npm run dev` (tsx, auto-reload) or `npm run build && npm start`.
 */
import { config, validateConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { createApp } from "./mcp/server.js";
import { closeAllPools } from "./database/pool.js";

async function main() {
  validateConfig();

  const app = createApp();
  const server = app.listen(config.mcp.port, () => {
    logger.info(
      { port: config.mcp.port, env: config.env, publicUrl: config.mcp.publicUrl || "(not set)" },
      `claude-sql-mcp listening on http://localhost:${config.mcp.port}/mcp`,
    );
    if (config.env !== "production") {
      logger.info("Test locally with: npx @modelcontextprotocol/inspector");
    }
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    server.close(async () => {
      await closeAllPools();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "Unhandled promise rejection"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", err);
  process.exit(1);
});
