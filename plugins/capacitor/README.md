# Capacitor plugin

[Back to platform plugins](../README.md)

`capacitor-pocketbase-replay` wraps the [PocketBase Replay](../../README.md)
client for Capacitor apps, with a native layer on Android and iOS

Recording runs in the WebView through the `pocketbase-replay` client, while the
native layer reports when the app leaves the screen and comes back

JavaScript errors and structured application logs also run in the WebView,
with the same native pause and resume handling

## Install

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

Set up the replay server as described in [installation](../../docs/installation.md)

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
**Errors and logs settings** to receive diagnostics. Both features default off

See [client integration](../../docs/integration.md) for replay and
[errors and logs](../../docs/observability.md) for capture options, privacy and
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
| `StartOptions` | `ReplayOptions` plus `errors`, `logs`, `service` and `beforeSend` |
| `GetMetricsResult` | `{ metrics: ReplayMetrics \| null }` |
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

The four XCTest cases send UIKit notifications through Capacitor listeners and
check pause, resume, listener removal and plugin release. They also check that
background and foreground notifications do not send duplicate active events.
