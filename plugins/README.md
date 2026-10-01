# Platform plugins

[Back to README](../README.md)

Each folder here wraps PocketBase Replay for one app platform and ships as its
own package

| Folder | Package | Platforms |
| --- | --- | --- |
| [capacitor](capacitor/README.md) | `capacitor-pocketbase-replay` | Android, iOS and web through Capacitor |

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

Flutter and React Native draw native views rather than a DOM, so the client's
rrweb recorder cannot run there

A plugin for either has to turn the screen into rrweb events itself and send
them to the same endpoints: `/api/replay/config`, `/api/replay/start` and
`/api/replay/chunks`

[The client engine](../src/engine.ts) shows how those requests are made and
retried, and [the server hooks](../server/pb_hooks/lib/replay.js) show what the
server accepts
