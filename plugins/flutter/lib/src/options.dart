import 'package:flutter/foundation.dart';

import 'transport.dart';

/// Who a recording or diagnostics entry belongs to. It is read again for every request and event, so return the
/// current account and room each time.
@immutable
class ReplayMetadata {
  const ReplayMetadata({
    required this.deviceId,
    this.platform = '',
    this.appVersion = '',
    this.accountId = '',
    this.authToken = '',
    this.room = '',
  });

  /// Your app's stable device ID. Without one nothing is recorded or sent.
  final String deviceId;

  /// Empty uses the running platform: `android`, `ios`, `web`, `macos`, `windows`, `linux` or `fuchsia`.
  final String platform;
  final String appVersion;

  /// The signed-in account, verified on the server with [authToken].
  final String accountId;

  /// The account's PocketBase auth token, such as `pb.authStore.token`. Sent only with an [accountId].
  final String authToken;
  final String room;
}

/// The running platform's name, as [ReplayMetadata.platform] defaults to it.
String defaultPlatformName() {
  if (kIsWeb) return 'web';
  return switch (defaultTargetPlatform) {
    TargetPlatform.android => 'android',
    TargetPlatform.iOS => 'ios',
    TargetPlatform.macOS => 'macos',
    TargetPlatform.windows => 'windows',
    TargetPlatform.linux => 'linux',
    TargetPlatform.fuchsia => 'fuchsia',
  };
}

enum LogLevel { trace, debug, info, warn, error, fatal }

enum ErrorLevel { error, fatal }

enum ObservabilityEventKind { error, log }

/// Error capture. A const instance enables manual [PocketBaseReplay.captureException]; [captureUnhandled] also
/// collects errors that reach `FlutterError.onError` and `PlatformDispatcher.onError`.
@immutable
class ErrorTrackingOptions {
  const ErrorTrackingOptions({this.captureUnhandled = false});

  final bool captureUnhandled;
}

/// Log capture. A const instance enables manual [PocketBaseReplay.captureLog]; [capturePrint] also stores
/// `debugPrint` output, and `print` inside [PocketBaseReplay.runZoned], as `info` logs.
@immutable
class LogCaptureOptions {
  const LogCaptureOptions({this.capturePrint = false});

  final bool capturePrint;
}

/// A captured error or log as it will be sent, after redaction. Returned from [BeforeSend] to change or drop it.
@immutable
class ObservabilityEvent {
  const ObservabilityEvent({
    required this.kind,
    required this.id,
    required this.timestamp,
    required this.message,
    required this.level,
    this.appVersion = '',
    this.service,
    this.room,
    this.sessionId,
    this.sessionToken,
    this.attributes,
    this.name = 'Error',
    this.stack,
    this.handled = true,
  });

  final ObservabilityEventKind kind;

  /// Like [timestamp], [kind] and [appVersion], fixed at capture: changes made by [BeforeSend] are ignored.
  final String id;
  final int timestamp;
  final String appVersion;
  final String? service;
  final String? room;
  final String? sessionId;
  final String? sessionToken;
  final String message;
  final Map<String, Object?>? attributes;

  /// `error` or `fatal` for errors; a [LogLevel] name for logs.
  final String level;

  /// The error's type name, for errors only.
  final String name;
  final String? stack;
  final bool handled;

  ObservabilityEvent copyWith({
    String? service,
    String? room,
    String? message,
    Map<String, Object?>? attributes,
    String? level,
    String? name,
    String? stack,
    bool? handled,
    String? sessionId,
    String? sessionToken,
  }) =>
      ObservabilityEvent(
        kind: kind,
        id: id,
        timestamp: timestamp,
        appVersion: appVersion,
        service: service ?? this.service,
        room: room ?? this.room,
        sessionId: sessionId ?? this.sessionId,
        sessionToken: sessionToken ?? this.sessionToken,
        message: message ?? this.message,
        attributes: attributes ?? this.attributes,
        level: level ?? this.level,
        name: name ?? this.name,
        stack: stack ?? this.stack,
        handled: handled ?? this.handled,
      );

  /// The entry as the ingestion API takes it.
  Map<String, Object?> toJson() => {
        'id': id,
        'timestamp': timestamp,
        'appVersion': appVersion,
        if (service != null && service!.isNotEmpty) 'service': service,
        if (room != null && room!.isNotEmpty) 'room': room,
        if (sessionId != null && sessionToken != null) 'sessionId': sessionId,
        if (sessionId != null && sessionToken != null) 'sessionToken': sessionToken,
        'message': message,
        if (attributes != null) 'attributes': attributes,
        if (kind == ObservabilityEventKind.error) 'name': name,
        if (kind == ObservabilityEventKind.error && stack != null) 'stack': stack,
        if (kind == ObservabilityEventKind.error) 'handled': handled,
        'level': level,
      };
}

typedef BeforeSend = ObservabilityEvent? Function(ObservabilityEvent event);

/// Options for [PocketBaseReplay.start]: replay, plus errors and logs when [errors] or [logs] is set.
@immutable
class PocketBaseReplayOptions {
  const PocketBaseReplayOptions({
    required this.endpoint,
    required this.metadata,
    this.apiKey,
    this.transport,
    this.sensitiveText,
    this.maskAllText = false,
    this.maskAllImages = false,
    this.frameInterval = const Duration(seconds: 1),
    this.pixelRatio = 1.0,
    this.triggerOnError = true,
    this.errors,
    this.logs,
    this.service,
    this.beforeSend,
  });

  /// The replay server, such as `https://replay.example.com`. Empty disables recording.
  final String endpoint;
  final ReplayMetadata Function() metadata;

  /// An ingestion key, needed when the dashboard's Security settings require one.
  final String? apiKey;
  final ReplayTransport? transport;

  /// Words such as names and email addresses. Text containing one is masked on screen, and redacted from
  /// diagnostics and activity.
  final List<String> Function()? sensitiveText;

  /// Masks every text, not only text fields and [ReplayMask] areas.
  final bool maskAllText;

  /// Masks every image.
  final bool maskAllImages;

  /// The shortest time between two screen frames. Frames are taken only when the screen changed.
  final Duration frameInterval;

  /// Image pixels per logical pixel, from 0.25 to 2. Frames are made smaller when one would be too large to upload.
  final double pixelRatio;

  /// Set false so captured errors do not automatically upload the recording in trigger mode. Explicit calls to
  /// [PocketBaseReplay.trigger] still upload it.
  final bool triggerOnError;

  final ErrorTrackingOptions? errors;
  final LogCaptureOptions? logs;

  /// Labels errors and logs for filtering, such as `mobile`.
  final String? service;
  final BeforeSend? beforeSend;
}

/// Options for [PocketBaseReplay.startObservability], errors and logs without a recorder.
@immutable
class ObservabilityOptions {
  const ObservabilityOptions({
    required this.endpoint,
    required this.metadata,
    this.apiKey,
    this.errors,
    this.logs,
    this.service,
    this.sensitiveText,
    this.beforeSend,
    this.transport,
  });

  final String endpoint;
  final ReplayMetadata Function() metadata;
  final String? apiKey;
  final ErrorTrackingOptions? errors;
  final LogCaptureOptions? logs;
  final String? service;
  final List<String> Function()? sensitiveText;
  final BeforeSend? beforeSend;
  final ReplayTransport? transport;
}

/// The recording an entry or call belongs to.
@immutable
class ReplaySessionContext {
  const ReplaySessionContext(this.sessionId, this.token);

  final String sessionId;
  final String token;
}

/// Counters for the running recorder.
@immutable
class ReplayMetrics {
  const ReplayMetrics({
    required this.startedAt,
    required this.recording,
    required this.sessionId,
    required this.events,
    required this.frames,
    required this.rawBytes,
    required this.compressedBytes,
    required this.networkBytes,
    required this.uploadedChunks,
    required this.droppedChunks,
    required this.droppedEvents,
    required this.errors,
    required this.bufferedBytes,
    required this.queuedBytes,
  });

  final int startedAt;
  final bool recording;
  final String? sessionId;
  final int events;

  /// Screen images taken, full frames and changed areas.
  final int frames;
  final int rawBytes;
  final int compressedBytes;
  final int networkBytes;
  final int uploadedChunks;
  final int droppedChunks;
  final int droppedEvents;
  final int errors;
  final int bufferedBytes;
  final int queuedBytes;
}

/// Counters for errors and logs.
@immutable
class ObservabilityMetrics {
  const ObservabilityMetrics({
    required this.errorsEnabled,
    required this.logsEnabled,
    required this.capturedErrors,
    required this.capturedLogs,
    required this.uploadedEvents,
    required this.droppedEvents,
    required this.queuedEvents,
    required this.queuedBytes,
    required this.networkErrors,
  });

  final bool errorsEnabled;
  final bool logsEnabled;
  final int capturedErrors;
  final int capturedLogs;
  final int uploadedEvents;
  final int droppedEvents;
  final int queuedEvents;
  final int queuedBytes;
  final int networkErrors;
}
