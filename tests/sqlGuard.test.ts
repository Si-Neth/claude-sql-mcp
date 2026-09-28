import { describe, it, expect } from "vitest";
import { assertQueryIsSafe, assertSafeIdentifier, quoteIdentifier } from "../src/security/sqlGuard.js";

describe("assertQueryIsSafe", () => {
  it("allows a plain SELECT", () => {
    expect(() => assertQueryIsSafe("SELECT [Id], [Name] FROM [dbo].[Customers] WHERE [Id] = @p1")).not.toThrow();
  });

  it("allows a WITH (CTE) SELECT", () => {
    expect(() =>
      assertQueryIsSafe("WITH cte AS (SELECT 1 AS x) SELECT x FROM cte"),
    ).not.toThrow();
  });

  it.each([
    "INSERT INTO dbo.Customers (Name) VALUES ('x')",
    "UPDATE dbo.Customers SET Name = 'x'",
    "DELETE FROM dbo.Customers",
    "DROP TABLE dbo.Customers",
    "ALTER TABLE dbo.Customers ADD COLUMN x INT",
    "TRUNCATE TABLE dbo.Customers",
    "GRANT SELECT ON dbo.Customers TO public",
    "EXEC sp_who",
    "EXECUTE ('SELECT 1')",
    "EXEC xp_cmdshell 'whoami'",
    "SELECT * FROM dbo.Customers; DROP TABLE dbo.Customers",
    "SELECT * FROM dbo.Customers -- ; DROP TABLE dbo.Customers",
    "SELECT * FROM OPENROWSET('SQLNCLI', 'a', 'b')",
    "BACKUP DATABASE TRP_AMS TO DISK = 'x'",
    "sp_configure 'show advanced options', 1",
  ])("rejects dangerous statement: %s", (query) => {
    expect(() => assertQueryIsSafe(query)).toThrow();
  });

  it("does not false-positive on a column literally named CreateDate", () => {
    expect(() =>
      assertQueryIsSafe("SELECT [CreateDate] FROM [dbo].[Orders] WHERE [CreateDate] > @p1"),
    ).not.toThrow();
  });
});

describe("assertSafeIdentifier", () => {
  it("accepts normal identifiers", () => {
    expect(() => assertSafeIdentifier("InvoiceHeader", "table")).not.toThrow();
    expect(() => assertSafeIdentifier("_temp", "table")).not.toThrow();
  });

  it.each(["dbo.Customers", "Customers; DROP TABLE x", "Cust'omers", "[Customers]", "1Customers", "Cust omers"])(
    "rejects unsafe identifier: %s",
    (id) => {
      expect(() => assertSafeIdentifier(id, "table")).toThrow();
    },
  );
});

describe("quoteIdentifier", () => {
  it("brackets an identifier and escapes embedded ]", () => {
    expect(quoteIdentifier("Simple")).toBe("[Simple]");
  });
});
