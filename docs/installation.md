# Installation

[Back to README](../README.md)

Install the replay extension in an existing PocketBase or run a separate
PocketBase for replay

Both use the same hooks and base migration, with an extra migration for a
dedicated replay database

## Build and install the client

From a checkout of this repository:

```sh
npm ci
npm test
npm run build
npm pack
```

In your frontend project, install the tarball printed by `npm pack`, replacing
the path and version below with your generated file:

```sh
npm install /path/to/pocketbase-replay-VERSION.tgz
```

The client works with bundlers such as Vite, and TypeScript is optional

## Existing PocketBase

Back up your database and stop PocketBase before installing the extension

From your frontend project, point `--target` at the directory containing your
PocketBase hooks and migrations:

```sh
node node_modules/pocketbase-replay/scripts/install.mjs --target ./backend
```

The installer adds these files without replacing your hooks, migrations or data:

```text
pb_hooks/700_replay.pb.js
pb_hooks/lib/replay.js
pb_hooks/lib/replay-core.js
pb_hooks/replay-dash/
pb_migrations/1795600000_replay.js
```

Restart PocketBase to create `replay_settings`, `replay_sessions` and
`replay_chunks`

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
node node_modules/pocketbase-replay/scripts/install.mjs --target ./replay --dedicated
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

Use `CF-Connecting-IP` behind Cloudflare's proxy

With the variable unset, the hooks leave the setting alone

### Hosting under a path

A proxy can strip `/replay` from `https://example.com/replay/*` before forwarding
requests to PocketBase

Set the app's `endpoint` to `https://example.com/replay` and open the dashboard at
`https://example.com/replay/dash/replay`
