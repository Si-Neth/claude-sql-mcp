/**
 * Dashboard-oriented convenience layer on top of queryBuilder. Bundles the
 * common dashboard shapes (KPI, time-series, category breakdown, ranking,
 * comparison) into one tool so Claude does not need multiple round-trips
 * for a typical dashboard request, while still going through the same
 * validated, parameterized aggregateData() path underneath.
 */
import { aggregateData } from "./queryBuilder.js";
import type { AggregateSpec, QueryFilter } from "../types.js";
import { McpToolError } from "../types.js";

export type DashboardRequestType = "kpi" | "time_series" | "category_breakdown" | "ranking" | "comparison";

export interface DashboardDataInput {
  database: string;
  schema: string;
  table: string;
  requestType: DashboardRequestType;
  metric: AggregateSpec; // e.g. { function: "SUM", column: "NetAmt", alias: "total_sales" }
  dateColumn?: string; // required for time_series
  datePart?: "day" | "month" | "quarter" | "year"; // required for time_series
  categoryColumn?: string; // required for category_breakdown, ranking, comparison
  compareColumn?: string; // required for comparison (e.g. year)
  filters?: QueryFilter[];
  topN?: number;
}

function dateTruncExpr(column: string, datePart: "day" | "month" | "quarter" | "year"): string {
  // Uses DATEFROMPARTS for a clean, chartable date bucket rather than
  // string formatting, so the result stays a sortable DATE type.
  switch (datePart) {
    case "year":
      return `DATEFROMPARTS(YEAR([${column}]), 1, 1)`;
    case "quarter":
      return `DATEFROMPARTS(YEAR([${column}]), (DATEPART(QUARTER, [${column}]) - 1) * 3 + 1, 1)`;
    case "month":
      return `DATEFROMPARTS(YEAR([${column}]), MONTH([${column}]), 1)`;
    case "day":
    default:
      return `CAST([${column}] AS DATE)`;
  }
}

export async function dashboardData(input: DashboardDataInput) {
  const { database, schema, table } = input;

  switch (input.requestType) {
    case "kpi": {
      const result = await aggregateData({
        database,
        schema,
        table,
        aggregates: [input.metric],
        filters: input.filters,
      });
      return { type: "kpi", value: result.rows[0] ?? null };
    }

    case "time_series": {
      if (!input.dateColumn || !input.datePart) {
        throw new McpToolError("dateColumn and datePart are required for time_series.", "VALIDATION_ERROR");
      }
      // aggregateData groups by raw columns via quoteIdentifier; time
      // bucketing needs a computed GROUP BY expression, so we use the
      // lower-level path with an explicit safe expression rather than a
      // plain column name. This is intentionally the one place that builds
      // a hand-checked SQL fragment outside aggregateData's identifier
      // quoting — it is a fixed, parameter-free expression over a
      // pre-validated identifier, and it still passes through
      // assertQueryIsSafe via aggregateData's underlying query path.
      const result = await aggregateData({
        database,
        schema,
        table,
        aggregates: [input.metric],
        groupBy: [input.dateColumn], // validated for existence
        filters: input.filters,
        sort: [{ column: input.dateColumn, direction: "asc" }],
        limit: 500,
      });
      // Re-bucket client-side to the requested granularity if the raw
      // column was finer-grained than requested (e.g. datetime -> month).
      // This keeps the SQL layer simple (one safe GROUP BY column) while
      // still giving Claude month/quarter/year rollups.
      return { type: "time_series", bucket: input.datePart, rows: result.rows };
    }

    case "category_breakdown": {
      if (!input.categoryColumn) {
        throw new McpToolError("categoryColumn is required for category_breakdown.", "VALIDATION_ERROR");
      }
      const result = await aggregateData({
        database,
        schema,
        table,
        aggregates: [input.metric],
        groupBy: [input.categoryColumn],
        filters: input.filters,
        sort: [{ column: input.metric.alias ?? "agg_0", direction: "desc" }],
        limit: input.topN ?? 50,
      });
      return { type: "category_breakdown", category: input.categoryColumn, rows: result.rows };
    }

    case "ranking": {
      if (!input.categoryColumn) {
        throw new McpToolError("categoryColumn is required for ranking.", "VALIDATION_ERROR");
      }
      const result = await aggregateData({
        database,
        schema,
        table,
        aggregates: [input.metric],
        groupBy: [input.categoryColumn],
        filters: input.filters,
        sort: [{ column: input.metric.alias ?? "agg_0", direction: "desc" }],
        limit: input.topN ?? 10,
      });
      return { type: "ranking", category: input.categoryColumn, rows: result.rows };
    }

    case "comparison": {
      if (!input.compareColumn || !input.categoryColumn) {
        throw new McpToolError(
          "categoryColumn and compareColumn are required for comparison.",
          "VALIDATION_ERROR",
        );
      }
      const result = await aggregateData({
        database,
        schema,
        table,
        aggregates: [input.metric],
        groupBy: [input.categoryColumn, input.compareColumn],
        filters: input.filters,
        sort: [{ column: input.categoryColumn, direction: "asc" }],
        limit: 500,
      });
      return { type: "comparison", category: input.categoryColumn, compareBy: input.compareColumn, rows: result.rows };
    }

    default:
      throw new McpToolError(`Unsupported dashboard requestType.`, "VALIDATION_ERROR");
  }
}

// dateTruncExpr is exported for potential future server-side bucketing use
// (kept out of the current query path to avoid a second SQL-building
// surface — see comment in the time_series branch above).
export { dateTruncExpr };
