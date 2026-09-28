/**
 * Shared type definitions for claude-sql-mcp.
 */

export interface DatabaseIdentifier {
  database: string;
}

export interface SchemaIdentifier extends DatabaseIdentifier {
  schema: string;
}

export interface TableIdentifier extends SchemaIdentifier {
  table: string;
}

export interface ColumnMetadata {
  name: string;
  dataType: string;
  maxLength: number | null;
  isNullable: boolean;
  isPrimaryKey: boolean;
  isIdentity: boolean;
  ordinalPosition: number;
  description: string | null;
}

export interface ForeignKeyMetadata {
  constraintName: string;
  fromColumn: string;
  toSchema: string;
  toTable: string;
  toColumn: string;
}

export interface TableMetadata {
  database: string;
  schema: string;
  table: string;
  type: "TABLE" | "VIEW";
  columns: ColumnMetadata[];
  primaryKeyColumns: string[];
  rowCountApprox: number | null;
}

export interface QueryFilter {
  column: string;
  operator:
    | "eq"
    | "neq"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "in"
    | "notIn"
    | "like"
    | "isNull"
    | "isNotNull"
    | "between";
  value?: string | number | boolean | Array<string | number>;
  value2?: string | number; // for "between"
}

export interface QuerySort {
  column: string;
  direction: "asc" | "desc";
}

export interface AggregateSpec {
  function: "SUM" | "COUNT" | "COUNT_DISTINCT" | "AVG" | "MIN" | "MAX";
  column: string; // "*" allowed only for COUNT
  alias?: string;
}

export interface AuditLogEntry {
  timestamp: string;
  requestId: string;
  principal: string;
  tool: string;
  database?: string;
  schema?: string;
  table?: string;
  queryType?: string;
  durationMs: number;
  rowCount?: number;
  success: boolean;
  errorCategory?: string;
}

export class McpToolError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "UNSAFE_QUERY"
      | "NOT_ALLOWED"
      | "NOT_FOUND"
      | "TOO_LARGE"
      | "TIMEOUT"
      | "DB_UNAVAILABLE"
      | "VALIDATION_ERROR"
      | "INTERNAL_ERROR" = "INTERNAL_ERROR",
  ) {
    super(message);
    this.name = "McpToolError";
  }
}
