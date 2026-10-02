/**
 * Remote MCP server: Express + Streamable HTTP transport, with:
 *   - Bearer-token authentication (or OAuth, if AUTH_MODE=oauth — see
 *     SECURITY.md for the OAuth upgrade path)
 *   - Origin allowlisting (DNS-rebinding protection per MCP spec)
 *   - helmet security headers
 *   - rate limiting
 *   - a plain HTTP /healthz endpoint for load balancer / uptime checks
 *     (separate from the MCP health_check TOOL, which Claude calls)
 */
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { mcpRateLimiter } from "../security/rateLimiter.js";
import { registerTools } from "./tools.js";

function buildMcpServer(): McpServer {
  const server = new McpServer({
    name: "trp-ams-sql-readonly",
    version: "1.0.0",
  });
  // principal is set per-request in the /mcp handler below via closure;
  // registerTools reads it lazily through getCtx() so every tool call is
  // attributed to the authenticated caller in the audit log.
  let currentPrincipal = "unknown";
  registerTools(server, () => ({ principal: currentPrincipal }));
  return Object.assign(server, {
    __setPrincipal: (p: string) => {
      currentPrincipal = p;
    },
  }) as McpServer & { __setPrincipal: (p: string) => void };
}

function authenticate(req: Request, res: Response, next: NextFunction): void {
  if (config.auth.mode === "oauth") {
    // Production OAuth verification (JWT signature + issuer + audience
    // checks against config.auth.oauth.issuerUrl) belongs here. Wire in
    // your identity provider's verification library — see SECURITY.md
    // "Authentication Architecture" for the recommended approach with
    // Entra ID / Okta / Auth0, since the exact verification code depends
    // on which provider your company uses.
    res.status(501).json({
      error:
        "AUTH_MODE=oauth is selected but OAuth token verification is not wired up in this deployment. " +
        "See SECURITY.md for the identity-provider integration steps.",
    });
    return;
  }

  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${config.auth.bearerToken}`;
  if (header !== expected) {
    logger.warn({ path: req.path, ip: req.ip }, "Rejected MCP request: invalid or missing bearer token");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as Request & { principal?: string }).principal = "connector-bearer-token";
  next();
}

function enforceOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (!origin) {
    next(); // non-browser MCP clients (e.g. server-to-server) may omit Origin
    return;
  }
  if (!config.mcp.allowedOrigins.includes(origin)) {
    logger.warn({ origin }, "Rejected MCP request: disallowed Origin");
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  next();
}

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(helmet());
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", service: "claude-sql-mcp", time: new Date().toISOString() });
  });

  app.post("/mcp", enforceOrigin, mcpRateLimiter, authenticate, async (req, res) => {
    const server = buildMcpServer() as McpServer & { __setPrincipal: (p: string) => void };
    server.__setPrincipal((req as Request & { principal?: string }).principal ?? "unknown");

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, "MCP request handling failed");
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // Streamable HTTP also expects GET (server->client stream) and DELETE
  // (session termination) on the same endpoint for stateful sessions.
  // Since sessionIdGenerator issues a fresh id per POST above (stateless
  // mode, safest for a multi-instance/load-balanced deployment), these are
  // simple no-ops that return 405 to signal stateless operation.
  app.get("/mcp", enforceOrigin, authenticate, (_req, res) => {
    res.status(405).json({ error: "This server operates in stateless mode; GET streaming is not used." });
  });
  app.delete("/mcp", enforceOrigin, authenticate, (_req, res) => {
    res.status(204).end();
  });

  return app;
}
