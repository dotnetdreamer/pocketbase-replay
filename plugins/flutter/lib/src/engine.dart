import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'events.dart';
import 'gzip/gzip.dart';
import 'options.dart';
import 'privacy.dart';
import 'runtime.dart';
import 'transport.dart';

/// Bounds for the replay upload engine. They follow the web client's, sized for screen frames, which are larger
/// than DOM events: a frame can take a few hundred KiB where a DOM snapshot of a page takes tens.
abstract final class ReplayLimits {
  static const int bufferBytes = 256 * 1024;
  static const int rawQueueBytes = 8 * 1024 * 1024;
  static const int eventBytes = 1024 * 1024;
  static const int queueBytes = 4 * 1024 * 1024;
  static const int queueChunks = 40;
  // The server takes at most 384 KiB of gzip data in a 512 KiB body.
  static const int targetBodyBytes = 400 * 1024;
  static const int maxBodyBytes = 500 * 1024;
  static const int sessionChunks = 2048;
  static const int rejectedChunks = 3;
  static const int retryMs = 5000;
  static const int maxRetryMs = 5 * 60 * 1000;
  static const int configIntervalMs = 45000;
  // Trigger mode keeps one to two minutes on the device, each part opening with a full snapshot, and uploads for a
  // minute after the last trigger.
  static const int checkoutMs = 60000;
  static const int keptBytes = 6 * 1024 * 1024;
  static const int keptChunks = 40;
  static const int liveMs = 60000;
  static const int markMs = 5000;
}

/// What the recorder records under: the app's options combined with the server's answer.
class RecorderSettings {
  const RecorderSettings({
    required this.endpoint,
    required this.maskAllText,
    required this.maskAllImages,
    required this.recordNetwork,
    required this.recordConsole,
    required this.recordPocketbase,
    this.tracePocketbaseRequests = false,
    required this.sensitiveText,
    required this.replaySession,
    this.frameInterval = const Duration(seconds: 1),
    this.pixelRatio = 1.0,
  });

  /// The replay endpoint without a trailing slash.
  final String endpoint;
  final bool maskAllText;
  final bool maskAllImages;
  final bool recordNetwork;
  final bool recordConsole;
  final bool recordPocketbase;
  /// Adds an opt-in request-log marker only when the server enables request tracing.
  final bool tracePocketbaseRequests;
  final List<String> Function() sensitiveText;

  /// The live recording's session ID, which a PocketBase call carries to the server, or null between triggers.
  final String? Function() replaySession;
  final Duration frameInterval;
  final double pixelRatio;
}

/// Turns the app into events. The engine starts it once the server selects this device.
abstract class ReplayRecorder {
  /// Starts recording into [emit] and returns what stops it, or null when recording cannot start.
  void Function()? start(void Function(ReplayEvent event) emit, RecorderSettings settings);

  /// Asks for a meta event and a full snapshot as soon as possible.
  void snapshot();

  /// Screen images taken so far.
  int get frames;

  /// Whether there is anything to record, such as a screen in place. A session starts only then.
  bool get available;
}

/// Cleaned exactly as the server cleans it, so no label can make it refuse the session: no control characters,
/// at most 64 characters, and never half of an emoji.
String triggerLabel(String? value) {
  var label = (value ?? '').replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '').trim();
  if (label.length > 64) label = label.substring(0, 64);
  if (label.isNotEmpty) {
    final last = label.codeUnitAt(label.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) label = label.substring(0, label.length - 1);
  }
  label = label.trim();
  return label.isEmpty ? 'manual' : label;
}

class _Entry {
  _Entry(this.json, this.bytes, this.timestamp, this.type);

  final String json;
  final int bytes;
  final int timestamp;
  final int type;

  bool get snapshot => type == EventType.fullSnapshot;
}

class _Batch {
  _Batch(this.entries, this.room, this.epoch, this.bytes);

  final List<_Entry> entries;
  final String room;
  int epoch;
  final int bytes;
}

class _Prepared {
  _Prepared(this.body, this.bytes, this.epoch);

  final String body;
  final int bytes;
  final int epoch;
}

class _Session {
  _Session(this.sessionId, this.token, this.expiresAt);

  final String sessionId;
  final String token;
  final int expiresAt;
}

// A trigger opens a part only with its full snapshot, which follows its meta event.
bool _opensSnapshot(_Batch batch) => batch.entries.take(2).any((entry) => entry.snapshot);

String? _serverSelector(Object? value) => value == null ? '' : value is String ? value : null;

Set<String> _rules(String value) => value.split(',').map((rule) => rule.trim()).where((rule) => rule.isNotEmpty).toSet();

/// Uploads a recording to `/api/replay/config`, `/start` and `/chunks`, as the web client's engine does.
class ReplayEngine {
  ReplayEngine({
    required this.options,
    required ReplayTransport transport,
    required ReplayRecorder recorder,
    ReplayRuntime? runtime,
    void Function() Function(void Function(bool active) listener)? subscribeActive,
    void Function() Function(void Function() listener)? subscribeErrors,
    bool initialActive = true,
  })  : _transport = transport,
        _recorder = recorder,
        _runtime = runtime ?? ReplayRuntime.system,
        _subscribeActive = subscribeActive,
        _subscribeErrors = subscribeErrors,
        _endpoint = options.endpoint.trim().replaceAll(RegExp(r'/+$'), ''),
        _apiKey = (options.apiKey ?? '').trim(),
        _active = initialActive {
    _closed = _endpoint.isEmpty;
    _startedAt = _runtime.now();
  }

  final PocketBaseReplayOptions options;
  final ReplayTransport _transport;
  final ReplayRecorder _recorder;
  final ReplayRuntime _runtime;
  final void Function() Function(void Function(bool active) listener)? _subscribeActive;
  final void Function() Function(void Function() listener)? _subscribeErrors;
  final String _endpoint;
  final String _apiKey;

  late bool _closed;
  bool _active;
  _Session? _session;
  String _identity = '';
  int _epoch = 0;
  int _seq = 0;
  int _interval = 25000;
  void Function()? _captureStop;
  bool _awaitingSnapshot = true;
  bool _localBlocked = false;
  List<_Entry> _buffer = [];
  int _bufferBytes = 0;
  String _room = '';
  List<_Batch> _pending = [];
  int _pendingBytes = 0;
  List<_Prepared> _queue = [];
  int _queueBytes = 0;
  Future<void>? _pumping;
  bool _retryUnreachable = false;
  int _retryAt = 0;
  int _retryDelay = 0;
  int _rejected = 0;
  Future<void>? _refreshing;
  bool _refreshAgain = false;
  Object? _recoveryTimer;
  int _lastRecoveryAt = 0;
  Object? _configTimer;
  Object? _flushTimer;
  Object? _checkoutTimer;
  Object? _snapshotTimer;
  void Function()? _removeLifecycle;
  void Function()? _removeErrors;
  String? _serverMask = '';
  String? _serverBlock = '';
  bool _serverNetwork = false;
  bool _serverConsole = false;
  bool _serverPocketbase = false;
  bool _serverPocketbaseTrace = false;
  String _captureRules = '';
  // Trigger mode records on the device and uploads only after a trigger, for a while.
  String _mode = 'session';
  bool _live = false;
  int _liveUntil = 0;
  List<_Batch> _kept = [];
  int _keptBytes = 0;
  // A promoted backlog may briefly exceed the usual queue bounds while it uploads.
  int _burstBytes = 0;
  int _burstChunks = 0;
  String _triggered = '';
  List<Completer<ReplaySessionContext?>> _waiting = [];
  final Map<String, int> _marks = {};
  // Trigger marks made while the next part still waits for its full snapshot; they follow that snapshot.
  List<ReplayEvent> _heldMarks = [];

  late final int _startedAt;
  bool _recording = false;
  String? _sessionId;
  int _events = 0;
  int _rawBytes = 0;
  int _compressedBytes = 0;
  int _networkBytes = 0;
  int _uploadedChunks = 0;
  int _droppedChunks = 0;
  int _droppedEvents = 0;
  int _errors = 0;

  int _now() => _runtime.now();

  Uri _url(String path) => Uri.parse('$_endpoint$path');

  List<String> _sensitiveText() {
    try {
      return options.sensitiveText?.call() ?? const [];
    } catch (_) {
      return const [];
    }
  }

  ReplayMetadata? _metadata() {
    try {
      final value = options.metadata();
      if (value.deviceId.isEmpty) return null;
      final accountId = clip(value.accountId, 128);
      return ReplayMetadata(
        deviceId: clip(value.deviceId, 128),
        accountId: accountId,
        platform: clip(value.platform.isEmpty ? defaultPlatformName() : value.platform, 32),
        appVersion: clip(value.appVersion, 64),
        room: clip(value.room, 64),
        authToken: accountId.isEmpty ? '' : value.authToken,
      );
    } catch (_) {
      return null;
    }
  }

  String _identityOf(ReplayMetadata value) => '${value.deviceId}\n${value.accountId}';

  // Between triggers nothing uploads; what is recorded stays on the device.
  bool _keeping() => _mode == 'trigger' && !_live;

  void _rememberRules(Map<String, Object?> answer) {
    _serverMask = _serverSelector(answer['maskTextSelector']);
    _serverBlock = _serverSelector(answer['blockSelector']);
    _serverNetwork = answer['recordNetwork'] == true;
    _serverConsole = answer['recordConsole'] == true;
    _serverPocketbase = answer['recordPocketbase'] == true;
    _serverPocketbaseTrace = answer['tracePocketbaseRequests'] == true;
  }

  String _rulesKey() => jsonEncode([_serverMask, _serverBlock, _serverNetwork, _serverConsole, _serverPocketbase, _serverPocketbaseTrace]);

  // Dashboard rules are CSS selectors for web pages. A screen recorder understands two of them: `*` among the mask
  // rules masks all text, and `img` among the block rules masks all images; `*` among the block rules does both.
  // A rule list the app cannot read stops recording rather than go unmasked.
  RecorderSettings? _captureOptions() {
    final mask = _serverMask, block = _serverBlock;
    if (mask == null || block == null) return null;
    final maskRules = _rules(mask), blockRules = _rules(block);
    return RecorderSettings(
      endpoint: _endpoint,
      maskAllText: options.maskAllText || maskRules.contains('*') || blockRules.contains('*'),
      maskAllImages: options.maskAllImages || blockRules.contains('img') || blockRules.contains('*'),
      recordNetwork: _serverNetwork,
      recordConsole: _serverConsole,
      recordPocketbase: _serverPocketbase,
      tracePocketbaseRequests: _serverPocketbaseTrace,
      sensitiveText: _sensitiveText,
      replaySession: () => _context()?.sessionId,
      frameInterval: options.frameInterval,
      pixelRatio: options.pixelRatio,
    );
  }

  void _stopCapture() {
    _recording = false;
    _runtime.cancel(_checkoutTimer);
    _checkoutTimer = null;
    final stop = _captureStop;
    _captureStop = null;
    try {
      stop?.call();
    } catch (_) {
      _errors++;
    }
  }

  void _clearData() {
    _droppedChunks += _pending.length + _queue.length + _kept.length;
    _droppedEvents += _buffer.length;
    _buffer = [];
    _bufferBytes = 0;
    _pending = [];
    _pendingBytes = 0;
    _queue = [];
    _queueBytes = 0;
    _kept = [];
    _keptBytes = 0;
    _burstBytes = 0;
    _burstChunks = 0;
    _awaitingSnapshot = true;
    _epoch++;
  }

  void _settle(ReplaySessionContext? context) {
    final callers = _waiting;
    _waiting = [];
    for (final caller in callers) {
      if (!caller.isCompleted) caller.complete(context);
    }
  }

  void _disable() {
    _stopCapture();
    _session = null;
    _sessionId = null;
    _live = false;
    _liveUntil = 0;
    _triggered = '';
    _heldMarks = [];
    _clearData();
    _settle(null);
  }

  // Another account or device: what was recorded and kept for the last one is dropped, and recording starts over.
  void _adopt(String next) {
    _disable();
    _identity = next;
    _seq = 0;
    _localBlocked = false;
    _marks.clear();
  }

  // The session's credential ends between triggers; what the device keeps waits for the next one.
  void _endSession() {
    _droppedChunks += _pending.length + _queue.length;
    _pending = [];
    _pendingBytes = 0;
    _queue = [];
    _queueBytes = 0;
    _burstBytes = 0;
    _burstChunks = 0;
    _session = null;
    _sessionId = null;
    _seq = 0;
    _epoch++;
    for (final batch in _kept) {
      batch.epoch = _epoch;
    }
  }

  void _snapshotNow() {
    if (_captureStop == null) return;
    try {
      _recorder.snapshot();
    } catch (_) {
      _errors++;
      _disable();
    }
  }

  void _recover() {
    _clearData();
    if (_recoveryTimer != null || (_session == null && !_keeping()) || !_active || _closed) return;
    final delay = min(5000, max(0, 5000 - (_now() - _lastRecoveryAt)));
    _recoveryTimer = _runtime.schedule(Duration(milliseconds: delay), () {
      _recoveryTimer = null;
      if (!_closed && _active && (_session != null || _keeping()) && !_localBlocked) {
        _lastRecoveryAt = _now();
        _snapshotNow();
      }
    });
  }

  void _blockOversize() {
    _localBlocked = true;
    _heldMarks = [];
    _stopCapture();
    _clearData();
  }

  // Keeps from the newest part at least a checkout old, so a trigger at any moment has a minute or more of history.
  // Each part opens with a full snapshot, so an upload can always be played from its start.
  void _keep(_Batch batch) {
    _kept.add(batch);
    _keptBytes += batch.bytes;
    final cutoff = _now() - ReplayLimits.checkoutMs;
    var from = -1;
    for (var index = _kept.length - 1; index >= 0; index--) {
      if (!_opensSnapshot(_kept[index])) continue;
      from = index;
      if (_kept[index].entries.first.timestamp <= cutoff) break;
    }
    _dropKept(from < 0 ? _kept.length : from);
    while (_keptBytes > ReplayLimits.keptBytes || _kept.length > ReplayLimits.keptChunks) {
      var next = -1;
      for (var index = 1; index < _kept.length; index++) {
        if (_opensSnapshot(_kept[index])) {
          next = index;
          break;
        }
      }
      // The newest part alone is too large to keep: start again from a fresh snapshot.
      if (next < 0) {
        _recover();
        return;
      }
      _dropKept(next);
    }
  }

  void _dropKept(int count) {
    for (final batch in _kept.take(count)) {
      _keptBytes -= batch.bytes;
    }
    _kept = _kept.sublist(count);
  }

  void _seal() {
    if (_buffer.isEmpty) return;
    final batch = _Batch(_buffer, _room, _epoch, _bufferBytes);
    _buffer = [];
    _bufferBytes = 0;
    if (_keeping()) {
      _keep(batch);
      return;
    }
    _pending.add(batch);
    _pendingBytes += batch.bytes;
    if (_pendingBytes > ReplayLimits.rawQueueBytes + _burstBytes || _pending.length > ReplayLimits.queueChunks + _burstChunks) _recover();
  }

  void _scheduleCheckout() {
    _runtime.cancel(_checkoutTimer);
    _checkoutTimer = _runtime.schedule(const Duration(milliseconds: ReplayLimits.checkoutMs), () {
      _checkoutTimer = null;
      if (_closed || !_active || _captureStop == null || _localBlocked || !_keeping()) return;
      _snapshotNow();
      _scheduleCheckout();
    });
  }

  // Whatever comes next, kept or live, must open with a full snapshot; it is taken whenever one is still missing.
  void _snapshotSoon() {
    if (_snapshotTimer != null) return;
    _snapshotTimer = _runtime.schedule(Duration.zero, () {
      _snapshotTimer = null;
      if (!_closed && _active && _captureStop != null && !_localBlocked && _awaitingSnapshot) _snapshotNow();
    });
  }

  // The minute after the last trigger has passed: upload what is buffered, then keep on the device again.
  void _endLive() {
    _seal();
    unawaited(_pump());
    _live = false;
    _awaitingSnapshot = true;
    _snapshotSoon();
    _scheduleCheckout();
  }

  bool _liveEnded() => _mode == 'trigger' && _live && _now() >= _liveUntil;

  // A trigger with a session: what the device kept uploads first, then recording stays live for a minute.
  void _promote() {
    if (_keeping()) _seal();
    _live = true;
    _liveUntil = max(_liveUntil, _now() + ReplayLimits.liveMs);
    _triggered = '';
    if (_kept.isNotEmpty && _opensSnapshot(_kept.first)) {
      _burstBytes += (_keptBytes * 1.4).ceil();
      _burstChunks += _kept.length * 2;
      for (final batch in _kept) {
        batch.epoch = _epoch;
        _pending.add(batch);
        _pendingBytes += batch.bytes;
      }
    }
    _kept = [];
    _keptBytes = 0;
    if (_awaitingSnapshot) _snapshotSoon();
    unawaited(_pump());
  }

  void _take(ReplayEvent event) {
    if (_closed || !_active || _localBlocked) return;
    if (_liveEnded()) _endLive();
    if (_session == null && !_keeping()) return;
    final value = _metadata();
    if (value == null || _identityOf(value) != _identity) {
      _disable();
      unawaited(refresh());
      return;
    }
    final opening = event.type == EventType.fullSnapshot || event.type == EventType.meta;
    if (_awaitingSnapshot && !opening) return;
    // A meta event opens the next part, and its full snapshot stays in the same one.
    if (event.type == EventType.meta) _seal();
    if (value.room != _room) {
      _seal();
      _room = value.room;
      if (!_keeping()) unawaited(_pump());
    }
    final json = jsonEncode(event.toJson());
    final bytes = byteLength(json) + 1;
    if (bytes > ReplayLimits.eventBytes) {
      _droppedEvents++;
      _blockOversize();
      return;
    }
    final followsMeta = event.type == EventType.fullSnapshot && _buffer.length == 1 && _buffer.first.type == EventType.meta;
    if (_bufferBytes > 0 && _bufferBytes + bytes > ReplayLimits.bufferBytes && !followsMeta) _seal();
    _buffer.add(_Entry(json, bytes, event.timestamp, event.type));
    _bufferBytes += bytes;
    _events++;
    _rawBytes += bytes;
    if (event.type == EventType.fullSnapshot) _awaitingSnapshot = false;
    if (_bufferBytes >= ReplayLimits.bufferBytes) {
      _seal();
      if (!_keeping()) unawaited(_pump());
    }
  }

  void _receive(ReplayEvent event) {
    try {
      _take(event);
      // Marks held for this snapshot follow it, placed no earlier than the part they now open.
      if (event.type == EventType.fullSnapshot && !_awaitingSnapshot && _heldMarks.isNotEmpty) {
        final held = _heldMarks;
        _heldMarks = [];
        for (final mark in held) {
          _take(ReplayEvent(mark.type, max(mark.timestamp, event.timestamp), mark.data));
        }
      }
    } catch (_) {
      _errors++;
      _recover();
    }
  }

  void _startCapture() {
    if (_closed || !_active || (_session == null && !_keeping()) || _captureStop != null || _localBlocked) return;
    final settings = _captureOptions();
    if (settings == null) {
      _errors++;
      return;
    }
    _captureRules = _rulesKey();
    _awaitingSnapshot = true;
    void Function()? stop;
    try {
      stop = _recorder.start(_receive, settings);
    } catch (_) {
      _errors++;
      _disable();
      return;
    }
    if (_closed || !_active || _localBlocked) {
      stop?.call();
      return;
    }
    _captureStop = stop;
    _recording = stop != null;
    if (stop != null && _keeping()) _scheduleCheckout();
  }

  Map<String, Object?> _makeChunk(_Batch batch, List<int> compressed, int rawBytes, int number) {
    final startedAt = batch.entries.first.timestamp;
    return {
      'sessionId': _session!.sessionId,
      'token': _session!.token,
      'seq': number,
      'startedAt': startedAt,
      'endedAt': max(startedAt, batch.entries.last.timestamp),
      'room': batch.room,
      'encoding': 'gzip-base64',
      'data': base64Encode(compressed),
      'rawBytes': rawBytes,
      'eventCount': batch.entries.length,
      'hasSnapshot': batch.entries.any((entry) => entry.snapshot),
      if (_apiKey.isNotEmpty) 'apiKey': _apiKey,
    };
  }

  String _rawBatch(_Batch batch) => '[${batch.entries.map((entry) => entry.json).join(',')}]';

  void _prepare(_Batch batch) {
    if (batch.epoch != _epoch || _session == null) return;
    if (_seq >= ReplayLimits.sessionChunks) {
      _disable();
      unawaited(refresh());
      return;
    }
    final raw = utf8.encode(_rawBatch(batch));
    List<int> compressed;
    try {
      compressed = gzipBytes(raw);
    } catch (_) {
      _errors++;
      if (batch.epoch == _epoch) _recover();
      return;
    }
    final body = jsonEncode(_makeChunk(batch, compressed, raw.length, _seq));
    final bytes = byteLength(body);
    if (bytes > ReplayLimits.targetBodyBytes && batch.entries.length > 1 && !batch.entries.any((entry) => entry.snapshot)) {
      final middle = batch.entries.length ~/ 2;
      final halves = [batch.entries.sublist(0, middle), batch.entries.sublist(middle)];
      _pending.insertAll(
        0,
        halves.map((entries) => _Batch(entries, batch.room, batch.epoch, entries.fold(0, (sum, entry) => sum + entry.bytes))),
      );
      _pendingBytes += batch.bytes;
      return;
    }
    if (bytes > ReplayLimits.maxBodyBytes) {
      _blockOversize();
      return;
    }
    _seq++;
    _queue.add(_Prepared(body, bytes, _epoch));
    _queueBytes += bytes;
    _compressedBytes += compressed.length;
    if (_queueBytes > ReplayLimits.queueBytes + _burstBytes || _queue.length > ReplayLimits.queueChunks + _burstChunks) _recover();
  }

  Future<void> _drain() async {
    while (_pending.isNotEmpty && !_closed && _session != null) {
      final batch = _pending.removeAt(0);
      _pendingBytes -= batch.bytes;
      _prepare(batch);
    }
    // A retryAt further out than the delay means the clock stepped back.
    while (_queue.isNotEmpty && !_closed && _session != null && (_now() >= _retryAt || _retryAt - _now() > _retryDelay)) {
      final item = _queue.first;
      try {
        _networkBytes += item.bytes;
        await _transport.post(_url('/api/replay/chunks'), item.body);
      } catch (error) {
        _errors++;
        if (item.epoch != _epoch) break;
        final status = statusOf(error);
        if (status == 401 || status == 403 || status == 404) {
          _disable();
        } else if (status == 410) {
          _disable();
          unawaited(refresh());
        } else if (status == 413) {
          _recover();
        } else if (retryable(status)) {
          _retryUnreachable = status == 0;
          _retryDelay = min(_retryDelay == 0 ? ReplayLimits.retryMs : _retryDelay * 2, ReplayLimits.maxRetryMs);
          _retryAt = _now() + _retryDelay;
        } else if (++_rejected >= ReplayLimits.rejectedChunks) {
          _localBlocked = true;
          _disable();
        } else {
          _recover();
        }
        break;
      }
      _retryAt = 0;
      _retryDelay = 0;
      _rejected = 0;
      if (item.epoch != _epoch) break;
      if (_queue.isNotEmpty && identical(_queue.first, item)) {
        _queue.removeAt(0);
        _queueBytes -= item.bytes;
      }
      _uploadedChunks++;
    }
    if (_pending.isEmpty && _queue.isEmpty) {
      _burstBytes = 0;
      _burstChunks = 0;
    }
  }

  Future<void> _pump() {
    final running = _pumping;
    if (running != null) return running;
    if (_closed || _session == null) return Future<void>.value();
    final done = Completer<void>();
    _pumping = done.future;
    () async {
      try {
        await _drain();
      } catch (_) {
        _errors++;
      } finally {
        _pumping = null;
        done.complete();
      }
    }();
    return done.future;
  }

  /// Uploads what is buffered and queued now, instead of at the next interval.
  Future<void> flush() async {
    try {
      if (_closed) return;
      if (_liveEnded()) _endLive();
      if (_session == null) return;
      final value = _metadata();
      if (value == null || _identityOf(value) != _identity) {
        _disable();
        await refresh();
        return;
      }
      if (!_keeping()) _seal();
      await _pump();
      if (_pending.isNotEmpty) await _pump();
    } catch (_) {
      _errors++;
    }
  }

  /// Pauses recording while the app is in the background; each resume starts with a full snapshot.
  void setActive(bool value) {
    if (_closed) return;
    if (!value) {
      _active = false;
      _stopCapture();
      unawaited(flush());
    } else if (!_active) {
      _active = true;
      _awaitingSnapshot = true;
      unawaited(refresh());
    }
  }

  // Between triggers the session holds nothing current, so an entry captured now asks for a trigger instead.
  // That includes a live minute that has passed on an idle screen before anything ended it.
  ReplaySessionContext? _context() {
    final session = _session;
    if (_closed || session == null || _keeping() || _liveEnded() || session.expiresAt <= _now()) return null;
    final value = _metadata();
    return value != null && _identityOf(value) == _identity ? ReplaySessionContext(session.sessionId, session.token) : null;
  }

  /// The live recording's credentials, which link a captured error or log to it.
  ReplaySessionContext? getSessionContext() => _context();

  // Marks on the timeline where the app asked; repeats of one reason within a few seconds share a mark.
  void _mark(String reason) {
    final now = _now();
    final last = _marks[reason];
    if (last != null && now >= last && now - last < ReplayLimits.markMs) return;
    if (_marks.length >= 50) _marks.clear();
    _marks[reason] = now;
    final event = customEvent('pbr/trigger', {'reason': reason}, now);
    if (!_awaitingSnapshot) {
      _receive(event);
    } else if (_heldMarks.length < 20) {
      _heldMarks.add(event);
    }
  }

  /// Marks this moment on the recording. In trigger mode it also uploads what the device kept and records live for
  /// one more minute. Resolves with the session once it exists, or null when nothing is recorded or it cannot start.
  Future<ReplaySessionContext?> trigger([String? reason]) {
    if (_closed) return Future.value(null);
    // Nothing is recorded on this device, so nothing waits to upload.
    if (_captureStop == null) return Future.value(null);
    final label = triggerLabel(reason);
    if (_mode != 'trigger') {
      _mark(label);
      return Future.value(_context());
    }
    // A trigger made after the account or device changed is theirs: what the device kept for the last one is
    // dropped, and the trigger asks for a session for the new one.
    final value = _metadata();
    if (value != null && _identityOf(value) != _identity) _adopt(_identityOf(value));
    // A session close to its end cannot carry another minute: the live minute ends and the trigger asks for a new
    // session. Otherwise the minute is extended before the mark is recorded.
    final session = _session;
    final usable = session != null && session.expiresAt > _now() + 30000;
    if (_live && usable) {
      _liveUntil = max(_liveUntil, _now() + ReplayLimits.liveMs);
    } else if (_live) {
      _endLive();
    }
    _mark(label);
    if (_live) return Future.value(_context());
    // Recording the mark ends the session if the account or device changed since the check above.
    if (usable && _session != null) {
      _promote();
      return Future.value(_context());
    }
    if (_triggered.isEmpty) _triggered = label;
    final waiting = Completer<ReplaySessionContext?>();
    _waiting.add(waiting);
    unawaited(refresh());
    return waiting.future;
  }

  // Only trigger mode listens for uncaught errors, and only while the server asks for it.
  void _watchErrors() {
    final subscribe = _subscribeErrors;
    final wanted = !_closed && _mode == 'trigger' && options.triggerOnError && subscribe != null;
    if (wanted && _removeErrors == null) {
      try {
        _removeErrors = subscribe(() {
          unawaited(trigger('error'));
        });
      } catch (_) {
        _errors++;
      }
    } else if (!wanted && _removeErrors != null) {
      final remove = _removeErrors!;
      _removeErrors = null;
      try {
        remove();
      } catch (_) {
        _errors++;
      }
    }
  }

  int? _expiry(Map<String, Object?> result) {
    final expiresIn = result['expiresIn'];
    // Measured on this device's clock, which may be hours off; the server's 410 has the final say.
    if (expiresIn is num && expiresIn.isFinite && expiresIn > 0) return _now() + expiresIn.toInt();
    final expiresAt = result['expiresAt'];
    if (expiresAt is num && expiresAt.isFinite) return expiresAt.toInt();
    if (expiresAt is String) return DateTime.tryParse(expiresAt)?.millisecondsSinceEpoch;
    return null;
  }

  Future<void> _refreshOnce() async {
    if (_closed) return;
    final value = _metadata();
    if (value == null) {
      _disable();
      return;
    }
    final nextIdentity = _identityOf(value);
    if (_identity != nextIdentity) _adopt(nextIdentity);
    final current = _session;
    if (current != null && current.expiresAt <= _now() + 30000) {
      // Trigger mode goes on recording on the device, live or not; the next trigger asks for a new session.
      if (_mode == 'trigger') {
        if (_live) _endLive();
        _endSession();
      } else {
        _disable();
        _seq = 0;
      }
    }
    final expectedIdentity = _identity;
    try {
      final request = <String, Object?>{
        'deviceId': value.deviceId,
        'accountId': value.accountId,
        'platform': value.platform,
        'appVersion': value.appVersion,
        'room': value.room,
        'authToken': value.authToken,
        'features': const ['trigger'],
        if (_apiKey.isNotEmpty) 'apiKey': _apiKey,
      };
      final body = jsonEncode(request);
      _networkBytes += byteLength(body);
      final config = answerOf(await _transport.post(_url('/api/replay/config'), body));
      if (_closed || expectedIdentity != _identity || _identityOf(_metadata() ?? value) != expectedIdentity) {
        _refreshAgain = !_closed;
        return;
      }
      if (config['enabled'] != true) {
        _disable();
        return;
      }
      final interval = config['uploadIntervalMs'];
      _interval = interval is num && interval.isFinite && interval > 0 ? interval.toInt().clamp(20000, 30000) : 25000;
      // Back online: a network failure need not wait out its back-off. A 429 or 5xx still does.
      if (_retryUnreachable) {
        _retryAt = 0;
        _retryDelay = 0;
        _retryUnreachable = false;
      }
      final nextMode = config['uploadMode'] == 'trigger' ? 'trigger' : 'session';
      // Switching between whole sessions and triggers starts over in the new mode.
      if (nextMode != _mode) {
        _disable();
        _seq = 0;
        _mode = nextMode;
      }
      _watchErrors();
      _rememberRules(config);
      // A fresh capture takes a full snapshot under the new rules.
      if (_captureStop != null && _rulesKey() != _captureRules) _stopCapture();
      if (!_active || _localBlocked) return;
      // Without a screen in place a session would stay empty; one starts once a screen attaches.
      if (_session == null && _mode == 'session' && !_recorder.available) return;
      if (_session == null && (_mode == 'session' || _triggered.isNotEmpty)) {
        if (_captureOptions() == null) {
          _errors++;
          return;
        }
        final start = _triggered.isNotEmpty ? jsonEncode({...request, 'trigger': _triggered}) : body;
        _networkBytes += byteLength(start);
        final result = answerOf(await _transport.post(_url('/api/replay/start'), start));
        if (_closed || _identityOf(_metadata() ?? value) != expectedIdentity) {
          _refreshAgain = !_closed;
          return;
        }
        final sessionId = result['sessionId'], token = result['token'];
        if (result['enabled'] != true || sessionId is! String || token is! String) {
          _disable();
          return;
        }
        final expiresAt = _expiry(result);
        if (expiresAt == null) {
          _disable();
          return;
        }
        _session = _Session(sessionId, token, expiresAt);
        _rememberRules(result);
        _sessionId = sessionId;
        _seq = 0;
        _retryAt = 0;
        _retryDelay = 0;
        _rejected = 0;
        if (_mode == 'trigger') _promote();
        _room = value.room;
      } else if (_session != null && _triggered.isNotEmpty && _keeping()) {
        _promote();
      }
      if (_mode == 'trigger' && _session != null && _live) _settle(_context());
      _startCapture();
    } catch (error) {
      _errors++;
      // An unreachable or busy server keeps the session and its queue for the next poll; a waiting trigger tries again then.
      _settle(null);
      if (!retryable(statusOf(error))) {
        _disable();
      } else if (_closed || _identityOf(_metadata() ?? value) != expectedIdentity) {
        _refreshAgain = !_closed;
      } else {
        _startCapture();
      }
    }
  }

  /// Reads `metadata()` and the server's settings again, after sign-in, sign-out or a room change.
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
        _errors++;
      } finally {
        _refreshing = null;
        done.complete();
      }
    }();
    return done.future;
  }

  void _scheduleConfig() {
    _configTimer = _runtime.schedule(const Duration(milliseconds: ReplayLimits.configIntervalMs), () {
      if (_closed) return;
      unawaited(refresh());
      _scheduleConfig();
    });
  }

  void _scheduleFlush() {
    _flushTimer = _runtime.schedule(Duration(milliseconds: _interval), () {
      if (_closed) return;
      unawaited(flush());
      _scheduleFlush();
    });
  }

  /// Subscribes to pause and resume, starts the settings and upload timers, and asks the server whether to record.
  void start() {
    if (_closed) return;
    try {
      _removeLifecycle = _subscribeActive?.call(setActive);
    } catch (_) {
      _errors++;
    }
    _scheduleConfig();
    _scheduleFlush();
    unawaited(refresh());
  }

  /// Stops recording and releases its listeners. What was not uploaded yet is dropped; call [flush] first.
  void stop() {
    if (_closed) return;
    _closed = true;
    _disable();
    for (final timer in [_configTimer, _flushTimer, _recoveryTimer, _snapshotTimer, _checkoutTimer]) {
      _runtime.cancel(timer);
    }
    _watchErrors();
    try {
      _removeLifecycle?.call();
    } catch (_) {
      _errors++;
    }
  }

  bool get closed => _closed;

  ReplayMetrics getMetrics() => ReplayMetrics(
        startedAt: _startedAt,
        recording: _recording,
        sessionId: _sessionId,
        events: _events,
        frames: _recorder.frames,
        rawBytes: _rawBytes,
        compressedBytes: _compressedBytes,
        networkBytes: _networkBytes,
        uploadedChunks: _uploadedChunks,
        droppedChunks: _droppedChunks,
        droppedEvents: _droppedEvents,
        errors: _errors,
        bufferedBytes: _bufferBytes + _pendingBytes + _keptBytes,
        queuedBytes: _queueBytes,
      );
}
