# Capacitor plugin

[Back to platform plugins](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/plugins/README.md)

`capacitor-pocketbase-replay` wraps the [PocketBase Replay](https://github.com/dotnetdreamer/pocketbase-replay#readme)
client for Capacitor apps, with a native layer on Android and iOS

Recording runs in the WebView through the `pocketbase-replay` client, while the
native layer reports when the app leaves the screen and comes back. Android
and iOS can also record masked WebView screenshots; this is off by default

JavaScript errors and structured application logs also run in the WebView,
with the same native pause and resume handling

## Install

In your app, install the plugin and client from npm, then sync the native
projects:

```sh
npm install capacitor-pocketbase-replay pocketbase-replay
npx cap sync
```

Build both packages from a checkout of this repository:

```sh
npm ci
npm pack
cd plugins/capacitor
npm ci
npm pack
```

In your app, install both tarballs using the filenames printed by `npm pack`,
then sync the native projects:

```sh
npm install /path/to/pocketbase-replay-VERSION.tgz /path/to/capacitor-pocketbase-replay-VERSION.tgz
npx cap sync
```

`pocketbase-replay` is a peer dependency, so your app chooses its version

Set up the replay server as described in [installation](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/installation.md)

## Usage

```ts
import { Capacitor } from '@capacitor/core';
import { PocketBaseReplay } from 'capacitor-pocketbase-replay';

await PocketBaseReplay.start({
  endpoint: 'https://replay.example.com',
  metadata: () => ({
    deviceId: yourApp.deviceId,
    platform: Capacitor.getPlatform(),
    appVersion: '1.0.0',
    accountId: yourApp.account?.id || '',
    authToken: yourApp.authToken || '',
  }),
  errors: { captureUnhandled: true },
  logs: { captureConsole: ['warn', 'error'] },
  service: 'mobile',
});

await PocketBaseReplay.captureException({ error: new Error('Checkout failed') });
await PocketBaseReplay.captureLog({ level: 'info', message: 'Checkout started' });

// After sign-in, sign-out or a room change:
await PocketBaseReplay.refresh();

// When recording should end:
await PocketBaseReplay.stop();
```

`start` takes the client's replay options plus `errors`, `logs`, `service` and
`beforeSend`. Enable **Collect errors** and **Collect logs** in the dashboard's
**Diagnostics** settings to receive errors and logs. Both features default off

Pass your PocketBase JS SDK client as `pocketbase` to record its calls, such as
`orders.create · 400`, and see in the player why the server refused one. See
[PocketBase calls](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/integration.md#pocketbase-calls)

The optional `apiKey` option works on `start` and `startObservability`. Set it
when you enable **Require API key** under the dashboard's **Security**
button. A combined `start` passes the same key to replay and
diagnostics; independently started diagnostics keep their own key when a
later replay-only `start` leaves them running

**Require a signed-in account** is a separate optional requirement using the
`accountId` and `authToken` metadata above. Both security requirements default
off. Ingestion keys are public and copyable from an installed app and never
grant access to recorded data or administration. See
[ingestion security](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/authentication.md#optional-ingestion-requirements)

See [client integration](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/integration.md) for replay and
[errors and logs](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/observability.md) for capture options, privacy and
server settings

The client is loaded by `start`, so importing the plugin at the top of your app
adds almost nothing to its startup

## Platforms

| Part | Android and iOS | Web and Electron |
| --- | --- | --- |
| Recording | The client, in the WebView | The client, in the page |
| Pause and resume | This plugin's native app state | `visibilitychange`, `pagehide` and `pageshow` |
| Requests | `CapacitorHttp` | `fetch`, and `sendBeacon` at page exit |

Pause and resume happen at the same moments as `@capacitor/app`'s
`appStateChange`, so your app does not need that plugin:

- Android pauses when the app leaves the screen, but not for a sheet or dialog
  shown over it
- iOS pauses when the app resigns active, which includes Control Center and
  incoming calls

Until `npx cap sync` has added the native layer, the client falls back to its
own detection

## Screenshot replay

Enable screenshots explicitly on Android or iOS after syncing the plugin:

```ts
await PocketBaseReplay.start({
  endpoint: 'https://replay.example.com',
  metadata: () => ({ deviceId: 'device-123', platform: Capacitor.getPlatform(), appVersion: '1.0.0' }),
  // The web build keeps DOM replay; screenshot mode rejects outside Android and iOS.
  screenshotMode: Capacitor.isNativePlatform(),
  screenshotOptions: {
    intervalMs: 1000,
    maxDimension: 1280,
    maskAllImages: true,
  },
});
```

Omit `screenshotMode`, or set it to `false`, to use DOM replay without native
screenshot calls. Calling `start` again switches modes. Screenshot mode
requires the synced Android or iOS native plugin; it rejects on web or when
the native layer is missing

Build or update the plugin and `pocketbase-replay` client together. Screenshot
mode rejects an older client that lacks image replay support

| Option | Default | Behavior |
| --- | --- | --- |
| `screenshotMode` | `false` | Record masked native WebView images instead of the DOM |
| `screenshotOptions.intervalMs` | `1000` | Delay between periodic captures, clamped to 500–60000 ms; requested full snapshots may happen sooner |
| `screenshotOptions.maxDimension` | `1280` | Longest PNG edge, clamped to 256–1280 pixels; large images may be reduced further |
| `screenshotOptions.maskAllImages` | `true` | Mask images and CSS background images; allowing them also requires the server's **Record images** setting |

Native code paints over inputs, editable areas, `data-replay-mask` areas,
mask and block selectors, and text matching `sensitiveText` before an image
crosses the bridge. Canvas, embedded pages, video and other media are blocked.
Uninspectable or changing layouts can skip frames; complex painting effects
can mask the entire viewport. Review a recording against your actual UI and
mark other private content explicitly. See [privacy and limits](../../docs/privacy-and-limits.md#capacitor-screenshot-mode)

No frame is taken while a CSS transition or animation runs in the page, so a
looping spinner or shimmer placeholder pauses capture until it is removed.
Pages with more than 10,000 displayed elements and text nodes are not
captured. On iOS the page's viewport must fill the WebView, as with
Capacitor's default `ios.contentInset` of `never`; with content insets no
frames are taken

On Android and iOS the plugin watches for shadow roots from the moment the app
loads it, so screenshot mode can inspect closed shadow roots like open ones;
the watch only notes them. Import the plugin before your app renders, for
example in `main.ts`. A custom element that was already set up when the plugin
loaded may hold a closed root nothing can see, so it masks the whole viewport.
Angular component hosts and Ionic components rendered after the import are
inspected like any other element

The capture covers the visible WebView. Native views, system sheets and the
system keyboard outside it are not included. Images use the same replay events
as Flutter, so the existing server and player need no changes. Activity,
PocketBase calls, errors, logs, triggers and native pause/resume continue to work

Unchanged images are skipped and frames upload as they are taken. Each PNG is
at most 192 KiB, but a screen that changes every second can send several MiB
a minute, far more than DOM replay. Check the per-IP upload allowance (64 MiB
of gzip data an hour by default, under **Rate limits** in **Security**) and the
daily storage budget. Consider
[trigger mode](../../docs/configuration.md#record-only-when-something-breaks)
and a longer interval. In trigger mode the device keeps up to 6 MiB of frames:
a minute or more of a screen that changes now and then, less when large frames
change every second. The server's session limits apply

## API

### start(options)

```ts
start(options: StartOptions) => Promise<void>
```

Starts recording, with the same options as the client's `startReplay`, and
starts error and log capture when `errors` or `logs` is set

Calling it again stops the running recorder first, so there is never more than
one. Capture is replaced only by a call that sets `errors` or `logs`; a
replay-only call leaves capture started earlier, by `start` or
`startObservability`, running

Capture begins straight away. Errors thrown before the server's settings
arrive are queued and sent once they do

It rejects if the client cannot be loaded; errors while recording never reach your app

### stop()

```ts
stop() => Promise<void>
```

Stops recording and diagnostics and releases their listeners

Android and iOS have no beacon at exit, so events not yet uploaded there are
dropped; call `flush()` first to send them

### flush()

```ts
flush() => Promise<void>
```

Uploads queued recording events, exceptions and logs now

### refresh()

```ts
refresh() => Promise<void>
```

Reads `metadata()` and the server's recording and diagnostic settings again,
after sign-in, sign-out or a room change

### getMetrics()

```ts
getMetrics() => Promise<GetMetricsResult>
```

Returns counters for the running recorder, or `null` before `start` and after `stop`

### trigger(options)

```ts
trigger(options?: { reason?: string }) => Promise<{ sessionId: string | null }>
```

Marks this moment on the recording, for example from a **Report a problem**
button. When the server records only when something breaks, it also uploads
what the device kept and records live for one more minute. Resolves with the
recording's ID, or `null` when nothing is recorded or its session cannot start
yet. Errors captured by the plugin trigger the recorder too. See
[triggers](../../docs/integration.md#triggers-and-bug-reports)

### startObservability(options)

```ts
startObservability(options: ObservabilityOptions) => Promise<void>
```

Starts errors and logs without starting a recorder. A running recorder supplies
the session link automatically. Calling this method again replaces the current
diagnostics controller

```ts
await PocketBaseReplay.startObservability({
  endpoint: 'https://replay.example.com',
  metadata: () => ({ deviceId: yourApp.deviceId, platform: 'ios', appVersion: '1.0.0' }),
  errors: true,
  logs: true,
});
```

### stopObservability()

Stops only errors and logs. Recording keeps running

### captureException(options)

```ts
captureException(options: CaptureExceptionOptions) => Promise<{ id: string | null }>
```

Queue an exception. Supply `error` and optional `attributes`, `groupingKey`,
`handled`, and `level` (`error` or `fatal`). A stable grouping key joins known
failures within the same service across builds and platforms. Requires the client's `errors` option and the
server's **Collect errors** switch

### captureLog(options)

```ts
captureLog(options: CaptureLogOptions) => Promise<{ id: string | null }>
```

Queue a structured log. Supply `level`, `message` and optional `attributes`.
Levels are `trace`, `debug`, `info`, `warn`, `error` and `fatal`. Requires the
client's `logs` option and the server's **Collect logs** switch

A returned event ID means queued locally, not confirmed delivered. `null`
means capture is unavailable, filtered or full

### getObservabilityMetrics()

```ts
getObservabilityMetrics() => Promise<{ metrics: ObservabilityMetrics | null }>
```

Reports enabled features, captured and uploaded entries, dropped entries,
queued bytes and network failures

This plugin collects JavaScript errors and application logs, including optional
console capture. It does not collect native process crashes or device system logs

### Types

| Type | Definition |
| --- | --- |
| `StartOptions` | `ReplayOptions` plus `errors`, `logs`, `service`, `beforeSend`, `screenshotMode` and `screenshotOptions` |
| `ScreenshotOptions` | `{ intervalMs?, maxDimension?, maskAllImages? }` |
| `GetMetricsResult` | `{ metrics: ReplayMetrics \| null }` |
| `TriggerOptions` | `{ reason? }`, a label of up to 64 characters |
| `TriggerResult` | `{ sessionId: string \| null }` |
| `CaptureExceptionOptions` | `{ error, attributes?, groupingKey?, handled?, level? }` |
| `CaptureLogOptions` | `{ level, message, attributes? }` |
| `GetObservabilityMetricsResult` | `{ metrics: ObservabilityMetrics \| null }` |

`ReplayOptions`, `ReplayMetadata`, `ReplayMetrics` and `ReplayTransport` are
re-exported from the client

The plugin also re-exports the diagnostics option, event, context, log level
and metrics types

## Development

The plugin links to the client at the repository root, so install that first,
which also builds it:

```sh
npm ci
cd plugins/capacitor
npm ci
npm test
```

`npm test` builds the plugin, then tests its logic and the built package

`npm run verify:android` compiles the Android layer and needs JDK 21 and the
Android SDK

`npm run verify:ios` compiles the iOS layer and needs macOS with Xcode

Run the native lifecycle tests on an installed iOS simulator:

```sh
npm run test:ios -- -destination 'platform=iOS Simulator,name=iPhone 17'
```

The native XCTest cases send UIKit notifications through Capacitor listeners and
check pause, resume, listener removal and plugin release. They also check that
background and foreground notifications do not send duplicate active events,
validate screenshot plans, and check PNG masking, scaling and size limits.
