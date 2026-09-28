# Database setup (for your DBA)

This document is for whoever administers your SQL Server / TRP_AMS
environment. It requires `sysadmin` (or at minimum `securityadmin` at the
server level + `db_owner` on TRP_AMS) — a normal developer account cannot
run these scripts.

## Terminology, precisely

- **SQL Server instance** — the physical/virtual server process, reached
  via `SQL_SERVER_HOST` + `SQL_SERVER_PORT` (+ optional
  `SQL_SERVER_INSTANCE` for a named instance).
- **Database** — e.g. `TRP_AMS`. One instance can host multiple databases.
- **Schema** — a namespace within a database, e.g. `dbo`, `sales`.
- **Table / view** — within a schema.

If, in your environment, "TRP_AMS" refers to the whole SQL Server instance
(hosting several separate databases) rather than one database, set
`SQL_DATABASE` to whichever database the connector should default into,
and list every database it may read in `ALLOWED_DATABASES` (comma
separated) — the connector's `list_databases` tool will discover whichever
of those the login can see.

## Step 1 — Create the read-only login and user

Run `sql/01-create-login-and-user.sql` in SSMS, connected as `sysadmin`.

Before running:
1. Generate a strong password (20+ random characters). Do not reuse any
   existing password.
2. Replace `YOUR_STRONG_PASSWORD_HERE` in the script with it.
3. Decide whether this connector needs to read more than one database. If
   so, duplicate the `USE TRP_AMS; ... CREATE USER ...` block for each
   additional database.

This creates the `claude_mcp_reader` SQL login and denies it dangerous
server-level permissions up front (defense in depth — these DENYs are
redundant with "grant nothing" but make the intent explicit and auditable).

## Step 2 — Grant minimal read permissions

Run `sql/02-grant-readonly-permissions.sql`.

Choose **Approach A** (simplest: `db_datareader` role, grants SELECT on
every table/view in the database) or **Approach B** (recommended for
production: explicit per-schema/table grants, so sensitive tables are
blocked by SQL Server itself, not only by the application's `.env`
allowlist). The script has both, clearly commented — uncomment the one you
want and comment out the other.

Either way, the script finishes with explicit `DENY` statements confirming
no write/DDL/EXECUTE permission exists.

## Step 3 — Verify

Run `sql/03-verification.sql`. This has two parts:

1. **Metadata checks** (run as sysadmin) — confirm role memberships look
   right.
2. **Live security test** — connect to SSMS *as `claude_mcp_reader` itself*
   (SQL Server Authentication, not Windows Auth) and run each numbered
   statement one at a time. `SELECT` must succeed; every write/DDL/EXEC
   attempt must fail with a permission error. If anything succeeds that
   shouldn't, stop and fix Step 2 before proceeding.

## Step 4 — Give the values to whoever configures the connector

Hand off (via your secret manager, not email/chat) these `.env` values:

| .env variable | Value |
|---|---|
| `SQL_SERVER_HOST` | the instance hostname/IP |
| `SQL_SERVER_PORT` | usually 1433, or your configured port |
| `SQL_SERVER_INSTANCE` | only if a named instance |
| `SQL_DATABASE` | `TRP_AMS` (or your default database) |
| `SQL_USER` | `claude_mcp_reader` |
| `SQL_PASSWORD` | the password you generated |

## Choosing an authentication mode

**SQL Server Authentication (recommended, `SQL_AUTH_TYPE=sql`)** — used by
this project by default. The MCP server runs as a background service, not
an interactive Windows session, so Windows Integrated Authentication
(`SQL_AUTH_TYPE` other than `sql`) generally does not work cleanly for a
remotely hosted service unless you set up a Managed Service Account /
gMSA with Kerberos delegation — extra infrastructure most teams should
skip in favor of a dedicated SQL login with a strong, rotated password
stored in a secret manager.

**Microsoft Entra ID authentication** — applicable if TRP_AMS is (or
migrates to) Azure SQL Database/Managed Instance. Set
`SQL_AUTH_TYPE=azure-ad-default` or `azure-ad-msi` and configure an Entra
service principal instead of a SQL login; permissions are still granted
with the same `GRANT`/`DENY` model in `02-grant-readonly-permissions.sql`,
just against an Entra-mapped database user instead of a SQL login. Ask
your DBA whether TRP_AMS supports this before choosing it.

## TLS / encryption

Always keep `SQL_ENCRYPT=true`. For `SQL_TRUST_SERVER_CERTIFICATE`:
- `false` (recommended) — requires SQL Server to have a certificate issued
  by a CA the connecting machine trusts. Ask your PKI team to issue one if
  SQL Server doesn't already have a trusted certificate.
- `true` — only acceptable temporarily, during initial internal-network
  testing, never in production, since it disables certificate validation
  (vulnerable to a man-in-the-middle on the network path to SQL Server).

## Rotating or removing the account

To rotate: run `sql/04-rollback.sql` to drop the login/user, then re-run
`01` and `02` with a new password, and update the secret manager /
`.env`. To fully decommission the connector: run `04-rollback.sql` and stop
the Node.js server / deployment.

## Row counts and performance impact

`describe_table` reads approximate row counts from `sys.partitions`
(no full table scan) and `VIEW DATABASE STATE` metadata — this has
negligible performance impact. `sample_table` and `get_distinct_values`
are capped (max 50 rows, max 500 distinct values) and use `TOP` so they
never scan a whole large table just to preview it. `aggregate_data` and
`dashboard_data` push aggregation to SQL Server (`GROUP BY`) so Claude
never pulls raw rows for a chart that only needs monthly totals — prefer
these over `query_data` for anything beyond small filtered lookups,
especially on multi-million-row transactional tables. If a specific report
is run often, consider creating a materialized/indexed view for it and
adding it to `config/business-metadata.json`'s `preferredViews` so Claude
is nudged toward the validated view instead of joining raw tables itself.
