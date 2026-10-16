# Installation

[Back to README](../README.md)

Install the replay extension in an existing PocketBase or run a separate
PocketBase for replay

Both use the same hooks and base migration, with an extra migration for a
dedicated replay database

## Install the client

In your frontend project:

```sh
npm install pocketbase-replay
```

The client works with bundlers such as Vite, and TypeScript is optional

To build an unpublished version from a checkout of this repository:

```sh
npm ci
npm test
npm pack
```

Then install the generated tarball in your frontend project with
`npm install /path/to/pocketbase-replay-VERSION.tgz`

A Flutter app uses the [Flutter plugin](../plugins/flutter/README.md#install)
instead, added to its `pubspec.yaml` from this repository. The server setup
below is the same for both

## Existing PocketBase

Back up your database and stop PocketBase before installing the extension

From your frontend project, point `--target` at the directory containing your
PocketBase hooks and migrations:

```sh
npx pb-replay-install --target ./backend
```

The installer adds these files without replacing your hooks, migrations or data:

```text
pb_hooks/700_replay.pb.js
pb_hooks/lib/replay.js
pb_hooks/lib/replay-core.js
pb_hooks/705_ingestion_security.pb.js
pb_hooks/lib/ingestion-security.js
pb_hooks/lib/ingestion-limits.js
pb_hooks/710_observability.pb.js
pb_hooks/lib/observability.js
pb_hooks/lib/observability-core.js
pb_hooks/715_sourcemaps.pb.js
pb_hooks/lib/sourcemaps.js
pb_hooks/lib/sourcemap-core.js
pb_hooks/720_pocketbase.pb.js
pb_hooks/lib/pocketbase.js
pb_hooks/lib/pocketbase-core.js
pb_hooks/725_mcp.pb.js
pb_hooks/lib/mcp.js
pb_hooks/lib/mcp-core.js
pb_hooks/lib/activity.js
pb_hooks/lib/activity-core.js
pb_hooks/lib/gzip.js
pb_hooks/replay-dash/
pb_migrations/1795600000_replay.js
pb_migrations/1795600002_observability.js
pb_migrations/1795600003_replay_trigger.js
pb_migrations/1795600004_sourcemaps.js
pb_migrations/1795600005_mcp.js
```

Restart PocketBase to create `replay_settings`, `replay_sessions`,
`replay_chunks`, the error, log and alert collections, the source map
collections, and the collections for [AI agents](ai-agents.md)

The migration refuses an existing collection with a conflicting name and never
imports a full database schema

The record API is closed for these collections, while your other collection
rules stay unchanged

Open `http://localhost:8090/dash/replay` and sign in with a PocketBase superuser

The `/dash/replay` route can coexist with an existing `/dash` page, but must take
precedence over a custom broad `/dash/*` handler

### Upgrade the extension

Back up your database and stop PocketBase before upgrading

Delete the files and the `replay-dash/` folder listed above, then run the
installer from the new package version and restart PocketBase

The installer refuses to overwrite a file that differs

The error and log migration adds collections without changing existing
recordings. Both features start disabled, including on upgraded servers

The source map migration adds its own collections. Until maps are uploaded,
errors group exactly as before

The AI agents migration adds collections for agent keys, their audit log and
recordings read as text. Agents have no access until a superuser creates a key

## Dedicated replay database

From a checkout of this repository, with Docker installed:

```sh
npm ci
npm run build
docker compose up -d --build
docker compose exec replay /pb/pocketbase superuser upsert YOUR_EMAIL YOUR_PASSWORD
```

Open `http://localhost:8097/dash/replay` and sign in with that superuser

Data lives in `./pb_data`

The included Docker image pins PocketBase 0.39.9 with its release checksum and
targets Linux amd64

Test upgrades before using another release, and use the corresponding official
PocketBase binary for another architecture

The image includes `pb_migrations/1795600001_replay_dedicated.js`, which:

- Enables PocketBase's rate limiter while keeping existing rules
- Adds `*:auth` at 2 requests per 3 seconds if that rule is missing
- Sets the `users` collection's create rule to null, closing public sign-up

For your own PocketBase instance used only for replay, install with
`--dedicated` to add the same migration:

```sh
npx pb-replay-install --target ./replay --dedicated
```

Do not use `--dedicated` on a PocketBase that also serves your app because it
closes sign-up on `users`

If accounts live in your app's database, configure
[account verification and deletion](authentication.md)

## Enable recording

Recording starts disabled

In the dashboard's Recording settings, select percentage sampling or an account
allowlist, then configure the [privacy rules](configuration.md#privacy-rules)
for your app

Connect the [client](integration.md) and watch a new recording to check the
result

## Source map uploads

To let build jobs upload source maps for readable stack traces, set
`REPLAY_SOURCEMAP_KEY` on the replay server to a random secret of 32 to 512
characters, for example from `openssl rand -hex 32`. Compose passes it through
from your shell or `.env`:

```text
REPLAY_SOURCEMAP_KEY=your-secret
```

With it unset, only a superuser can upload maps. See
[source maps](observability.md#source-maps) for the CLI and the limits

## Request log links

Set `REPLAY_TRACE_REQUESTS=on` to link the [PocketBase calls](integration.md#pocketbase-calls)
apps record to PocketBase's request log, for fuller explanations in the player.
It adds a small hook to PocketBase's record, auth, batch and realtime
subscription requests. Overhead depends on your server and workload; no
middleware is installed around long-lived realtime streams. It is off unless set:

```text
REPLAY_TRACE_REQUESTS=on
```

The replay configuration then tells clients to add a `__replayRequest` query
marker alongside `X-Replay-Request`. The marker contains only the random call
ID and optional recording ID, so it can link failures that happen before the
tracing hook runs. Clients omit it unless their latest configuration enables
tracing; changes take effect at their next settings check. See
[request log links](integration.md#link-calls-to-pocketbases-request-log)

## AI agents

[AI agents](ai-agents.md) connect to `/api/replay/mcp` with a key from
**AI agents** in the dashboard and need no server settings. Two optional
settings change how they work:

```text
# Which recordings are read ahead of time while a key exists: errors (default), all or off
REPLAY_MCP_INDEX=errors
# Browser origins allowed to call the endpoint, separated by commas
REPLAY_MCP_ORIGINS=https://inspector.example.com
```

Recordings outside `REPLAY_MCP_INDEX` are read when an agent first asks for
them. Coding agents send no `Origin` header, so `REPLAY_MCP_ORIGINS` is only
for browser-based MCP clients

## Behind a reverse proxy

Use HTTPS for remote deployments

An existing proxy's basic-auth protection can cover `/dash*` and `/_/*`, while
replay data and settings also require a PocketBase superuser token

Never put a superuser token in your frontend

Every per-IP limit uses the address PocketBase sees, so a proxy makes all
clients share one bucket unless you configure the client address header

This also applies to the rate limiter enabled by the dedicated migration

The included `compose.yaml` listens only on `127.0.0.1`, so remote access needs
a reverse proxy

Set `REPLAY_TRUSTED_PROXY` on the replay server to the header carrying the client
address; Compose passes it through from your shell or `.env`:

```text
REPLAY_TRUSTED_PROXY=X-Forwarded-For
```

At boot, the hooks write this into PocketBase's trusted proxy setting and read
the rightmost IP, which is the address your proxy saw

The header name may contain only letters, digits and hyphens; an invalid value
is ignored with a `replay:` warning in the log

A proxy that answers CORS itself should allow the `X-Replay-Request` request
header, so apps on another origin, such as Capacitor apps, can link their
PocketBase calls to PocketBase's request log. An app checks once and leaves the
header out when it is refused, so its own calls never fail because of it

Use `CF-Connecting-IP` behind Cloudflare's proxy

With the variable unset, the hooks leave the setting alone

### Hosting under a path

A proxy can strip `/replay` from `https://example.com/replay/*` before forwarding
requests to PocketBase

Set the app's `endpoint` to `https://example.com/replay` and open the dashboard at
`https://example.com/replay/dash/replay`
