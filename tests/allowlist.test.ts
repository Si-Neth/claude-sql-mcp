import { describe, it, expect, beforeEach, vi } from "vitest";

// The allowlist module reads config at import time via config.ts, which in
// turn reads process.env. Set required env vars before importing.
process.env.SQL_SERVER_HOST = "test-host";
process.env.SQL_DATABASE = "TRP_AMS";
process.env.SQL_USER = "test_user";
process.env.SQL_PASSWORD = "test_password";
process.env.MCP_BEARER_TOKEN = "test_token";
process.env.ALLOWED_DATABASES = "TRP_AMS";
process.env.ALLOWED_SCHEMAS = "dbo,sales.vw_MonthlySales";
process.env.DENIED_TABLES = "dbo.employees";
process.env.DENIED_COLUMNS = "dbo.customers.nic";

const { assertDatabaseAllowed, assertSchemaAllowed, assertTableAllowed, isColumnDenied } = await import(
  "../src/security/allowlist.js"
);

describe("allowlist", () => {
  it("allows a configured database", () => {
    expect(() => assertDatabaseAllowed("TRP_AMS")).not.toThrow();
  });

  it("rejects an unconfigured database", () => {
    expect(() => assertDatabaseAllowed("OtherDb")).toThrow();
  });

  it("allows a wildcard-permitted schema", () => {
    expect(() => assertSchemaAllowed("TRP_AMS", "dbo")).not.toThrow();
  });

  it("allows an exact schema.table permitted pattern", () => {
    expect(() => assertTableAllowed("TRP_AMS", "sales", "vw_MonthlySales")).not.toThrow();
  });

  it("rejects a schema not covered by any pattern", () => {
    expect(() => assertSchemaAllowed("TRP_AMS", "hr")).toThrow();
  });

  it("rejects an explicitly denied table even within an allowed schema", () => {
    expect(() => assertTableAllowed("TRP_AMS", "dbo", "employees")).toThrow();
  });

  it("flags a denied column", () => {
    expect(isColumnDenied("dbo", "customers", "nic")).toBe(true);
    expect(isColumnDenied("dbo", "customers", "name")).toBe(false);
  });
});
