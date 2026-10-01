# Capacitor plugin

[Back to platform plugins](../README.md)

`capacitor-pocketbase-replay` wraps the [PocketBase Replay](../../README.md)
client for Capacitor apps, with a native layer on Android and iOS

Recording runs in the WebView through the `pocketbase-replay` client, while the
native layer reports when the app leaves the screen and comes back

Native features such as device logs belong in that layer too

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
});

// After sign-in, sign-out or a room change:
await PocketBaseReplay.refresh();

// When recording should end:
await PocketBaseReplay.stop();
```

`start` takes the same options as the client's `startReplay`, described in
[client integration](../../docs/integration.md)

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

Starts recording, with the same options as the client's `startReplay`

Calling it again stops the running recorder first, so there is never more than one

It rejects if the client cannot be loaded; errors while recording never reach your app

### stop()

```ts
stop() => Promise<void>
```

Stops recording and releases the recorder

Android and iOS have no beacon at exit, so events not yet uploaded there are
dropped; call `flush()` first to send them

### flush()

```ts
flush() => Promise<void>
```

Uploads buffered events now instead of at the next interval

### refresh()

```ts
refresh() => Promise<void>
```

Reads `metadata()` and the server's settings again, after sign-in, sign-out or
a room change

### getMetrics()

```ts
getMetrics() => Promise<GetMetricsResult>
```

Returns counters for the running recorder, or `null` before `start` and after `stop`

### Types

| Type | Definition |
| --- | --- |
| `StartOptions` | The client's `ReplayOptions` |
| `GetMetricsResult` | `{ metrics: ReplayMetrics \| null }` |

`ReplayOptions`, `ReplayMetadata`, `ReplayMetrics` and `ReplayTransport` are
re-exported from the client

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
