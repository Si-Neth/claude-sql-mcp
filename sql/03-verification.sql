/* ============================================================================
   03-verification.sql
   ----------------------------------------------------------------------------
   WHO RUNS THIS: DBA first (as sysadmin, to confirm the grants look right),
   then re-run the SELECT/INSERT/UPDATE/DELETE test block by connecting to
   SSMS or sqlcmd AS claude_mcp_reader itself, to prove the account cannot
   write — this is the "security test" required in SECURITY.md.
============================================================================ */

-- 1. Confirm the login exists and is not a member of any admin server role.
SELECT sp.name AS login_name, sp.type_desc, sp.is_disabled
FROM sys.server_principals sp
WHERE sp.name = 'claude_mcp_reader';

SELECT r.name AS server_role
FROM sys.server_role_members m
JOIN sys.server_principals r ON r.principal_id = m.role_principal_id
JOIN sys.server_principals p ON p.principal_id = m.member_principal_id
WHERE p.name = 'claude_mcp_reader';
-- EXPECTED: zero rows (not a member of sysadmin, securityadmin, etc.)

-- 2. Confirm database role membership in TRP_AMS.
USE TRP_AMS;
GO
SELECT dp.name AS database_role
FROM sys.database_role_members m
JOIN sys.database_principals dp ON dp.principal_id = m.role_principal_id
JOIN sys.database_principals u ON u.principal_id = m.member_principal_id
WHERE u.name = 'claude_mcp_reader';
-- EXPECTED: db_datareader only (never db_owner / db_datawriter / db_ddladmin)

-- 3. List effective permissions for the user.
SELECT * FROM fn_my_permissions('dbo', 'DATABASE');
-- Run this WHILE CONNECTED AS claude_mcp_reader for accurate results.

-- ----------------------------------------------------------------------------
-- 4. LIVE SECURITY TEST — connect to SSMS / sqlcmd using:
--      Server:   <SQL_SERVER_HOST>,<SQL_SERVER_PORT>
--      Auth:     SQL Server Authentication
--      Login:    claude_mcp_reader
--      Password: <the password you set>
--    Then run EACH statement below ONE AT A TIME and record the result.
--    Every statement except the first SELECT MUST fail with a permission
--    error. If any of them succeed, STOP and fix the grants before using
--    this account with the MCP server.
-- ----------------------------------------------------------------------------

-- 4a. Expected: SUCCEEDS
SELECT TOP 5 * FROM INFORMATION_SCHEMA.TABLES;

-- 4b. Expected: FAILS ("The INSERT permission was denied...")
-- INSERT INTO dbo.SomeExistingTable DEFAULT VALUES;

-- 4c. Expected: FAILS ("The UPDATE permission was denied...")
-- UPDATE dbo.SomeExistingTable SET SomeColumn = SomeColumn;

-- 4d. Expected: FAILS ("The DELETE permission was denied...")
-- DELETE FROM dbo.SomeExistingTable WHERE 1 = 0;

-- 4e. Expected: FAILS ("CREATE TABLE permission denied...")
-- CREATE TABLE dbo.__mcp_test (id INT);

-- 4f. Expected: FAILS ("ALTER permission was denied...")
-- ALTER TABLE dbo.SomeExistingTable ADD __mcp_test_col INT NULL;

-- 4g. Expected: FAILS ("EXECUTE permission was denied...")
-- EXEC sp_who;

-- 4h. Expected: FAILS (no xp_cmdshell access / not enabled / no permission)
-- EXEC xp_cmdshell 'whoami';

PRINT 'Verification checklist complete — confirm all 4b-4h statements failed.';
