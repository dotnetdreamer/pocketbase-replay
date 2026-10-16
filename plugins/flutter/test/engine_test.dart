import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/src/engine.dart';
import 'package:pocketbase_replay_flutter/src/options.dart';
import 'package:pocketbase_replay_flutter/src/transport.dart';

import 'support.dart';

void main() {
  late FakeClock clock;
  late FakeRecorder recorder;
  late FakeTransport transport;
  late ReplayMetadata metadata;
  late List<int> chunkFailures;

  Object? serve(String path, Map<String, Object?> body, {String mode = 'session'}) {
    if (path == '/api/replay/config') return configAnswer(uploadMode: mode);
    if (path == '/api/replay/start') return startAnswer();
    if (path == '/api/replay/chunks' && chunkFailures.isNotEmpty) throw ReplayHttpException(chunkFailures.removeAt(0));
    return {'ok': true};
  }

  ReplayEngine engine({
    String? apiKey,
    bool triggerOnError = true,
    void Function() Function(void Function() listener)? errors,
    void Function() Function(void Function(bool active) listener)? lifecycle,
  }) =>
      ReplayEngine(
        options: PocketBaseReplayOptions(endpoint: 'https://replay.test/', metadata: () => metadata, apiKey: apiKey, triggerOnError: triggerOnError),
        transport: transport,
        recorder: recorder,
        runtime: clock.runtime,
        subscribeErrors: errors,
        subscribeActive: lifecycle,
      );

  List<Map<String, Object?>> uploaded() => [for (final chunk in transport.to('/api/replay/chunks')) ...decodeChunk(chunk.body)];

  setUp(() {
    clock = FakeClock();
    recorder = FakeRecorder();
    chunkFailures = [];
    transport = FakeTransport(serve);
    metadata = const ReplayMetadata(deviceId: 'device-1', appVersion: '1.0.0');
  });

  test('asks the server, starts a session and uploads the screen in gzip chunks', () async {
    final replay = engine(apiKey: ' pbr_key ')..start();
    await settle();
    final config = transport.to('/api/replay/config').single.body;
    expect(config['deviceId'], 'device-1');
    expect(config['features'], ['trigger']);
    expect(config['apiKey'], 'pbr_key');
    expect(config['platform'], isNotEmpty);
    expect(config['authToken'], '');
    expect(transport.to('/api/replay/start'), hasLength(1));
    expect(recorder.running, isTrue);
    expect(recorder.settings!.endpoint, 'https://replay.test');
    expect(recorder.settings!.recordNetwork, isTrue);
    expect(recorder.settings!.recordPocketbase, isTrue);
    expect(recorder.settings!.tracePocketbaseRequests, isFalse);
    expect(recorder.settings!.replaySession(), sessionId);

    // Nothing counts before the first full snapshot, and a large one keeps its meta event in the same chunk.
    recorder.touch(clock.time);
    recorder.screen(clock.time, imageChars: 300 * 1024);
    recorder.touch(clock.time + 5);
    await replay.flush();
    final chunks = transport.to('/api/replay/chunks').map((sent) => sent.body).toList();
    expect(chunks, hasLength(2));
    expect(chunks.map((chunk) => chunk['seq']), [0, 1]);
    expect(chunks.first['sessionId'], sessionId);
    expect(chunks.first['token'], uploadToken);
    expect(chunks.first['encoding'], 'gzip-base64');
    expect(chunks.first['apiKey'], 'pbr_key');
    expect(chunks.map((chunk) => chunk['hasSnapshot']), [true, false]);
    expect(decodeChunk(chunks.first).map((event) => event['type']), [4, 2]);
    expect(decodeChunk(chunks.last).map((event) => event['type']), [3]);
    expect(replay.getMetrics().uploadedChunks, 2);
    replay.stop();
    expect(recorder.running, isFalse);
  });

  test('request tracing follows server config and restarts capture when the opt-in changes', () async {
    var trace = true;
    transport.respond = (path, body) => path == '/api/replay/config' || path == '/api/replay/start'
        ? {...startAnswer(), 'tracePocketbaseRequests': trace}
        : {'ok': true};
    final replay = engine()..start();
    await settle();
    expect(recorder.settings!.tracePocketbaseRequests, isTrue);
    final starts = recorder.starts;
    trace = false;
    await replay.refresh();
    expect(recorder.settings!.tracePocketbaseRequests, isFalse);
    expect(recorder.starts, starts + 1);
    replay.stop();
  });

  test('maps the dashboard rules a screen recorder understands, and waits while one cannot be read', () async {
    transport.respond = (path, body) => path == '/api/replay/config' || path == '/api/replay/start'
        ? {...startAnswer(), 'maskTextSelector': '.chat, *', 'blockSelector': 'img'}
        : {'ok': true};
    final replay = engine()..start();
    await settle();
    expect(recorder.settings!.maskAllText, isTrue);
    expect(recorder.settings!.maskAllImages, isTrue);
    replay.stop();

    recorder = FakeRecorder();
    transport.respond = (path, body) => {...startAnswer(), 'maskTextSelector': 42};
    final unreadable = engine()..start();
    await settle();
    expect(recorder.starts, 0);
    expect(transport.to('/api/replay/start').length, 1);
    unreadable.stop();
  });

  test('retries network failures with back-off, then starts a new session after 410', () async {
    final replay = engine()..start();
    await settle();
    recorder.screen(clock.time);
    chunkFailures = [0];
    await replay.flush();
    expect(transport.to('/api/replay/chunks'), hasLength(1));
    await replay.flush();
    expect(transport.to('/api/replay/chunks'), hasLength(1), reason: 'waits out the back-off');
    await clock.advance(5000);
    await replay.flush();
    final attempts = transport.to('/api/replay/chunks');
    expect(attempts, hasLength(2));
    expect(attempts.map((sent) => sent.body['seq']), [0, 0]);

    chunkFailures = [410];
    recorder.touch(clock.time);
    await replay.flush();
    await settle();
    expect(transport.to('/api/replay/start'), hasLength(2));
    expect(recorder.starts, 2);
    replay.stop();
  });

  test('a refused upload ends the session and stops recording', () async {
    final replay = engine()..start();
    await settle();
    recorder.screen(clock.time);
    chunkFailures = [403];
    await replay.flush();
    expect(recorder.running, isFalse);
    expect(replay.getMetrics().sessionId, isNull);
    replay.stop();
  });

  test('a new account starts over under that identity, with its token', () async {
    final replay = engine()..start();
    await settle();
    recorder.screen(clock.time);
    metadata = const ReplayMetadata(deviceId: 'device-1', accountId: 'account-1', authToken: 'pb-token', appVersion: '1.0.0');
    recorder.touch(clock.time);
    await settle();
    final configs = transport.to('/api/replay/config');
    expect(configs, hasLength(2));
    expect(configs.last.body['accountId'], 'account-1');
    expect(configs.last.body['authToken'], 'pb-token');
    expect(transport.to('/api/replay/start'), hasLength(2));
    expect(transport.to('/api/replay/chunks'), isEmpty, reason: 'the old identity\'s events are dropped');
    replay.stop();
  });

  test('pauses in the background and resumes with a fresh capture', () async {
    void Function(bool active)? lifecycle;
    final replay = engine(lifecycle: (listener) {
      lifecycle = listener;
      return () => lifecycle = null;
    })
      ..start();
    await settle();
    recorder.screen(clock.time);
    lifecycle!(false);
    await settle();
    expect(recorder.running, isFalse);
    expect(transport.to('/api/replay/chunks'), hasLength(1), reason: 'pausing flushes');
    lifecycle!(true);
    await settle();
    expect(recorder.starts, 2);
    replay.stop();
    expect(lifecycle, isNull);
  });

  test('trigger mode keeps the recording on the device and uploads it after a trigger', () async {
    transport.respond = (path, body) => serve(path, body, mode: 'trigger');
    final replay = engine()..start();
    await settle();
    expect(transport.to('/api/replay/start'), isEmpty);
    expect(recorder.running, isTrue);
    recorder.screen(clock.time);
    recorder.touch(clock.time + 10);
    await clock.advance(30000);
    expect(transport.to('/api/replay/chunks'), isEmpty);
    expect(recorder.settings!.replaySession(), isNull, reason: 'nothing is live between triggers');

    final context = await replay.trigger(' checkout\nfailed ');
    expect(transport.to('/api/replay/start').single.body['trigger'], 'checkoutfailed');
    expect(context?.sessionId, sessionId);
    await replay.flush();
    final events = uploaded();
    expect(events.take(3).map((event) => event['type']), [4, 2, 3]);
    final mark = events.firstWhere((event) => event['type'] == 5);
    expect(mark['data'], {
      'tag': 'pbr/trigger',
      'payload': {'reason': 'checkoutfailed'},
    });
    expect(recorder.settings!.replaySession(), sessionId);
    replay.stop();
  });

  test('uncaught errors trigger the recorder in trigger mode unless the app opts out', () async {
    void Function()? onError;
    void Function() Function(void Function() listener) errors() => (listener) {
          onError = listener;
          return () => onError = null;
        };
    transport.respond = (path, body) => serve(path, body, mode: 'trigger');
    final replay = engine(errors: errors())..start();
    await settle();
    expect(onError, isNotNull);
    recorder.screen(clock.time);
    onError!();
    await settle();
    expect(transport.to('/api/replay/start').single.body['trigger'], 'error');
    replay.stop();
    expect(onError, isNull);

    final optedOut = engine(triggerOnError: false, errors: errors())..start();
    await settle();
    expect(onError, isNull);
    optedOut.stop();
  });

  test('a trigger in whole-session mode marks the timeline once per reason within five seconds', () async {
    final replay = engine()..start();
    await settle();
    recorder.screen(clock.time);
    expect((await replay.trigger('report'))?.sessionId, sessionId);
    await replay.trigger('report');
    await clock.advance(6000);
    await replay.trigger('report');
    await replay.trigger();
    await replay.flush();
    final reasons = uploaded().where((event) => event['type'] == 5).map((event) => (event['data']! as Map)['payload']);
    expect(reasons, [
      {'reason': 'report'},
      {'reason': 'report'},
      {'reason': 'manual'},
    ]);
    replay.stop();
  });

  test('an event over 1 MiB stops recording rather than uploading it', () async {
    final replay = engine()..start();
    await settle();
    recorder.screen(clock.time, imageChars: 1100 * 1024);
    expect(recorder.running, isFalse);
    await replay.refresh();
    expect(recorder.starts, 1);
    // The oversized snapshot and the meta event buffered before it.
    expect(replay.getMetrics().droppedEvents, 2);
    replay.stop();
  });

  test('a room change starts a new chunk carrying that room', () async {
    final replay = engine()..start();
    await settle();
    recorder.screen(clock.time);
    metadata = const ReplayMetadata(deviceId: 'device-1', appVersion: '1.0.0', room: 'lobby');
    recorder.touch(clock.time + 1);
    await replay.flush();
    expect(transport.to('/api/replay/chunks').map((sent) => sent.body['room']), ['', 'lobby']);
    replay.stop();
  });

  test('a trigger right after sign-in belongs to the new account and starts its session', () async {
    var sessions = 0;
    transport.respond = (path, body) {
      if (path == '/api/replay/config') return configAnswer(uploadMode: 'trigger');
      if (path == '/api/replay/start') return startAnswer(id: 'session${(++sessions).toString().padLeft(8, '0')}');
      return {'ok': true};
    };
    final replay = engine()..start();
    await settle();
    recorder.screen(clock.time);
    expect(await replay.trigger('first'), isNotNull);
    // Signed in, before the app called refresh().
    metadata = const ReplayMetadata(deviceId: 'device-1', accountId: 'account-1', authToken: 'pb-token', appVersion: '1.0.0');
    final second = await replay.trigger('bug-report');
    final start = transport.to('/api/replay/start').last.body;
    expect(start['accountId'], 'account-1');
    expect(start['trigger'], 'bug-report');
    expect(second?.sessionId, 'session00000002');
    expect(recorder.running, isTrue);
    recorder.screen(clock.time);
    await replay.flush();
    final marks = transport
        .to('/api/replay/chunks')
        .where((sent) => sent.body['sessionId'] == 'session00000002')
        .expand((sent) => decodeChunk(sent.body))
        .where((event) => event['type'] == 5);
    expect(marks.map((event) => (event['data']! as Map)['payload']), [
      {'reason': 'bug-report'},
    ]);
    replay.stop();
  });

  test('no session starts while there is no screen to record, and one starts once a screen attaches', () async {
    recorder.hasScreen = false;
    final replay = engine()..start();
    await settle();
    expect(transport.to('/api/replay/config'), hasLength(1));
    expect(transport.to('/api/replay/start'), isEmpty);
    recorder.hasScreen = true;
    await replay.refresh();
    expect(transport.to('/api/replay/start'), hasLength(1));
    expect(recorder.running, isTrue);
    replay.stop();
  });

  test('trigger labels are cleaned as the server cleans them', () {
    expect(triggerLabel('  report\u0000 '), 'report');
    expect(triggerLabel(null), 'manual');
    expect(triggerLabel('x' * 70).length, 64);
    expect(triggerLabel('${'x' * 63}😀'), 'x' * 63);
  });

  test('an empty endpoint records nothing', () async {
    final replay = ReplayEngine(
      options: PocketBaseReplayOptions(endpoint: ' ', metadata: () => metadata),
      transport: transport,
      recorder: recorder,
      runtime: clock.runtime,
    )..start();
    await settle();
    expect(transport.sent, isEmpty);
    expect(await replay.trigger('x'), isNull);
    replay.stop();
  });
}
