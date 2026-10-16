import 'dart:convert';
import 'dart:io';

import 'package:pocketbase_replay_flutter/src/engine.dart';
import 'package:pocketbase_replay_flutter/src/events.dart';
import 'package:pocketbase_replay_flutter/src/runtime.dart';
import 'package:pocketbase_replay_flutter/src/transport.dart';

class _Timer {
  _Timer(this.at, this.callback);

  final int at;
  final void Function() callback;
}

/// A manual clock: timers run only when the test advances time.
class FakeClock {
  int time = 1760000000000;
  final List<_Timer> _timers = [];

  late final ReplayRuntime runtime = ReplayRuntime(
    now: () => time,
    schedule: (delay, callback) {
      final timer = _Timer(time + delay.inMilliseconds, callback);
      _timers.add(timer);
      return timer;
    },
    cancel: (timer) => _timers.remove(timer),
  );

  Future<void> advance(int ms) async {
    final target = time + ms;
    while (true) {
      _timers.sort((a, b) => a.at.compareTo(b.at));
      final due = _timers.where((timer) => timer.at <= target).firstOrNull;
      if (due == null) break;
      _timers.remove(due);
      time = due.at < time ? time : due.at;
      due.callback();
      await settle();
    }
    time = target;
    await settle();
  }
}

Future<void> settle() async {
  for (var index = 0; index < 30; index++) {
    await Future<void>.delayed(Duration.zero);
  }
}

class Sent {
  Sent(this.path, this.body);

  final String path;
  final Map<String, Object?> body;
}

/// Records each request and answers with [respond], which may throw a [ReplayHttpException].
class FakeTransport implements ReplayTransport {
  FakeTransport(this.respond);

  Object? Function(String path, Map<String, Object?> body) respond;
  final List<Sent> sent = [];

  List<Sent> to(String path) => sent.where((item) => item.path == path).toList();

  @override
  Future<Object?> post(Uri url, String body) async {
    final json = jsonDecode(body) as Map<String, Object?>;
    sent.add(Sent(url.path, json));
    return respond(url.path, json);
  }
}

/// The events inside an uploaded chunk, checked the way the server and viewer check them.
List<Map<String, Object?>> decodeChunk(Map<String, Object?> chunk) {
  final data = chunk['data']! as String;
  if (!data.startsWith('H4sI')) throw StateError('Not gzip-base64');
  final raw = gzip.decode(base64Decode(data));
  if (raw.length != chunk['rawBytes']) throw StateError('rawBytes ${chunk['rawBytes']} != ${raw.length}');
  final events = (jsonDecode(utf8.decode(raw)) as List).cast<Map<String, Object?>>();
  if (events.length != chunk['eventCount']) throw StateError('eventCount');
  return events;
}

/// Stands in for the screen recorder: tests emit the events a screen would produce.
class FakeRecorder implements ReplayRecorder {
  void Function(ReplayEvent event)? emit;
  RecorderSettings? settings;
  int starts = 0;
  int stops = 0;
  int snapshots = 0;

  bool get running => emit != null;

  @override
  int get frames => 0;

  bool hasScreen = true;

  @override
  bool get available => hasScreen;

  @override
  void Function()? start(void Function(ReplayEvent event) emit, RecorderSettings settings) {
    this.emit = emit;
    this.settings = settings;
    starts++;
    return () {
      stops++;
      this.emit = null;
    };
  }

  @override
  void snapshot() => snapshots++;

  /// A meta event and a full snapshot whose image is [imageChars] characters long.
  void screen(int timestamp, {int imageChars = 16}) {
    emit!(ReplayEvent(EventType.meta, timestamp, {'href': 'flutter://app/', 'width': 100, 'height': 200}));
    emit!(ReplayEvent(EventType.fullSnapshot, timestamp, {
      'node': {'type': 0, 'id': 1, 'image': 'x' * imageChars},
      'initialOffset': {'top': 0, 'left': 0},
    }));
  }

  void touch(int timestamp) {
    emit!(ReplayEvent(EventType.incrementalSnapshot, timestamp, {'source': 2, 'type': 7, 'id': 6, 'x': 1, 'y': 2}));
  }
}

const String sessionId = 'abcdefghij12345';
final String uploadToken = 'T' * 64;

Map<String, Object?> configAnswer({String uploadMode = 'session', Object? mask = '', Object? block = '', bool pocketbase = true}) => {
      'enabled': true,
      'uploadIntervalMs': 25000,
      'maskTextSelector': mask,
      'blockSelector': block,
      'recordImages': false,
      'recordNetwork': true,
      'recordConsole': false,
      'recordPocketbase': pocketbase,
      'uploadMode': uploadMode,
    };

Map<String, Object?> startAnswer({String id = sessionId}) => {
      ...configAnswer(),
      'sessionId': id,
      'token': uploadToken,
      'expiresIn': 4 * 60 * 60 * 1000,
    };
