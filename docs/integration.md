# Client integration

[Back to README](../README.md)

For exception and log capture, use [`startObservability`](observability.md)
alongside `startReplay`, or on its own. The Capacitor plugin supports the same
capture options

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
| `maskTextSelector` | Add CSS selectors for text masking alongside the server's rules |
| `blockSelector` | Add CSS selectors for blocked elements alongside the server's rules |
| `transport` | Override automatic request transport detection |
| `subscribeActive(listener)` | Override automatic pause and resume detection |
| `initialActive` | Override the initial recording activity state |
| `assetBaseUrl` | Override automatic asset URL rewriting |
| `preserveDataAttributes` | Keep explicitly listed, finite `data-*` UI state values in DOM replay |

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
