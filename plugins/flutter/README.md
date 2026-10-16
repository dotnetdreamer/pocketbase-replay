# Flutter plugin

[Back to platform plugins](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/plugins/README.md)

`pocketbase_replay_flutter` records Flutter apps for [PocketBase Replay](https://github.com/dotnetdreamer/pocketbase-replay#readme).
It sends the screen, touches, screen changes, PocketBase calls, network
requests and console output to the replay viewer, and Dart errors and
structured logs to **Issues** and **Logs**

It is a Dart package without native code, so the same code runs on Android,
iOS, web, macOS, Windows and Linux. It needs Flutter 3.24 or newer

## Install

Add the package from this repository to your app's `pubspec.yaml`:

```yaml
dependencies:
  pocketbase_replay_flutter:
    git:
      url: https://github.com/dotnetdreamer/pocketbase-replay.git
      path: plugins/flutter
```

From a checkout of this repository, use a path instead:

```yaml
dependencies:
  pocketbase_replay_flutter:
    path: /path/to/pocketbase-replay/plugins/flutter
```

Then run `flutter pub get`, and set up the replay server as described in
[installation](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/installation.md)

## Usage

Initialize Flutter, start recording and call `runApp` inside the same
`PocketBaseReplay.runZoned` callback. This keeps Flutter input and frame
callbacks in the zone that captures `print` output:

```dart
import 'package:flutter/material.dart';
import 'package:pocketbase/pocketbase.dart';
import 'package:pocketbase_replay_flutter/pocketbase_replay_flutter.dart';

final pb = PocketBase('https://api.example.com', httpClientFactory: ReplayPocketBaseClient.new);

Future<void> main() => PocketBaseReplay.runZoned(() async {
  await PocketBaseReplay.start(PocketBaseReplayOptions(
    endpoint: 'https://replay.example.com',
    metadata: () => ReplayMetadata(
      deviceId: yourApp.deviceId,
      appVersion: '1.0.0',
      accountId: pb.authStore.record?.id ?? '',
      authToken: pb.authStore.token,
    ),
    errors: const ErrorTrackingOptions(captureUnhandled: true),
    logs: const LogCaptureOptions(capturePrint: true),
    service: 'mobile',
  ));
  runApp(const PocketBaseReplayWidget(child: MyApp()));
});

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        // Notes named routes as page changes in the recording.
        navigatorObservers: [PocketBaseReplay.navigatorObserver],
        home: const HomePage(),
      );
}
```

Then, anywhere in the app:

```dart
try {
  await checkout();
} catch (error, stack) {
  PocketBaseReplay.captureException(error, stackTrace: stack, groupingKey: 'checkout-payment');
}
PocketBaseReplay.captureLog(LogLevel.info, 'Checkout started', attributes: {'items': 3});

// From a Report a problem button:
await PocketBaseReplay.trigger('report');

// After sign-in, sign-out or a room change:
await PocketBaseReplay.refresh();

// When recording should end, send what is queued first:
await PocketBaseReplay.flush();
await PocketBaseReplay.stop();
```

Recording follows the dashboard's **Recording settings**, and errors and
logs its **Diagnostics** settings; all of them start off. `metadata()` is read
again for every request, so return the current account and room each time.
Use a device ID your app stores, such as a UUID saved on first launch;
`platform` defaults to `android`, `ios`, `web`, `macos`, `windows` or
`linux`

`accountId` with `authToken`, such as `pb.authStore.token`, lets the server
verify the account for [account allowlists and **Require a signed-in
account**](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/authentication.md).
Set `apiKey` when **Require API key** is on

See the [example app](example/lib/main.dart)

## What is recorded

The replay viewer plays a Flutter recording like a web one, with the same
timeline, activity panel, triggers and linked errors

| Recording | How |
| --- | --- |
| Screen | An image of the screen whenever it changed, at most once per `frameInterval` (1 second by default): the whole screen, or only the area that changed |
| Touches | Touch start, moves and end, and a click on each tap named after the tapped control, such as `button "Pay now"`. Mouse moves and clicks on desktop and web |
| Pages | Named routes through `PocketBaseReplay.navigatorObserver`, without their query. Dialogs, sheets and routes without a name are not listed |
| PocketBase calls | Calls through `ReplayPocketBaseClient`, while the server records PocketBase calls |
| Network requests | Requests through `ReplayNetworkClient`, with **Record network requests** on |
| Console | `debugPrint` output, and `print` inside `PocketBaseReplay.runZoned`, with **Record console messages** on. Uncaught errors are listed too |

Images are PNG, at most 1280 pixels on the longer side and at `pixelRatio`
image pixels per logical pixel (1 by default). A frame over 240 KiB is taken
again at a lower ratio. Frames are larger than a web page's DOM events, so a
busy Flutter recording uses more of the storage budget than a web one. On a
server that [records only when something
breaks](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/configuration.md#record-only-when-something-breaks),
only the minute or two around a trigger is stored

Recording pauses when the app leaves the screen and resumes with a whole new
frame: on Android once the app is hidden, but not for a dialog over it; on iOS
also when the app resigns active, as for Control Center or a call; on the web
when its page is hidden

## Privacy

Masked areas are painted over before a frame leaves the device:

- Text fields, always, and the magnifier that shows an enlarged copy of one
  while text is selected
- Anything inside `ReplayMask(child: ...)`
- Text containing a word from `sensitiveText`, which is also redacted from
  errors, logs and activity
- All text with `maskAllText: true`, and all images with `maskAllImages: true`:
  `Image` widgets and images in box and shape decorations. An `Ink` image is
  painted by the surrounding `Material`, so wrap it in `ReplayMask`

Platform views and textures, such as maps, web views and video, cannot be
captured as an image and are shown as plain grey boxes

The dashboard's mask and block rules are CSS selectors for web pages. A
Flutter app reads two of them, so a rule change can still tighten an app that
is already installed:

| Dashboard rule | Effect in Flutter |
| --- | --- |
| `*` among the mask rules | Masks all text |
| `img` among the block rules | Masks all images |
| `*` among the block rules | Masks all text and images |

Other selectors apply only to web pages. A tap inside a masked area is listed
as `*` and recorded at the centre of that area, so the keys of a masked PIN pad
cannot be read back from where they were pressed. A tap on a text field never
shows its text. Text drawn by a `CustomPainter` is not text to the recorder, so
wrap private drawings in `ReplayMask`

A network request is recorded by method, address without query, status and
time; its headers and bodies are never read. A PocketBase call adds its
collection, action, record ID, item counts, a fixed standard PocketBase error
message when available, and the names and codes of refused fields. Custom
server messages and field error messages are omitted because they can echo
rejected values. Request field values are never read. See
[privacy and limits](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/privacy-and-limits.md)

## PocketBase calls

Pass `ReplayPocketBaseClient.new` as the PocketBase Dart SDK's
`httpClientFactory`. To keep a client of your own, wrap it:
`httpClientFactory: () => ReplayPocketBaseClient(MyClient())`

When the SDK talks to the same server as `endpoint`, each call also carries an
`X-Replay-Request` header. API-rule explanations work without request tracing.
Enable `REPLAY_TRACE_REQUESTS=on` on the server to link its request log and
issues, including errors thrown before replay hooks run. With tracing enabled,
the client also adds the reserved `__replayRequest` query parameter; leave that
parameter to the recorder. On the web, an
app on another origin than the server first checks once that the header passes
CORS and any proxy, as the web client does. The realtime connection itself is
not recorded; its subscription changes are

`ReplayNetworkClient` wraps any other `http.Client` the same way, for the
network rows

## Errors and logs

With `errors: ErrorTrackingOptions(captureUnhandled: true)`, errors that reach
`FlutterError.onError` or `PlatformDispatcher.onError` are captured as
unhandled. Handlers your app set before `start` keep running after the
capture. Set your own handlers before calling `start`, or have a handler set
later call the one it replaces, as crash reporters do. Errors the framework
reports silently, such as an image that failed to load, are passed on but not
captured. With
`logs: LogCaptureOptions(capturePrint: true)`, `debugPrint` output, and `print`
inside `PocketBaseReplay.runZoned`, is stored as `info` logs

```dart
Future<void> main() => PocketBaseReplay.runZoned(() async {
  // Initialize dependencies here too if they initialize Flutter bindings.
  await PocketBaseReplay.start(options);
  runApp(const PocketBaseReplayWidget(child: MyApp()));
});
```

Dart stack frames are sent in the form the server groups by, so repeated errors
join one issue across devices. A framework error such as a layout overflow is
named `FlutterError`, with its summary line as the message and its library as
an attribute. A captured error triggers the recorder when the server records
only when something breaks, and links to the recording. Set
`triggerOnError: false` to disable this automatic upload; explicit
`PocketBaseReplay.trigger()` calls still work

Release builds made with `--obfuscate` report frames as addresses. These issues
group by message, and `flutter symbolize` with the build's
`--split-debug-info` files reads their stacks. For a web release build, run
`flutter build web --source-maps`, then upload the map with
`npx pb-replay-sourcemaps --endpoint https://replay.example.com --version 1.0.0 --from build/web --delete-after`
so stacks show Dart files and lines. See
[source maps](https://github.com/dotnetdreamer/pocketbase-replay/blob/main/docs/observability.md#source-maps)

To capture errors and logs without recording, call
`PocketBaseReplay.startObservability(ObservabilityOptions(endpoint: ..., metadata: ..., errors: const ErrorTrackingOptions(), logs: const LogCaptureOptions()))`.
A recorder started later links its recording to new entries

The upload credential is kept in memory, so each app launch asks the server for
a new one. Native crashes and system logs, such as Android logcat, are not
collected

## API

| Member | Use |
| --- | --- |
| `PocketBaseReplay.start(options)` | Starts recording, and errors and logs when `errors` or `logs` is set. A second call replaces the recorder; capture is replaced only by a call that sets `errors` or `logs` |
| `PocketBaseReplay.stop()` | Stops recording, errors and logs. What was not uploaded is dropped, so call `flush()` first |
| `PocketBaseReplay.flush()` | Uploads queued recording, errors and logs now |
| `PocketBaseReplay.refresh()` | Reads `metadata()` and the server's settings again |
| `PocketBaseReplay.trigger([reason])` | Marks the moment; in trigger mode also uploads what the device kept. Resolves with the session ID, or `null` |
| `PocketBaseReplay.getMetrics()` | Recorder counters, including `frames`, or `null` |
| `PocketBaseReplay.startObservability(options)` | Errors and logs without a recorder |
| `PocketBaseReplay.stopObservability()` | Stops only errors and logs |
| `PocketBaseReplay.captureException(error, ...)` | Queues an error with optional `stackTrace`, `attributes`, `groupingKey`, `handled` and `level`, and returns its ID, or `null` |
| `PocketBaseReplay.captureLog(level, message, ...)` | Queues a log with optional `attributes`, and returns its ID, or `null` |
| `PocketBaseReplay.getObservabilityMetrics()` | Error and log counters, or `null` |
| `PocketBaseReplay.navigatorObserver` | Notes named routes as page changes |
| `PocketBaseReplay.runZoned(body)` | Runs `body` with its `print` output captured |
| `PocketBaseReplayWidget` | Marks the recorded screen; without it no recording session starts |
| `ReplayMask` | Masks its child; `enabled: false` shows it again |
| `ReplayPocketBaseClient` / `ReplayNetworkClient` | `http.Client` wrappers for PocketBase calls and network rows |

A returned ID means queued, not delivered

`PocketBaseReplayOptions`:

| Option | Default | Use |
| --- | --- | --- |
| `endpoint` | Required | The replay server; empty disables recording |
| `metadata` | Required | Returns `ReplayMetadata` with `deviceId`, `platform`, `appVersion`, `accountId`, `authToken` and `room` |
| `apiKey` | None | Ingestion key, when **Require API key** is on |
| `sensitiveText` | None | Words to mask on screen and redact from errors, logs and activity |
| `maskAllText` | `false` | Masks all text |
| `maskAllImages` | `false` | Masks all images |
| `frameInterval` | 1 second | Shortest time between two frames |
| `pixelRatio` | `1.0` | Image pixels per logical pixel, 0.25 to 2 |
| `triggerOnError` | `true` | Set `false` so captured errors do not automatically upload the recording in trigger mode; explicit triggers still work |
| `errors` | None | `ErrorTrackingOptions(captureUnhandled: ...)` enables error capture |
| `logs` | None | `LogCaptureOptions(capturePrint: ...)` enables log capture |
| `service` | None | Labels errors and logs, such as `mobile` |
| `beforeSend` | None | Edits an `ObservabilityEvent` before it is queued, or returns `null` to drop it; its ID, time, kind and app version stay as captured |
| `transport` | `package:http` | A custom `ReplayTransport`, which throws `ReplayHttpException(status)` for a non-2xx answer |

## Development

```sh
cd plugins/flutter
flutter pub get
flutter analyze
flutter test
```

The tests cover the upload protocol, trigger mode, retries, errors and logs,
redaction, PocketBase calls through the real Dart SDK, and screen capture,
masking and taps with real frames

`test/server_test.dart` runs the plugin against a replay server and reads back
what it stored. It changes that server's settings, so use a throwaway one, such
as one installed with `npx pb-replay-install --target <dir>`:

```sh
REPLAY_TEST_ENDPOINT=http://127.0.0.1:8090 REPLAY_TEST_EMAIL=you@example.com REPLAY_TEST_PASSWORD=... \
  flutter test test/server_test.dart
```
