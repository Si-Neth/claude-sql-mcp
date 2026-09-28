/**
 * Structured, safe query engine.
 *
 * Per SECURITY.md Layer 2/3: Claude never sends raw SQL text to this
 * server. Every data-access tool (query_data, aggregate_data,
 * dashboard_data) describes WHAT it wants (columns, filters, grouping,
 * sorting, pagination) as structured JSON: this module is the only place
 * in the codebase that turns that structure into an actual SQL statement,
 * using exclusively:
 *   - bracket-quoted identifiers that have passed assertSafeIdentifier()
 *   - bound @parameters for every literal value (never string-interpolated)
 * The assembled statement is then passed through assertQueryIsSafe() as a
 * final check before execution.
 */
import { sql, runQuery, type SqlParamType } from "../database/pool.js";
import { assertTableAllowed, isColumnDenied } from "../security/allowlist.js";
import { assertSafeIdentifier, assertQueryIsSafe, quoteIdentifier } from "../security/sqlGuard.js";
import { describeTable } from "../metadata/discovery.js";
import { config } from "../config.js";
import { McpToolError, type QueryFilter, type QuerySort, type AggregateSpec } from "../types.js";

function paramName(prefix: string, index: number): string {
  return `${prefix}${index}`;
}

function sqlTypeForColumn(dataType: string): SqlParamType {
  const t = dataType.toLowerCase();
  if (["int", "smallint", "tinyint"].includes(t)) return sql.Int;
  if (["bigint"].includes(t)) return sql.BigInt;
  if (["decimal", "numeric", "money", "smallmoney", "float", "real"].includes(t)) return sql.Float;
  if (["bit"].includes(t)) return sql.Bit;
  if (["date"].includes(t)) return sql.Date;
  if (["datetime", "datetime2", "smalldatetime"].includes(t)) return sql.DateTime2;
  return sql.NVarChar(sql.MAX);
}

async function assertColumnsExist(
  database: string,
  schema: string,
  table: string,
  columns: string[],
): Promise<Map<string, string>> {
  const meta = await describeTable(database, schema, table);
  const typeByName = new Map(meta.columns.map((c) => [c.name.toLowerCase(), c.dataType]));
  for (const col of columns) {
    if (col === "*") continue;
    assertSafeIdentifier(col, "column");
    if (!typeByName.has(col.toLowerCase())) {
      throw new McpToolError(`Column "${col}" does not exist on ${schema}.${table}.`, "VALIDATION_ERROR");
    }
    if (isColumnDenied(schema, table, col)) {
      throw new McpToolError(
        `Column "${col}" is restricted and cannot be returned by this connector.`,
        "NOT_ALLOWED",
      );
    }
  }
  return typeByName;
}

function buildWhereClause(
  filters: QueryFilter[],
  typeByName: Map<string, string>,
  params: Record<string, { type: SqlParamType; value: unknown }>,
): string {
  if (!filters || filters.length === 0) return "";
  const clauses: string[] = [];
  filters.forEach((f, idx) => {
    assertSafeIdentifier(f.column, "filter.column");
    const dataType = typeByName.get(f.column.toLowerCase());
    if (!dataType) {
      throw new McpToolError(`Unknown filter column "${f.column}".`, "VALIDATION_ERROR");
    }
    const col = quoteIdentifier(f.column);
    const sqlType = sqlTypeForColumn(dataType);

    switch (f.operator) {
      case "isNull":
        clauses.push(`${col} IS NULL`);
        return;
      case "isNotNull":
        clauses.push(`${col} IS NOT NULL`);
        return;
      case "in":
      case "notIn": {
        const values = Array.isArray(f.value) ? f.value : [f.value];
        const names = values.map((v, i) => {
          const name = paramName(`f${idx}_`, i);
          params[name] = { type: sqlType, value: v };
          return `@${name}`;
        });
        clauses.push(`${col} ${f.operator === "in" ? "IN" : "NOT IN"} (${names.join(", ")})`);
        return;
      }
      case "between": {
        const nameA = paramName(`f${idx}_a`, idx);
        const nameB = paramName(`f${idx}_b`, idx);
        params[nameA] = { type: sqlType, value: f.value };
        params[nameB] = { type: sqlType, value: f.value2 };
        clauses.push(`${col} BETWEEN @${nameA} AND @${nameB}`);
        return;
      }
      case "like": {
        const name = paramName(`f${idx}_`, idx);
        params[name] = { type: sql.NVarChar(200), value: `%${f.value}%` };
        clauses.push(`${col} LIKE @${name}`);
        return;
      }
      default: {
        const opMap: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };
        const op = opMap[f.operator];
        if (!op) throw new McpToolError(`Unsupported filter operator "${f.operator}".`, "VALIDATION_ERROR");
        const name = paramName(`f${idx}_`, idx);
        params[name] = { type: sqlType, value: f.value };
        clauses.push(`${col} ${op} @${name}`);
      }
    }
  });
  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

export interface QueryDataInput {
  database: string;
  schema: string;
  table: string;
  columns?: string[];
  filters?: QueryFilter[];
  sort?: QuerySort[];
  page?: number;
  pageSize?: number;
}

export async function queryData(input: QueryDataInput): Promise<{ rows: Record<string, unknown>[]; rowCount: number; truncated: boolean }> {
  const { database, schema, table } = input;
  assertTableAllowed(database, schema, table);

  const requestedColumns = input.columns && input.columns.length > 0 ? input.columns : ["*"];
  const typeByName = await assertColumnsExist(database, schema, table, requestedColumns);

  const selectList =
    requestedColumns[0] === "*"
      ? [...typeByName.keys()]
          .filter((c) => !isColumnDenied(schema, table, c))
          .map((c) => quoteIdentifier(c))
          .join(", ")
      : requestedColumns.map((c) => quoteIdentifier(c)).join(", ");

  const params: Record<string, { type: SqlParamType; value: unknown }> = {};
  const whereClause = buildWhereClause(input.filters ?? [], typeByName, params);

  const sortClause =
    input.sort && input.sort.length > 0
      ? "ORDER BY " +
        input.sort
          .map((s) => {
            assertSafeIdentifier(s.column, "sort.column");
            if (!typeByName.has(s.column.toLowerCase())) {
              throw new McpToolError(`Unknown sort column "${s.column}".`, "VALIDATION_ERROR");
            }
            return `${quoteIdentifier(s.column)} ${s.direction === "desc" ? "DESC" : "ASC"}`;
          })
          .join(", ")
      : "ORDER BY (SELECT NULL)";

  const pageSize = Math.min(input.pageSize ?? config.limits.maxRows, config.limits.maxRows);
  const page = Math.max(1, input.page ?? 1);
  const offset = (page - 1) * pageSize;

  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const queryText = `SELECT ${selectList} FROM ${qualified} ${whereClause} ${sortClause}
    OFFSET @offset ROWS FETCH NEXT @fetchNext ROWS ONLY`;

  assertQueryIsSafe(queryText);

  params.offset = { type: sql.Int, value: offset };
  params.fetchNext = { type: sql.Int, value: pageSize + 1 }; // fetch one extra to detect truncation

  const { rows } = await runQuery(database, queryText, params);
  const truncated = rows.length > pageSize;
  return { rows: truncated ? rows.slice(0, pageSize) : rows, rowCount: Math.min(rows.length, pageSize), truncated };
}

export interface AggregateDataInput {
  database: string;
  schema: string;
  table: string;
  aggregates: AggregateSpec[];
  groupBy?: string[];
  filters?: QueryFilter[];
  sort?: QuerySort[];
  limit?: number;
}

export async function aggregateData(
  input: AggregateDataInput,
): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const { database, schema, table } = input;
  assertTableAllowed(database, schema, table);

  const groupBy = input.groupBy ?? [];
  const nonWildcardCols = [
    ...groupBy,
    ...input.aggregates.filter((a) => a.column !== "*").map((a) => a.column),
  ];
  const typeByName = await assertColumnsExist(database, schema, table, nonWildcardCols);

  if (input.aggregates.length === 0) {
    throw new McpToolError("At least one aggregate is required.", "VALIDATION_ERROR");
  }
  if (input.aggregates.length > 10) {
    throw new McpToolError("Too many aggregates requested (max 10).", "VALIDATION_ERROR");
  }

  const aggExprs = input.aggregates.map((a, i) => {
    if (a.column === "*" && a.function !== "COUNT") {
      throw new McpToolError('"*" is only valid with the COUNT function.', "VALIDATION_ERROR");
    }
    const alias = a.alias ? a.alias.replace(/[^A-Za-z0-9_]/g, "_") : `agg_${i}`;
    const colExpr = a.column === "*" ? "*" : quoteIdentifier(a.column);
    const fn = a.function === "COUNT_DISTINCT" ? `COUNT(DISTINCT ${colExpr})` : `${a.function}(${colExpr})`;
    return `${fn} AS ${quoteIdentifier(alias)}`;
  });

  const groupExprs = groupBy.map((g) => {
    assertSafeIdentifier(g, "groupBy");
    return quoteIdentifier(g);
  });

  const params: Record<string, { type: SqlParamType; value: unknown }> = {};
  const whereClause = buildWhereClause(input.filters ?? [], typeByName, params);

  const selectList = [...groupExprs, ...aggExprs].join(", ");
  const groupClause = groupExprs.length ? `GROUP BY ${groupExprs.join(", ")}` : "";
  const limit = Math.min(input.limit ?? 500, 500);

  const sortClause =
    input.sort && input.sort.length > 0
      ? "ORDER BY " +
        input.sort.map((s) => `${quoteIdentifier(s.column)} ${s.direction === "desc" ? "DESC" : "ASC"}`).join(", ")
      : groupExprs.length
        ? `ORDER BY ${groupExprs[0]}`
        : "";

  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const queryText = `SELECT TOP (@__limit) ${selectList} FROM ${qualified} ${whereClause} ${groupClause} ${sortClause}`;

  assertQueryIsSafe(queryText);
  params.__limit = { type: sql.Int, value: limit };

  const { rows } = await runQuery(database, queryText, params);
  return { rows, rowCount: rows.length };
}
