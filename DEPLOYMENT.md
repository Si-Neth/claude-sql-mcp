# Deployment

Covers: local Windows 11 development, and permanent production hosting.
Requirement A/B/C/D/E/F split (who needs to do what) is at the bottom.

## A. Local development setup (Windows 11)

Prerequisites: Windows 11, [Node.js 18+ LTS](https://nodejs.org) installed,
VS Code, SSMS, network access to your SQL Server environment.

```powershell
# 1. Get the project onto your machine (unzip, or git clone your repo)
cd claude-sql-mcp

# 2. Install dependencies
npm install

# 3. Configure environment
copy .env.example .env
notepad .env
# Fill in SQL_SERVER_HOST, SQL_USER=claude_mcp_reader, SQL_PASSWORD, etc.
# (see DATABASE-SETUP.md for where these come from)
# Generate a bearer token for MCP_BEARER_TOKEN:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 4. Type-check and run the test suite
npm run build
npm test

# 5. Start the dev server (auto-reloads on file changes)
npm run dev
# -> claude-sql-mcp listening on http://localhost:8787/mcp
```

### Test with MCP Inspector before connecting Claude

```powershell
npx @modelcontextprotocol/inspector
```

This opens a local web UI. Connect it to `http://localhost:8787/mcp`, using
Streamable HTTP transport, with header `Authorization: Bearer <your
MCP_BEARER_TOKEN>`. From there you can:
- See all 11 registered tools and their schemas
- Call `health_check` to confirm SQL Server connectivity
- Call `list_databases` / `list_tables` / `describe_table` against your
  real TRP_AMS data
- Try a `query_data` or `aggregate_data` call and inspect the JSON result

Fix any connectivity or permission errors here (see TROUBLESHOOTING.md)
before wiring up Claude — it's much faster to debug in the Inspector.

## B. Production deployment

The employee laptop must never be the production server — if it's off, the
whole company loses the connector. Deploy to a server or a cloud host that
stays running.

### Option 1 — Company server (Windows Server or Linux)

```powershell
npm run build
npm start
```

To keep it running permanently:
- **Windows Server:** run it as a Windows Service using
  [`node-windows`](https://www.npmjs.com/package/node-windows) or NSSM
  (Non-Sucking Service Manager) wrapping `node dist/server.js`, so it
  restarts automatically on crash/reboot. Put a reverse proxy (IIS with
  URL Rewrite + Application Request Routing, or `nginx` for Windows) in
  front for HTTPS termination and a stable public hostname.
- **Linux server:** run it under `systemd` (a unit file calling `node
  dist/server.js`, `Restart=always`) behind `nginx` or `Caddy` for TLS
  termination.

### Option 2 — Azure App Service (recommended if your company is
already on Microsoft infrastructure)

- Deploy this Node.js project directly (App Service has native Node.js
  support — no Docker required, satisfying "no IT-admin laptop install").
- App Service gives you: automatic HTTPS on a stable `*.azurewebsites.net`
  domain (or your own custom domain), automatic restart, built-in
  monitoring/logging (Application Insights), and easy secret management via
  **Azure Key Vault** references in App Settings — do not put real secrets
  in App Service's plain configuration blade for production; use Key Vault
  references.
- If SQL Server is on-premises: connect this App Service to your network
  via **VNet Integration** + a **Site-to-Site VPN** or **ExpressRoute** to
  your on-prem network, and restrict the SQL Server firewall to that VNet's
  address range only.
- If SQL Server is Azure SQL Database: use **Private Endpoint** so traffic
  never leaves Azure's private network.

Basic deployment commands (Azure CLI):
```powershell
az webapp up --name YOUR-APP-NAME --resource-group YOUR-RG --runtime "NODE:20-lts"
az webapp config appsettings set --name YOUR-APP-NAME --resource-group YOUR-RG `
  --settings SQL_SERVER_HOST="..." SQL_DATABASE="TRP_AMS" MCP_PORT="8080" NODE_ENV="production"
# Store secrets (SQL_PASSWORD, MCP_BEARER_TOKEN) as Key Vault references instead of plain settings.
```

### Option 3 — Azure Container Apps / AWS / other Node.js hosting

Any platform that runs a standard Node.js HTTP server works (this project
has zero platform-specific code). Azure Container Apps or AWS App
Runner/Elastic Beanstalk are reasonable alternatives if you prefer
container-based deployment — note the requirement "no Docker required on
employee laptops" only constrains employee machines, not your production
hosting; using a container on the server side is fine if your team already
manages containers, but is not required.

### What every option must provide

- [ ] HTTPS (TLS termination) — never serve the raw HTTP port to the internet
- [ ] A stable URL — this becomes `MCP_PUBLIC_URL` and the Claude Custom
      Connector's endpoint
- [ ] Automatic restart on crash
- [ ] Centralized logging (stdout collection, or `AUDIT_LOG_FILE` shipped
      somewhere durable)
- [ ] Secrets stored in a secret manager (Azure Key Vault, AWS Secrets
      Manager, or your platform's equivalent) — never a plain `.env` file
      sitting on a shared server
- [ ] Health checks pointed at `GET /healthz`
- [ ] A private network path to SQL Server (never a public SQL Server)

## C. SQL Server administrator requirements

Covered fully in [DATABASE-SETUP.md](DATABASE-SETUP.md): creating
`claude_mcp_reader`, granting minimal permissions, opening the firewall to
the MCP server's IP/subnet only.

## D. Network / firewall requirements

- SQL Server's firewall must allow inbound TCP on `SQL_SERVER_PORT` from
  the MCP server's IP address (or the VNet/subnet it lives in) — nothing
  broader.
- The MCP server's own inbound HTTPS port must be reachable from wherever
  Claude's infrastructure calls it from — this typically means a public
  HTTPS endpoint (with the auth layer in `src/mcp/server.ts` protecting it)
  unless your company's Claude deployment tunnels through a private network
  Anthropic supports for your plan — check your Claude Enterprise
  configuration/Anthropic account team if you require that instead of a
  public endpoint.
- These changes require your network/security team's sign-off. This
  project does not attempt to bypass firewall or security policy — the
  design goal ("no IT-admin install on employee laptops") is about
  employee machines, not about avoiding legitimate infrastructure approval
  for the server itself.

## E. Claude organization-owner requirements

See [CLAUDE-CONNECTOR.md](CLAUDE-CONNECTOR.md).

## F. Normal employee requirements

None beyond having Claude with the connector enabled by their organization.
No Node.js, no Python, no drivers, no local server.

## Startup/operation summary

```powershell
# Development
npm install
npm run dev

# Production
npm run build
npm start
```

Do not run `npm run dev` in production (it uses `tsx watch`, intended for
local iteration only, not a hardened long-running process).
