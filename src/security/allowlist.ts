/**
 * Layer 4 of the defense-in-depth model: application-level allow/deny lists
 * for databases, schemas, tables, and columns — enforced BEFORE any query
 * reaches SQL Server, independent of whatever the SQL login's own
 * permissions happen to be.
 */
import { config } from "../config.js";
import { McpToolError } from "../types.js";
import { assertSafeIdentifier } from "./sqlGuard.js";

function matchesPattern(pattern: string, schema: string, table?: string): boolean {
  // Supported patterns: "schema.*" (whole schema) or "schema.table" (exact)
  const [pSchema, pTable] = pattern.split(".");
  if (pSchema.toLowerCase() !== schema.toLowerCase()) return false;
  if (!pTable || pTable === "*") return true;
  if (!table) return true; // schema-level check only
  return pTable.toLowerCase() === table.toLowerCase();
}

export function assertDatabaseAllowed(database: string): void {
  assertSafeIdentifier(database, "database");
  const { allowedDatabases } = config.access;
  if (allowedDatabases.length > 0 && !allowedDatabases.some((d) => d.toLowerCase() === database.toLowerCase())) {
    throw new McpToolError(
      `The requested data source is not available to this connector. Database "${database}" is not in ALLOWED_DATABASES.`,
      "NOT_ALLOWED",
    );
  }
}

export function assertSchemaAllowed(database: string, schema: string): void {
  assertSafeIdentifier(schema, "schema");
  assertDatabaseAllowed(database);
  const { allowedSchemas } = config.access;
  if (allowedSchemas.length > 0 && !allowedSchemas.some((p) => matchesPattern(p, schema))) {
    throw new McpToolError(
      `The requested data source is not available to this connector. Schema "${schema}" is not permitted.`,
      "NOT_ALLOWED",
    );
  }
}

export function assertTableAllowed(database: string, schema: string, table: string): void {
  assertSafeIdentifier(table, "table");
  assertSchemaAllowed(database, schema);

  const qualified = `${schema}.${table}`.toLowerCase();
  if (config.access.deniedTables.includes(qualified)) {
    throw new McpToolError(
      `The requested data source is not available to this connector. Table "${schema}.${table}" is denied.`,
      "NOT_ALLOWED",
    );
  }

  const { allowedSchemas } = config.access;
  if (allowedSchemas.length > 0 && !allowedSchemas.some((p) => matchesPattern(p, schema, table))) {
    throw new McpToolError(
      `The requested data source is not available to this connector. Table "${schema}.${table}" is not permitted.`,
      "NOT_ALLOWED",
    );
  }
}

/** Remove denied columns from a set of requested/returned columns. Returns
 *  the filtered list; never throws, so a dashboard query simply omits
 *  sensitive fields rather than failing outright. */
export function filterDeniedColumns(schema: string, table: string, columns: string[]): string[] {
  const denied = new Set(config.access.deniedColumns);
  return columns.filter((c) => !denied.has(`${schema}.${table}.${c}`.toLowerCase()));
}

export function isColumnDenied(schema: string, table: string, column: string): boolean {
  return config.access.deniedColumns.includes(`${schema}.${table}.${column}`.toLowerCase());
}
