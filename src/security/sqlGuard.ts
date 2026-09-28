/**
 * Application-level SQL safety layer.
 *
 * IMPORTANT CONTEXT: in this architecture, Claude never sends raw SQL text.
 * Every MCP tool (list_tables, query_data, aggregate_data, dashboard_data,
 * ...) builds parameterized SQL internally from a structured input schema
 * (see dashboard/queryBuilder.ts). This file is the last line of defense
 * that inspects every piece of dynamic SQL text (identifiers, generated
 * fragments) this server ever sends to SQL Server, so that even a bug in
 * the query builder cannot smuggle a dangerous statement through.
 *
 * Defense in depth — this is Layer 2/3 of the 9 layers described in
 * SECURITY.md. Layers 5 (SQL Server permissions) and 4 (allowlist) do not
 * depend on this file being correct.
 */
import { McpToolError } from "../types.js";

/** Statement keywords that must never appear anywhere in generated SQL. */
const FORBIDDEN_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "GRANT",
  "REVOKE",
  "DENY",
  "EXEC",
  "EXECUTE",
  "SP_EXECUTESQL",
  "OPENROWSET",
  "OPENDATASOURCE",
  "OPENQUERY",
  "BULK",
  "BACKUP",
  "RESTORE",
  "DBCC",
  "SHUTDOWN",
  "RECONFIGURE",
  "WAITFOR",
  "XP_CMDSHELL",
] as const;

/** Extended stored procedure prefix — blocked regardless of case/spacing. */
const XP_SP_PREFIX = /\bxp_\w+/i;
const SP_CONFIGURE = /\bsp_configure\b/i;

/** A single valid SQL identifier: letters, digits, underscore, must not
 *  start with a digit. No brackets, no dots, no spaces, no quotes. Multi-
 *  part names (schema.table) must be validated part-by-part by the caller,
 *  never as one string. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Only these single characters are ever allowed to appear next to an
 *  identifier when it's interpolated into generated SQL (brackets used for
 *  quoting, dot for schema.table separation, comma/space for lists). */
export function assertSafeIdentifier(value: string, context: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new McpToolError(
      `"${context}" contains characters that are not permitted in a SQL identifier.`,
      "VALIDATION_ERROR",
    );
  }
}

/** Wrap a validated identifier in SQL Server bracket-quoting. Always call
 *  assertSafeIdentifier() first — quoteIdentifier() does not re-validate. */
export function quoteIdentifier(value: string): string {
  return `[${value.replace(/]/g, "]]")}]`;
}

/**
 * Scans a fully-assembled SQL statement (built exclusively from validated,
 * bracket-quoted identifiers and bound @parameters — never raw user text)
 * for forbidden keywords, as a final safety net before execution.
 *
 * Throws McpToolError("UNSAFE_QUERY") if anything forbidden is found.
 */
export function assertQueryIsSafe(queryText: string): void {
  // Strip string literals and bracketed identifiers before keyword-scanning
  // so that legitimate data values or column names (e.g. a column literally
  // named "CreateDate") don't trigger false positives, while keywords
  // hidden inside a comment or concatenation trick still get caught because
  // we scan the SQL *keyword* structure, not the identifiers.
  const withoutBracketedIdentifiers = queryText.replace(/\[[^\]]*\]/g, "");
  const withoutStringLiterals = withoutBracketedIdentifiers.replace(/'(?:[^']|'')*'/g, "''");

  // Must be a single statement: reject stacked queries via semicolon
  // (aside from one optional trailing semicolon) and SQL comments, which
  // are common obfuscation vectors.
  const trimmed = withoutStringLiterals.trim();
  const withoutTrailingSemicolon = trimmed.endsWith(";") ? trimmed.slice(0, -1) : trimmed;
  if (withoutTrailingSemicolon.includes(";")) {
    throw new McpToolError(
      "This operation is not permitted because the connector is read-only (multiple statements detected).",
      "UNSAFE_QUERY",
    );
  }
  if (/--/.test(withoutStringLiterals) || /\/\*/.test(withoutStringLiterals)) {
    throw new McpToolError(
      "This operation is not permitted because the connector is read-only (comment syntax detected).",
      "UNSAFE_QUERY",
    );
  }

  if (XP_SP_PREFIX.test(withoutStringLiterals) || SP_CONFIGURE.test(withoutStringLiterals)) {
    throw new McpToolError(
      "This operation is not permitted because the connector is read-only.",
      "UNSAFE_QUERY",
    );
  }

  const tokens = withoutStringLiterals
    .toUpperCase()
    .split(/[^A-Z_]+/)
    .filter(Boolean);
  const tokenSet = new Set(tokens);
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (tokenSet.has(keyword)) {
      throw new McpToolError(
        "This operation is not permitted because the connector is read-only.",
        "UNSAFE_QUERY",
      );
    }
  }

  // Must start with SELECT (after stripping a leading WITH ... CTE, which
  // is also read-only and fine to permit).
  const normalized = withoutStringLiterals.trim().toUpperCase();
  const startsWithSelect = normalized.startsWith("SELECT");
  const startsWithCte = normalized.startsWith("WITH");
  if (!startsWithSelect && !startsWithCte) {
    throw new McpToolError(
      "This operation is not permitted because the connector is read-only (only SELECT is allowed).",
      "UNSAFE_QUERY",
    );
  }
}

/** Validate a LIKE pattern value coming from tool input — still bound as a
 *  parameter, but we also cap length and reject control characters. */
export function assertSafeLikeValue(value: string): void {
  if (value.length > 200) {
    throw new McpToolError("Filter value is too long.", "VALIDATION_ERROR");
  }
}
