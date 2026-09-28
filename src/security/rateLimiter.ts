/**
 * Simple per-connector rate limiting (Layer for availability protection —
 * prevents one runaway conversation from overwhelming SQL Server). Applied
 * at the Express HTTP layer, in front of the MCP transport.
 */
import rateLimit from "express-rate-limit";
import { config } from "../config.js";

export const mcpRateLimiter = rateLimit({
  windowMs: config.limits.rateLimitWindowMs,
  limit: config.limits.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please slow down and try again shortly.",
  },
});
