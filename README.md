# PocketBase Replay

Self-hosted DOM session replay, error tracking and logs for PocketBase, with
an rrweb recorder and a private dashboard

## Features

- Add replay to an existing PocketBase or run a dedicated replay server
- Use a framework-independent client in web, Capacitor and Electron apps
- Select sessions with percentage sampling or verified account allowlists
- Control masking, retention and storage limits from the dashboard
- Find recordings by account, device, date or room and play them with timeline,
  speed and pause controls
- Capture exceptions, group repeated errors into issues, and resolve or ignore
  issues, with alerts in the dashboard and to a Slack, Discord or other webhook
  when an issue appears or returns
- Ingest structured logs, search by message, severity, service, account,
  device or recording, and chart their volume by level over time
- Configure errors and logs independently, with their own retention and a
  shared daily storage limit

Recording, error tracking and logs are off by default. Dashboard access
requires a PocketBase superuser

## Get started

### 1. Install the client

In your frontend project:

```sh
npm install pocketbase-replay
```

Build a package from a checkout of this repository:

```sh
npm ci
npm pack
```

In your frontend project, install the generated tarball using the filename
printed by `npm pack`:

```sh
npm install /path/to/pocketbase-replay-VERSION.tgz
```

The client works with bundlers such as Vite, and TypeScript is optional

### 2. Set up PocketBase

Choose an [existing PocketBase](docs/installation.md#existing-pocketbase) or a
[dedicated replay server with Docker](docs/installation.md#dedicated-replay-database)

Open `/dash/replay` on that server and sign in with a PocketBase superuser

In Recording settings, configure your [privacy rules](docs/configuration.md#privacy-rules)
and enable percentage sampling

### 3. Connect your app

```js
import { startReplay } from 'pocketbase-replay';

const replay = startReplay({
  endpoint: 'https://replay.example.com',
  metadata: () => ({
    deviceId: yourApp.deviceId,
    platform: 'web',
    appVersion: '1.0.0',
  }),
});

// When the app is disposed
replay.stop();
```

Use your app's stable device ID and deployed server URL, then watch a new
recording in the dashboard to check playback and masking

See [client integration](docs/integration.md) for accounts, room metadata,
lifecycle handling and native asset setup

In a Capacitor app, the [Capacitor plugin](plugins/capacitor/README.md) wraps
this client and adds native pause and resume

### 4. Add errors and logs

In `/dash/replay`, open Errors and logs settings and enable the features you need

```js
import { startObservability } from 'pocketbase-replay';

const diagnostics = startObservability({
  endpoint: 'https://replay.example.com',
  metadata: () => ({
    deviceId: yourApp.deviceId,
    platform: 'web',
    appVersion: '1.0.0',
  }),
  errors: { captureUnhandled: true },
  logs: { captureConsole: ['warn', 'error'] },
  service: 'frontend',
  replay,
});

diagnostics.captureException(new Error('Checkout failed'));
diagnostics.captureLog('info', 'Checkout started', { cartItems: 3 });
```

Each feature needs to be enabled both in the client and on the server. Errors
and logs also work when replay recording is off or no recorder is supplied

See [errors and logs](docs/observability.md) for configuration, manual capture,
privacy, alert behavior and the ingestion API

## Privacy and compatibility

- Input values and editable text are masked by default
- Text outside inputs needs masking or blocking rules for your app
- Canvas, WebGL, iframes, video and audio are not captured
- DOM replay needs available images, fonts and other page assets
- The client requires Chromium 91 or newer

Use HTTPS for remote deployments and keep superuser tokens out of your frontend

## Documentation

| Guide | Covers |
| --- | --- |
| [Installation](docs/installation.md) | Existing and dedicated servers, upgrades, HTTPS and reverse proxies |
| [Client integration](docs/integration.md) | Metadata, Capacitor, Electron, custom transports and native assets |
| [Configuration](docs/configuration.md) | Sampling, retention, storage budgets, privacy rules and playback |
| [Errors and logs](docs/observability.md) | Capture options, issue resolution, alerts, searchable logs and ingestion |
| [Accounts](docs/authentication.md) | Token verification, separate databases and account deletion |
| [Privacy and limits](docs/privacy-and-limits.md) | Captured data, retries, recording limits and compatibility |
| [Development](docs/development.md) | Local checks, performance measurement and releases |
| [Platform plugins](plugins/README.md) | The Capacitor plugin, and how plugins for other platforms stay separate |

## License

[MIT](LICENSE)
