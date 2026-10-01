# PocketBase Replay

Self-hosted DOM session replay for PocketBase, with an rrweb recorder and a
private dashboard for watching clicks, taps, menus and dialogs

## Features

- Add replay to an existing PocketBase or run a dedicated replay server
- Use a framework-independent client in web, Capacitor and Electron apps
- Select sessions with percentage sampling or verified account allowlists
- Control masking, retention and storage limits from the dashboard
- Find recordings by account, device, date or room and play them with timeline,
  speed and pause controls

Recording is off by default, and replay access requires a PocketBase superuser

## Get started

### 1. Install the client

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

## Privacy and compatibility

- Input values and editable text are masked by default
- Text outside inputs needs masking or blocking rules for your app
- Canvas, WebGL, iframes, video and audio are not captured
- DOM replay needs available images, fonts and other page assets
- Chromium 91 is the client floor

Use HTTPS for remote deployments and keep superuser tokens out of your frontend

## Documentation

| Guide | Covers |
| --- | --- |
| [Installation](docs/installation.md) | Existing and dedicated servers, upgrades, HTTPS and reverse proxies |
| [Client integration](docs/integration.md) | Metadata, Capacitor, Electron, custom transports and native assets |
| [Configuration](docs/configuration.md) | Sampling, retention, storage budgets, privacy rules and playback |
| [Accounts](docs/authentication.md) | Token verification, separate databases and account deletion |
| [Privacy and limits](docs/privacy-and-limits.md) | Captured data, retries, recording limits and compatibility |
| [Development](docs/development.md) | Local checks, performance measurement and releases |
| [Platform plugins](plugins/README.md) | The Capacitor plugin, and how plugins for other platforms stay separate |

## License

[MIT](LICENSE)
