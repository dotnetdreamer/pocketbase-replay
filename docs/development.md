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

Upload security checks cover the default-off switches, named key creation
and revocation, optional key and verified-account requirements across replay,
errors and logs, existing anonymous credentials, and superuser-only management.
Client checks preserve legacy envelopes without a key, carry keys through
native requests and exit beacons, and isolate saved diagnostic credentials
by endpoint and key. Capacitor tests cover combined and independent starts

Rate-limit checks cover unchanged defaults, positive bounded values, partial
updates, shared error/log settings and preserved usage counters. Saving limits
must leave security switches and unrelated settings unchanged. In the browser,
verify the separate **Save limits** action and **Use default limits**, which
fills the draft until saved

Error and log checks also cover explicit grouping keys, complete Discord
messages and partial retries, concurrent storage admission, transaction
rollback, configured rate limits, stale chart requests and plugin capture

To verify the hooks and migration against real PocketBase 0.39.9:

```sh
REPLAY_PB_BIN=/path/to/pocketbase npm run test:integration
```

The runner installs into a temporary directory, starts an isolated server on
port 8099, checks ingestion and dashboard APIs, and removes its data on exit.
It checks actual cron webhook delivery to a local receiver and concurrent
uploads near the storage limit. It can wait up to 70 seconds for the minute
job. Set `REPLAY_TEST_PORT` to use another free port

For a browser check, leave the fixture running until Ctrl+C:

```sh
REPLAY_PB_BIN=/path/to/pocketbase npm run test:integration -- --serve
```

Open the printed dashboard URL and use the local credentials the runner prints

## Android WebView checks

Install the Android SDK, Java 21 and Maestro. Run one visible emulator, or
select a connected device with `REPLAY_ANDROID_DEVICE`. The runner reuses
that device and builds a separate Capacitor test app

```sh
REPLAY_PB_BIN=/path/to/pocketbase npm run test:android
```

A freshly booted emulator can be slow: the flow allows the app up to two and a
half minutes to show its first result, and gives Maestro's driver three
minutes to start. Set `MAESTRO_DRIVER_STARTUP_TIMEOUT` in milliseconds to
change the driver's limit

The Maestro flow checks real JavaScript stacks, DOMException fields, startup
buffering, explicit grouping, replay-only starts and native background and
resume. The runner then verifies the stored errors and logs in PocketBase.
It removes its app, temporary build, server and any reverse port it created

To use the already-running local fixture from the browser check:

```sh
npm run test:android -- --endpoint http://localhost:8099
```

Use `--keep-open` to inspect the test app before Ctrl+C cleans it up. The
runner accepts only loopback HTTP fixtures. Native process crashes and
system logs remain outside these APIs

## Performance checks

Measure frame times, CPU and bytes per minute in the integrating app on its own
screens and devices

`getMetrics()` reports wire bytes and package processing time, but excludes
some of rrweb's mutation observer work and is not a total CPU measurement

## Release

The root package is published as `pocketbase-replay` on the public npm registry.
The Capacitor plugin has its own package in `plugins/capacitor`

For a release, update the root version and lockfile together, then run the
local checks and PocketBase integration check above. The first npm release
uses the existing version, `0.3.0`

Create and inspect the release tarball:

```sh
npm pack
```

`prepack` builds the client, TypeScript declarations and dashboard before
packing. The package includes the server hooks, migrations and installer,
so consumers do not need build tools

Install that tarball in a temporary frontend project with
`npm install --omit=dev /path/to/pocketbase-replay-VERSION.tgz`. Check the
client import and run `npx pb-replay-install --target ./backend` to verify
the packaged server files

Sign in to npm and publish the verified tarball, replacing the filename with
the one printed by `npm pack`:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish ./pocketbase-replay-VERSION.tgz --access public --registry=https://registry.npmjs.org/
```

Complete npm's authentication prompts, then verify the registry version:

```sh
npm view pocketbase-replay version --registry=https://registry.npmjs.org/
```

When publishing directly from the repository, `prepublishOnly` also runs the
test suite. Publishing a tarball uses its existing files, so run the checks
before creating it. A published name and version cannot be reused

## Dependencies

The package pins `@rrweb/record` and `rrweb-player` to 2.1.6, and `fflate` to
0.8.3

The dashboard bundles the player, which is not loaded into the recorded app

## Upstream references

- [rrweb recorder and player APIs](https://github.com/rrweb-io/rrweb/blob/main/guide.md)
- [rrweb documentation in Context7](https://context7.com/rrweb-io/rrweb)
- [PocketBase JavaScript extensions](https://pocketbase.io/docs/js-overview/)
- [PocketBase migrations](https://pocketbase.io/docs/js-migrations/)
