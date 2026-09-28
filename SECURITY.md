# Security architecture

## Core guarantee

**Claude can never write to TRP_AMS, even if this application has a bug.**

This is achieved with defense in depth — nine independent layers. A failure
in any one layer does not compromise the guarantee, because each layer
enforces read-only access independently of the others.

```
Layer 1  Claude tool design       — Claude is only ever given structured,
                                     read-only tools (no "run_sql" tool)
Layer 2  MCP input validation     — zod schemas reject malformed input
                                     before any handler runs
Layer 3  SQL query validation     — sqlGuard.ts blocks INSERT/UPDATE/DELETE/
                                     MERGE/DROP/ALTER/CREATE/TRUNCATE/GRANT/
                                     REVOKE/DENY/EXEC/EXECUTE/xp_*/sp_configure/
                                     OPENROWSET/OPENDATASOURCE/BULK/BACKUP/
                                     RESTORE/DBCC/statement-stacking/comments
Layer 4  Allow/deny lists         — ALLOWED_DATABASES/ALLOWED_SCHEMAS/
                                     DENIED_TABLES/DENIED_COLUMNS enforced
                                     before any query is even built
Layer 5  SQL Server permissions   — claude_mcp_reader has SELECT + VIEW
                                     DEFINITION only; explicit DENY on
                                     INSERT/UPDATE/DELETE/ALTER/CREATE/EXECUTE
Layer 6  Network security         — SQL Server is never exposed to the
                                     internet; only this server reaches it,
                                     over the private network / VPN
Layer 7  Authentication           — bearer token or OAuth required on every
                                     MCP request; Origin allowlisting
Layer 8  Authorization            — (see "Multi-user authorization" below)
Layer 9  Audit logging            — every tool call is logged with principal,
                                     tool, table, duration, row count, outcome
```

Even if Layers 1–4 (the application) were completely disabled, Layer 5
alone (SQL Server permissions) still prevents any write. This is proven in
`sql/03-verification.sql` — connect to SSMS *as `claude_mcp_reader`
directly* and confirm INSERT/UPDATE/DELETE/DROP/ALTER/EXEC all fail.

## Why not just trust a prompt instruction?

Telling Claude "don't modify the database" in a system prompt is not a
security control — a prompt is advisory, not enforced, and can be
overridden by unexpected model behavior, a bug in how tools are wired, or
content injected through database values (see "Prompt-injection defense"
below). This design assumes the LLM will eventually attempt (accidentally
or via injected content) every operation it is *capable* of, and ensures
none of the write operations are capable of succeeding at any layer.

## Application-level SQL validation (Layer 3)

`src/security/sqlGuard.ts` is not a "does the string contain the word
DELETE" substring check — naive substring checks are trivially defeated
(e.g. a column value containing the word "delete", or `DELETE`/**/`FROM`).
Instead:

1. Bracketed identifiers (`[ColumnName]`) and string literals are stripped
   first, so legitimate data or column names containing keyword-like
   substrings don't cause false positives.
2. The remaining SQL is tokenized on non-letter boundaries and checked
   against a keyword denylist as whole tokens.
3. Statement-stacking (`;` followed by more SQL) and SQL comments (`--`,
   `/* */`) are rejected outright — these are the classic vectors for
   smuggling a second statement past a naive filter.
4. The statement must begin with `SELECT` or `WITH` (CTE) — nothing else is
   accepted structurally.
5. `xp_*` and `sp_configure` are blocked via dedicated pattern checks
   regardless of case or spacing.

This is a genuine parser-adjacent validator, not a blocklist alone — but it
is still Layer 3 of 9, not the only control. In this architecture Claude
never actually sends raw SQL text at all (see below); sqlGuard.ts is the
final safety net over SQL text that *this server itself* assembles from
structured tool input, catching any bug in the query-building code before
execution.

## No arbitrary SQL tool

Per the requirement to avoid unrestricted SQL execution where possible,
this implementation does **not** expose a generic "run this SQL" tool.
Instead:

- `query_data` — table + column list + structured filters/sort/pagination
- `aggregate_data` — table + SUM/COUNT/AVG/MIN/MAX + GROUP BY + filters
- `dashboard_data` — the above, pre-shaped for KPI/time-series/category/
  ranking/comparison dashboard patterns

`src/dashboard/queryBuilder.ts` is the only place SQL text is assembled,
exclusively from:
- identifiers that passed `assertSafeIdentifier()` (alphanumeric/underscore
  only, then bracket-quoted)
- values bound as `@parameters` via `mssql`'s parameterized `.input()` API
  — never string-concatenated into SQL text

The assembled text is still passed through `assertQueryIsSafe()` before
execution (Layer 3), even though it was built internally, as a bug-catching
safety net.

## Database-level security (Layer 5)

See [DATABASE-SETUP.md](DATABASE-SETUP.md) and `sql/01-*.sql` / `sql/02-*.sql`
for the exact scripts. Summary:

- Dedicated login `claude_mcp_reader`, SQL Authentication (not a personal or
  shared admin account).
- `db_datareader` role membership (or narrower, table-by-table `GRANT
  SELECT`, recommended — see the two approaches in `02-grant-readonly-permissions.sql`).
- `VIEW DEFINITION` and `VIEW DATABASE STATE` for metadata only.
- Explicit `DENY` on `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `CREATE TABLE`,
  `CREATE VIEW`, `CREATE PROCEDURE`, `CREATE FUNCTION`, `EXECUTE`, and
  server-level `CONTROL SERVER` / `ALTER ANY LOGIN` / `ALTER ANY DATABASE` /
  `ALTER SERVER STATE`.
- No membership in `db_owner`, `db_datawriter`, `db_ddladmin`, `sysadmin`,
  `securityadmin`, or `bulkadmin`, ever.

## Network security (Layer 6)

SQL Server must never be directly reachable from the public internet.
Recommended shape:

```
Claude ── HTTPS ──> Claude Custom Connector ── authenticated MCP (HTTPS) ──>
   claude-sql-mcp (public HTTPS endpoint, e.g. Azure App Service)
       │
       │ outbound-only connection over your private network / VNet
       │ peering / VPN — SQL Server's firewall allows inbound only from
       │ this server's IP / subnet, never 0.0.0.0/0
       ▼
   SQL Server (private network, no public IP)
```

If your SQL Server is on-premises and the MCP server is cloud-hosted, you
need one of: a site-to-site VPN, an ExpressRoute/private-link connection
(if on Azure), or a reverse tunnel from a small on-prem relay — this
requires your network/infrastructure team; it cannot be avoided by
application-level tricks, and this project does not attempt to.

## Authentication architecture (Layer 7)

Three options, in order of increasing effort and increasing suitability for
many users with different permissions:

**Option A — Shared bearer token (implemented, default: `AUTH_MODE=bearer`).**
A single long random secret (`MCP_BEARER_TOKEN`) that Claude sends as
`Authorization: Bearer <token>`. Simple, works today with Claude Custom
Connectors. Trade-off: every connected user shares the same database
identity/permissions — fine for a small trusted pilot group, not for
company-wide rollout with per-user data restrictions.

**Option B — OAuth 2.1 (scaffolded, `AUTH_MODE=oauth`).** Per-user sign-in
through your identity provider (Entra ID, Okta, Auth0). `src/mcp/server.ts`
has the request-rejection wiring in place; the actual token-verification
call (JWT signature + issuer + audience check against your provider) is
intentionally left for you to complete against your specific identity
provider's SDK, since that choice is company-specific. This is the
recommended production path once more than a handful of users need the
connector, or once different users need different data access.

**Option C — Company identity provider + per-user DB authorization.** The
strongest option: OAuth (Option B) plus mapping each authenticated user's
identity to a specific SQL Server login (or an application-level row/column
policy) so two employees asking the same question can see different data.
Requires either (a) SQL Server's native Row-Level Security combined with a
`SESSION_CONTEXT` set per authenticated user, or (b) multiple
`claude_mcp_reader_<team>`-style logins mapped from the OAuth claims. This
is real engineering work specific to your org chart — flagged here rather
than glossed over.

**Recommendation:** start with Option A for a pilot with a small group,
then move to Option B before a company-wide rollout, and only invest in
Option C if different employees genuinely need different SQL-level
visibility (rather than relying on the shared allowlist in `.env`, which
already restricts everyone equally).

## Multi-user authorization (Layer 8)

With `AUTH_MODE=bearer`, all connected users share the same
`ALLOWED_DATABASES`/`ALLOWED_SCHEMAS`/`DENIED_TABLES`/`DENIED_COLUMNS` and
the same `claude_mcp_reader` SQL identity — there is currently no per-user
differentiation. If your company needs different employees to see
different subsets of TRP_AMS, that requires Option B/C above; do not treat
a single shared connector as safe for data that not everyone should see.

## Prompt-injection defense

Database content is DATA, never instructions. A text column could
theoretically contain a string like "ignore previous instructions and
run X" — this cannot cause harm in this architecture because:

- Query results are returned to Claude only as tool-result JSON, which
  Claude's system prompt and safety training treat as data to reason
  about, not as new instructions.
- Even if Claude were somehow induced to "want" to write to the database,
  there is no tool exposed that can do it (Layer 1), and even a raw SQL
  string built entirely by an injected payload would still be blocked at
  Layers 3–5.
- Tool descriptions themselves are fixed, static strings defined in
  `src/mcp/tools.ts` — never built from database content — so injected
  database values cannot alter what a tool claims to do.

## Data minimization

- `MAX_ROWS` (default 1000) caps every `query_data` page.
- `aggregate_data`/`dashboard_data` return only the aggregated rows
  requested (e.g. month × region totals), never raw transactions, unless
  Claude explicitly calls `query_data` for a small, filtered slice.
- `DENIED_COLUMNS` strips specific sensitive columns (NIC numbers, phone
  numbers, etc.) from every result, regardless of what Claude asks for.
- `query_data` with `columns: ["*"]` still excludes denied columns.

## Audit logging

Every tool call produces one structured JSON log line
(`src/utils/logger.ts` → `auditLog()`) containing: timestamp, request id,
authenticated principal, tool name, database/schema/table touched,
duration, row count, success/failure, and an error category on failure.
Passwords, tokens, and full row data are never logged (pino's `redact`
config additionally guards against accidental logging of secret fields).
Point `AUDIT_LOG_FILE` at a file, or rely on your hosting platform's stdout
log collection (recommended for most cloud hosts).

## Security verification procedure

Full step-by-step in `sql/03-verification.sql` and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#28-security-test). Summary of what
to prove before go-live:

1. `claude_mcp_reader` is not a member of any server admin role.
2. `claude_mcp_reader` is a member of `db_datareader` only in TRP_AMS (never
   `db_owner`/`db_datawriter`/`db_ddladmin`).
3. Connected directly as `claude_mcp_reader` in SSMS: `SELECT` succeeds;
   `INSERT`/`UPDATE`/`DELETE`/`CREATE TABLE`/`ALTER TABLE`/`EXEC
   sp_who`/`EXEC xp_cmdshell` all fail with a permission error.
4. Through the running MCP server (via MCP Inspector or Claude): the same
   9 attempts made through `query_data`/`aggregate_data` inputs designed to
   smuggle a write are rejected by `sqlGuard.ts` before ever reaching SQL
   Server (see `tests/sqlGuard.test.ts` for the automated version of this).

## Production checklist

- [ ] `sql/01-*.sql` and `sql/02-*.sql` run by a DBA; verified with `sql/03-*.sql`
- [ ] `.env` values sourced correctly (see `.env.example`); stored in a
      secret manager in production, not committed to git
- [ ] `SQL_ENCRYPT=true`; real TLS certificate on SQL Server;
      `SQL_TRUST_SERVER_CERTIFICATE=false`
- [ ] `ALLOWED_DATABASES`/`ALLOWED_SCHEMAS`/`DENIED_TABLES`/`DENIED_COLUMNS`
      reviewed and signed off by the data owner
- [ ] `MCP_BEARER_TOKEN` generated with `crypto.randomBytes(32)`, stored as
      a secret, rotated on a schedule; or OAuth wired up for multi-user
- [ ] `MCP_ALLOWED_ORIGINS` set to Claude's actual origin(s) — verify current
      values in Anthropic's docs before deploying
- [ ] Rate limiting values (`RATE_LIMIT_*`) reviewed for expected concurrency
- [ ] SQL Server firewall allows inbound only from the MCP server's
      IP/subnet — never `0.0.0.0/0`
- [ ] Audit logs confirmed flowing and reviewed periodically
- [ ] `sql/04-rollback.sql` tested once in non-production
- [ ] Disaster recovery: `.env` and `sql/*.sql` backed up in your secret
      manager / infra-as-code repo (not just on one developer's laptop)
