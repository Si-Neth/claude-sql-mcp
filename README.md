# claude-sql-mcp

A permanent, read-only remote MCP (Model Context Protocol) server that lets
Claude securely query your Microsoft SQL Server environment (TRP_AMS) and
build dashboards — without anyone manually exporting data and pasting it
into a chat.

**Stack:** Node.js + TypeScript only. No Python anywhere.

```
Employee's Claude
      │  HTTPS (Claude Custom Connector)
      ▼
Claude Custom Connector
      │  Authenticated MCP (Streamable HTTP)
      ▼
claude-sql-mcp  (Node.js/TypeScript, this repo)
  ├─ Auth (bearer token or OAuth)
  ├─ Origin / rate limiting
  ├─ Allow/deny list (database/schema/table/column)
  ├─ SQL safety validator (blocks INSERT/UPDATE/DELETE/DDL/EXEC/xp_*/...)
  ├─ Structured query engine (query_data / aggregate_data / dashboard_data)
  ├─ Metadata discovery + cache
  └─ Audit logging
      │  Parameterized, read-only SQL over TLS
      ▼
Microsoft SQL Server — TRP_AMS
  (dedicated claude_mcp_reader login, SELECT-only)
```

## Why this architecture

- **SQL Server is never exposed to the internet.** Only this Node.js server
  talks to SQL Server, over your private network. The internet-facing side
  is this server's own HTTPS endpoint.
- **Defense in depth.** Nine independent layers — see [SECURITY.md](SECURITY.md)
  — mean that even a bug in this application still cannot let Claude write
  to your database, because the SQL login itself has no write permission.
- **No arbitrary SQL from Claude.** Claude calls structured tools
  (`query_data`, `aggregate_data`, `dashboard_data`, ...) with JSON
  arguments; this server is the only thing that ever builds SQL text, and
  every fragment is validated before execution.
- **Employees install nothing.** Only the server (one machine or one cloud
  service) needs Node.js. Employees just use Claude with the connector
  enabled.

## Documentation map

| Doc | Purpose |
|---|---|
| [DATABASE-SETUP.md](DATABASE-SETUP.md) | For your DBA: creating the read-only SQL login, permissions, verification |
| [SECURITY.md](SECURITY.md) | The full defense-in-depth model, authentication options, prompt-injection handling |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Local Windows setup, production hosting options, HTTPS, process management |
| [CLAUDE-CONNECTOR.md](CLAUDE-CONNECTOR.md) | Registering this server as a Claude Custom Connector (personal + Team/Enterprise) |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Cause → verification → fix, for every stage |
| `.env.example` | Every configuration value, what it means, where to get it |

## Quick start (development, Windows 11)

```powershell
# 1. Clone / unzip this project, then:
cd claude-sql-mcp
npm install

# 2. Configure
copy .env.example .env
notepad .env      # fill in real values — see .env.example and DATABASE-SETUP.md

# 3. Run
npm run dev
# -> claude-sql-mcp listening on http://localhost:8787/mcp

# 4. In another terminal, sanity-check it
npx @modelcontextprotocol/inspector
# point the Inspector at http://localhost:8787/mcp with your MCP_BEARER_TOKEN
```

Full step-by-step (including SQL Server account creation) is in
[DATABASE-SETUP.md](DATABASE-SETUP.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## Project structure

```
claude-sql-mcp/
├── src/
│   ├── server.ts              # entrypoint
│   ├── config.ts              # env parsing + validation
│   ├── types.ts                # shared types, McpToolError
│   ├── database/
│   │   └── pool.ts            # SQL Server connection pooling, parameterized query runner
│   ├── security/
│   │   ├── sqlGuard.ts        # statement validator, identifier quoting
│   │   ├── allowlist.ts       # database/schema/table/column allow-deny lists
│   │   └── rateLimiter.ts
│   ├── metadata/
│   │   ├── discovery.ts       # list_databases/schemas/tables, describe_table, get_relationships, sample_table, get_distinct_values
│   │   └── cache.ts           # in-memory metadata cache (TTL from .env)
│   ├── dashboard/
│   │   ├── queryBuilder.ts    # query_data, aggregate_data (safe, structured SQL generation)
│   │   └── dashboardEngine.ts # dashboard_data (kpi/time_series/category_breakdown/ranking/comparison)
│   ├── mcp/
│   │   ├── tools.ts           # all MCP tool registrations + audit wrapper
│   │   └── server.ts          # Express + Streamable HTTP transport, auth, CORS
│   └── utils/
│       └── logger.ts          # pino structured logging + audit log
├── sql/
│   ├── 01-create-login-and-user.sql
│   ├── 02-grant-readonly-permissions.sql
│   ├── 03-verification.sql
│   └── 04-rollback.sql
├── config/
│   └── business-metadata.example.json   # optional semantic layer
├── tests/
│   ├── sqlGuard.test.ts
│   └── allowlist.test.ts
├── .env.example
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## The 11 MCP tools

| Tool | Purpose |
|---|---|
| `list_databases` | Databases visible to the connector |
| `list_schemas` | Schemas within a database |
| `list_tables` | Tables/views within a schema |
| `describe_table` | Columns, types, nullability, primary key, approx. row count |
| `get_relationships` | Foreign keys from a table |
| `sample_table` | Small row sample (max 50) for exploration |
| `get_distinct_values` | Distinct values of a column (for filters) |
| `query_data` | Filtered/sorted/paginated rows from one table |
| `aggregate_data` | SUM/COUNT/AVG/MIN/MAX with GROUP BY |
| `dashboard_data` | KPI / time-series / category / ranking / comparison, dashboard-ready |
| `health_check` | Server + SQL connectivity status (no secrets returned) |

Claude is expected to call `list_databases` → `list_schemas` → `list_tables`
→ `describe_table` → `get_relationships` as needed to understand your
schema, then use `dashboard_data` (or `aggregate_data`/`query_data`) to
fetch only the aggregated data actually needed for a chart — never raw
millions-of-rows dumps. See [SECURITY.md](SECURITY.md) for the worked
end-to-end dashboard example.

## Example: end-to-end dashboard request

**User:** "Create a dashboard showing 2026 monthly sales by region."

1. Claude calls `list_databases` → sees `TRP_AMS`.
2. Claude calls `list_tables` on `dbo` → notices `vw_MonthlySalesByRegion`
   (a reporting view) alongside raw tables.
3. Claude calls `describe_table` on the view → sees `SaleMonth`, `RegionName`,
   `TotalSales` columns.
4. Claude calls:
   ```json
   {
     "tool": "dashboard_data",
     "database": "TRP_AMS", "schema": "dbo", "table": "vw_MonthlySalesByRegion",
     "requestType": "comparison",
     "metric": { "function": "SUM", "column": "TotalSales", "alias": "total_sales" },
     "categoryColumn": "RegionName",
     "compareColumn": "SaleMonth",
     "filters": [{ "column": "SaleMonth", "operator": "gte", "value": "2026-01-01" }]
   }
   ```
5. SQL Server returns a small, pre-aggregated result set (month × region ×
   total), never the underlying transactions.
6. Claude renders the chart and states any caveats (e.g. partial current
   month).
7. Follow-up — "Filter this to Colombo" — Claude adds a filter and calls
   `dashboard_data` again with `{"column":"RegionName","operator":"eq","value":"Colombo"}`.

## Testing

```powershell
npm test              # unit tests: SQL safety + allowlist (33 tests)
npm run build          # type-check + compile
npx @modelcontextprotocol/inspector   # interactive protocol-level testing
```

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md#28-security-test) for the full
manual security verification procedure (proving `claude_mcp_reader` cannot
write, at both the SQL Server level and the application level).

## Production checklist

See the bottom of [SECURITY.md](SECURITY.md) for the full checklist. In short:

- [ ] `sql/01-04*.sql` run by DBA; `claude_mcp_reader` verified read-only (03-verification.sql, all write attempts fail)
- [ ] `.env` populated from a secret manager in production, not a plain file
- [ ] `ALLOWED_DATABASES` / `ALLOWED_SCHEMAS` / `DENIED_TABLES` / `DENIED_COLUMNS` reviewed with the data owner
- [ ] `SQL_ENCRYPT=true`, valid TLS certificate on SQL Server, `SQL_TRUST_SERVER_CERTIFICATE=false`
- [ ] Server deployed behind HTTPS with a stable URL (see DEPLOYMENT.md)
- [ ] `MCP_BEARER_TOKEN` (or OAuth) configured; rotated on a schedule
- [ ] Audit logging confirmed working and reviewed periodically
- [ ] Connector registered in Claude (Team/Enterprise) — see CLAUDE-CONNECTOR.md
- [ ] Rollback script (`sql/04-rollback.sql`) tested once in a non-production environment
