# mcp-proxy — mcp.austindevs.com

Multi-account front door for remote MCP servers that only let claude.ai connect one account per URL.

```
https://mcp.austindevs.com/<service>/<account>/mcp
```

| service | upstream                     | upstream auth                              |
|---------|------------------------------|--------------------------------------------|
| slack   | https://mcp.slack.com/mcp    | one internal Slack app per workspace (no DCR) — `SLACK_<ACCOUNT>_CLIENT_ID` + `SLACK_<ACCOUNT>_CLIENT_SECRET` |
| sentry  | https://mcp.sentry.dev/mcp   | dynamic client registration (automatic)    |
| trello  | https://mcp.trello.com/v1    | dynamic client registration (automatic)    |

`<account>` is a free-form label (`zollege`, `paycove`, …). It exists so each claude.ai custom
connector has a unique URL and therefore its own token; the actual workspace/org is picked on the
upstream consent screen.

## How it works

* Toward Claude, the Worker is an OAuth 2.1 authorization server with dynamic client registration
  (`@cloudflare/workers-oauth-provider`), so any custom connector "just works".
* When Claude hits `/authorize`, the Worker reads the RFC 8707 `resource` param to learn which
  `<service>/<account>` the connector is for, then bounces you through the upstream's own OAuth
  (discovered via RFC 9728 / RFC 8414). The upstream token is stored in KV under a random id that
  is sealed into the Claude-facing grant.
* Every MCP request on `/<service>/<account>/mcp` is forwarded to the upstream with that token
  (refreshing it when it expires). `Mcp-Session-Id` and streaming responses pass straight through.

## Adding an account in claude.ai

Customize → Connectors → **Add custom connector** → URL `https://mcp.austindevs.com/slack/zollege/mcp`
(no client id/secret needed) → Connect → log into the workspace you want.

## Config (Worker vars/secrets)

* Slack only lets **internal** (or Marketplace-listed) apps use its MCP server, so create one app
  *in each workspace* at api.slack.com: enable **Agents → Slack Model Context Protocol (MCP) Server**,
  add `https://mcp.austindevs.com/callback` under OAuth & Permissions → Redirect URLs, add the
  *user* scopes from https://mcp.slack.com/.well-known/oauth-protected-resource, then set
  `SLACK_<ACCOUNT>_CLIENT_ID` (var) and `SLACK_<ACCOUNT>_CLIENT_SECRET` (secret) on the Worker, where
  `<ACCOUNT>` is the connector label upper-cased (`zollege` → `SLACK_ZOLLEGE_*`). `SLACK_CLIENT_ID` /
  `SLACK_CLIENT_SECRET` without an account act as defaults; `SLACK_<ACCOUNT>_SCOPES` trims the scopes.
* `SENTRY_*` / `TRELLO_*` — optional; DCR is used when unset.

## Build & deploy

```
npm install
npm run build            # dist/worker.min.js
npx wrangler deploy      # or: PUT dist/worker.min.js via the Workers API
```
