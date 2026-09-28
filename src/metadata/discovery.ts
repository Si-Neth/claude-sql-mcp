/**
 * Database discovery: databases -> schemas -> tables/views -> columns ->
 * relationships. All queries here are fixed, hard-coded SQL against
 * INFORMATION_SCHEMA / sys catalog views — no user input is ever
 * concatenated into these statements; identifiers from the caller are
 * always passed as bound parameters or validated with assertSafeIdentifier
 * before being used to build a bracket-quoted, fully-qualified name.
 */
import { sql, runQuery } from "../database/pool.js";
import { cached } from "./cache.js";
import { assertDatabaseAllowed, assertSchemaAllowed, assertTableAllowed } from "../security/allowlist.js";
import { assertSafeIdentifier, quoteIdentifier } from "../security/sqlGuard.js";
import { config } from "../config.js";
import type { ColumnMetadata, ForeignKeyMetadata, TableMetadata } from "../types.js";

export interface DatabaseInfo {
  name: string;
  isAllowed: boolean;
}

export async function listDatabases(): Promise<DatabaseInfo[]> {
  return cached("meta:databases", async () => {
    const { rows } = await runQuery<{ name: string }>(
      config.sql.database,
      `SELECT name FROM sys.databases
       WHERE database_id > 4          -- exclude master/tempdb/model/msdb
         AND state_desc = 'ONLINE'
       ORDER BY name`,
    );
    return rows.map((r) => ({
      name: r.name,
      isAllowed:
        config.access.allowedDatabases.length === 0 ||
        config.access.allowedDatabases.some((d) => d.toLowerCase() === r.name.toLowerCase()),
    }));
  });
}

export async function listSchemas(database: string): Promise<string[]> {
  assertDatabaseAllowed(database);
  return cached(`meta:schemas:${database}`, async () => {
    const { rows } = await runQuery<{ schema_name: string }>(
      database,
      `SELECT s.name AS schema_name
       FROM sys.schemas s
       JOIN sys.tables t ON t.schema_id = s.schema_id
       WHERE s.name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin',
                             'db_securityadmin','db_ddladmin','db_backupoperator','db_datareader',
                             'db_datawriter','db_denydatareader','db_denydatawriter')
       GROUP BY s.name
       ORDER BY s.name`,
    );
    return rows.map((r) => r.schema_name);
  });
}

export interface TableSummary {
  schema: string;
  name: string;
  type: "TABLE" | "VIEW";
}

export async function listTables(database: string, schema: string): Promise<TableSummary[]> {
  assertSchemaAllowed(database, schema);
  return cached(`meta:tables:${database}:${schema}`, async () => {
    const { rows } = await runQuery<{ table_name: string; table_type: string }>(
      database,
      `SELECT TABLE_NAME AS table_name, TABLE_TYPE AS table_type
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = @schema
       ORDER BY TABLE_NAME`,
      { schema: { type: sql.NVarChar(128), value: schema } },
    );
    return rows.map((r) => ({
      schema,
      name: r.table_name,
      type: r.table_type === "VIEW" ? ("VIEW" as const) : ("TABLE" as const),
    }));
  });
}

export async function describeTable(database: string, schema: string, table: string): Promise<TableMetadata> {
  assertTableAllowed(database, schema, table);
  return cached(`meta:describe:${database}:${schema}:${table}`, async () => {
    const { rows: colRows } = await runQuery<{
      column_name: string;
      data_type: string;
      max_length: number | null;
      is_nullable: string;
      ordinal_position: number;
      is_identity: number;
    }>(
      database,
      `SELECT
         c.COLUMN_NAME AS column_name,
         c.DATA_TYPE AS data_type,
         c.CHARACTER_MAXIMUM_LENGTH AS max_length,
         c.IS_NULLABLE AS is_nullable,
         c.ORDINAL_POSITION AS ordinal_position,
         COLUMNPROPERTY(OBJECT_ID(@qualified), c.COLUMN_NAME, 'IsIdentity') AS is_identity
       FROM INFORMATION_SCHEMA.COLUMNS c
       WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
       ORDER BY c.ORDINAL_POSITION`,
      {
        schema: { type: sql.NVarChar(128), value: schema },
        table: { type: sql.NVarChar(128), value: table },
        qualified: { type: sql.NVarChar(256), value: `${schema}.${table}` },
      },
    );

    const { rows: pkRows } = await runQuery<{ column_name: string }>(
      database,
      `SELECT ku.COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
         ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA
       WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @schema AND tc.TABLE_NAME = @table`,
      { schema: { type: sql.NVarChar(128), value: schema }, table: { type: sql.NVarChar(128), value: table } },
    );
    const pkSet = new Set(pkRows.map((r) => r.column_name));

    let rowCountApprox: number | null = null;
    try {
      const { rows: cntRows } = await runQuery<{ approx_rows: number }>(
        database,
        `SELECT SUM(p.rows) AS approx_rows
         FROM sys.partitions p
         JOIN sys.tables t ON t.object_id = p.object_id
         JOIN sys.schemas s ON s.schema_id = t.schema_id
         WHERE s.name = @schema AND t.name = @table AND p.index_id IN (0,1)`,
        { schema: { type: sql.NVarChar(128), value: schema }, table: { type: sql.NVarChar(128), value: table } },
      );
      rowCountApprox = cntRows[0]?.approx_rows ?? null;
    } catch {
      rowCountApprox = null; // views have no partitions; not an error
    }

    const columns: ColumnMetadata[] = colRows.map((r) => ({
      name: r.column_name,
      dataType: r.data_type,
      maxLength: r.max_length,
      isNullable: r.is_nullable === "YES",
      isPrimaryKey: pkSet.has(r.column_name),
      isIdentity: r.is_identity === 1,
      ordinalPosition: r.ordinal_position,
      description: null, // populated from business metadata layer if configured
    }));

    return {
      database,
      schema,
      table,
      type: colRows.length > 0 ? "TABLE" : "VIEW",
      columns,
      primaryKeyColumns: [...pkSet],
      rowCountApprox,
    };
  });
}

export async function getRelationships(
  database: string,
  schema: string,
  table: string,
): Promise<ForeignKeyMetadata[]> {
  assertTableAllowed(database, schema, table);
  return cached(`meta:fk:${database}:${schema}:${table}`, async () => {
    const { rows } = await runQuery<{
      constraint_name: string;
      from_column: string;
      to_schema: string;
      to_table: string;
      to_column: string;
    }>(
      database,
      `SELECT
         fk.name AS constraint_name,
         cpa.name AS from_column,
         SCHEMA_NAME(tr.schema_id) AS to_schema,
         tr.name AS to_table,
         cref.name AS to_column
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.tables tp ON tp.object_id = fk.parent_object_id
       JOIN sys.schemas sp ON sp.schema_id = tp.schema_id
       JOIN sys.tables tr ON tr.object_id = fk.referenced_object_id
       JOIN sys.columns cpa ON cpa.object_id = fkc.parent_object_id AND cpa.column_id = fkc.parent_column_id
       JOIN sys.columns cref ON cref.object_id = fkc.referenced_object_id AND cref.column_id = fkc.referenced_column_id
       WHERE sp.name = @schema AND tp.name = @table`,
      { schema: { type: sql.NVarChar(128), value: schema }, table: { type: sql.NVarChar(128), value: table } },
    );
    return rows.map((r) => ({
      constraintName: r.constraint_name,
      fromColumn: r.from_column,
      toSchema: r.to_schema,
      toTable: r.to_table,
      toColumn: r.to_column,
    }));
  });
}

export async function sampleTable(
  database: string,
  schema: string,
  table: string,
  limit: number,
): Promise<Record<string, unknown>[]> {
  assertTableAllowed(database, schema, table);
  assertSafeIdentifier(schema, "schema");
  assertSafeIdentifier(table, "table");
  const cappedLimit = Math.min(Math.max(1, limit), config.limits.maxRows, 50);

  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const { rows } = await runQuery(
    database,
    `SELECT TOP (@limit) * FROM ${qualified}`,
    { limit: { type: sql.Int, value: cappedLimit } },
  );
  return rows;
}

export async function getDistinctValues(
  database: string,
  schema: string,
  table: string,
  column: string,
  limit: number,
): Promise<unknown[]> {
  assertTableAllowed(database, schema, table);
  assertSafeIdentifier(schema, "schema");
  assertSafeIdentifier(table, "table");
  assertSafeIdentifier(column, "column");
  const cappedLimit = Math.min(Math.max(1, limit), 500);

  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const col = quoteIdentifier(column);
  const { rows } = await runQuery<Record<string, unknown>>(
    database,
    `SELECT DISTINCT TOP (@limit) ${col} AS value FROM ${qualified} WHERE ${col} IS NOT NULL ORDER BY ${col}`,
    { limit: { type: sql.Int, value: cappedLimit } },
  );
  return rows.map((r) => r.value);
}
