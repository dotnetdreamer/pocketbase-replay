import 'dart:async';

import 'package:flutter/widgets.dart';

import 'activity/navigation.dart';
import 'engine.dart';
import 'hooks.dart';
import 'observability.dart';
import 'options.dart';
import 'screen/recorder.dart';
import 'transport.dart';

class _EngineLink implements ReplayLink {
  @override
  ReplaySessionContext? sessionContext() => PocketBaseReplay._engine?.getSessionContext();

  @override
  Future<ReplaySessionContext?> trigger(String reason) {
    final engine = PocketBaseReplay._engine;
    if (engine == null || !engine.options.triggerOnError) return Future.value(null);
    return engine.trigger(reason);
  }
}

/// Session replay, errors and logs for a Flutter app, sent to a PocketBase Replay server.
///
/// ```dart
/// Future<void> main() => PocketBaseReplay.runZoned(() async {
///   await PocketBaseReplay.start(PocketBaseReplayOptions(
///     endpoint: 'https://replay.example.com',
///     metadata: () => ReplayMetadata(deviceId: deviceId, appVersion: '1.0.0'),
///     errors: const ErrorTrackingOptions(captureUnhandled: true),
///   ));
///   runApp(const PocketBaseReplayWidget(child: MyApp()));
/// });
/// ```
abstract final class PocketBaseReplay {
  static ReplayEngine? _engine;
  static ObservabilityController? _observability;
  static void Function()? _removeErrorCapture;
  static void Function()? _removePrintCapture;
  static final ReplayNavigatorObserver _navigatorObserver = ReplayNavigatorObserver();

  /// Add to your app's `navigatorObservers` so screen changes are noted in the recording.
  static NavigatorObserver get navigatorObserver => _navigatorObserver;

  /// Starts recording, and errors and logs when [PocketBaseReplayOptions.errors] or [PocketBaseReplayOptions.logs]
  /// is set.
  ///
  /// Calling it again stops the running recorder first, so there is never more than one. Capture is replaced only by
  /// a call that sets `errors` or `logs`; a replay-only call leaves capture started earlier running.
  static Future<void> start(PocketBaseReplayOptions options) async {
    WidgetsFlutterBinding.ensureInitialized();
    _engine?.stop();
    _engine = null;
    // Started before runApp, the recorder has no screen yet; it asks the server again once the widget is in place.
    ScreenRecorder.instance.onAttach = () => unawaited(_engine?.refresh());
    if (options.errors != null || options.logs != null) {
      _startObservability(ObservabilityOptions(
        endpoint: options.endpoint,
        metadata: options.metadata,
        apiKey: options.apiKey,
        errors: options.errors,
        logs: options.logs,
        service: options.service,
        sensitiveText: options.sensitiveText,
        beforeSend: options.beforeSend,
        transport: options.transport,
      ));
    }
    final engine = ReplayEngine(
      options: options,
      transport: options.transport ?? HttpReplayTransport(),
      recorder: ScreenRecorder.instance,
      subscribeActive: AppLifecycle.subscribe,
      subscribeErrors: (listener) => ErrorHooks.subscribe((error, stack, attributes) => listener()),
      initialActive: AppLifecycle.isActive,
    );
    _engine = engine;
    engine.start();
  }

  /// Stops recording and diagnostics and releases their listeners. What was not uploaded yet is dropped; call
  /// [flush] first to send it.
  static Future<void> stop() async {
    _engine?.stop();
    _engine = null;
    _stopObservability();
  }

  /// Uploads queued recording events, errors and logs now.
  static Future<void> flush() async {
    await Future.wait([
      _engine?.flush() ?? Future<void>.value(),
      _observability?.flush() ?? Future<void>.value(),
    ]);
  }

  /// Reads `metadata()` and the server's settings again, after sign-in, sign-out or a room change.
  static Future<void> refresh() async {
    await Future.wait([
      _engine?.refresh() ?? Future<void>.value(),
      _observability?.refresh() ?? Future<void>.value(),
    ]);
  }

  /// Counters for the running recorder, or null before [start] and after [stop].
  static ReplayMetrics? getMetrics() => _engine?.getMetrics();

  /// Marks this moment on the recording, for example from a **Report a problem** button. When the server records only
  /// when something breaks, it also uploads what the device kept and records live for one more minute.
  ///
  /// Resolves with the recording's session ID, or null when nothing is recorded or its session cannot start yet.
  static Future<String?> trigger([String? reason]) async {
    final context = await (_engine?.trigger(reason) ?? Future<ReplaySessionContext?>.value(null));
    return context?.sessionId;
  }

  /// Starts errors and logs without a recorder. A recorder started later links its recording to new entries.
  static Future<void> startObservability(ObservabilityOptions options) async {
    WidgetsFlutterBinding.ensureInitialized();
    _startObservability(options);
  }

  /// Stops only errors and logs; recording keeps running.
  static Future<void> stopObservability() async => _stopObservability();

  static void _startObservability(ObservabilityOptions options) {
    _stopObservability();
    final controller = ObservabilityController(
      options: options,
      transport: options.transport ?? HttpReplayTransport(),
      replay: _EngineLink(),
      subscribeActive: AppLifecycle.subscribe,
    );
    _observability = controller;
    if (options.errors?.captureUnhandled == true) {
      _removeErrorCapture = ErrorHooks.subscribe((error, stack, attributes) {
        controller.captureUnhandled(error, stack, attributes: attributes);
      });
    }
    if (options.logs?.capturePrint == true) _removePrintCapture = PrintHooks.subscribe(controller.capturePrinted);
    controller.start();
  }

  static void _stopObservability() {
    _removeErrorCapture?.call();
    _removeErrorCapture = null;
    _removePrintCapture?.call();
    _removePrintCapture = null;
    _observability?.stop();
    _observability = null;
  }

  /// Queues an exception and returns its event ID, or null when error capture is off, the entry was filtered out or
  /// a limit was reached. The ID means queued, not delivered.
  ///
  /// A stable [groupingKey], such as `checkout-payment`, joins known failures into one issue across builds.
  static String? captureException(
    Object error, {
    StackTrace? stackTrace,
    Map<String, Object?>? attributes,
    String? groupingKey,
    bool handled = true,
    ErrorLevel level = ErrorLevel.error,
  }) =>
      _observability?.captureException(
        error,
        stackTrace: stackTrace ?? (error is Error ? error.stackTrace : null) ?? StackTrace.current,
        attributes: attributes,
        groupingKey: groupingKey,
        handled: handled,
        level: level,
      );

  /// Queues a structured log and returns its event ID, or null when log capture is off, the entry was filtered out
  /// or a limit was reached.
  static String? captureLog(LogLevel level, String message, {Map<String, Object?>? attributes}) =>
      _observability?.captureLog(level, message, attributes: attributes);

  /// Counters for errors and logs, or null when they are not started.
  static ObservabilityMetrics? getObservabilityMetrics() => _observability?.getMetrics();

  /// Runs [body] in a zone whose `print` output reaches log capture and the recording's console activity, as
  /// `debugPrint` output always does. Initialize Flutter and start recording inside this same zone, so Flutter's
  /// input and frame callbacks retain the capture zone:
  ///
  /// ```dart
  /// Future<void> main() => PocketBaseReplay.runZoned(() async {
  ///   await PocketBaseReplay.start(options);
  ///   runApp(const PocketBaseReplayWidget(child: MyApp()));
  /// });
  /// ```
  static R runZoned<R>(R Function() body) => runZonedWithPrints(body);
}
