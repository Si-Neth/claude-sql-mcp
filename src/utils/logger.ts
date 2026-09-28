/**
 * Structured logging + audit trail.
 *
 * - `logger` is for general application logs (startup, errors, warnings).
 * - `auditLog()` writes one structured entry per MCP tool invocation, for
 *   security review. It never logs secrets, passwords, or full row data —
 *   only metadata about what was accessed.
 */
import pino from "pino";
import fs from "node:fs";
import { config } from "../config.js";
import type { AuditLogEntry } from "../types.js";

export const logger = pino({
  level: config.logging.level,
  redact: {
    paths: [
      "req.headers.authorization",
      "*.password",
      "*.SQL_PASSWORD",
      "*.token",
      "*.bearerToken",
    ],
    censor: "[REDACTED]",
  },
  transport: config.isProduction
    ? undefined
    : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});

export function auditLog(entry: AuditLogEntry): void {
  const line = JSON.stringify(entry);
  logger.info({ audit: entry }, "mcp_tool_call");
  if (config.logging.auditLogFile) {
    try {
      fs.appendFileSync(config.logging.auditLogFile, line + "\n");
    } catch (err) {
      logger.error({ err }, "Failed to write audit log file");
    }
  }
}
