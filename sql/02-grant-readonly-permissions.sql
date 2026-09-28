/* ============================================================================
   02-grant-readonly-permissions.sql
   ----------------------------------------------------------------------------
   WHO RUNS THIS: SQL Server administrator / DBA, with db_owner (or
   equivalent) rights on TRP_AMS.

   WHAT IT DOES: grants the MINIMUM permission set the connector needs:
     - SELECT on data (via db_datareader, OR narrower schema/table grants)
     - VIEW DEFINITION so the connector can read column/key/FK metadata
     - VIEW DATABASE STATE for row-count / performance metadata (optional)

   It explicitly documents what is NOT granted.

   CHOOSE ONE OF TWO APPROACHES BELOW:
     APPROACH A: db_datareader (simplest; grants SELECT on ALL tables/views
                 in the database). Use only if every table in TRP_AMS is
                 acceptable for Claude to eventually see (the application-
                 level ALLOWED_SCHEMAS / DENIED_TABLES / DENIED_COLUMNS
                 allowlist in .env is still enforced in front of it).
     APPROACH B: schema/table-level GRANT (recommended for production —
                 SQL Server itself, not just the app, refuses to return
                 sensitive tables). Uncomment and edit the table list.
============================================================================ */

USE TRP_AMS;
GO

-- ---------------------------------------------------------------------------
-- APPROACH A — simplest: read access to every table/view in TRP_AMS
-- ---------------------------------------------------------------------------
ALTER ROLE db_datareader ADD MEMBER claude_mcp_reader;
GO

-- Allow reading table/column/key/FK metadata (needed by describe_table,
-- get_relationships, and the discovery tools).
GRANT VIEW DEFINITION TO claude_mcp_reader;
GO

-- Optional: allows reading approximate row counts and query performance
-- state without granting any control over the server.
GRANT VIEW DATABASE STATE TO claude_mcp_reader;
GO

-- ---------------------------------------------------------------------------
-- APPROACH B — narrower, table-by-table grants (RECOMMENDED). If you use
-- this approach, do NOT run "ALTER ROLE db_datareader ADD MEMBER" above —
-- comment it out and use only the grants below instead.
-- ---------------------------------------------------------------------------
-- GRANT SELECT ON SCHEMA::dbo TO claude_mcp_reader;
-- GRANT SELECT ON SCHEMA::sales TO claude_mcp_reader;
-- -- Deny specific sensitive tables even within an otherwise-allowed schema:
-- DENY SELECT ON dbo.Employees TO claude_mcp_reader;
-- DENY SELECT ON dbo.PayrollDetails TO claude_mcp_reader;
-- DENY SELECT ON hr.SalaryHistory TO claude_mcp_reader;
-- GO

-- ---------------------------------------------------------------------------
-- EXPLICITLY CONFIRM NO WRITE / DDL / ADMIN PERMISSIONS
-- (These DENY statements are redundant with "grant nothing", but make the
-- security intent explicit and auditable, and protect against someone
-- later adding this user to db_datawriter/db_ddladmin by mistake.)
-- ---------------------------------------------------------------------------
DENY INSERT, UPDATE, DELETE, ALTER, CREATE TABLE, CREATE VIEW,
     CREATE PROCEDURE, CREATE FUNCTION, REFERENCES ON SCHEMA::dbo TO claude_mcp_reader;
DENY EXECUTE ON SCHEMA::dbo TO claude_mcp_reader;
GO

PRINT 'Read-only permissions applied to claude_mcp_reader on TRP_AMS.';
