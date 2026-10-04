# Platform plugins

[Back to README](../README.md)

Each folder here wraps PocketBase Replay for one app platform and ships as its
own package

## Available plugin

The [Capacitor plugin](capacitor/README.md), `capacitor-pocketbase-replay`, is
implemented for Android, iOS and web. It records the WebView's DOM, captures
JavaScript errors and structured application logs, and adds native pause and
resume handling on Android and iOS. Requests use `CapacitorHttp` on native
platforms

Recording runs in the WebView. Native views outside it and native process
crashes are not captured. See [privacy and limits](../docs/privacy-and-limits.md)
for the DOM recorder's coverage

## Future integrations

Capacitor is the only platform plugin currently implemented in this repository

| Platform | Status |
| --- | --- |
| React Native | Future integration, no plugin implemented yet |
| NativeScript | Future integration, no plugin implemented yet |
| Flutter | Future integration, no plugin implemented yet |

These are future integration targets, with no release dates set

## Keeping plugins apart

A plugin can change and ship without touching the core or another plugin:

- It has its own manifest, lockfile, build, tests and CI workflow
- It uses the core only through what the core publishes: the
  `pocketbase-replay` package or the replay server's HTTP API, never files
  under `src/`
- Its native identifiers include its platform, such as the Android namespace
  `io.github.dotnetdreamer.pocketbasereplay.capacitor`, so native code from two
  plugins never collides
- The core never builds, tests or packs anything in this folder, and its Docker
  image leaves it out

## Adding a platform

Put a new plugin in its own folder, such as `plugins/flutter` or
`plugins/react-native`, and name its package the way that ecosystem does

React Native, NativeScript and Flutter interfaces do not expose the browser
DOM that the client's rrweb recorder requires. Replaying those interfaces
needs a platform-specific recorder that produces events the replay viewer
can render

A plugin for these platforms has to turn the screen into rrweb events and send
them to the same endpoints: `/api/replay/config`, `/api/replay/start` and
`/api/replay/chunks`

An embedded WebView can use the existing DOM client inside its page, but
native UI outside that WebView is not recorded

[The client engine](../src/engine.ts) shows how those requests are made and
retried, and [the server hooks](../server/pb_hooks/lib/replay.js) show what the
server accepts
