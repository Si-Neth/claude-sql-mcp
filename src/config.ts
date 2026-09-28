/**
 * Centralized, validated configuration. Every environment variable the
 * application reads is parsed exactly once, here, so the rest of the code
 * never touches process.env directly.
 */
import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith("YOUR_") || value.startsWith("REPLACE_")) {
    throw new Error(
      `Missing or placeholder value for required environment variable "${name}". ` +
        `Copy .env.example to .env and set a real value. See README.md / .env.example for how to obtain it.`,
    );
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.length > 0 ? value : fallback;
}

function csv(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw.toLowerCase() === "true";
}

export const config = {
  env: optionalEnv("NODE_ENV", "development"),
  isProduction: optionalEnv("NODE_ENV", "development") === "production",

  sql: {
    host: requireEnv("SQL_SERVER_HOST"),
    port: intEnv("SQL_SERVER_PORT", 1433),
    instance: optionalEnv("SQL_SERVER_INSTANCE", ""),
    database: requireEnv("SQL_DATABASE"),
    user: requireEnv("SQL_USER"),
    password: requireEnv("SQL_PASSWORD"),
    authType: optionalEnv("SQL_AUTH_TYPE", "sql"),
    encrypt: boolEnv("SQL_ENCRYPT", true),
    trustServerCertificate: boolEnv("SQL_TRUST_SERVER_CERTIFICATE", false),
    poolMax: intEnv("SQL_POOL_MAX", 10),
    poolMin: intEnv("SQL_POOL_MIN", 0),
    idleTimeoutMs: intEnv("SQL_POOL_IDLE_TIMEOUT_MS", 30000),
    connectTimeoutMs: intEnv("SQL_CONNECT_TIMEOUT_MS", 15000),
    requestTimeoutMs: intEnv("SQL_REQUEST_TIMEOUT_MS", 20000),
  },

  mcp: {
    port: intEnv("MCP_PORT", 8787),
    publicUrl: optionalEnv("MCP_PUBLIC_URL", ""),
    allowedOrigins: csv(optionalEnv("MCP_ALLOWED_ORIGINS", "https://claude.ai")),
  },

  auth: {
    mode: optionalEnv("AUTH_MODE", "bearer") as "bearer" | "oauth",
    bearerToken: process.env.MCP_BEARER_TOKEN ?? "",
    oauth: {
      clientId: process.env.OAUTH_CLIENT_ID ?? "",
      clientSecret: process.env.OAUTH_CLIENT_SECRET ?? "",
      issuerUrl: process.env.OAUTH_ISSUER_URL ?? "",
    },
  },

  access: {
    allowedDatabases: csv(optionalEnv("ALLOWED_DATABASES", "")),
    allowedSchemas: csv(optionalEnv("ALLOWED_SCHEMAS", "")),
    deniedTables: csv(optionalEnv("DENIED_TABLES", "")).map((t) => t.toLowerCase()),
    deniedColumns: csv(optionalEnv("DENIED_COLUMNS", "")).map((c) => c.toLowerCase()),
  },

  limits: {
    maxRows: intEnv("MAX_ROWS", 1000),
    maxQueryTimeMs: intEnv("MAX_QUERY_TIME_MS", 15000),
    maxResultSizeMb: intEnv("MAX_RESULT_SIZE_MB", 5),
    cacheTtlSeconds: intEnv("CACHE_TTL_SECONDS", 300),
    rateLimitWindowMs: intEnv("RATE_LIMIT_WINDOW_MS", 60000),
    rateLimitMaxRequests: intEnv("RATE_LIMIT_MAX_REQUESTS", 60),
  },

  logging: {
    level: optionalEnv("LOG_LEVEL", "info"),
    auditLogFile: process.env.AUDIT_LOG_FILE ?? "",
  },

  businessMetadataPath: optionalEnv("BUSINESS_METADATA_PATH", "./config/business-metadata.json"),
};

/** Call once at startup to fail fast with a clear message instead of a
 *  confusing runtime error later. */
export function validateConfig(): void {
  if (config.auth.mode === "bearer" && !config.auth.bearerToken) {
    throw new Error("AUTH_MODE=bearer requires MCP_BEARER_TOKEN to be set in .env");
  }
  if (config.auth.mode === "oauth") {
    if (!config.auth.oauth.clientId || !config.auth.oauth.clientSecret || !config.auth.oauth.issuerUrl) {
      throw new Error("AUTH_MODE=oauth requires OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_ISSUER_URL");
    }
  }
  if (config.access.allowedDatabases.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      "[config] WARNING: ALLOWED_DATABASES is empty — the connector will expose every database " +
        "the SQL login can see. Set ALLOWED_DATABASES in .env for production.",
    );
  }
}
