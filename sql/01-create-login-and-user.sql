/* ============================================================================
   01-create-login-and-user.sql
   ----------------------------------------------------------------------------
   WHO RUNS THIS: A SQL Server administrator (sysadmin / securityadmin +
   db_owner on the target database). A normal developer account CANNOT run
   this script. Hand this file to your DBA.

   WHAT IT DOES:
     1. Creates a dedicated SQL Server LOGIN for the MCP connector.
     2. Explicitly denies dangerous server-level permissions (defense in depth).
     3. Creates a matching USER in the TRP_AMS database (and any other
        database the connector must read — repeat step 3 per database).

   Replace YOUR_STRONG_PASSWORD_HERE with a strong, randomly generated
   password (20+ characters) BEFORE running this script. Store the password
   in your organization's secret manager, then place it in the connector's
   .env / production secret store as SQL_PASSWORD. Do not email it, do not
   put it in a ticket, do not leave it in this file after use.
============================================================================ */

USE master;
GO

-- 1. Create the login. SQL Server Authentication is used (not Windows Auth)
--    because the MCP server runs as a service, not as an interactive
--    Windows user session — see DATABASE-SETUP.md for why.
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'claude_mcp_reader')
BEGIN
    CREATE LOGIN claude_mcp_reader@lms-prd-01
        WITH PASSWORD = 'YOUR_STRONG_PASSWORD_HERE',
             CHECK_POLICY = ON,        -- enforce Windows password complexity
             CHECK_EXPIRATION = OFF,   -- rotate manually on a schedule instead
             DEFAULT_DATABASE = TRP_AMS;
    PRINT 'Login claude_mcp_reader@lms-prd-01 created.';
END
ELSE
    PRINT 'Login claude_mcp_reader@lms-prd-01 already exists — skipping creation.';
GO

-- 2. Explicitly deny server-level dangerous permissions even though a
--    freshly created login has none of these by default. This is
--    belt-and-braces so a future accidental GRANT at the server level is
--    still blocked for this specific login.
DENY CONTROL SERVER TO claude_mcp_reader@lms-prd-01;
DENY ALTER ANY LOGIN TO claude_mcp_reader@lms-prd-01;
DENY ALTER ANY DATABASE TO claude_mcp_reader@lms-prd-01;
DENY ALTER SERVER STATE TO claude_mcp_reader@lms-prd-01;
DENY ALTER ANY LINKED SERVER TO claude_mcp_reader@lms-prd-01;
DENY ALTER ANY CREDENTIAL TO claude_mcp_reader@lms-prd-01;
GO

-- 3. Create the database user mapped to the login, in TRP_AMS.
--    Repeat this block (with USE <OtherDatabase>) for any additional
--    database this connector is allowed to read.
USE TRP_AMS;
GO

IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'claude_mcp_reader@lms-prd-01')
BEGIN
    CREATE USER claude_mcp_reader@lms-prd-01 FOR LOGIN claude_mcp_reader@lms-prd-01;
    PRINT 'User claude_mcp_reader@lms-prd-01 created in TRP_AMS.';
END
ELSE
    PRINT 'User claude_mcp_reader@lms-prd-01 already exists in TRP_AMS — skipping.';
GO

/* Next step: run 02-grant-readonly-permissions.sql to grant the minimum
   read permissions this user actually needs. Do NOT add this user to
   db_owner, db_datawriter, db_ddladmin, or any admin role. */
