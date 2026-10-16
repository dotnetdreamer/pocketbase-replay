# Errors and logs

[Back to README](../README.md)

Error tracking and logs run independently of DOM recording. Each feature must
be enabled in the dashboard and in your client configuration

## Enable the features

1. Upgrade the server hooks and install the new migration as described in
   [installation](installation.md#upgrade-the-extension)
2. Open `/dash/replay`, sign in as a superuser, and open **Diagnostics**
3. Enable **Collect errors**, **Collect logs**, or both. Set retention and the
   daily storage limit, then save. Open **Rate limits** to adjust session,
   request and upload limits for your traffic
4. Start the client with the corresponding `errors` and `logs` options

Both switches start off on new and upgraded servers. Replay sampling stays
unchanged, and clients that only call `startReplay` do not capture diagnostics

## Browser and Electron

```ts
import { startObservability, startReplay } from 'pocketbase-replay';

const metadata = () => ({
  deviceId: yourApp.deviceId,
  platform: 'web',
  appVersion: '1.0.0',
  accountId: yourApp.account?.id || '',
  authToken: yourApp.authToken || '',
  room: yourApp.roomCode || '',
});

const replay = startReplay({ endpoint: 'https://replay.example.com', metadata });
const diagnostics = startObservability({
  endpoint: 'https://replay.example.com',
  metadata,
  errors: { captureUnhandled: true },
  logs: { captureConsole: ['warn', 'error'] },
  service: 'frontend',
  replay,
});

try {
  await yourApp.checkout();
} catch (error) {
  diagnostics.captureException(error, { attributes: { operation: 'checkout' } });
}
diagnostics.captureLog('info', 'Checkout started', { cartItems: 3 });

// After the account, device or room changes:
await replay.refresh();
await diagnostics.refresh();

// Before disposal, send what is queued:
await diagnostics.flush();
diagnostics.stop();
replay.stop();
```

Omit `replay` if you only need errors and logs. When supplied, it attaches the
active recording to newly captured entries. The dashboard shows a replay link
only while that recording exists, and opens it near the entry's timestamp

When the server [records only when something breaks](configuration.md#record-only-when-something-breaks),
a captured exception that `beforeSend` keeps also triggers the recorder; one it
drops does not. The error waits up to 10 seconds
for the session its trigger starts, then links to it. The recording's activity
panel lists the session's stored errors and logs at their moments, up to the
newest 1,000 of each, and says when it left some out

`captureException` and `captureLog` return a queued event ID, or `null` when
capture is disabled, the event is filtered out, or a limit is reached. They do
not wait for a network request. A queued ID does not confirm server ingestion

Capture starts at once. Entries captured before the server's first answer wait
in the queue and are sent when it arrives, so an error thrown while the app
starts is kept. If the server has that feature off, they are dropped then.
After a sign-in or sign-out, entries captured under the previous account or
device are dropped, and capture continues under the new one

## Client configuration

| Option | Default | Behavior |
| --- | --- | --- |
| `apiKey` | Absent | Optional ingestion key; required when **Require API key** is enabled in the dashboard |
| `errors` | `false` | `true` enables manual exception capture; `{ captureUnhandled: true }` also collects browser `error` and `unhandledrejection` events |
| `logs` | `false` | `true` enables manual log capture; `{ captureConsole: true }` also captures supported console methods, or pass an array of levels to select them |
| `service` | Empty | Labels entries for filtering, such as `frontend`, `checkout` or `api` |
| `replay` | Absent | A replay controller that supplies credentials for the active recording |
| `session` | Absent | A callback returning `{ sessionId, token }` for custom recording integrations |
| `sensitiveText` | Absent | A callback returning strings to redact from messages, stacks and attributes |
| `beforeSend` | Absent | Edit a sanitized event before it is queued, or return `null` to discard it. Its `id`, `timestamp`, `kind` and `appVersion` stay as captured |
| `transport` | Detected | Override the same `post` and optional `beacon` interface used by replay |
| `subscribeActive` | Detected | Override page or native pause and resume detection |

Log levels are `trace`, `debug`, `info`, `warn`, `error` and `fatal`.
`console.log` maps to `info`. Console capture leaves normal console behavior
in place and releases its hooks when the controller stops

For manual exception capture, the optional context supports `attributes`,
`handled`, `groupingKey` and a `level` of `error` or `fatal`. A grouping key is
a stable label of up to 128 characters for a known failure, such as
`checkout-payment`. It overrides automatic stack matching within the same
service, including when exception names, messages or stacks differ

```ts
diagnostics.captureException(error, { groupingKey: 'checkout-payment' });
```

The key is redacted and stored in `attributes.groupingKey`. For automatic
capture, set that attribute in `beforeSend` when your app recognizes the error.
Leave it out to use automatic grouping

```ts
const diagnostics = startObservability({
  endpoint: 'https://replay.example.com',
  metadata,
  errors: true,
  logs: true,
  sensitiveText: () => yourApp.privateWords,
  beforeSend: (event) => {
    if (event.kind === 'log' && event.level === 'debug') return null;
    return event;
  },
});
```

An empty endpoint or both client switches off makes the controller inactive

Replay and diagnostics each accept `apiKey`; pass it to both controllers when
the server requires a key. **Require a signed-in account** is independent and
uses the same `accountId` and `authToken` metadata. Both requirements default
off. See [ingestion security](authentication.md#optional-ingestion-requirements)

## Capacitor

`start` accepts these options alongside its existing replay options. Only a
`start` call that includes `errors` or `logs` replaces running capture; a
replay-only `start` leaves it running:

```ts
import { PocketBaseReplay } from 'capacitor-pocketbase-replay';

await PocketBaseReplay.start({
  endpoint: 'https://replay.example.com',
  metadata,
  errors: { captureUnhandled: true },
  logs: { captureConsole: ['warn', 'error'] },
  service: 'mobile',
});

await PocketBaseReplay.captureException({ error: new Error('Checkout failed') });
await PocketBaseReplay.captureLog({
  level: 'info', message: 'Checkout started', attributes: { cartItems: 3 },
});
await PocketBaseReplay.flush();
await PocketBaseReplay.stop();
```

For diagnostics without a recorder, call
`PocketBaseReplay.startObservability({ endpoint, metadata, errors: true, logs: true })`
and use `stopObservability()` to release only that controller. A recorder
started later links its recording to new entries. `stop()` ends both

Capture runs in the WebView on Android and iOS and uses the plugin's native
lifecycle. These APIs collect JavaScript exceptions and application logs. They
do not install native crash handlers or collect Android logcat or iOS system logs

See the [plugin API](../plugins/capacitor/README.md)

## Flutter

The [Flutter plugin](../plugins/flutter/README.md) takes the same capture
options in Dart. `start` with `errors` or `logs` replaces running capture, as
in Capacitor:

```dart
Future<void> main() => PocketBaseReplay.runZoned(() async {
  await PocketBaseReplay.start(PocketBaseReplayOptions(
    endpoint: 'https://replay.example.com',
    metadata: () => ReplayMetadata(deviceId: yourApp.deviceId, appVersion: '1.0.0'),
    errors: const ErrorTrackingOptions(captureUnhandled: true),
    logs: const LogCaptureOptions(capturePrint: true),
    service: 'mobile',
  ));
  runApp(const PocketBaseReplayWidget(child: MyApp()));
});

// In your checkout handler:
Future<void> pay() async {
  try {
    await checkout();
  } catch (error, stack) {
    PocketBaseReplay.captureException(error, stackTrace: stack, groupingKey: 'checkout-payment');
  }
  PocketBaseReplay.captureLog(LogLevel.info, 'Checkout started', attributes: {'cartItems': 3});
}
```

`captureUnhandled` collects errors that reach `FlutterError.onError` and
`PlatformDispatcher.onError`, and the handlers the app set before still run.
A framework error such as a layout overflow is named `FlutterError`, with its
summary line as the message and its library as an attribute. `capturePrint`
stores `debugPrint` output, and `print` inside `PocketBaseReplay.runZoned`, as
`info` logs. Initialize Flutter's binding, start replay and call `runApp` inside
the same `runZoned` body so print capture includes later input callbacks.
`triggerOnError: false` keeps captured exceptions from triggering a Flutter
recording; explicit `trigger()` calls still work.
`PocketBaseReplay.startObservability` captures without a recorder

Dart stacks are sent with each frame written as `at function (file:line:column)`,
so issues group by their top frames as they do for JavaScript. App frames are
`package:` paths, which stay the same across devices and builds. A release
built with `--obfuscate` reports addresses instead, so its errors group by
message; read their stacks with `flutter symbolize` and the build's
`--split-debug-info` files. A Flutter web release reports JavaScript frames in
`main.dart.js`; build it with `flutter build web --source-maps` and upload
`build/web` with the [source map CLI](#upload-with-the-cli) to see Dart files
and lines

The upload credential is kept in memory, so each app launch asks for a new one.
The plugin does not collect native crashes or system logs. See the
[plugin's guide](../plugins/flutter/README.md#errors-and-logs)

## Server configuration

The dashboard saves one JSON object under the `observability` key in
`replay_settings`. `GET` and `POST /api/replay/observability/settings` expose
the same object to superusers

The six rate fields below are also available in **Security**, under
**Rate limits**, and through `GET` and `POST /api/replay/security/limits` in
the `observability` group. Both panels use the same saved values. **Save
limits** applies changes; **Use default limits** fills the form and takes
effect only after saving. Replay limits are separate

| Key | Allowed values | Default |
| --- | --- | --- |
| `errors_enabled` | Boolean | `false` |
| `logs_enabled` | Boolean | `false` |
| `alerts_enabled` | Boolean | `true` |
| `server_errors` | Boolean; keeps [server errors](#server-errors) while `errors_enabled` is on | `true` |
| `errors_retention_days` | 1 to 365 | `30` |
| `logs_retention_days` | 1 to 365 | `14` |
| `daily_limit_mb` | 1 to 1048576 | `64` |
| `alert_webhook_url` | Empty, or an `http` or `https` address | Empty |
| `sessions_per_device_hour` | 1 to 1000000 | `30` |
| `sessions_per_ip_hour` | 1 to 1000000 | `120` |
| `sessions_per_hour` | 1 to 1000000 | `20000` |
| `config_requests_per_ip_minute` | 1 to 1000000 | `120` |
| `upload_requests_per_ip_minute` | 1 to 1000000 | `120` |
| `upload_mb_per_ip_hour` | 1 to 1048576 | `8` |

The daily limit conservatively counts received error and log data, issue
summaries and new alerts over the last 24 hours. Its counter commits with
the uploaded entries, and a refused batch rolls it back. SQL totals refresh
once per minute
Replay has its own storage budget. Settings saved from the dashboard apply to
the next request, so a disabled feature immediately refuses new uploads. Upload
and config requests read the settings from memory, so a change made directly
to the `replay_settings` row takes up to five seconds. Clients refresh their
configuration every 45 seconds

Limits stay enabled even when the API key and account requirements are off.
Saving them applies immediately, keeps current usage counters and leaves
feature switches, privacy, retention and daily storage budgets unchanged.
Requests and new-credential limits accept positive whole numbers up to
1000000; the IP byte allowance accepts 1 to 1048576 MiB. The dashboard labels
this allowance MB, with each unit meaning 1024 × 1024 bytes

Session limits count newly issued credentials. Renewing the same credential
does not consume another session. Configuration requests have their own
minute limit; the upload request limit applies separately to errors and logs.
The IP upload allowance is shared by both. MB values mean 1024 × 1024 bytes.
Older settings and dashboard saves retain omitted values

Users behind the same IP share these limits. Configure
[trusted proxy headers](installation.md#behind-a-reverse-proxy) so PocketBase
sees each client's address. Request and per-IP byte counters reset at their
fixed minute/hour boundaries or on a server restart; new-credential counts
cover stored credentials created in the preceding hour and survive restarts.
See [the limits API](configuration.md#limits-api) for partial updates and
[counter constraints](privacy-and-limits.md#counter-windows-and-restarts)

## Issues and alerts

The **Issues** tab groups similar exceptions by service, exception name and
the top stack frames. A frame is reduced to its function and file: the origin
(`https://localhost` on Android, `capacitor://localhost` on iOS), the build hash
in a file name such as `index-BHg5Ehe4.js`, and line numbers are left out, so
common errors group across platforms and releases. Automatic matching is a
heuristic; use a stable `groupingKey` when your app needs deterministic grouping.
Minified one- and
two-letter function names change with every build, so when fewer than two
frames are named, the message decides instead, with numbers, hex values, UUIDs
and record IDs ignored. Without a stack the message decides as well. With
[source maps](#source-maps), frames they resolve group by their original
function and file instead. The detail shows the stack, occurrence count,
metadata, attributes and individual recording links

Use **Resolve** after fixing an issue. An occurrence that happens after that
moment reopens it and creates a regression alert. One that happened before
it, delivered late by a device that was offline, is added without reopening
it. **Ignore** keeps an issue suppressed even when another occurrence arrives.
**Reopen** lets you resume investigating it

An alert is raised when an issue first appears or a resolved issue returns.
Alerts are listed in the Issues tab, which refreshes them every 30 seconds
while it is open, and **Mark read** acknowledges one. Turn **Issue alerts** off
to stop raising new alerts; existing alerts remain until deleted or expired

To be told without opening the dashboard, enter an **Alert webhook**. Within a
minute of an alert, the server starts posting it there, up to 20 alerts per
sweep. Discord receives multiple messages when needed to fit complete alerts
within its message limit. Only accepted messages are marked sent, so a failed
message retries without repeating the successful ones:

- Slack incoming webhooks and Google Chat get `{ "text": "..." }`
- Discord webhooks get `{ "content": "..." }`
- Any other address gets `{ "text", "dashboard", "alerts": [...] }`, for an
  automation tool or your own endpoint

The message links to the dashboard when PocketBase's **Application URL** is
set. **Send a test alert** posts a sample to the address in the form, before
you save it. A webhook that keeps failing is retried once a minute and given
up after ten tries; the alert stays in the dashboard, marked as not accepted

## Server errors

With **Collect errors** and **Capture server errors** on in Diagnostics settings, problems on the PocketBase server itself become issues under the service `pocketbase`, grouped and alerted like other errors:

- An error thrown in a pb_hooks route or hook while PocketBase handles a request, such as a `TypeError`, and any request answered with a 5xx status. PocketBase's expected answers, such as refused rules, failed validation and 404s, are not issues
- A cron job that fails
- An error PocketBase logs, including your hooks' `$app.logger().error(...)` calls

A request error keeps its method, path without its query, status, collection and signed-in collection, and the signed-in record's ID as its account when PocketBase logs auth IDs. When the call came from a recording with [PocketBase calls](integration.md#pocketbase-calls) and [linking](integration.md#link-calls-to-pocketbases-request-log) is on, it also keeps the call's ID and that recording, so **Watch replay** opens the moment it happened and the call's details in the player link to the issue

All of them are read from PocketBase's logs once a minute, with a 30-second lag to allow its batched log writes to finish. They typically appear after 30–90 seconds; log batching, load and capture limits can add delay. PocketBase's logs must be on. A stack shows the line within the hook's own function, such as `at pb.js:2:65`, because PocketBase runs each hook handler on its own. At most 120 server errors a minute are kept, within the daily storage budget, and none that names an erased account. Turning **Capture server errors** or **Collect errors** off excludes errors logged during that disabled period, including after capture is enabled again

## Source maps

Production stacks point into minified bundles, such as
`at a (https://app.example.com/assets/index-BHg5Ehe4.js:1:23423)`, or
`https://localhost/...` on Android and `capacitor://localhost/...` on iOS.
Upload each build's source maps, and the occurrence detail shows the original
function, file, line and code. Issues then group by original frames, which do
not change between releases

Maps are stored per app version. An error uses the maps of the `appVersion`
its app reported when the error was captured, so upload with exactly that
version. Each entry carries that version, so errors still queued from an older
build keep it after a newer build on the same device renews the shared
credential. A build that reports no version sends an empty one, and its errors
stay without a version. Entries from clients that predate this use the credential's version. Apps that share a
server need distinct version strings, such as a prefix per app, because an
upload replaces the map stored for the same version and path. A frame's address
loses its scheme, host, query and hash, so both Capacitor origins give
`assets/index-BHg5Ehe4.js`, and it uses the uploaded map whose path is the
longest match for its end. When no path matches, a map with the same file name
is used if it is the only one

### Build with source maps

With Vite, turn source maps on in `vite.config.ts`:

```ts
export default defineConfig({
  build: { sourcemap: 'hidden' },
});
```

`'hidden'` writes the `.map` files without the `//# sourceMappingURL` comment,
so browsers never ask for them. `true` also works, but adds the comment, and
deploying the maps with your app publishes your source code. Upload the maps
from the build output, then delete them before deploying, or let the CLI
delete them with `--delete-after`

### Upload with the CLI

Set `REPLAY_SOURCEMAP_KEY` on the server to a random secret of 32 to 512
characters, such as the output of `openssl rand -hex 32`, and give your build
job the same value, for example from your CI secret store. Then, after each
build:

```sh
# REPLAY_SOURCEMAP_KEY is set in the job's environment
npm run build
npx pb-replay-sourcemaps --endpoint https://replay.example.com --version 1.4.0 --from ./dist --delete-after
```

The CLI finds every `*.js.map`, `*.mjs.map` and `*.cjs.map` under `--from`,
skips `node_modules` and refuses symlinks. Each map is stored under its
generated file's path relative to `--from`, such as `assets/index-BHg5Ehe4.js`.
It prints a line per file and exits non-zero when any upload fails;
`--delete-after` removes only the maps that were uploaded. `--dry-run` checks
and lists the maps without sending anything. The key is read only from the
environment, never from an argument, so it stays out of process lists and
build logs. Uploading the same version again replaces each file's map in one
transaction

Upload before you release the build, so its first errors already group by
original frames. A superuser token works instead of the key for the API, so
the key is needed only by build jobs. Without the key set on the server,
key uploads are refused with 503

### In the dashboard

When any frame of an occurrence resolves, its stack trace shows the original
frames: the function, `source:line:column`, and the code around the line with
the error line highlighted, when the map includes `sourcesContent`.
**Original** and **Minified** switch between this view and the stack as it was
sent, which is also shown when nothing resolves. A frame keeps its own function
name when it is longer than two characters, and otherwise shows the name the
map records there

### How grouping changes

When at least one of an error's top five frames resolves, those frames are
keyed as `identifier@source`: the name the map records at that position, or
`?`, and the original source path without `webpack://`, `./`, leading `../` or
a query. Line numbers are left out, so the issue survives releases. As before,
the message is ignored once at least two frames are named, so messages that
differ by a user or record name still join one issue. The recorded name at a
call site is often the called function rather than the one containing the call;
it is just as stable

Frames from builds without maps keep the automatic grouping described in
[Issues and alerts](#issues-and-alerts). An issue can therefore split between
mapped and unmapped builds: errors from before maps were uploaded, from a
version whose maps were deleted, or from a script without a map form other
issues than the mapped ones. Maps apply to new errors; stored issues are not
regrouped. A `groupingKey` still takes precedence over both

### Limits

- One map per upload, at most 32 MiB, version 3 only. Index maps with
  `sections` are refused; upload each generated file's own map instead
- Up to 20,000 sources, 500,000 names and 4,000,000 mappings segments per map.
  Source paths keep 1,024 characters and names 256. Each source's
  `sourcesContent` keeps up to 2,000,000 characters; a longer file keeps its
  first lines, so later lines show no code
- `appVersion` must be 1 to 64 letters, digits, `.`, `_`, `+` or `-`, starting
  with a letter or digit. `path` is relative, without `..`, a leading `/`, `?`
  or `#`, and names a `.js`, `.mjs` or `.cjs` file
- Mappings must be sorted by generated position, as every common bundler
  writes them
- The server redacts URL queries from stored stacks, and with them the line
  and column that follow, so frames whose script URL has a query, such as
  `index.js?v=3`, are not resolved. Vite and Capacitor URLs have none
- A version's maps stay until you delete them; retention does not remove them

The server decodes a map once on upload and stores it in blocks of about 256
segments, so a lookup reads one block. On PocketBase 0.39.9 on Apple silicon,
a 13.4 MB map with 684,000 segments took about 2.4 seconds to upload and an
850 KB map about 0.2 seconds. Resolving a frame adds under a millisecond to an
error upload

### Manage versions

**Diagnostics** lists the uploaded versions with their file count, size and
upload time, and deletes a version with **Delete**. A build job can delete one
with its key:

```sh
curl -X DELETE -H "x-replay-sourcemap-key: $REPLAY_SOURCEMAP_KEY" \
  "https://replay.example.com/api/replay/sourcemaps?appVersion=1.4.0"
```

### Source map API

| Route | Access | Use |
| --- | --- | --- |
| `POST /api/replay/sourcemaps?appVersion=1.4.0&path=assets/index.js` | Superuser or key | Store the raw source map in the body for that version and generated file, replacing an earlier one |
| `GET /api/replay/sourcemaps` | Superuser | Versions with `files`, `bytes` and `uploadedAt`, newest first. With `?appVersion=`, that version's files |
| `DELETE /api/replay/sourcemaps?appVersion=1.4.0` | Superuser or key | Delete a version's maps |
| `GET /api/replay/errors/{id}/frames` | Superuser | An occurrence's frames with original positions and code |

Send the key in the `x-replay-sourcemap-key` header. An upload answers with
what it stored, for example `{ "ok": true, "appVersion": "1.4.0", "path":
"assets/index.js", "bytes": 873200, "segments": 48444, "blocks": 190,
"sources": 18, "sourcesWithContent": 18, "names": 1408, "replaced": false,
"ms": 135 }`. Errors use `{ "message" }` with status 400 for an invalid map,
version or path, 401 or 403 without access, 413 past a limit and 503 when no
key is configured

The frames route answers with `appVersion`, the number of `sourceMaps` stored
for it, how many frames were `mapped`, and `frames`. Each frame has `raw`,
`function`, `file`, `line` and `column` as the stack gives them, and a resolved
one also has `mapped` with `source`, `line`, `column` and `name`, and
`context` with the 1-based `start` line and up to four `lines` on each side,
each cut to 300 characters. Lines and columns are 1-based throughout

The `1795600004_sourcemaps.js` migration adds the `replay_sourcemaps`,
`replay_sourcemap_blocks` and `replay_sourcemap_sources` collections, with the
record API closed. Without it, errors group as they did before

## Search logs

The **Logs** tab supports message and attribute search, severity, service,
account, device, session and date filters. Open an entry to inspect its
structured attributes and metadata, or view its recording when available

**Log volume** charts the matching entries over time, stacked by level with
errors at the bottom, so a burst of errors or a quiet period stands out. It
follows the same filters as the list, uses up to about 60 periods, and shows
each period's counts on hover, with the arrow keys, or as a table

Dates use the dashboard browser's local timezone. Lists load in pages rather
than downloading the entire log store

From a session's detail, use its issue or log action to filter diagnostics to
that recording

## Ingestion API

Custom senders can use the same API as the SDK:

1. `POST /api/replay/observability/config` with replay metadata. The response
   includes `errorsEnabled`, `logsEnabled`, an upload `token`, `expiresIn`,
   `uploadIntervalMs` and `maxBatchEvents`. Include the token on later config
   requests to reuse it
2. `POST /api/replay/errors` or `POST /api/replay/logs` with
   `{ "token": "...", "events": [ ... ] }`

When **Require API key** is on, include `apiKey` in each config and upload
body, alongside the upload token. It is an ingestion key, separate from
`authToken`, which verifies a user's account. **Require a signed-in account**
refuses anonymous admission and uploads from existing anonymous credentials

Every entry needs a stable `id`, a Unix millisecond `timestamp` and a nonempty
`message`. Errors also accept `name`, `stack`, `handled` and severity; logs
accept any supported severity. Both accept `service`, `room`, JSON
`attributes`, the `appVersion` the entry was captured in (empty for a build
without one, and the credential's when the field is left out), and optional
`sessionId` plus `sessionToken` for replay linkage

Keep each event ID unchanged when retrying. A repeated entry counts as a
duplicate. An ID reused with different content is skipped and counted under
`conflicts`, and the rest of its batch is still stored. Batches accept at most
20 entries within a 64 KiB envelope

A credential lasts four hours, and every config request made with it extends
it again, so a sender that refreshes regularly keeps one credential. A link to
a recording needs that recording's upload token and the same account and
device. A link that fails, for example because the recording was deleted, is
dropped and the entry stored without it

Dashboard routes require a superuser:

| Route | Use |
| --- | --- |
| `GET /api/replay/issues` | Search and filter issues |
| `GET /api/replay/issues/{id}` | Issue and paged occurrences |
| `POST /api/replay/issues/{id}` | Set `status` to `open`, `resolved` or `ignored` |
| `DELETE /api/replay/issues/{id}` | Delete an issue, its occurrences and alerts |
| `GET /api/replay/errors` | Error occurrences across issues, with the logs list's filters, such as `?sessionId=` for one recording |
| `GET /api/replay/errors/{id}/frames` | An occurrence's frames, resolved through [source maps](#source-maps) |
| `GET /api/replay/logs` | Search and filter log entries |
| `GET /api/replay/logs/volume` | Counts per level and period, with the list's filters |
| `GET /api/replay/logs/{id}` | Inspect an entry |
| `DELETE /api/replay/logs/{id}` | Delete an entry |
| `GET /api/replay/alerts` | List issue alerts |
| `POST /api/replay/alerts/{id}/acknowledge` | Acknowledge an alert |
| `POST /api/replay/alerts/test` | Post a sample alert to `alert_webhook_url`, or to the address in the body |

## Privacy and limits

The client and server redact common credentials, email addresses and URL query
strings from diagnostic content. Sensitive attribute keys are redacted, and
client serialization bounds nesting, array size and string length without
calling attribute getters

Use `sensitiveText` and `beforeSend` for your app's own data. DOM selectors do
not mask error messages or log attributes. Automatic console collection is
optional because console output can contain private content

The client keeps a bounded memory queue and retries temporary failures with
backoff. Capture never writes diagnostics to browser storage. Only the upload
credential is kept in `localStorage`, with its account and device, so a page
that reloads often does not need a new one each time. Permanent request
failures and exhausted retries discard affected entries. An entry over 16 KiB
loses its attributes, then the end of its stack and message, instead of being
discarded. `stop()` discards anything still queued; call `flush()` first when
delivery matters

Saved credentials are scoped to the endpoint and ingestion key. The SDK
uses a SHA-256 fingerprint in the storage name and does not store the raw API
key. If WebCrypto is unavailable, keyed credentials stay in memory

The server bounds request size, event count, per-IP traffic, credential
creation, and daily stored bytes. A periodic sweep removes expired entries
and credentials. Account erasure includes its diagnostics and recomputes issue
summaries from remaining occurrences. Deleting a single recording leaves the
errors and logs it was linked to; they lose only the link to the replay

## References

This implementation follows the error and log workflows in
[PostHog issues and exceptions](https://posthog.com/docs/error-tracking/issues-and-exceptions),
[PostHog logs](https://posthog.com/logs),
[Capawesome's exception API](https://github.com/capawesome-team/capacitor-plugins/tree/main/packages/posthog),
and [OpenReplay's exception and console options](https://docs.openreplay.com/en/sdk/constructor/)
