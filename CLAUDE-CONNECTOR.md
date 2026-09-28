# Connecting this server to Claude

## Terminology

- **Local MCP server** — runs on your own machine, connects only to Claude
  Desktop/Code on that same machine via stdio. Not used here.
- **Remote MCP server** — a server reachable over HTTPS, which is what this
  project is. This is required for a company-wide, always-on connector.
- **Claude Custom Connector (personal)** — a connector registered under one
  person's individual Claude account. Only that person can use it.
- **Team / Enterprise connector** — a connector registered by an
  organization owner/admin and made available to some or all members of
  the Claude Team/Enterprise workspace. **This is what you want for a
  company-wide rollout.**

Registering the connector under your own personal Claude account does
**not** automatically give any other employee access to it — each user (or
the org admin, for Team/Enterprise) must add it separately, or it must be
provisioned at the organization level.

## Before you start

1. Deploy the server so it has a stable HTTPS URL (see DEPLOYMENT.md) —
   e.g. `https://mcp.yourcompany.com/mcp`. Do not use `http://localhost` —
   Claude's cloud infrastructure cannot reach your laptop.
2. Confirm `GET https://your-url/healthz` returns `{"status":"ok",...}`
   from a machine outside your network (proves it's actually reachable).
3. Have your `MCP_BEARER_TOKEN` (or OAuth details) ready.

## Registering a personal connector (for initial testing)

The exact menu path in claude.ai changes over time — verify against
Anthropic's current documentation at
https://docs.claude.com and https://support.claude.com before following
these steps, since this project's authors cannot guarantee the UI hasn't
moved since this was written. As of the time this was written, the general
flow is:

1. In claude.ai, open **Settings → Connectors** (sometimes surfaced as
   **Settings → Customize** or a Connectors icon in the composer, depending
   on account type).
2. Choose **Add custom connector** (or equivalent).
3. Enter:
   - **Name:** e.g. "TRP_AMS SQL (read-only)"
   - **Remote MCP server URL:** `https://your-domain/mcp` (your
     `MCP_PUBLIC_URL`)
   - **Authentication:** if the UI offers a bearer-token / API-key field,
     paste your `MCP_BEARER_TOKEN` there. If it only offers OAuth, you'll
     need `AUTH_MODE=oauth` configured and working (see SECURITY.md).
4. Save, then enable the connector for a conversation.
5. Test: ask Claude "What databases can you see through the TRP_AMS
   connector?" — it should call `list_databases` and report back.

## Registering a Team / Enterprise connector (company-wide)

This step requires your Claude **organization owner or admin** — an
individual user's personal connector registration does not do this. In
Team/Enterprise admin settings there is an organization-level Connectors
management area where an admin can:
- Add the same remote MCP server URL + auth configuration, scoped to the
  organization (or specific groups, depending on your plan's granularity).
- Choose which tools are enabled/visible.
- Control which members can use the connector.
- Disable or remove the connector for everyone at once, or roll out an
  updated URL/secret if you migrate hosting.

Verify the exact current admin flow in Anthropic's Team/Enterprise
documentation, since organization-level connector management is a feature
area that evolves — do not assume the steps above are pixel-exact without
checking https://docs.claude.com first.

## Enabling and using it in a conversation

Once registered (personal or org-provisioned), a user turns the connector
on for a given conversation (typically a toggle near the message composer
or in conversation settings), then can simply ask for what they need:

> "Create a dashboard showing monthly sales by region for 2026."

Claude will call the MCP tools automatically as needed; no manual SQL, no
manual export/paste.

## Disabling / removing / updating

- **Disable for one user:** the user turns the connector toggle off for
  future conversations.
- **Remove entirely:** delete the custom connector from Settings
  (personal) or the org admin panel (Team/Enterprise) — this does not
  delete the server itself, only Claude's registration of it. Also
  consider rotating `MCP_BEARER_TOKEN` if you want to guarantee the old
  registration can no longer authenticate even if somehow re-added.
- **Update the URL or auth after migrating hosting:** update the connector
  entry with the new URL/secret; existing conversations that already have
  it enabled will use the new endpoint going forward.

## Dashboard rendering: what to expect

Claude renders dashboards using its own built-in chart/table rendering
(native visualizations in the chat surface) driven by the structured data
this MCP server returns — the MCP server itself does not render charts; it
only returns data (JSON rows/aggregates). This is the most realistic,
currently-supported approach: an MCP tool result is data for Claude to
visualize, not an interactive UI component Claude embeds directly. If a
richer, standalone interactive dashboard (e.g. a shareable web app with
filters) is later required beyond what Claude's own chat-native charts
provide, that would be the optional Node.js/React dashboard frontend
described as a stretch goal (Section 31 of the original requirements) —
not necessary for the core "ask Claude for a dashboard" workflow described
here, and intentionally not built as part of this first delivery to keep
scope focused on the secure data-access layer, which is the harder and
more important problem.
