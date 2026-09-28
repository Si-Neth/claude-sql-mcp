# Troubleshooting

Format: **Symptom → Cause → Verification → Solution**

## Node.js / npm

**"node is not recognized"**
- Cause: Node.js not installed or not on PATH.
- Verify: `node --version` (need 18.17+).
- Fix: install from https://nodejs.org (LTS), restart terminal.

**`npm install` fails**
- Cause: usually network/proxy restrictions, or a stale lockfile.
- Verify: `npm install --verbose` and read the first error.
- Fix: confirm your company proxy allows `registry.npmjs.org`; delete
  `node_modules` and `package-lock.json` and retry if the lockfile looks
  corrupted.

## SQL Server connection

**"TRP_AMS database is currently unavailable" / connection errors on startup**
- Cause: wrong host/port, firewall blocking the MCP server's IP, or SQL
  Server not running.
- Verify: from the machine running the MCP server, `Test-NetConnection
  -ComputerName <SQL_SERVER_HOST> -Port <SQL_SERVER_PORT>` in PowerShell.
  If this fails, it's a network/firewall issue, not the application.
- Fix: ask your network/DBA team to open the firewall from this server's
  IP to SQL Server's port.

**Login failed for user 'claude_mcp_reader'**
- Cause: wrong password in `.env`, or the login wasn't created / is
  disabled.
- Verify: try connecting in SSMS with the exact same credentials, SQL
  Server Authentication.
- Fix: re-run `sql/01-create-login-and-user.sql`, confirm `CHECK_POLICY`
  hasn't locked the account after failed attempts (`ALTER LOGIN
  claude_mcp_reader WITH PASSWORD = '...' UNLOCK;` if needed).

**TLS / certificate error**
- Cause: `SQL_ENCRYPT=true` with `SQL_TRUST_SERVER_CERTIFICATE=false`, but
  SQL Server's certificate isn't trusted by the connecting machine.
- Verify: the exact mssql driver error will mention certificate validation.
- Fix: either install a CA-trusted certificate on SQL Server (preferred,
  production), or temporarily set `SQL_TRUST_SERVER_CERTIFICATE=true`
  while testing on a trusted internal network only.

## MCP endpoint / Claude connectivity

**Claude cannot connect to the connector**
- Cause: URL not publicly reachable, or wrong URL registered.
- Verify: from an external network (e.g. your phone's cellular data,
  not company wifi), `curl https://your-domain/healthz` — must return
  200 with `{"status":"ok"}`.
- Fix: check your reverse proxy / hosting platform's public networking
  config; confirm DNS resolves; confirm HTTPS certificate is valid (not
  self-signed, unless Claude's infra is configured to trust it, which it
  generally is not).

**401 Unauthorized on every request**
- Cause: `MCP_BEARER_TOKEN` mismatch, or the connector's auth field in
  Claude wasn't filled in.
- Verify: run `curl -H "Authorization: Bearer <token>" -X POST
  https://your-domain/mcp -H "Content-Type: application/json" -d
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'`
  and confirm you get a JSON-RPC response, not 401.
- Fix: re-copy the token exactly (no trailing whitespace) into both `.env`
  and the Claude connector config.

**403 "Origin not allowed"**
- Cause: `MCP_ALLOWED_ORIGINS` doesn't include the Origin header Claude's
  infrastructure is actually sending.
- Verify: check the server logs for the rejected `origin` value logged by
  `enforceOrigin()`.
- Fix: add that origin to `MCP_ALLOWED_ORIGINS` in `.env` (comma
  separated) after confirming it's a legitimate Anthropic origin, per
  current Anthropic documentation — don't blanket-allow `*`.

**Tool not appearing in Claude / "tool execution failed"**
- Cause: server crashed on a specific tool call, or a zod schema
  validation error.
- Verify: check server logs (`LOG_LEVEL=debug` temporarily) for the
  specific error; try the same call in MCP Inspector for a clearer error
  message.
- Fix: usually a malformed argument from Claude's side (rare) or a bug in
  the specific handler — check the audit log entry's `errorCategory`.

## Authentication error (multi-user / OAuth)

**"AUTH_MODE=oauth ... not wired up in this deployment" (501 error)**
- Cause: you set `AUTH_MODE=oauth` but haven't implemented the token
  verification call in `src/mcp/server.ts`'s `authenticate()` function.
- Fix: see SECURITY.md "Authentication architecture" Option B, and
  integrate your identity provider's token-verification SDK there before
  switching `AUTH_MODE` to `oauth` in production.

## Data / query issues

**Empty results**
- Cause: filters too narrow, wrong schema/table name, or the data is in a
  different database than `SQL_DATABASE` defaults to.
- Verify: call `list_databases` / `list_tables` / `sample_table` to confirm
  the table has data and you're pointed at the right database.
- Fix: adjust filters, or add the other database to `ALLOWED_DATABASES`.

**"The requested data source is not available to this connector"**
- Cause: the database/schema/table is not in `ALLOWED_DATABASES` /
  `ALLOWED_SCHEMAS`, or is explicitly in `DENIED_TABLES`.
- Verify: check `.env` allowlist values.
- Fix: if access is actually intended, add it to the allowlist (with the
  data owner's sign-off).

**"This operation is not permitted because the connector is read-only"**
- Cause: `sqlGuard.ts` rejected the generated query — either a genuine
  write attempt was blocked (working as intended) or a legitimate query
  tripped a false positive (e.g. unusual identifier characters).
- Verify: check `tests/sqlGuard.test.ts` for the exact patterns blocked;
  reproduce the input via MCP Inspector.
- Fix: if it's a false positive on a legitimate read, the identifier
  probably contains a character outside `[A-Za-z0-9_]` — SQL Server object
  names with spaces/special characters aren't supported by this connector
  by design; consider exposing a view with a clean name instead.

**"The requested dataset is too large" / timeout**
- Cause: query against a huge table without enough filtering, or
  `MAX_QUERY_TIME_MS` too low for the workload.
- Fix: prefer `aggregate_data`/`dashboard_data` over `query_data` for large
  tables; add date-range filters; raise `MAX_QUERY_TIME_MS` moderately if
  genuinely needed (but prefer server-side aggregation first).

**Multiple-database discovery failure**
- Cause: `claude_mcp_reader` has no user mapped in one of the databases
  listed in `ALLOWED_DATABASES`.
- Fix: repeat the `CREATE USER` step in `sql/01-*.sql` for that database.

## 28. Security test

See `sql/03-verification.sql` for the full script. Quick version:

1. Connect to SSMS as `claude_mcp_reader` (SQL Authentication).
2. Run: `SELECT TOP 5 * FROM INFORMATION_SCHEMA.TABLES;` → must succeed.
3. Run, one at a time: an `INSERT`, `UPDATE`, `DELETE`, `CREATE TABLE`,
   `ALTER TABLE`, `EXEC sp_who`, `EXEC xp_cmdshell 'whoami'` against any
   real or dummy table → every one must fail with a permission error.
4. Run `npm test` — confirms the application-level validator
   (`sqlGuard.ts`) independently rejects the same categories of statement
   before they would even reach SQL Server.

If any statement in step 3 succeeds, stop using the connector in
production and fix the grants in `sql/02-grant-readonly-permissions.sql`
immediately.
