/**
 * MCP tool registration. Every tool:
 *   1. Declares a strict zod input schema (validated by the MCP SDK before
 *      the handler ever runs).
 *   2. Delegates to the security/metadata/dashboard modules — no SQL is
 *      built inline here.
 *   3. Is wrapped by withAudit() for structured audit logging and
 *      consistent, non-leaky error messages.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";

import { listDatabases, listSchemas, listTables, describeTable, getRelationships, sampleTable, getDistinctValues } from "../metadata/discovery.js";
import { queryData, aggregateData } from "../dashboard/queryBuilder.js";
import { dashboardData } from "../dashboard/dashboardEngine.js";
import { auditLog, logger } from "../utils/logger.js";
import { getPool } from "../database/pool.js";
import { config } from "../config.js";
import { McpToolError } from "../types.js";

const filterSchema = z.object({
  column: z.string(),
  operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "in", "notIn", "like", "isNull", "isNotNull", "between"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
  value2: z.union([z.string(), z.number()]).optional(),
});

const sortSchema = z.object({
  column: z.string(),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

const aggregateSpecSchema = z.object({
  function: z.enum(["SUM", "COUNT", "COUNT_DISTINCT", "AVG", "MIN", "MAX"]),
  column: z.string(),
  alias: z.string().optional(),
});

interface ToolContext {
  principal: string;
}

function withAudit<Args extends Record<string, unknown>, Result>(
  toolName: string,
  handler: (args: Args, ctx: ToolContext) => Promise<Result>,
) {
  return async (args: Args, ctx: ToolContext) => {
    const requestId = randomUUID();
    const started = Date.now();
    try {
      const result = await handler(args, ctx);
      auditLog({
        timestamp: new Date().toISOString(),
        requestId,
        principal: ctx.principal,
        tool: toolName,
        database: (args as { database?: string }).database,
        schema: (args as { schema?: string }).schema,
        table: (args as { table?: string }).table,
        durationMs: Date.now() - started,
        rowCount: Array.isArray((result as { rows?: unknown[] })?.rows)
          ? (result as { rows: unknown[] }).rows.length
          : undefined,
        success: true,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const isKnown = err instanceof McpToolError;
      const message = isKnown ? err.message : "An internal error occurred while processing this request.";
      const category = isKnown ? err.code : "INTERNAL_ERROR";

      auditLog({
        timestamp: new Date().toISOString(),
        requestId,
        principal: ctx.principal,
        tool: toolName,
        database: (args as { database?: string }).database,
        schema: (args as { schema?: string }).schema,
        table: (args as { table?: string }).table,
        durationMs: Date.now() - started,
        success: false,
        errorCategory: category,
      });
      if (!isKnown) logger.error({ err, toolName, requestId }, "Unhandled tool error");

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ error: message, code: category }) }],
        isError: true,
      };
    }
  };
}

/** Registers all read-only tools on the given McpServer instance. `ctx` is
 *  supplied per-request by the transport layer (server.ts) so audit logs
 *  can record which authenticated principal made each call. */
export function registerTools(server: McpServer, getCtx: () => ToolContext): void {
  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description:
        "Lists the SQL Server databases this read-only connector can see, marking which are within ALLOWED_DATABASES. Always call this before assuming a database name.",
      inputSchema: {},
    },
    async () => withAudit("list_databases", async () => ({ databases: await listDatabases() }))({}, getCtx()),
  );

  server.registerTool(
    "list_schemas",
    {
      title: "List schemas",
      description: "Lists schemas within a database that contain at least one table, filtered by ALLOWED_SCHEMAS.",
      inputSchema: { database: z.string().describe("Database name, from list_databases") },
    },
    async (args) => withAudit("list_schemas", async (a: typeof args) => ({ schemas: await listSchemas(a.database) }))(args, getCtx()),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables and views",
      description: "Lists tables and views within a database/schema.",
      inputSchema: {
        database: z.string(),
        schema: z.string().describe("Schema name, from list_schemas"),
      },
    },
    async (args) => withAudit("list_tables", async (a: typeof args) => ({ tables: await listTables(a.database, a.schema) }))(args, getCtx()),
  );

  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "Returns column names, data types, nullability, primary key info, approximate row count for one table or view. Call this before querying an unfamiliar table.",
      inputSchema: { database: z.string(), schema: z.string(), table: z.string() },
    },
    async (args) =>
      withAudit("describe_table", async (a: typeof args) => await describeTable(a.database, a.schema, a.table))(args, getCtx()),
  );

  server.registerTool(
    "get_relationships",
    {
      title: "Get table relationships",
      description: "Returns foreign-key relationships from this table to other tables, useful for joins/lookups.",
      inputSchema: { database: z.string(), schema: z.string(), table: z.string() },
    },
    async (args) =>
      withAudit("get_relationships", async (a: typeof args) => ({
        relationships: await getRelationships(a.database, a.schema, a.table),
      }))(args, getCtx()),
  );

  server.registerTool(
    "sample_table",
    {
      title: "Sample table rows",
      description: `Returns a small sample of rows (max ${config.limits.maxRows}, default 10) from a table, for exploration only — not for bulk retrieval.`,
      inputSchema: { database: z.string(), schema: z.string(), table: z.string(), limit: z.number().int().min(1).max(50).default(10) },
    },
    async (args) =>
      withAudit("sample_table", async (a: typeof args) => ({
        rows: await sampleTable(a.database, a.schema, a.table, a.limit),
      }))(args, getCtx()),
  );

  server.registerTool(
    "get_distinct_values",
    {
      title: "Get distinct column values",
      description: "Returns up to `limit` distinct non-null values for a column — useful for discovering valid filter values (e.g. region names).",
      inputSchema: {
        database: z.string(),
        schema: z.string(),
        table: z.string(),
        column: z.string(),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async (args) =>
      withAudit("get_distinct_values", async (a: typeof args) => ({
        values: await getDistinctValues(a.database, a.schema, a.table, a.column, a.limit),
      }))(args, getCtx()),
  );

  server.registerTool(
    "query_data",
    {
      title: "Query structured data",
      description: `Returns rows from a single table/view with optional column selection, filters, sorting, and pagination. Read-only; results capped at ${config.limits.maxRows} rows per page. Prefer aggregate_data or dashboard_data for large tables.`,
      inputSchema: {
        database: z.string(),
        schema: z.string(),
        table: z.string(),
        columns: z.array(z.string()).optional(),
        filters: z.array(filterSchema).optional(),
        sort: z.array(sortSchema).optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(config.limits.maxRows).default(Math.min(100, config.limits.maxRows)),
      },
    },
    async (args) => withAudit("query_data", async (a: typeof args) => await queryData(a))(args, getCtx()),
  );

  server.registerTool(
    "aggregate_data",
    {
      title: "Aggregate data",
      description:
        "Runs a server-side SUM/COUNT/AVG/MIN/MAX aggregation with optional GROUP BY and filters. Always prefer this over query_data + client-side math for totals or breakdowns over large tables.",
      inputSchema: {
        database: z.string(),
        schema: z.string(),
        table: z.string(),
        aggregates: z.array(aggregateSpecSchema).min(1).max(10),
        groupBy: z.array(z.string()).optional(),
        filters: z.array(filterSchema).optional(),
        sort: z.array(sortSchema).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      },
    },
    async (args) => withAudit("aggregate_data", async (a: typeof args) => await aggregateData(a))(args, getCtx()),
  );

  server.registerTool(
    "dashboard_data",
    {
      title: "Dashboard data",
      description:
        "High-level tool optimized for dashboard generation: kpi, time_series, category_breakdown, ranking, or comparison shapes, computed server-side with safe aggregation. Use this as the primary tool once you know which table/columns to use (via describe_table).",
      inputSchema: {
        database: z.string(),
        schema: z.string(),
        table: z.string(),
        requestType: z.enum(["kpi", "time_series", "category_breakdown", "ranking", "comparison"]),
        metric: aggregateSpecSchema,
        dateColumn: z.string().optional(),
        datePart: z.enum(["day", "month", "quarter", "year"]).optional(),
        categoryColumn: z.string().optional(),
        compareColumn: z.string().optional(),
        filters: z.array(filterSchema).optional(),
        topN: z.number().int().min(1).max(100).optional(),
      },
    },
    async (args) => withAudit("dashboard_data", async (a: typeof args) => await dashboardData(a))(args, getCtx()),
  );

  server.registerTool(
    "health_check",
    {
      title: "Health check",
      description: "Reports MCP server status, SQL Server connectivity, and configuration status. No secrets are returned.",
      inputSchema: {},
    },
    async () =>
      withAudit("health_check", async () => {
        let sqlConnected = false;
        try {
          await getPool(config.sql.database);
          sqlConnected = true;
        } catch {
          sqlConnected = false;
        }
        return {
          status: sqlConnected ? "ok" : "degraded",
          sqlServerConnectivity: sqlConnected,
          version: "1.0.0",
          environment: config.env,
          allowedDatabases: config.access.allowedDatabases,
          readOnly: true,
        };
      })({}, getCtx()),
  );
}
