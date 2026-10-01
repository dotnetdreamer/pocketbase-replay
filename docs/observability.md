# Errors and logs

[Back to README](../README.md)

Error tracking and logs run independently of DOM recording. Each feature must
be enabled in the dashboard and in your client configuration

## Enable the features

1. Upgrade the server hooks and install the new migration as described in
   [installation](installation.md#upgrade-the-extension)
2. Open `/dash/replay`, sign in as a superuser, and open **Errors and logs settings**
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
| `errors` | `false` | `true` enables manual exception capture; `{ captureUnhandled: true }` also collects browser `error` and `unhandledrejection` events |
| `logs` | `false` | `true` enables manual log capture; `{ captureConsole: true }` also captures supported console methods, or pass an array of levels to select them |
| `service` | Empty | Labels entries for filtering, such as `frontend`, `checkout` or `api` |
| `replay` | Absent | A replay controller that supplies credentials for the active recording |
| `session` | Absent | A callback returning `{ sessionId, token }` for custom recording integrations |
| `sensitiveText` | Absent | A callback returning strings to redact from messages, stacks and attributes |
| `beforeSend` | Absent | Edit a sanitized event before it is queued, or return `null` to discard it |
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

## Server configuration

The dashboard saves one JSON object under the `observability` key in
`replay_settings`. `GET` and `POST /api/replay/observability/settings` expose
the same object to superusers

| Key | Allowed values | Default |
| --- | --- | --- |
| `errors_enabled` | Boolean | `false` |
| `logs_enabled` | Boolean | `false` |
| `alerts_enabled` | Boolean | `true` |
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
Replay has its own storage budget. Settings changes apply at ingestion, so a
disabled feature immediately refuses new uploads. Clients refresh their
configuration every 45 seconds

Session limits count newly issued credentials. Renewing the same credential
does not consume another session. Configuration requests have their own
minute limit; the upload request limit applies separately to errors and logs.
The IP upload allowance is shared by both. MB values mean 1024 × 1024 bytes.
Older settings and dashboard saves retain omitted values

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
and record IDs ignored. Without a stack the message decides as well. The
detail shows the stack, occurrence count, metadata, attributes and individual
recording links

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

Every entry needs a stable `id`, a Unix millisecond `timestamp` and a nonempty
`message`. Errors also accept `name`, `stack`, `handled` and severity; logs
accept any supported severity. Both accept `service`, `room`, JSON
`attributes`, and optional `sessionId` plus `sessionToken` for replay linkage

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
