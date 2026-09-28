# PocketBase Replay

DOM session replay for PocketBase. Record screens, clicks, taps, menus and dialogs,
then watch them in a private dashboard. The recorder has no React, Capacitor or
application dependency; in a Capacitor app it finds Capacitor on the page at run
time instead of importing it.

Install the server extension in **an existing PocketBase** or run **a separate
PocketBase just for replay**. Both paths use the same hooks and base migration;
a dedicated replay database also gets one migration of its own (see Option B).
Recording is off until an administrator enables it.

## Get started

This repository is prepared for publishing; it has not been published to npm yet.
Build a local package first:

```sh
npm ci
npm test
npm run build
npm pack
```

Install the resulting `pocketbase-replay-0.2.0.tgz` in your frontend project.
Once a release is published, `npm install pocketbase-replay` replaces this step.
The JavaScript client works with bundlers such as Vite; TypeScript is optional.

### Option A: extend an existing PocketBase

Back up your database and stop PocketBase before installing the extension.

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

Restart PocketBase. The migration creates `replay_settings`, `replay_sessions`
and `replay_chunks`. It refuses an existing collection with a conflicting name;
it never imports a full database schema. The record API is closed for these
collections. Your other collection rules are unchanged.

Open `http://localhost:8090/dash/replay` and sign in with a PocketBase superuser.
The `/dash/replay` path is specific so an existing `/dash` page can coexist.
If you run a custom broad `/dash/*` handler, ensure this route takes precedence.

To move to a new package version, delete the files and the `replay-dash/` folder
listed above and run the installer again. It refuses to overwrite a file that
differs.

### Option B: a dedicated replay database

From this repository, with Docker installed:

```sh
npm ci
npm run build
docker compose up -d --build
docker compose exec replay /pb/pocketbase superuser upsert YOUR_EMAIL YOUR_PASSWORD
```

Open `http://localhost:8097/dash/replay`. Data lives in `./pb_data`.
The included image pins PocketBase **0.39.9** with its release checksum; test
upgrades before using another release. This Dockerfile targets Linux amd64.
For another architecture, use the corresponding official PocketBase binary.

The image also carries the dedicated migration,
`pb_migrations/1795600001_replay_dedicated.js`. It turns on PocketBase's rate
limiter, keeping the rules already there and adding `*:auth` at 2 requests per 3
seconds if it is missing, and it sets the `users` collection's create rule to
null so nobody can sign up. To run your own PocketBase for replay alone instead of
this image, install with `--dedicated`, which adds the same migration:

```sh
node node_modules/pocketbase-replay/scripts/install.mjs --target ./replay --dedicated
```

Do not use `--dedicated` on a PocketBase that also serves your app: it closes
sign-up on `users`.

Put remote deployments behind HTTPS. An existing reverse proxy's basic-auth
protection can cover `/dash*` and `/_/*`; replay data and settings also require
a PocketBase superuser token. Never put a superuser token in your frontend.

### Behind a reverse proxy

Every per-IP limit uses the address PocketBase sees. Behind a proxy, that is the
proxy's own address, so all clients share one bucket, and the rate limiter the
dedicated migration turns on does the same. The included `compose.yaml` only
listens on `127.0.0.1`, so a remote deployment is always behind one. Set
`REPLAY_TRUSTED_PROXY` on the replay server to the header that carries the client
address; `compose.yaml` passes it through from your shell or `.env`:

```text
REPLAY_TRUSTED_PROXY=X-Forwarded-For
```

At boot the hooks write it into PocketBase's trusted proxy setting and read the
rightmost IP, which is the address your proxy saw. The value must be a header
name of letters, digits and hyphens; anything else is ignored with a `replay:`
warning in the log. Use `CF-Connecting-IP` behind Cloudflare's proxy. With the
variable unset, the hooks leave the setting alone.

The server also works under a path on another site, e.g. a proxy that strips
`/replay` from `https://example.com/replay/*` before passing it on. Set the app's
`endpoint` to `https://example.com/replay` and open the dashboard at
`https://example.com/replay/dash/replay`.

### Connect your app

```js
import { startReplay } from 'pocketbase-replay';

const replay = startReplay({
  endpoint: 'https://replay.example.com',
  metadata: () => ({
    deviceId: yourApp.deviceId,
    platform: 'web',
    appVersion: '1.0.0',
    accountId: yourApp.account?.id || '',
    authToken: yourApp.authToken || '',
    room: yourApp.roomCode || '',
  }),
});

// After sign-in, sign-out or a room change:
await replay.refresh();

// Optional, for an explicit flush before navigation:
await replay.flush();

// When the app is disposed:
replay.stop();
```

That is the whole integration. Which parts of the screen to mask or block is set
in the dashboard, not in the app (see [Privacy rules](#privacy-rules)). Use your
app's stable device ID. Access to storage can fail in private browsing, so a
generated ID should fall back to memory. Empty `endpoint` disables replay. The
recorder is imported only after the server selects a session.

`metadata()` is read again for every request and event, so return the current
account and room each time. Only `accountId` and `deviceId` decide which session
is used; `appVersion` also picks the archived images and fonts in a packaged app.

Optional settings:

- `sensitiveText: () => string[]` masks these words, such as names and email
  addresses, wherever they appear in recorded text.
- `maskTextSelector` and `blockSelector` add rules of your own. They are joined
  with the server's rules, and both apply.
- `transport`, `subscribeActive(listener)`, `initialActive` and `assetBaseUrl`
  replace the detection below. Each option you pass wins over it.

#### What the package detects on its own

| Part | Android and iOS (Capacitor) | Web and Electron |
| --- | --- | --- |
| Requests | `CapacitorHttp` with a `text/plain` body and 8 second timeouts; no beacon | `fetch` with a `text/plain` body, and `sendBeacon` at page exit |
| Pause and resume | The `App` plugin's `appStateChange` event | `visibilitychange`, and `pagehide` and `pageshow` |
| Images and fonts | Loaded from this build's archive on the replay server | Loaded from the page, except in the packaged Electron app |

The package reads `window.Capacitor` when `startReplay` runs. It uses the native
parts only when `Capacitor.getPlatform()` says `android` or `ios` and the plugin
is registered on the page. `CapacitorHttp` comes with `@capacitor/core`; the
`App` plugin is there only if your app imports `@capacitor/app` somewhere.
Without it a native app gets no pause events, only `pagehide` and `pageshow`.
Inside the Android WebView, `visibilitychange` can arrive late, so it is not used
on a phone. A missing or unusual `Capacitor` global falls back to the web column.

When the host gives no `initialActive`, recording starts active unless the page
is hidden. Each resume takes a fresh full snapshot.

A request sent while the page is hidden uses `keepalive` when its body is 60,000
characters or less, so it can finish after the page closes.

To opt out of one detected part, pass your own: `transport: fetchTransport()`
keeps `fetch` on a phone, `subscribeActive: () => () => {}` turns the pause
events off, and `assetBaseUrl: ''` keeps asset URLs as they are. See
[`examples/capacitor.ts`](examples/capacitor.ts).

A custom `post(url, body)` returns the parsed JSON answer. It must throw
`ReplayHttpError(status)`, or any error with a numeric `status`, for a non-2xx
answer. The client sorts failures by that status. An error
with no status counts as a network failure, like 408, 429 and 5xx: the session and
its queue are kept and the request is retried. So a transport that throws a plain
error for a 401 or 403 keeps retrying instead of stopping.

```js
import { ReplayHttpError } from 'pocketbase-replay';

if (response.status < 200 || response.status >= 300) throw new ReplayHttpError(response.status);
```

### Native images and fonts

A packaged app serves its files from an address only that device can load:
`https://localhost` (Capacitor on Android), `capacitor://localhost` (Capacitor on
iOS) or `capacitor-electron://-` (Capacitor Electron). Archive each build's
public images and fonts alongside PocketBase:

```sh
npx pb-replay-assets --from ./dist --target ./backend --version 1.0.0
```

On one of those three origins the recorder rewrites same-origin image and font
URLs under `/assets`, `/fonts` and `/icons`, including CSS URLs, to
`{endpoint}/replay-assets/{appVersion}/`. `--version` must therefore equal the
`appVersion` your metadata sends. With an empty `appVersion`, or one the archive
command would refuse, URLs are left as they are. Pass `assetBaseUrl` to use
another address, or `assetBaseUrl: ''` to turn the rewrite off. The command
copies only images and fonts, refuses conflicting existing assets, and leaves
application JavaScript out. Files are public: use it only on build output
containing public assets. Keep each version until its recordings expire. Apps
with other asset layouts can keep those assets at stable public URLs.

## Accounts on a separate database

In an existing database, the recorder's `authToken` is verified locally.
For a dedicated replay database, set a **server-only** environment variable:

```text
REPLAY_AUTH_URL=https://your-app.example.com/api/collections/users/auth-refresh
```

Only this configured endpoint receives the app token. Account IDs are verified,
not trusted from client metadata. Anonymous sessions work with percentage
sampling; account allowlists require a verified account. Device, platform,
version and room remain client claims, not security identities. The client sends
the token only when it also sends an account ID.

The server first checks whether the claimed account or device would be selected
at all. If not, `/config` and `/start` answer `enabled: false` without checking
the token, since a false claim can only opt a client out. A selected client's
token is checked, and a successful remote check is cached for 10 minutes, keyed
by the token's SHA-256, for up to 1,000 tokens; when the cache is full, the entry
closest to expiry makes room. The two failure answers differ on purpose:

| Answer | When | What the client does |
| --- | --- | --- |
| 401 | The token is missing, refused or invalid, or belongs to another account | Stops recording |
| 503 `Account service unavailable` | `REPLAY_AUTH_URL` cannot be reached, takes over 3 seconds, or answers 429 or 5xx | Keeps its session and tries again at the next poll |

So a restart of your app's server does not end every running recording.

For account deletion, existing-database installs erase associated replays before
deleting a `users` record (`REPLAY_AUTH_COLLECTION` changes that collection name).
A separate app database must call the replay erasure route before completing
its own account deletion:

```text
POST /api/replay/forget
X-Replay-Erase-Key: YOUR_SERVER_ONLY_KEY
Content-Type: application/json

{"accountId":"ACCOUNT_ID"}
```

Set `REPLAY_ERASE_KEY` to the same random secret of at least 32 characters on
both servers. Repeat the request until `remainingSessions` is zero; each request
removes up to 200 of the account's oldest sessions and their chunks, and blocks
new sessions for that account for 24 hours. Fail or retry account deletion if
erasure fails, or let the retention period remove what is left. Keep this
endpoint internal where possible. The dashboard's superuser API also supports
`DELETE /api/replay/accounts/{id}` with the same batched response. Sessions
recorded without an account are not linked to it and expire with retention.

## Settings and playback

The dashboard edits rows in `replay_settings`:

| Key | Values | Initial value |
| --- | --- | --- |
| `mode` | `off`, `percentage`, `accounts` | `off` |
| `percentage` | 0–100, stable sampling by account or device | `0` |
| `account_ids` | JSON array of account IDs | `[]` |
| `retention_days` | 1–365 days | `14` |
| `daily_limit_mb` | 1–1048576 MB of gzip data a day | `1024` |
| `mask_selector` | CSS selector list whose text is recorded as `*` | `''` |
| `block_selector` | CSS selector list whose elements are replaced by empty boxes | `''` |

Rows store their values as JSON text, so a selector row holds a JSON string such
as `".chat-message, [class*=\"name\"]"`. The migration does not seed the
`daily_limit_mb`, `mask_selector` or `block_selector` rows; the server uses the
initial values above until the settings are saved. Open
clients check settings every 45 seconds. Uploads also check the current gate, so
turning recording off refuses new chunks immediately. Every minute a sweep
deletes expired sessions, 20 at a time, for up to about 5 seconds.

`daily_limit_mb` caps the gzip bytes of sessions started in the last 24 hours.
Past it, uploads get 429 `Replay storage budget reached` until older sessions
leave that window. Chunks are stored as base64 text, a third larger than the bytes
the limit counts, so at the defaults (1024 MB a day, 14 days) plan for about
14 GiB of recordings and about 19 GiB of disk.

### Privacy rules

`mask_selector` and `block_selector` are edited in the dashboard under Recording
settings, as ordinary CSS selector lists. Separate rules with commas: a line break
alone is a descendant combinator in CSS, not a separator.
They live on the replay server, so they change without an app release. Each
holds up to 20,000 characters, and control characters other than tabs and line
breaks are refused.

`/config` and `/start` send them to the app as `maskTextSelector` and
`blockSelector` whenever they answer `enabled: true`. The app adds them to its
built-in rules (inputs, `[contenteditable]`, `[data-replay-mask]`, canvas, media,
iframes, `[data-replay-block]`) and to any `maskTextSelector` or `blockSelector`
passed to `startReplay`.

A change applies to what is recorded after it. An open app picks it up at its
next settings check, within about a minute, then stops its recorder and starts
it again, so the next full snapshot uses the new rules. Recordings already
stored keep the rules they were made with.

Before it records, the app checks every rule with the page's own CSS parser. If
a rule cannot be read, from the server or from the app, the app records nothing
rather than record that text unmasked, and checks again at the next poll. A
running recording that receives such a rule stops, keeps what it had already
recorded, and resumes once the rule is fixed. The dashboard refuses to save a
selector its own browser cannot read, but an app on an older WebView can still
reject syntax that a new desktop browser accepts, such as `:has()` before
Chromium 105. Watch a new recording after each change.

Filter sessions by account, device, a date range in the viewer's local time, or
any room visited in the session. The room filter matches a whole room code in any
case. Playback includes rrweb's timeline, speed and pause controls. Missing or
unreadable chunks are marked as gaps, and playback waits for a complete DOM
snapshot after each one. A chunk whose sequence number was already played is
skipped.

## Privacy and limits

- All input values are masked. Contenteditable text is masked too.
- Canvas, iframes, video and audio are blocked. No screenshots, WebGL capture,
  microphone, console or network payload recording is enabled.
- Text already rendered outside an input needs a mask or block rule, set in the
  dashboard (see [Privacy rules](#privacy-rules)) or passed to `startReplay`, or
  a `sensitiveText` list. Review these against your actual UI. A rule the app
  cannot parse stops recording instead of leaving text unmasked.
- Sensitive attributes are removed, and so is every `data-*` attribute outside a
  short safe list, which can make some layouts replay slightly off. URL query
  strings and navigation fragments are stripped. Your own secrets embedded in URL
  path segments still need a blocking rule.
- Uploads use per-session credentials, gzip compression, sequence numbers and
  idempotent retries. All replay reads require a superuser.
- The client bounds its buffers and discards all queued history when recovery is
  necessary, then records a fresh snapshot. A single event over 1 MiB stops that
  recorder instance. This protects the host app from oversized pages.
- A failed upload with no status, 408, 429 or 5xx keeps its chunk and retries
  after 5 seconds, doubling to at most 5 minutes; a successful upload resets the
  wait. A successful `/config` poll resets it only when the last failure had no
  status, so a 429 or 5xx still waits its turn. 410 starts a new session. 413 takes a fresh snapshot. 401, 403 and 404 end
  the session, and the next poll decides whether to start another. Any other 4xx,
  such as 400, 409 or 422, drops the queue and takes a fresh snapshot, and three
  in a row stop recording until the account or device changes.
- Chunks normally flush every 25 seconds. Native pause flushes through
  `CapacitorHttp` or the injected transport. At web page exit, the chunk still being compressed, the
  pending batches and the buffer are packed into one chunk per room, up to 256 KB
  in all before compression, and sent with queued chunks by `sendBeacon` within a
  60 KB budget. A chunk whose `keepalive` upload is already under way is not sent
  again. Abrupt process termination can lose a tail.
- A session lasts at most four hours, 2,048 chunks, 40 MiB compressed, 96 MiB
  declared raw data or 500,000 events. The server answers 410 past a limit, and
  the client then starts another session. The client also moves to a new session
  on its own before it would send chunk 2,048, dropping any chunks still queued.
  Client claims never authorize replay reads.
- Chunk times may be up to 24 hours ahead of the server clock, so a phone whose
  clock is slow, or up to a day fast, still uploads. `/start` returns `expiresIn`,
  and the client times the session's four hours from it on its own clock.
- Each client IP may upload 64 MiB of gzip data an hour; past that, uploads get
  429 `Replay upload budget reached`. Once 4,096 IPs have uploaded in an hour, new
  ones are not counted until the next hour, and `daily_limit_mb` still caps the
  total. Per IP and minute, the server allows 120 `/config`, 30 `/start` and 240
  `/chunks` requests, and answers 429 `Too many replay requests` past that. Once
  it counts 4,096 route-and-IP pairs in a minute, new pairs are not counted until
  the next minute. New sessions are limited to 12 an hour per device, 120 per
  IP and 3,000 in total. See [Behind a reverse proxy](#behind-a-reverse-proxy).
- Chromium 91 is the client floor. No `structuredClone`, `randomUUID` or
  `CompressionStream` is required. Compression runs in a worker, except the
  page-exit tail, which is compressed synchronously.

DOM replay reconstructs the page. External assets must remain available; it is
not a pixel video archive. Canvas areas remain blank. After changing your UI or
its privacy rules, watch a new recording to check them.

## Development and release

```sh
npm test
npm run build
npm pack --dry-run
```

Tests cover queue bounds, retries, snapshot recovery, masking, settings, server
privacy rules, lifecycle, Capacitor detection, server validation, account
verification, erasure and migration isolation.
The application integrating this package should also measure frame times, CPU
and bytes per minute on its own screens and devices. `getMetrics()` reports
wire bytes and package processing time; its timing does not include all of
rrweb's mutation observer work and is not a total CPU measurement.

Publish from this directory as a separate repository. Set the desired package
name, repository URL and release version before `npm publish`. No command here
publishes a package or deploys a server automatically.

### Upstream references

- [rrweb recorder and player APIs](https://github.com/rrweb-io/rrweb/blob/main/guide.md)
- [rrweb documentation in Context7](https://context7.com/rrweb-io/rrweb)
- [PocketBase JavaScript extensions](https://pocketbase.io/docs/js-overview/)
- [PocketBase migrations](https://pocketbase.io/docs/js-migrations/)

Dependencies are pinned to `@rrweb/record` and `rrweb-player` 2.1.6 and `fflate`
0.8.3. The dashboard bundles the player; it is not loaded into the recorded app.
