import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/src/observability.dart';
import 'package:pocketbase_replay_flutter/src/options.dart';
import 'package:pocketbase_replay_flutter/src/transport.dart';

import 'support.dart';

final String credential = 'C' * 64;

class FakeLink implements ReplayLink {
  ReplaySessionContext? context;
  Completer<ReplaySessionContext?>? pending;
  final List<String> reasons = [];

  @override
  ReplaySessionContext? sessionContext() => context;

  @override
  Future<ReplaySessionContext?> trigger(String reason) {
    reasons.add(reason);
    pending = Completer<ReplaySessionContext?>();
    return pending!.future;
  }
}

void main() {
  late FakeClock clock;
  late FakeTransport transport;
  late ReplayMetadata metadata;
  late Map<String, Object?> answer;
  late List<int> uploadFailures;

  setUp(() {
    clock = FakeClock();
    metadata = const ReplayMetadata(deviceId: 'device-1', appVersion: '2.0.0', room: 'lobby');
    uploadFailures = [];
    answer = {
      'enabled': true,
      'errorsEnabled': true,
      'logsEnabled': true,
      'token': credential,
      'expiresIn': 4 * 60 * 60 * 1000,
      'uploadIntervalMs': 10000,
      'maxBatchEvents': 20,
    };
    transport = FakeTransport((path, body) {
      if (path == '/api/replay/observability/config') return answer;
      if (uploadFailures.isNotEmpty) throw ReplayHttpException(uploadFailures.removeAt(0));
      return {'ok': true};
    });
  });

  ObservabilityController controller({BeforeSend? beforeSend, ReplayLink? replay, bool logs = true, String? apiKey}) => ObservabilityController(
        options: ObservabilityOptions(
          endpoint: 'https://replay.test',
          metadata: () => metadata,
          apiKey: apiKey,
          errors: const ErrorTrackingOptions(),
          logs: logs ? const LogCaptureOptions() : null,
          service: 'mobile',
          sensitiveText: () => ['Wonderland'],
          beforeSend: beforeSend,
        ),
        transport: transport,
        runtime: clock.runtime,
        replay: replay,
      );

  List<Map<String, Object?>> events(String path) => [
        for (final sent in transport.to(path)) ...(sent.body['events']! as List).cast<Map<String, Object?>>(),
      ];

  test('an error captured before the server answers waits, then uploads redacted with a converted stack', () async {
    final diagnostics = controller(apiKey: 'pbr_key');
    Object? thrown;
    StackTrace? stack;
    try {
      throw StateError('No order for alice@example.test in Wonderland');
    } catch (error, trace) {
      thrown = error;
      stack = trace;
    }
    final id = diagnostics.captureException(thrown, stackTrace: stack, attributes: {'password': 'x', 'step': 'pay'});
    expect(id, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')));
    diagnostics.start();
    await settle();
    // The capture asked for a credential before start did, so the first request answered it.
    final config = transport.to('/api/replay/observability/config').first.body;
    expect(config['deviceId'], 'device-1');
    expect(config['apiKey'], 'pbr_key');
    final sent = transport.to('/api/replay/errors').single.body;
    expect(sent['token'], credential);
    expect(sent['apiKey'], 'pbr_key');
    final error = (sent['events']! as List).single as Map<String, Object?>;
    expect(error['id'], id);
    expect(error['name'], 'StateError');
    expect(error['message'], 'Bad state: No order for [redacted] in [redacted]');
    expect(error['stack'], startsWith('    at main.<anonymous closure> ('));
    expect(error['handled'], true);
    expect(error['level'], 'error');
    expect(error['appVersion'], '2.0.0');
    expect(error['service'], 'mobile');
    expect(error['room'], 'lobby');
    expect(error['attributes'], {'password': '[redacted]', 'step': 'pay'});
    expect(error.containsKey('sessionId'), isFalse);
    diagnostics.stop();
  });

  test('logs go to their own route, and a grouping key joins known failures', () async {
    final diagnostics = controller()..start();
    await settle();
    diagnostics.captureLog(LogLevel.warn, 'Retrying payment', attributes: {'attempt': 2});
    diagnostics.captureException(Exception('Declined'), groupingKey: 'checkout-payment', level: ErrorLevel.fatal, handled: false);
    await diagnostics.flush();
    expect(events('/api/replay/logs').single, containsPair('level', 'warn'));
    expect(events('/api/replay/logs').single['attributes'], {'attempt': 2});
    final error = events('/api/replay/errors').single;
    expect(error['attributes'], {'groupingKey': 'checkout-payment'});
    expect(error['level'], 'fatal');
    expect(error['handled'], false);
    expect(error['name'], 'Exception');
    expect(error['message'], 'Declined');
    diagnostics.stop();
  });

  test('a grouping key survives attributes cut to their limits', () async {
    final diagnostics = controller()..start();
    await settle();
    diagnostics.captureException(Exception('x'), groupingKey: 'checkout', attributes: {for (var index = 0; index < 25; index++) 'k$index': index});
    await diagnostics.flush();
    final attributes = events('/api/replay/errors').single['attributes']! as Map;
    expect(attributes['groupingKey'], 'checkout');
    expect(attributes.length, 20);
    diagnostics.stop();
  });

  test('beforeSend can edit or drop an entry, but not the facts of its capture', () async {
    final diagnostics = controller(beforeSend: (event) {
      if (event.kind == ObservabilityEventKind.log) return null;
      return event.copyWith(message: 'Edited', attributes: {'groupingKey': 'edited'});
    })
      ..start();
    await settle();
    final id = diagnostics.captureException(Exception('Original'));
    expect(diagnostics.captureLog(LogLevel.info, 'dropped'), isNull);
    await diagnostics.flush();
    final error = events('/api/replay/errors').single;
    expect(error['id'], id);
    expect(error['message'], 'Edited');
    expect(error['attributes'], {'groupingKey': 'edited'});
    expect(error['appVersion'], '2.0.0');
    expect(transport.to('/api/replay/logs'), isEmpty);
    expect(diagnostics.getMetrics().droppedEvents, 1);
    diagnostics.stop();
  });

  test('an error waits for the recording its trigger starts and links to it', () async {
    final link = FakeLink();
    final diagnostics = controller(replay: link)..start();
    await settle();
    diagnostics.captureException(Exception('Crash'));
    expect(link.reasons, ['error']);
    await diagnostics.flush();
    expect(transport.to('/api/replay/errors'), isEmpty, reason: 'held for the link');
    link.context = ReplaySessionContext(sessionId, uploadToken);
    link.pending!.complete(link.context);
    await settle();
    final error = events('/api/replay/errors').single;
    expect(error['sessionId'], sessionId);
    expect(error['sessionToken'], uploadToken);

    // With a live recording, an error links at once without a trigger.
    diagnostics.captureException(Exception('Again'));
    expect(link.reasons, ['error']);
    await diagnostics.flush();
    expect(events('/api/replay/errors').last['sessionId'], sessionId);
    diagnostics.stop();
  });

  test('a held error goes without its link after ten seconds', () async {
    final link = FakeLink();
    final diagnostics = controller(replay: link)..start();
    await settle();
    diagnostics.captureException(Exception('Crash'));
    await clock.advance(10000);
    expect(events('/api/replay/errors').single.containsKey('sessionId'), isFalse);
    diagnostics.stop();
  });

  test('a server with the features off drops the queue, and a refused credential is renewed', () async {
    answer = {...answer, 'errorsEnabled': false, 'logsEnabled': false};
    final off = controller();
    off.captureLog(LogLevel.info, 'queued');
    off.start();
    await settle();
    expect(off.getMetrics().droppedEvents, 1);
    expect(off.captureLog(LogLevel.info, 'refused'), isNull);
    off.stop();
    transport.sent.clear();

    answer = {...answer, 'errorsEnabled': true, 'logsEnabled': true};
    final diagnostics = controller()..start();
    await settle();
    uploadFailures = [401];
    diagnostics.captureLog(LogLevel.info, 'retried');
    await diagnostics.flush();
    expect(events('/api/replay/logs').map((log) => log['message']), ['retried']);
    // A credential is asked for at most every 5 seconds; the next upload tick renews it and sends the entry again.
    await clock.advance(10000);
    expect(transport.to('/api/replay/observability/config'), hasLength(2));
    expect(events('/api/replay/logs').map((log) => log['message']), ['retried', 'retried']);
    diagnostics.stop();
  });

  test('entries never move to another account', () async {
    final diagnostics = controller();
    diagnostics.captureLog(LogLevel.info, 'before sign-in');
    metadata = const ReplayMetadata(deviceId: 'device-1', accountId: 'account-1', authToken: 'pb-token');
    diagnostics.captureLog(LogLevel.info, 'after sign-in');
    diagnostics.start();
    await settle();
    expect(transport.to('/api/replay/observability/config').last.body['authToken'], 'pb-token');
    expect(events('/api/replay/logs').map((log) => log['message']), ['after sign-in']);
    diagnostics.stop();
  });

  test('an oversized entry sheds attributes, then stack and message, but keeps its grouping key', () async {
    final diagnostics = controller()..start();
    await settle();
    // Only text outside Latin script can pass 16 KiB: each of its characters takes two or more bytes.
    diagnostics.captureException(Exception('€' * 1900),
        stackTrace: StackTrace.fromString(List.filled(400, '#0      €€€€€€€€ (package:a/a.dart:1:1)').join('\n')),
        groupingKey: 'big',
        attributes: {for (var index = 0; index < 8; index++) 'k$index': 'v' * 400});
    await diagnostics.flush();
    final error = events('/api/replay/errors').single;
    expect(error['attributes'], {'truncated': true, 'groupingKey': 'big'});
    expect((error['stack']! as String).length, lessThanOrEqualTo(6000));
    expect(error['message'], '€' * 1900);
    diagnostics.stop();
  });
}
