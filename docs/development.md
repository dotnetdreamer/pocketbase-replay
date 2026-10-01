# Development and release

[Back to README](../README.md)

## Local checks

From this repository:

```sh
npm ci
npm test
npm run build
npm pack --dry-run
```

Tests cover queue bounds, retries, snapshot recovery, masking, settings, server
privacy rules, lifecycle, Capacitor detection, server validation, account
verification, erasure and migration isolation

Error and log checks also cover issue grouping, alerts, filtering, credential
scope, redaction, bounded queues and plugin capture methods

To verify the hooks and migration against real PocketBase 0.39.9:

```sh
REPLAY_PB_BIN=/path/to/pocketbase npm run test:integration
```

The runner installs into a temporary directory, starts an isolated server on
port 8099, checks ingestion and dashboard APIs, and removes its data on exit.
Set `REPLAY_TEST_PORT` to use another free port

For a browser check, leave the fixture running until Ctrl+C:

```sh
REPLAY_PB_BIN=/path/to/pocketbase npm run test:integration -- --serve
```

Open the printed dashboard URL and use the local credentials the runner prints

## Performance checks

Measure frame times, CPU and bytes per minute in the integrating app on its own
screens and devices

`getMetrics()` reports wire bytes and package processing time, but excludes
some of rrweb's mutation observer work and is not a total CPU measurement

## Release

Publish from this repository after setting the package name, repository URL
and release version

The checks above do not publish a package or deploy a server; publishing
requires a separate `npm publish` command

## Dependencies

The package pins `@rrweb/record` and `rrweb-player` to 2.1.6, and `fflate` to
0.8.3

The dashboard bundles the player, which is not loaded into the recorded app

## Upstream references

- [rrweb recorder and player APIs](https://github.com/rrweb-io/rrweb/blob/main/guide.md)
- [rrweb documentation in Context7](https://context7.com/rrweb-io/rrweb)
- [PocketBase JavaScript extensions](https://pocketbase.io/docs/js-overview/)
- [PocketBase migrations](https://pocketbase.io/docs/js-migrations/)
