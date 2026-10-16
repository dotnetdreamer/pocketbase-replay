import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'errors.dart';
import 'options.dart';
import 'privacy.dart';
import 'runtime.dart';
import 'transport.dart';

abstract final class ObservabilityLimits {
  static const int eventBytes = 16 * 1024;
  static const int batchBytes = 60 * 1024;
  static const int queueBytes = 512 * 1024;
  static const int queueEvents = 200;
  static const int batchEvents = 20;
  static const int retries = 5;
  static const int retryMs = 1000;
  static const int maxRetryMs = 60000;
  static const int configIntervalMs = 45000;
  static const int linkWaitMs = 10000;
}

/// What diagnostics need from a recorder: the live recording to link entries to, and a trigger that uploads what
/// the device kept when the server records only when something breaks.
abstract class ReplayLink {
  ReplaySessionContext? sessionContext();

  Future<ReplaySessionContext?> trigger(String reason);
}

final RegExp _sessionPattern = RegExp(r'^[a-z0-9]{15}$');
final RegExp _tokenPattern = RegExp(r'^[A-Za-z0-9]{64}$');

class _Entry {
  _Entry(this.event, this.json, this.bytes, this.identity);

  ObservabilityEvent event;
  String json;
  int bytes;
  int attempts = 0;

  /// The account and device the entry was captured under; it is only ever sent with that identity's credential.
  final String identity;

  /// Held back while the replay it triggered starts a session it can link to.
  bool held = false;
}

class _Batch {
  _Batch(this.entries, this.body, this.url);

  final List<_Entry> entries;
  final String body;
  final Uri url;
}

// Oversized entries keep their grouping key while shedding attributes and shortening stack and message text.
String? _fit(ObservabilityEvent event) {
  var candidate = event;
  var json = jsonEncode(candidate.toJson());
  if (byteLength(json) <= ObservabilityLimits.eventBytes) return json;
  if (candidate.attributes != null) {
    final groupingKey = event.kind == ObservabilityEventKind.error ? (event.attributes?['groupingKey']) : null;
    candidate = candidate.copyWith(attributes: {
      'truncated': true,
      if (groupingKey is String && groupingKey.isNotEmpty) 'groupingKey': groupingKey,
    });
    json = jsonEncode(candidate.toJson());
  }
  while (byteLength(json) > ObservabilityLimits.eventBytes && (candidate.stack?.length ?? 0) > 1) {
    candidate = candidate.copyWith(stack: candidate.stack!.substring(0, (candidate.stack!.length * 0.75).floor()));
    json = jsonEncode(candidate.toJson());
  }
  while (byteLength(json) > ObservabilityLimits.eventBytes && candidate.message.length > 1) {
    candidate = candidate.copyWith(message: candidate.message.substring(0, (candidate.message.length * 0.75).floor()));
    json = jsonEncode(candidate.toJson());
  }
  return byteLength(json) <= ObservabilityLimits.eventBytes ? json : null;
}

/// Errors and logs for `/api/replay/errors` and `/api/replay/logs`, as the web client's `startObservability` sends them.
class ObservabilityController {
  ObservabilityController({
    required this.options,
    required ReplayTransport transport,
    ReplayRuntime? runtime,
    ReplayLink? replay,
    void Function() Function(void Function(bool active) listener)? subscribeActive,
  })  : _transport = transport,
        _runtime = runtime ?? ReplayRuntime.system,
        _replay = replay,
        _subscribeActive = subscribeActive,
        _endpoint = options.endpoint.trim().replaceAll(RegExp(r'/+$'), ''),
        _apiKey = (options.apiKey ?? '').trim(),
        _localErrors = options.errors != null,
        _localLogs = options.logs != null {
    _closed = _endpoint.isEmpty || !(_localErrors || _localLogs);
  }

  final ObservabilityOptions options;
  final ReplayTransport _transport;
  final ReplayRuntime _runtime;
  final ReplayLink? _replay;
  final void Function() Function(void Function(bool active) listener)? _subscribeActive;
  final String _endpoint;
  final String _apiKey;
  final bool _localErrors;
  final bool _localLogs;

  late bool _closed;
  String _identity = '';
  String _token = '';
  int _expiresAt = 0;
  int _epoch = 0;
  // Until the server first answers for an identity, entries wait in the queue instead of being refused, so an error
  // thrown while the app starts is kept. The answer drops them if the server is off.
  bool _answered = false;
  bool _errorsEnabled = false;
  bool _logsEnabled = false;
  List<_Entry> _queue = [];
  int _queuedBytes = 0;
  int _interval = 10000;
  int _maxBatchEvents = ObservabilityLimits.batchEvents;
  int _retryAt = 0;
  int _retryDelay = 0;
  Future<void>? _refreshing;
  bool _refreshAgain = false;
  Future<void>? _pumping;
  int? _lastRefreshAt;
  Object? _flushTimer;
  Object? _configTimer;
  Object? _retryTimer;
  final Set<Object> _linkTimers = {};
  void Function()? _removeLifecycle;
  bool _capturing = false;

  int _capturedErrors = 0;
  int _capturedLogs = 0;
  int _uploadedEvents = 0;
  int _droppedEvents = 0;
  int _networkErrors = 0;

  int _now() => _runtime.now();

  bool get closed => _closed;

  ReplayMetadata? _metadata() {
    try {
      final value = options.metadata();
      if (value.deviceId.isEmpty) return null;
      final accountId = clip(value.accountId, 128);
      return ReplayMetadata(
        deviceId: clip(value.deviceId, 128),
        accountId: accountId,
        authToken: accountId.isEmpty ? '' : value.authToken,
        platform: clip(value.platform.isEmpty ? defaultPlatformName() : value.platform, 32),
        appVersion: clip(value.appVersion, 64),
        room: clip(value.room, 64),
      );
    } catch (_) {
      return null;
    }
  }

  String _identityOf(ReplayMetadata value) => '${value.deviceId}\n${value.accountId}';

  bool _wanted(ObservabilityEventKind kind) => !_closed &&
      (kind == ObservabilityEventKind.error ? _localErrors && (!_answered || _errorsEnabled) : _localLogs && (!_answered || _logsEnabled));

  void _drop(Iterable<_Entry> entries) {
    final removed = entries.toSet();
    _queue = _queue.where((entry) => !removed.contains(entry)).toList();
    _queuedBytes = _queue.fold(0, (sum, entry) => sum + entry.bytes);
  }

  // Entries never move to another account or device: a new identity drops the old one's queue and asks again.
  void _switchIdentity(String next) {
    _epoch++;
    final other = _queue.where((entry) => entry.identity != next).toList();
    _drop(other);
    _droppedEvents += other.length;
    _identity = next;
    _token = '';
    _expiresAt = 0;
    _answered = false;
    _errorsEnabled = false;
    _logsEnabled = false;
    _retryAt = 0;
    _retryDelay = 0;
    _runtime.cancel(_retryTimer);
  }

  // Entries and uploads ask for a credential at most every 5 seconds, so an unreachable server is not asked once per entry.
  void _renew() {
    final last = _lastRefreshAt;
    if (last == null || _now() - last >= 5000) unawaited(refresh());
  }

  // The server turned both features off, refused this identity, or the controller stopped.
  void _disable() {
    _epoch++;
    _token = '';
    _expiresAt = 0;
    _answered = true;
    _errorsEnabled = false;
    _logsEnabled = false;
    _droppedEvents += _queue.length;
    _queue = [];
    _queuedBytes = 0;
    _retryAt = 0;
    _retryDelay = 0;
    _runtime.cancel(_retryTimer);
  }

  List<String> _privateText() {
    try {
      return options.sensitiveText?.call() ?? const [];
    } catch (_) {
      return const [];
    }
  }

  ReplaySessionContext? _session() {
    try {
      final context = _replay?.sessionContext();
      return context != null && _sessionPattern.hasMatch(context.sessionId) && _tokenPattern.hasMatch(context.token) ? context : null;
    } catch (_) {
      return null;
    }
  }

  ObservabilityEvent _sanitize(ObservabilityEvent event, List<String> text) {
    final attributes = safeAttributes(event.attributes, text);
    final groupingKey = attributes?['groupingKey'];
    if (event.kind == ObservabilityEventKind.error && groupingKey is String) {
      attributes!['groupingKey'] = redactLabel(groupingKey, text, 128).trim();
    }
    final sessionId = event.sessionId, sessionToken = event.sessionToken;
    final linked = sessionId != null && sessionToken != null && _sessionPattern.hasMatch(sessionId) && _tokenPattern.hasMatch(sessionToken);
    final service = event.service, room = event.room;
    final isError = event.kind == ObservabilityEventKind.error;
    final level = isError
        ? (event.level == 'fatal' ? 'fatal' : 'error')
        : (LogLevel.values.any((value) => value.name == event.level) ? event.level : 'info');
    return ObservabilityEvent(
      kind: event.kind,
      id: event.id,
      timestamp: event.timestamp,
      // The build an entry was captured in names its source maps, so it is kept as given rather than redacted.
      appVersion: clip(event.appVersion.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), ''), 64),
      service: service != null && service.isNotEmpty ? redactLabel(service, text, 128) : null,
      room: room != null && room.isNotEmpty ? redactLabel(room, text, 64) : null,
      sessionId: linked ? sessionId : null,
      sessionToken: linked ? sessionToken : null,
      message: redactText(event.message, text),
      attributes: attributes,
      level: level,
      name: isError ? redactLabel(event.name, text, 128) : 'Error',
      stack: isError && event.stack != null ? redactText(event.stack!, text, 8000) : null,
      handled: event.handled,
    );
  }

  // Queues without sending, so a caller can hold the entry for its replay link before a full batch goes.
  _Entry? _enqueue(ObservabilityEvent event, String entryIdentity) {
    try {
      final text = _privateText();
      var prepared = _sanitize(event, text);
      final beforeSend = options.beforeSend;
      if (beforeSend != null) {
        final changed = beforeSend(prepared);
        if (changed == null) {
          _droppedEvents++;
          return null;
        }
        // Facts of the capture stay as captured, including the build, which a callback could otherwise drop.
        prepared = _sanitize(
          ObservabilityEvent(
            kind: event.kind,
            id: event.id,
            timestamp: event.timestamp,
            appVersion: event.appVersion,
            service: changed.service,
            room: changed.room,
            sessionId: changed.sessionId,
            sessionToken: changed.sessionToken,
            message: changed.message,
            attributes: changed.attributes,
            level: changed.level,
            name: changed.name,
            stack: changed.stack,
            handled: changed.handled,
          ),
          text,
        );
      }
      if (prepared.message.isEmpty) {
        _droppedEvents++;
        return null;
      }
      final json = _fit(prepared);
      final bytes = json == null ? 0 : byteLength(json);
      if (json == null || _queue.length >= ObservabilityLimits.queueEvents || _queuedBytes + bytes > ObservabilityLimits.queueBytes) {
        _droppedEvents++;
        return null;
      }
      final entry = _Entry(prepared, json, bytes, entryIdentity);
      _queue.add(entry);
      _queuedBytes += bytes;
      if (event.kind == ObservabilityEventKind.error) {
        _capturedErrors++;
      } else {
        _capturedLogs++;
      }
      return entry;
    } catch (_) {
      _droppedEvents++;
      return null;
    }
  }

  void _sendIfFull() {
    if (_token.isNotEmpty && _queue.length >= _maxBatchEvents) unawaited(flush());
  }

  // A replay that keeps its recording on the device until something breaks uploads it now.
  Future<ReplaySessionContext?>? _requestTrigger() {
    final replay = _replay;
    if (replay == null || _session() != null) return null;
    try {
      return replay.trigger('error').catchError((Object _) => null);
    } catch (_) {
      return null;
    }
  }

  void _relink(_Entry entry, ReplaySessionContext context) {
    final event = entry.event.copyWith(sessionId: context.sessionId, sessionToken: context.token);
    final json = _fit(event);
    if (json == null) return;
    final bytes = byteLength(json);
    _queuedBytes += bytes - entry.bytes;
    entry
      ..event = event
      ..json = json
      ..bytes = bytes;
  }

  // The entry waits for the session its trigger starts, at most a few seconds, then goes with or without the link.
  void _holdForLink(_Entry entry, Future<ReplaySessionContext?> linking) {
    entry.held = true;
    Object? timer;
    void release() {
      if (!entry.held) return;
      entry.held = false;
      _runtime.cancel(timer);
      _linkTimers.remove(timer);
      final context = _session();
      if (context != null && entry.identity == _identity && _queue.contains(entry)) _relink(entry, context);
      // A pump that already passed over the held entry would end without it, so flush again after it.
      final running = _pumping;
      if (running != null) {
        unawaited(running.whenComplete(() => flush()));
      } else {
        unawaited(flush());
      }
    }

    timer = _runtime.schedule(const Duration(milliseconds: ObservabilityLimits.linkWaitMs), release);
    _linkTimers.add(timer);
    unawaited(linking.then((_) => release(), onError: (Object _) => release()));
  }

  ({String identity, ObservabilityEvent base})? _captureContext(ObservabilityEventKind kind) {
    if (_closed || !(kind == ObservabilityEventKind.error ? _localErrors : _localLogs)) return null;
    final value = _metadata();
    if (value == null) return null;
    final next = _identityOf(value);
    if (next != _identity) {
      _switchIdentity(next);
      unawaited(refresh());
    }
    if (!_wanted(kind)) return null;
    // A missing, expired or refused credential is renewed; the entry waits in the queue meanwhile.
    if (_token.isEmpty || _expiresAt <= _now()) _renew();
    final context = _session(), text = _privateText(), timestamp = _now();
    final service = options.service;
    return (
      identity: next,
      base: ObservabilityEvent(
        kind: kind,
        id: eventId(),
        timestamp: timestamp,
        // Sent even when empty, so the server never gives the entry the version of a credential another build renewed.
        appVersion: value.appVersion,
        service: service != null && service.isNotEmpty ? redactLabel(service, text, 128) : null,
        room: value.room.isNotEmpty ? redactLabel(value.room, text, 64) : null,
        sessionId: context?.sessionId,
        sessionToken: context?.token,
        message: '',
        level: kind == ObservabilityEventKind.error ? 'error' : 'info',
      ),
    );
  }

  /// Queues an exception and returns its id, or null when capture is off, the entry was dropped, or a limit was reached.
  String? captureException(
    Object error, {
    StackTrace? stackTrace,
    Map<String, Object?>? attributes,
    String? groupingKey,
    bool handled = true,
    ErrorLevel level = ErrorLevel.error,
  }) {
    if (_capturing) return null;
    _capturing = true;
    try {
      final common = _captureContext(ObservabilityEventKind.error);
      if (common == null) return null;
      final text = _privateText();
      final key = groupingKey == null ? '' : redactLabel(groupingKey, text, 128).trim();
      final described = describeError(error, stackTrace, text);
      final entry = _enqueue(
        common.base.copyWith(
          message: described.message,
          name: described.name,
          stack: described.stack,
          handled: handled,
          level: level.name,
          // The key goes first, so trimming attributes to their size limit never drops it.
          attributes: key.isEmpty
              ? attributes
              : (<String, Object?>{'groupingKey': key}
                ..addAll(safeAttributes(attributes, text) ?? const {})
                ..['groupingKey'] = key),
        ),
        common.identity,
      );
      if (entry == null) return null;
      // Only an error the app keeps is a reason to upload the replay; one that beforeSend or a limit dropped is not.
      // It is held before a full batch can go, so the error that fills one still waits for its link.
      final linking = common.base.sessionId != null ? null : _requestTrigger();
      if (linking != null) _holdForLink(entry, linking);
      _sendIfFull();
      return entry.event.id;
    } catch (_) {
      _droppedEvents++;
      return null;
    } finally {
      _capturing = false;
    }
  }

  /// Queues a structured log and returns its id, or null when capture is off, the entry was dropped, or a limit was reached.
  String? captureLog(LogLevel level, String message, {Map<String, Object?>? attributes}) {
    if (_capturing) return null;
    _capturing = true;
    try {
      final common = _captureContext(ObservabilityEventKind.log);
      if (common == null) return null;
      final entry = _enqueue(common.base.copyWith(level: level.name, message: message, attributes: attributes), common.identity);
      if (entry != null) _sendIfFull();
      return entry?.event.id;
    } catch (_) {
      _droppedEvents++;
      return null;
    } finally {
      _capturing = false;
    }
  }

  /// An error the app did not handle, from `FlutterError.onError` or `PlatformDispatcher.onError`.
  void captureUnhandled(Object error, StackTrace? stackTrace, {Map<String, Object?>? attributes}) {
    if (!_wanted(ObservabilityEventKind.error)) return;
    captureException(error, stackTrace: stackTrace, attributes: attributes, handled: false);
  }

  /// A printed line, stored as an `info` log.
  void capturePrinted(String line) {
    if (!_wanted(ObservabilityEventKind.log)) return;
    captureLog(LogLevel.info, redactText(line, _privateText()));
  }

  _Batch? _batch() {
    if (_queue.isEmpty || _token.isEmpty) return null;
    _Entry? first;
    for (final entry in _queue) {
      if (entry.identity == _identity && !entry.held) {
        first = entry;
        break;
      }
    }
    if (first == null) return null;
    final kind = first.event.kind;
    final entries = <_Entry>[];
    final head = '{"token":${jsonEncode(_token)},${_apiKey.isNotEmpty ? '"apiKey":${jsonEncode(_apiKey)},' : ''}"events":[';
    var bytes = byteLength(head) + 2;
    for (final entry in _queue) {
      if (entry.identity != _identity || entry.event.kind != kind || entry.held) continue;
      if (entries.length >= _maxBatchEvents || bytes + entry.bytes + 1 > ObservabilityLimits.batchBytes) break;
      entries.add(entry);
      bytes += entry.bytes + 1;
    }
    if (entries.isEmpty) return null;
    return _Batch(
      entries,
      '$head${entries.map((entry) => entry.json).join(',')}]}',
      Uri.parse('$_endpoint/api/replay/${kind == ObservabilityEventKind.error ? 'errors' : 'logs'}'),
    );
  }

  void _scheduleRetry() {
    _runtime.cancel(_retryTimer);
    _retryTimer = _runtime.schedule(Duration(milliseconds: max(0, _retryAt - _now())), () {
      _retryAt = 0;
      unawaited(flush());
    });
  }

  Future<void> _drain() async {
    while (!_closed && _queue.isNotEmpty && _now() >= _retryAt) {
      final value = _metadata();
      if (value == null) return;
      if (_identityOf(value) != _identity) {
        _switchIdentity(_identityOf(value));
        unawaited(refresh());
        return;
      }
      // No credential yet, or it ran out: a refresh gets one and flushes again.
      if (_token.isEmpty || _expiresAt <= _now()) {
        _renew();
        return;
      }
      final item = _batch();
      if (item == null) return;
      final expectedEpoch = _epoch, sentToken = _token;
      try {
        await _transport.post(item.url, item.body);
        if (_closed || expectedEpoch != _epoch) return;
        _drop(item.entries);
        _uploadedEvents += item.entries.length;
        _retryAt = 0;
        _retryDelay = 0;
      } catch (error) {
        if (_closed || expectedEpoch != _epoch) return;
        _networkErrors++;
        final status = statusOf(error);
        final credential = status == 401 || status == 403 || status == 410;
        if (!credential && !retryable(status)) {
          final rejected = item.entries.where(_queue.contains).toList();
          _drop(rejected);
          _droppedEvents += rejected.length;
          continue;
        }
        for (final entry in item.entries) {
          entry.attempts++;
        }
        final exhausted = item.entries.where((entry) => entry.attempts >= ObservabilityLimits.retries && _queue.contains(entry)).toList();
        _drop(exhausted);
        _droppedEvents += exhausted.length;
        if (credential) {
          // The credential ended, or the server turned a feature off. The next answer says which, and drops what it must.
          if (_token == sentToken) {
            _token = '';
            _expiresAt = 0;
          }
          _renew();
          return;
        }
        _retryDelay = min(ObservabilityLimits.maxRetryMs, _retryDelay == 0 ? ObservabilityLimits.retryMs : _retryDelay * 2);
        _retryAt = _now() + _retryDelay;
        if (_queue.isNotEmpty) _scheduleRetry();
        return;
      }
    }
  }

  /// Uploads queued errors and logs now.
  Future<void> flush() {
    if (_closed) return Future<void>.value();
    final running = _pumping;
    if (running != null) return running;
    final done = Completer<void>();
    _pumping = done.future;
    () async {
      try {
        await _drain();
      } catch (_) {
        _networkErrors++;
      } finally {
        _pumping = null;
        done.complete();
      }
    }();
    return done.future;
  }

  Future<void> _refreshOnce() async {
    if (_closed) return;
    final value = _metadata();
    if (value == null) return;
    final nextIdentity = _identityOf(value);
    if (_identity != nextIdentity) _switchIdentity(nextIdentity);
    _lastRefreshAt = _now();
    final expectedEpoch = _epoch;
    try {
      final body = jsonEncode({
        'deviceId': value.deviceId,
        'accountId': value.accountId,
        'authToken': value.authToken,
        'platform': value.platform,
        'appVersion': value.appVersion,
        'room': value.room,
        if (_token.isNotEmpty) 'token': _token,
        if (_apiKey.isNotEmpty) 'apiKey': _apiKey,
      });
      final answer = answerOf(await _transport.post(Uri.parse('$_endpoint/api/replay/observability/config'), body));
      if (_closed) return;
      final latest = _metadata();
      // The account or device changed while the answer was on its way; it belongs to the old one.
      if (expectedEpoch != _epoch || latest == null || _identityOf(latest) != nextIdentity) {
        _refreshAgain = true;
        return;
      }
      final allowErrors = _localErrors && answer['errorsEnabled'] == true;
      final allowLogs = _localLogs && answer['logsEnabled'] == true;
      final token = answer['token'];
      if (answer['enabled'] != true || !(allowErrors || allowLogs) || token is! String || !_tokenPattern.hasMatch(token)) {
        _disable();
        return;
      }
      final expiresIn = answer['expiresIn'], expiresAt = answer['expiresAt'];
      final expiration = expiresIn is num && expiresIn.isFinite && expiresIn > 0
          ? _now() + expiresIn.toInt()
          : expiresAt is num && expiresAt.isFinite
              ? expiresAt.toInt()
              : null;
      if (expiration == null || expiration <= _now()) {
        _disable();
        return;
      }
      // A renewed credential for the same identity keeps the queue: those entries are still this identity's.
      _token = token;
      _expiresAt = expiration;
      _answered = true;
      _errorsEnabled = allowErrors;
      _logsEnabled = allowLogs;
      final interval = answer['uploadIntervalMs'];
      _interval = interval is num && interval.isFinite && interval > 0 ? interval.toInt().clamp(1000, 60000) : 10000;
      final batchEvents = answer['maxBatchEvents'];
      _maxBatchEvents = batchEvents is num && batchEvents.isFinite && batchEvents >= 1
          ? batchEvents.floor().clamp(1, ObservabilityLimits.batchEvents)
          : ObservabilityLimits.batchEvents;
      final forbidden = _queue
          .where((entry) => entry.event.kind == ObservabilityEventKind.error ? !_errorsEnabled : !_logsEnabled)
          .toList();
      _drop(forbidden);
      _droppedEvents += forbidden.length;
      // A pump still finishing may have stopped for want of this credential, so the queue goes after it.
      if (_queue.isNotEmpty) {
        final running = _pumping;
        unawaited(running == null ? flush() : running.whenComplete(flush));
      }
    } catch (error) {
      if (_closed || expectedEpoch != _epoch) return;
      _networkErrors++;
      // An unreachable or busy server keeps the queue for the next attempt. A refusal ends it.
      if (!retryable(statusOf(error))) _disable();
    }
  }

  /// Reads `metadata()` and the server's diagnostic settings again.
  Future<void> refresh() {
    if (_closed) return Future<void>.value();
    final running = _refreshing;
    if (running != null) {
      _refreshAgain = true;
      return running;
    }
    final done = Completer<void>();
    _refreshing = done.future;
    () async {
      try {
        do {
          _refreshAgain = false;
          await _refreshOnce();
        } while (_refreshAgain && !_closed);
      } catch (_) {
        _networkErrors++;
      } finally {
        _refreshing = null;
        done.complete();
      }
    }();
    return done.future;
  }

  void _scheduleFlush() {
    _flushTimer = _runtime.schedule(Duration(milliseconds: _interval), () {
      if (_closed) return;
      unawaited(flush());
      _scheduleFlush();
    });
  }

  void _scheduleConfig() {
    _configTimer = _runtime.schedule(const Duration(milliseconds: ObservabilityLimits.configIntervalMs), () {
      if (_closed) return;
      unawaited(refresh());
      _scheduleConfig();
    });
  }

  /// Subscribes to pause and resume, starts the timers and asks the server for a credential.
  void start() {
    if (_closed) return;
    try {
      _removeLifecycle = _subscribeActive?.call((active) {
        if (active) {
          unawaited(refresh());
        } else {
          unawaited(flush());
        }
      });
    } catch (_) {
      _networkErrors++;
    }
    _scheduleFlush();
    _scheduleConfig();
    unawaited(refresh());
  }

  /// Stops capture and drops anything still queued; call [flush] first when delivery matters.
  void stop() {
    if (_closed) return;
    _closed = true;
    _epoch++;
    _token = '';
    _expiresAt = 0;
    _droppedEvents += _queue.length;
    _queue = [];
    _queuedBytes = 0;
    for (final timer in [_flushTimer, _configTimer, _retryTimer, ..._linkTimers]) {
      _runtime.cancel(timer);
    }
    _linkTimers.clear();
    try {
      _removeLifecycle?.call();
    } catch (_) {
      // Cleanup must not reach the app.
    }
  }

  ObservabilityMetrics getMetrics() => ObservabilityMetrics(
        errorsEnabled: !_closed && _answered && _errorsEnabled,
        logsEnabled: !_closed && _answered && _logsEnabled,
        capturedErrors: _capturedErrors,
        capturedLogs: _capturedLogs,
        uploadedEvents: _uploadedEvents,
        droppedEvents: _droppedEvents,
        queuedEvents: _queue.length,
        queuedBytes: _queuedBytes,
        networkErrors: _networkErrors,
      );
}
