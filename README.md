# mcp-proxy — mcp.austindevs.com

Multi-account front door for remote MCP servers that only let claude.ai connect one account per URL.

```
https://mcp.austindevs.com/<service>/<account>/mcp
```

| service | upstream                     | upstream auth                              |
|---------|------------------------------|--------------------------------------------|
| slack   | https://mcp.slack.com/mcp    | your own internal Slack app per workspace — entered in claude.ai as *Use your own OAuth client* (or Worker vars) |
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

## Slack (bring your own client, no Worker config)

Slack's MCP server has no dynamic client registration and only allows **internal** (or
Marketplace-listed) apps, so you need one Slack app per workspace. Then, in claude.ai's *Add custom
connector* dialog, choose **OAuth client → Use your own OAuth client** and paste that app's
client ID and secret. The Worker recognises the `1234567890.1234567890` ID format, uses it as the
Slack app for that connector, and completes the Slack code exchange with the secret Claude sends
at `/token` — nothing to configure on the Worker.

Per workspace at api.slack.com/apps: create app → *Agents* → enable **Slack Model Context Protocol
(MCP) Server** → *OAuth & Permissions* → add redirect URL `https://mcp.austindevs.com/callback` and
the *user* scopes you want (see https://mcp.slack.com/.well-known/oauth-protected-resource) →
copy Client ID / Client Secret from *Basic Information*.

## Config (optional Worker vars/secrets)

* `SLACK_<ACCOUNT>_CLIENT_ID` / `SLACK_<ACCOUNT>_CLIENT_SECRET` (or `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`)
  — alternative to BYO client: lets a plain DCR connector work for `/slack/<account>/mcp`.
* `<SERVICE>_<ACCOUNT>_SCOPES` / `<SERVICE>_SCOPES` — trim the scopes requested upstream.
* `SENTRY_*` / `TRELLO_*` — optional; DCR is used when unset.

## Build & deploy

```
npm install
npm run build            # dist/worker.min.js
npx wrangler deploy      # or: PUT dist/worker.min.js via the Workers API
```
