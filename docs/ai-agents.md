# AI agents

[Back to README](../README.md)

Coding agents such as Claude Code, Cursor, VS Code and Codex can read your production issues, logs and recordings
through the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). Ask your agent to fix the top crash, and
it gets the source-mapped stack, what the user did before the error and why your PocketBase refused their request,
in one call

The MCP server is part of the replay hooks: one URL on your own PocketBase, no extra process or service. Agents use
read-only keys that you create, limit and revoke in the dashboard, and every request they make is logged

## What agents get

Recordings are read as text, so an agent can follow a session without watching it. This is what
`investigate_issue` returns for an error in a checkout, from the [integration test](../scripts/verify-mcp.mjs) run
against PocketBase 0.39.9:

```text
## What the user did
Recording yve30p0cwsqzbyb, 90 s before to 15 s after the error. Times are from the recording's start; the error is at +00:01.8.
+00:00.0        page       "/cart"
+00:00.8        input      `input` "Promo code" · Changed
+00:01.5        click      `button#checkout` "Place order"
+00:01.6  ERR   pocketbase orders.create · 400 · Failed to create record. · 40 ms
                      ↳ server: 400 in 0.1 ms, not signed in · the createRule refused it · createRule = "@request.auth.id != \"\""
+00:01.6  warn  log        "Order create refused" · Warning log · service "shop" · log h6geqoqrdsebhuu
+00:01.8  ERR   error      "TypeError: Cannot read properties of null (reading 'id')" · Unhandled error · service "shop" · issue dw8gomt31va07xu  ◀ this error
Watch it: https://replay.example.com/dash/replay#session=yve30p0cwsqzbyb&at=1792149033717

## Facts
- 1 request failed in the 15 s before the error, the last 200 ms before it: orders.create (400)
- The last click before the error was on `button#checkout` "Place order", 300 ms before it.
```

- **Steps:** pages, clicks named by their element and text, form fields that changed, PocketBase calls, network
  requests, console output, captured errors and logs, in order and timed from the start of the recording
- **Why a call failed:** the server's explanation of each refused or empty PocketBase call: the API rule that
  refused it with its expression, a record that does not exist, invalid fields, or an error thrown in a hook. See
  [PocketBase calls](integration.md#pocketbase-calls)
- **Code:** stack frames mapped to your original files, lines and functions with the code around them, when
  [source maps](observability.md#source-maps) were uploaded, so the agent can open the right file in your workspace
- **Links:** every recording, issue and log result links to the same moment in the dashboard, so you can check what
  the agent saw

Agents never get form field values, even masked ones, nor whether a box was checked or which option was picked, and
recorded text is masked by your [privacy rules](configuration.md#privacy-rules) before it leaves the user's device

## Set up

1. Upgrade the server hooks and install `pb_migrations/1795600005_mcp.js`, as described in
   [installation](installation.md#upgrade-the-extension), and restart PocketBase
2. Open `/dash/replay`, sign in as a superuser and open **AI agents**
3. Name a key, choose what it can read and when it expires, and select **Create key**
4. Pick your agent below the new key and copy its setup. The key is shown once

The panel fills in your server's URL and the key. The setups below use
`https://replay.example.com/api/replay/mcp` and `pbr_mcp_…`

### Claude Code

```sh
claude mcp add --transport http --scope user pocketbase-replay https://replay.example.com/api/replay/mcp --header "Authorization: Bearer pbr_mcp_…"
```

`--scope user` keeps the key in your user settings rather than a project file. Then ask what is broken in production,
or run a prompt such as `/mcp__pocketbase-replay__fix-issue`

### Cursor

Add to `~/.cursor/mcp.json`. The file in your home folder keeps the key out of the project:

```json
{
  "mcpServers": {
    "pocketbase-replay": {
      "url": "https://replay.example.com/api/replay/mcp",
      "headers": { "Authorization": "Bearer pbr_mcp_…" }
    }
  }
}
```

### VS Code

Add to `.vscode/mcp.json`. VS Code asks for the key once and keeps it in its secret storage, so this file can be
committed:

```json
{
  "inputs": [{ "type": "promptString", "id": "pocketbase-replay-key", "description": "PocketBase Replay agent key", "password": true }],
  "servers": {
    "pocketbase-replay": {
      "type": "http",
      "url": "https://replay.example.com/api/replay/mcp",
      "headers": { "Authorization": "Bearer ${input:pocketbase-replay-key}" }
    }
  }
}
```

### Other agents

| Agent | Where | Setup |
| --- | --- | --- |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `serverUrl` and `headers.Authorization` |
| Codex | `~/.codex/config.toml` | `url` and `bearer_token_env_var = "PB_REPLAY_MCP_KEY"`, with the key in that variable |
| Gemini CLI | `~/.gemini/settings.json` | `httpUrl` and `headers.Authorization` |
| Claude Desktop | `claude_desktop_config.json` | The [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) bridge with `--header "Authorization:${PB_REPLAY_AUTH}"` |
| Others | | Streamable HTTP at the URL, with `Authorization: Bearer <key>` |

The panel shows each of these in full. Clients that only connect with OAuth, such as web-based connectors, are not
supported yet

## Tools

All tools only read. They are annotated as read-only, so agents that ask before running tools can allow them all

| Tool | Scope | Returns |
| --- | --- | --- |
| `get_overview` | any | App health over a window: open issues ranked by events, new and returning issues, errors per app version, log counts by level, recordings with errors, and which data is being collected |
| `list_issues` | issues | Issues filtered by status, text, service, version, account, device or recording, sorted by recent, frequent or new |
| `get_issue` | issues | One issue's impact over time, versions and platforms, and an event with its mapped stack, code, attributes and recording |
| `investigate_issue` | issues | Everything to debug one issue: the error and its code, the recording before and after it with explained PocketBase calls, the device's logs, and server errors at that moment |
| `search_logs` | logs | Logs by text in the message or attributes, minimum level, service, account, device, recording and time, with counts per level |
| `list_sessions` | recordings | Recordings by account, device, room, platform, version and time, by errors, and by what happened in them: text, a page visited, or failed requests |
| `get_session` | recordings | A recording as text, whole or around an error or a moment, filtered by kind, in pages |

Times take durations such as `30m`, `24h` and `7d`, or ISO dates. A page holds as many results as fit in about
5,000 tokens, or 8,500 for recordings and investigations, and ends with a `cursor` for the next page when there is
more

`investigate_issue` reads its sections only with the matching scopes. A key with only the issues scope gets the error
and code without the recording or logs

### Prompts

Agents that support MCP prompts, such as Claude Code, offer these as commands:

| Prompt | Does |
| --- | --- |
| `fix-issue` | Investigates an issue, or the one with the most events, finds the cause in your workspace and proposes a fix with a test |
| `triage` | Ranks what is broken by impact and groups issues that share a cause |
| `explain-session` | Tells what the user did in a recording and where it went wrong |
| `release-health` | Compares an app version's issues and errors with earlier versions |

### Resources

Open issues and recent recordings with errors are listed as resources, so you can attach them in agents that support
it, for example with `@` in Claude Code. Their addresses are `pbreplay://issue/<id>`, `pbreplay://session/<id>` and
`pbreplay://log/<id>`

## How recordings become text

Recordings are stored compressed, as the client uploads them. The server reads each recording once, in order, into a
text index of what happened in it, and agents then search and read that index. The steps are the same as in the
dashboard's activity panel, plus form fields; tests check that both name every click alike

- **On first request:** a recording that has not been read yet is read when an agent asks for it, for up to 14
  seconds per call. A longer one says how far it got; the agent calls again for the rest, and nothing is read twice
- **Ahead of time:** while at least one agent key exists, the server reads recordings linked to an error or a trigger
  in the last 7 days, newest first, for up to 4 seconds a minute. Set `REPLAY_MCP_INDEX=all` to read every recording,
  or `off` to read only on request
- **Cost:** reading runs at roughly 3 to 4 MB of recorded events a second; screenshot and Flutter recordings, which
  are mostly images, read at about 1 MB a second. All reading together stops at 45 seconds a minute, so agents cannot keep
  the server busy, and nothing is read until a key exists

The index is deleted with its recording: by retention, by deleting the recording, and when an account's data is
[erased](authentication.md#delete-an-accounts-recordings-errors-and-logs)

## Security and privacy

- **Read-only:** no tool, prompt or resource can change or delete data. Keys cannot reach settings, ingestion keys or
  anything outside issues, logs and recordings
- **Keys:** each key reads only its scopes: issues, logs, recordings, or any combination. Only a SHA-256 hash is
  stored. Keys can expire, and removing one stops it at once
- **Audit log:** every tool call, prompt and resource read is kept for 30 days with its key, the agent's name and
  version, the arguments, how it ended and how long it took. Account and device IDs and search text in arguments are
  not kept. The latest requests are listed under **AI agents**
- **Limits:** 240 requests a minute per key, each message of a batch counting as one, and 30 failed attempts a minute
  per IP address. Only failed attempts count toward that, so a valid key keeps working from an address others share
- **Captured text:** messages, page text, URLs and attributes come from users' devices and could contain text written
  to manipulate an agent. Results quote every such value on a single line, strip invisible and direction-changing
  characters, and tell the agent to treat quoted text as data, never as instructions. Element names, field names and
  other identifiers a device sent are shown as code, and only collections that exist on your server appear as is
- **Reading time:** reading recordings for agents shares one budget of 45 seconds a minute, taken up front by each
  run, so agents asking many questions at once cannot keep the server busy
- **Origins:** browser requests are refused unless they come from PocketBase's application URL or an origin listed in
  `REPLAY_MCP_ORIGINS`. Coding agents send no `Origin` header

Tool results go to the agent, and from there to the model provider it uses. Recorded text is already masked, and
errors and logs had emails, tokens and secret-named attributes redacted when they arrived. Give each key only the
scopes it needs, for example only issues for an agent that fixes crashes

## Protocol support

The endpoint is `POST /api/replay/mcp` over Streamable HTTP. It speaks MCP 2026-07-28, which sends the protocol
version with every request, and 2025-11-25, 2025-06-18 and 2025-03-26, which open with `initialize`. No sessions are
kept, so it needs nothing more behind a load balancer or after a restart. `GET` and `DELETE` answer 405, as servers
without an event stream do

It is tested with the official MCP TypeScript clients, version 1.32 and version 2.3 in each of its negotiation modes

## Troubleshooting

- **401 Unauthorized:** the key is missing, mistyped, expired or removed. The answer says which. Check that the
  agent sends `Authorization: Bearer pbr_mcp_…`
- **"This key cannot use …":** the key lacks the scope that tool needs. Create a key with it
- **"This recording is still being read":** call the tool again; reading continues where it stopped
- **Explanations marked "likely":** the server worked them out from the collection's current rules. Set
  `REPLAY_TRACE_REQUESTS=on` to link calls to PocketBase's request log for certain answers. See
  [request log links](installation.md#request-log-links)
- **No recording for an error:** the device was not selected for recording, recording was off, or the recording
  expired. See [recording settings](configuration.md#recording-settings)
