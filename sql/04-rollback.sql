/* ============================================================================
   04-rollback.sql
   ----------------------------------------------------------------------------
   WHO RUNS THIS: SQL Server administrator.
   WHAT IT DOES: completely removes the connector's database access.
   Run this if the connector must be decommissioned, or if you need to
   rotate the account (drop, then re-run 01 and 02 with a new password).
============================================================================ */

USE TRP_AMS;
GO

IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = 'claude_mcp_reader')
BEGIN
    DROP USER claude_mcp_reader;
    PRINT 'User claude_mcp_reader dropped from TRP_AMS.';
END
GO

-- Repeat the DROP USER block above (with USE <OtherDatabase>) for every
-- other database this connector was granted access to.

USE master;
GO

IF EXISTS (SELECT 1 FROM sys.server_principals WHERE name = 'claude_mcp_reader')
BEGIN
    DROP LOGIN claude_mcp_reader;
    PRINT 'Login claude_mcp_reader dropped.';
END
GO
