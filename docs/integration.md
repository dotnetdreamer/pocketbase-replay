# Client integration

[Back to README](../README.md)

For exception and log capture, use [`startObservability`](observability.md)
alongside `startReplay`, or on its own. The Capacitor plugin supports the same
capture options. For Flutter apps, see [Flutter apps](#flutter-apps)

## Connect your app

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

Use your app's stable device ID, with an in-memory fallback if storage is
unavailable in private browsing

An empty `endpoint` disables replay, and the recorder is imported only after
the server selects a session

`metadata()` is read again for every request and event, so return the current
account and room each time

Only `accountId` and `deviceId` decide which session is used; `appVersion` also
selects the archived images and fonts in a packaged app

Configure masking and blocking in the dashboard's
[privacy rules](configuration.md#privacy-rules), with optional client rules
for your app

For accounts stored outside the replay database, set up
[account verification](authentication.md)

## Optional settings

| Option | Use |
| --- | --- |
| `sensitiveText: () => string[]` | Mask words such as names and email addresses wherever they appear in recorded text |
| `pocketbase` | Your PocketBase JS SDK client, so its calls are recorded. See [PocketBase calls](#pocketbase-calls) |
| `maskTextSelector` | Add CSS selectors for text masking alongside the server's rules |
| `blockSelector` | Add CSS selectors for blocked elements alongside the server's rules |
| `transport` | Override automatic request transport detection |
| `subscribeActive(listener)` | Override automatic pause and resume detection |
| `initialActive` | Override the initial recording activity state |
| `assetBaseUrl` | Override automatic asset URL rewriting |
| `preserveDataAttributes` | Keep explicitly listed, finite `data-*` UI state values in DOM replay |
| `triggerOnError` | Set `false` so uncaught errors do not upload the recording in [trigger mode](configuration.md#record-only-when-something-breaks) |

Client masking and blocking rules are combined with the server's rules, so
both apply

If your CSS uses a `data-*` attribute to show a screen, opt in only its fixed
UI states. For example:

```js
startReplay({
  endpoint,
  metadata,
  preserveDataAttributes: { 'data-screen': ['language', 'lobby', 'game'] },
});
```

The default short safe list is unchanged. Extra names must be lowercase
`data-*` names, and values must be exact ASCII words containing only
letters, digits, `_` or `-`, up to 40 characters. At most 16 names and 16
values per name are accepted. Private-looking names and values, URLs, arbitrary
text and values matching `sensitiveText` are discarded. If a recorded state
later changes to an unlisted value, replay removes the old attribute. Use
this only for fixed UI state, never for names, account data or identifiers.

## Triggers and bug reports

`replay.trigger(reason)` marks the moment on the recording's timeline. When the server [records only when something breaks](configuration.md#record-only-when-something-breaks), it also uploads what the device kept and records live for one more minute

```js
reportButton.addEventListener('click', async () => {
  // Resolves once the recording's session exists, so the log below links to it
  await replay.trigger('report');
  diagnostics.captureLog('info', 'Problem reported', { report: reportText.value });
});
```

The reason is a label such as `report` or `checkout-failed`. Control characters are removed and it is cut to 64 characters, so no label can stop a recording. The session list shows the first trigger's reason, and repeats of one reason within 5 seconds share one timeline mark. Without a reason the mark reads `manual`

In trigger mode, uncaught errors and unhandled promise rejections are triggers too, unless `triggerOnError` is `false`. Errors captured by `startObservability` trigger the recorder passed as its `replay` option, unless `beforeSend` drops them, and link to the session it starts

`trigger` resolves with `{ sessionId, token }` once the session exists, or with `null` when this device records nothing or its session cannot start yet. The device then keeps its recording and tries again at its next settings check. It never throws

In the Capacitor plugin, `PocketBaseReplay.trigger({ reason: 'report' })` resolves with `{ sessionId }`, and errors captured by the plugin trigger its recorder

In the Flutter plugin, `PocketBaseReplay.trigger('report')` resolves with the session ID, and errors it captures trigger its recorder unless `triggerOnError` is `false`. This opt-out also applies to manually captured exceptions; explicit `trigger()` calls still work

## PocketBase calls

Pass your PocketBase JS SDK client as `pocketbase`, and every call it sends while recording becomes a row in the player's activity panel, such as `orders.create · 400 · Invalid: total`. The Capacitor plugin's `start` takes the same option. In a Flutter app, pass `ReplayPocketBaseClient.new` as the PocketBase Dart SDK's `httpClientFactory`; see [Flutter PocketBase calls](../plugins/flutter/README.md#pocketbase-calls)

```js
import PocketBase from 'pocketbase';

const pb = new PocketBase('https://api.example.com');
const replay = startReplay({ endpoint: 'https://api.example.com', metadata, pocketbase: pb });
```

A call is recorded by how PocketBase routes it: collection, action, record ID, status and time, a list's item count and total, whether it was filtered and which fields it sorted, expanded or picked, and the names and codes of the fields it refused. Only PocketBase's fixed standard error messages are retained; arbitrary validation and hook messages are omitted because they can echo submitted values. Request and response field values, filter text and auth tokens are not recorded. **Record PocketBase calls** in Recording settings is on by default and records nothing until an app passes its client; turning it off stops it for every app at their next settings check

When the replay hooks run inside your app's own PocketBase, so `endpoint` and the client's URL share an origin, the dashboard also explains a call that failed, came back empty or took a second or more:

- The current API rule, such as `createRule: @request.auth.id != ""`, or whether it is locked to superusers
- For a view, update or delete that found nothing, whether the record currently exists and a rule may have hidden it
- For a list that came back empty, the list rule that may be filtering the result
- An error thrown in a hook or route while handling the call

Explanations inferred from a response and current record state are marked as likely. A generic failure can come from an unreadable filter or sort as well as a hook, so those explanations name both possibilities. Rules and record lookups reflect the server now and may differ from when the call was made; a public rule is not evidence that it blocked the call

### Link calls to PocketBase's request log

Set `REPLAY_TRACE_REQUESTS=on` on PocketBase for fuller explanations: the signed-in collection, the time spent on the server, standard errors and refused field names and codes, and a linked [server issue](observability.md#server-errors). Tracing is off by default. It adds hooks to record, auth, batch and realtime subscription requests, with overhead that depends on the server and workload. It does not install middleware around long-lived realtime streams

Calls to the replay server's own PocketBase carry an `X-Replay-Request` header with a random ID and, while a recording is live, its session ID; with tracing on, the replay hooks add it to PocketBase's request log. A page on another origin, such as a Capacitor app, first checks with `GET /api/replay/link` that CORS and any proxy in front of PocketBase let the header through, and sends calls without it until then. A Flutter app on Android, iOS or desktop has no CORS and can send it from the first call; a Flutter web app checks as a page does. PocketBase keeps its request log 5 days by default, so keep its logs on

Only when the replay configuration advertises `REPLAY_TRACE_REQUESTS=on`, the client also adds the same bounded IDs in a `__replayRequest` query parameter. PocketBase's request log retains that marker even when an app hook throws before the tracing hook runs. The marker contains no application values; it is stripped from recorded URLs and explanation attributes. Existing clients pick up the opt-in at their next settings check

Calls without a usable request log are explained from the current rule and record as above. A route of your own can add the metadata link with `require(`${__hooks}/lib/pocketbase.js`).link(e, e.request.header.get('X-Replay-Request'))` in its handler

With network recording also on, a PocketBase call is listed once, as a PocketBase row

## Flutter apps

The [Flutter plugin](../plugins/flutter/README.md), `pocketbase_replay_flutter`, records Flutter apps on Android, iOS, web and desktop. Flutter draws its own interface rather than a DOM, so the plugin sends the screen as images inside rrweb events, which the same viewer plays, with touches, page changes, PocketBase calls, network requests and console output in the activity panel

```dart
Future<void> main() => PocketBaseReplay.runZoned(() async {
  await PocketBaseReplay.start(PocketBaseReplayOptions(
    endpoint: 'https://replay.example.com',
    metadata: () => ReplayMetadata(deviceId: yourApp.deviceId, appVersion: '1.0.0'),
    errors: const ErrorTrackingOptions(captureUnhandled: true),
  ));
  runApp(const PocketBaseReplayWidget(child: MyApp()));
});
```

Keep Flutter binding initialization, replay startup and `runApp` in this same zone so `print` capture also covers later input callbacks

It takes the same metadata, `apiKey`, `sensitiveText`, `triggerOnError` and error and log options as this client. It follows the same recording settings, trigger mode and ingestion requirements, and counts against the same limits. Text fields are always masked, and `ReplayMask` masks any other widget. The dashboard's CSS rules apply only to web pages, except `*` among the mask rules and `img` among the block rules, which mask all text or all images in a Flutter app too. See [the plugin's guide](../plugins/flutter/README.md) for setup, privacy and the API

## Platform detection

The recorder has no React, Capacitor or application dependency

It reads `window.Capacitor` when `startReplay` runs, without importing Capacitor

| Part | Android and iOS with Capacitor | Web and Electron |
| --- | --- | --- |
| Requests | `CapacitorHttp` with a `text/plain` body and 8 second timeouts; no beacon | `fetch` with a `text/plain` body, and `sendBeacon` at page exit |
| Pause and resume | The `App` plugin's `appStateChange` event | `visibilitychange`, `pagehide` and `pageshow` |
| Images and fonts | Loaded from this build's archive on the replay server | Loaded from the page, except in a packaged Electron app |

Native behavior is used only when `Capacitor.getPlatform()` returns `android`
or `ios` and the relevant plugin is registered on the page

`CapacitorHttp` comes with `@capacitor/core`; the `App` plugin is available only
if your app imports `@capacitor/app` somewhere

Without the `App` plugin, native apps receive only `pagehide` and `pageshow`
events for lifecycle handling

The recorder avoids `visibilitychange` on phones because it can arrive late in
the Android WebView

A missing or unusual `Capacitor` global falls back to web behavior

Unless you supply `initialActive`, recording starts active when the page is
visible, and each resume takes a fresh full snapshot

A request sent while the page is hidden uses `keepalive` when its body is no
more than 60,000 characters, allowing it to finish after the page closes

To override a detected behavior:

- Pass `transport: fetchTransport()` to keep `fetch` on a phone
- Pass `subscribeActive: () => () => {}` to disable pause events
- Pass `assetBaseUrl: ''` to leave asset URLs unchanged

See the [Capacitor example](../examples/capacitor.ts)

The [Capacitor plugin](../plugins/capacitor/README.md) reports pause and resume
from its own native code, so it does not need `@capacitor/app`

## Custom transport

A custom `post(url, body)` must return the parsed JSON response and throw
`ReplayHttpError(status)`, or another error with a numeric `status`, for a
non-2xx response

```js
import { ReplayHttpError } from 'pocketbase-replay';

if (response.status < 200 || response.status >= 300) throw new ReplayHttpError(response.status);
```

An error without a status counts as a network failure, like 408, 429 and 5xx,
so the client keeps its session and queue and retries the request

Throwing a plain error for 401 or 403 therefore causes retries instead of
stopping recording

See [retry behavior](privacy-and-limits.md) for the full status handling

## Native images and fonts

Packaged apps serve files from addresses only the device can load:

| Platform | Local origin |
| --- | --- |
| Capacitor on Android | `https://localhost` |
| Capacitor on iOS | `capacitor://localhost` |
| Capacitor Electron | `capacitor-electron://-` |

Archive each build's public images and fonts alongside PocketBase:

```sh
npx pb-replay-assets --from ./dist --target ./backend --version 1.0.0
```

On these origins, the recorder rewrites same-origin image and font URLs under
`/assets`, `/fonts` and `/icons`, including CSS URLs, to
`{endpoint}/replay-assets/{appVersion}/`

The archive's `--version` must match the `appVersion` sent in metadata

An empty or invalid `appVersion` leaves URLs unchanged, using the same version
validation as the archive command

Pass `assetBaseUrl` for another address, or `assetBaseUrl: ''` to disable
rewriting

The archive command copies only images and fonts, refuses conflicting existing
assets, and excludes application JavaScript

Archived files are public, so use only build output containing public assets
and keep each version until its recordings expire

Apps with other asset layouts can host those assets at stable public URLs
