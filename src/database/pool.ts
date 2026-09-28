/**
 * SQL Server connection pool.
 *
 * A single shared, read-only connection pool is created at startup and
 * reused for every request (per target database). Connections use the
 * dedicated claude_mcp_reader login only — this module never accepts or
 * builds credentials from anywhere except config.ts.
 */
import sql from "mssql";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { McpToolError } from "../types.js";

/** The mssql `.input(name, type, value)` type parameter accepts either an
 *  ISqlType instance or a zero/param factory function (e.g. `sql.Int`,
 *  `sql.NVarChar(200)`). This alias is used everywhere a bound parameter's
 *  SQL type is declared in this codebase. */
export type SqlParamType = sql.ISqlType | (() => sql.ISqlType);

const pools = new Map<string, sql.ConnectionPool>();

function buildConfig(database: string): sql.config {
  return {
    server: config.sql.host,
    port: config.sql.port,
    database,
    user: config.sql.user,
    password: config.sql.password,
    connectionTimeout: config.sql.connectTimeoutMs,
    requestTimeout: config.sql.requestTimeoutMs,
    pool: {
      max: config.sql.poolMax,
      min: config.sql.poolMin,
      idleTimeoutMillis: config.sql.idleTimeoutMs,
    },
    options: {
      encrypt: config.sql.encrypt,
      trustServerCertificate: config.sql.trustServerCertificate,
      instanceName: config.sql.instance || undefined,
      // Read-only intent hint. Does NOT by itself prevent writes — the real
      // enforcement is the SQL Server-level permissions (sql/02-*.sql) and
      // the application-level query validator (security/sqlGuard.ts). This
      // is an additional, defense-in-depth signal to SQL Server / AlwaysOn
      // readable secondaries where applicable.
      appName: "claude-sql-mcp",
    },
  };
}

/** Get (or lazily create) a pooled connection to the given database. Only
 *  databases present in the ALLOWED_DATABASES allowlist should ever reach
 *  this function — callers must check accessControl.assertDatabaseAllowed()
 *  first. */
export async function getPool(database: string): Promise<sql.ConnectionPool> {
  const existing = pools.get(database);
  if (existing && existing.connected) return existing;

  try {
    const pool = new sql.ConnectionPool(buildConfig(database));
    pool.on("error", (err) => logger.error({ err, database }, "SQL pool error"));
    await pool.connect();
    pools.set(database, pool);
    logger.info({ database }, "Connected to SQL Server database");
    return pool;
  } catch (err) {
    logger.error({ err, database }, "Failed to connect to SQL Server");
    throw new McpToolError(
      `TRP_AMS database "${database}" is currently unavailable. Please try again shortly.`,
      "DB_UNAVAILABLE",
    );
  }
}

export async function closeAllPools(): Promise<void> {
  for (const [database, pool] of pools.entries()) {
    try {
      await pool.close();
    } catch (err) {
      logger.warn({ err, database }, "Error closing pool");
    }
  }
  pools.clear();
}

/** Execute a parameterized, read-only query with a hard timeout.
 *  `params` are always bound via sql.Request().input(...) — string
 *  concatenation of user-controlled values into SQL text is never used
 *  anywhere in this codebase. */
export async function runQuery<T = Record<string, unknown>>(
  database: string,
  queryText: string,
  params: Record<string, { type: SqlParamType; value: unknown }> = {},
): Promise<{ rows: T[]; durationMs: number }> {
  const pool = await getPool(database);
  // Per-request timeout is inherited from the pool's `requestTimeout`
  // config (set in buildConfig() above from SQL_REQUEST_TIMEOUT_MS), which
  // mssql applies to every request issued from this pool.
  const request = pool.request();

  for (const [name, { type, value }] of Object.entries(params)) {
    request.input(name, type, value);
  }

  const started = Date.now();
  try {
    const result = await request.query<T>(queryText);
    return { rows: result.recordset as unknown as T[], durationMs: Date.now() - started };
  } catch (err: unknown) {
    const durationMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, database, durationMs }, "SQL query failed");
    if (message.toLowerCase().includes("timeout")) {
      throw new McpToolError(
        "The requested dataset is too large or slow. The query must be filtered or aggregated further.",
        "TIMEOUT",
      );
    }
    if (message.toLowerCase().includes("permission")) {
      throw new McpToolError(
        "The requested data source is not available to this connector.",
        "NOT_ALLOWED",
      );
    }
    throw new McpToolError("The query could not be executed against SQL Server.", "INTERNAL_ERROR");
  }
}

export { sql };
