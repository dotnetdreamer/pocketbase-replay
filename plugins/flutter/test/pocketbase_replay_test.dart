import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/pocketbase_replay_flutter.dart';

import 'support.dart';

Future<void> waitFor(WidgetTester tester, bool Function() done, {String reason = 'condition'}) async {
  for (var attempt = 0; attempt < 150 && !done(); attempt++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(done(), isTrue, reason: 'timed out waiting for $reason');
}

void main() {
  testWidgets('records the app, uploads it, and links errors to the recording', (tester) async {
    final credential = 'C' * 64;
    final transport = FakeTransport((path, body) => switch (path) {
          '/api/replay/config' || '/api/replay/start' => {...startAnswer(), 'maskTextSelector': '*'},
          '/api/replay/observability/config' => {
              'enabled': true,
              'errorsEnabled': true,
              'logsEnabled': true,
              'token': credential,
              'expiresIn': 4 * 60 * 60 * 1000,
            },
          _ => {'ok': true},
        });
    final handler = FlutterError.onError;
    await tester.pumpWidget(const PocketBaseReplayWidget(
      child: MaterialApp(home: Scaffold(body: Align(alignment: Alignment.topLeft, child: Text('Plain words')))),
    ));
    await PocketBaseReplay.start(PocketBaseReplayOptions(
      endpoint: 'https://replay.test',
      metadata: () => const ReplayMetadata(deviceId: 'device-1', appVersion: '3.1.0'),
      transport: transport,
      frameInterval: const Duration(milliseconds: 100),
      errors: const ErrorTrackingOptions(captureUnhandled: true),
      logs: const LogCaptureOptions(),
      service: 'mobile',
    ));
    await waitFor(tester, () => (PocketBaseReplay.getMetrics()?.frames ?? 0) > 0, reason: 'a frame');
    expect(transport.to('/api/replay/start').single.body['platform'], 'android');
    expect(PocketBaseReplay.getMetrics()!.sessionId, sessionId);

    final flushing = PocketBaseReplay.flush();
    await waitFor(tester, () => transport.to('/api/replay/chunks').isNotEmpty, reason: 'a chunk');
    await flushing;
    final events = decodeChunk(transport.to('/api/replay/chunks').first.body);
    expect(events.take(2).map((event) => event['type']), [4, 2]);
    expect((events.first['data']! as Map)['href'], 'flutter://app/');
    final image = RegExp(r'data:image/png;base64,[A-Za-z0-9+/=]+').firstMatch(jsonEncode(events[1]))![0]!;
    final text = tester.getRect(find.text('Plain words'));
    final color = await tester.runAsync(() async {
      final codec = await ui.instantiateImageCodec(base64Decode(image.split(',').last));
      final frame = (await codec.getNextFrame()).image;
      final data = (await frame.toByteData(format: ui.ImageByteFormat.rawStraightRgba))!;
      final offset = (text.center.dy.round() * frame.width + text.left.round() + 2) * 4;
      return Color.fromARGB(data.getUint8(offset + 3), data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2));
    });
    expect(color, const Color(0xFF9E9E9E), reason: 'the server rule * masks all text');

    final id = PocketBaseReplay.captureException(StateError('checkout failed'), groupingKey: 'checkout');
    FlutterError.reportError(FlutterErrorDetails(exception: Exception('layout broke'), library: 'widgets library'));
    expect(tester.takeException(), isA<Exception>());
    final sent = PocketBaseReplay.flush();
    await waitFor(tester, () => transport.to('/api/replay/errors').isNotEmpty, reason: 'errors');
    await sent;
    final errors = [for (final batch in transport.to('/api/replay/errors')) ...(batch.body['events']! as List).cast<Map<String, Object?>>()];
    expect(errors.first['id'], id);
    expect(errors.first['sessionId'], sessionId);
    expect(errors.first['attributes'], {'groupingKey': 'checkout'});
    expect(errors.last['handled'], false);
    expect(errors.last['message'], 'layout broke');
    expect(errors.last['attributes'], {'library': 'widgets library'});

    expect(await tester.runAsync(() => PocketBaseReplay.trigger('report')), sessionId);
    await PocketBaseReplay.stop();
    expect(PocketBaseReplay.getMetrics(), isNull);
    expect(FlutterError.onError, handler, reason: 'the app\'s handler is put back');
    expect(PocketBaseReplay.captureLog(LogLevel.info, 'after stop'), isNull);
  }, variant: const TargetPlatformVariant({TargetPlatform.android}));

  testWidgets(
      'triggerOnError false captures diagnostics without uploading replay, while explicit triggers work',
      (tester) async {
    final previous = FlutterError.onError;
    FlutterError.onError = (_) {};
    final transport = FakeTransport((path, body) => switch (path) {
          '/api/replay/config' => configAnswer(uploadMode: 'trigger'),
          '/api/replay/start' => startAnswer(),
          '/api/replay/observability/config' => {
              'enabled': true,
              'errorsEnabled': true,
              'logsEnabled': false,
              'token': 'C' * 64,
              'expiresIn': 4 * 60 * 60 * 1000,
            },
          _ => {'ok': true},
        });
    try {
      await tester.pumpWidget(const PocketBaseReplayWidget(
        child: MaterialApp(home: Scaffold(body: Text('Basket'))),
      ));
      await tester
          .runAsync(() => PocketBaseReplay.start(PocketBaseReplayOptions(
                endpoint: 'https://replay.test',
                metadata: () => const ReplayMetadata(deviceId: 'error-opt-out'),
                transport: transport,
                triggerOnError: false,
                errors: const ErrorTrackingOptions(captureUnhandled: true),
              )));
      await waitFor(
          tester, () => (PocketBaseReplay.getMetrics()?.events ?? 0) >= 2,
          reason: 'buffered frame');
      await tester.runAsync(() async {
        FlutterError.reportError(FlutterErrorDetails(
            exception: StateError('Uncaught with opt-out')));
        PocketBaseReplay.captureException(StateError('Handled with opt-out'));
        await settle();
        await PocketBaseReplay.flush();
      });
      final errors = [
        for (final batch in transport.to('/api/replay/errors'))
          ...(batch.body['events']! as List)
      ];
      expect(errors, hasLength(2),
          reason: 'the option does not disable diagnostic error capture');
      expect(transport.to('/api/replay/start'), isEmpty);
      expect(transport.to('/api/replay/chunks'), isEmpty);

      final explicit =
          await tester.runAsync(() => PocketBaseReplay.trigger('report'));
      expect(explicit, sessionId);
      await tester.runAsync(PocketBaseReplay.flush);
      expect(
          transport.to('/api/replay/start').single.body['trigger'], 'report');
      expect(transport.to('/api/replay/chunks'), isNotEmpty);
    } finally {
      await PocketBaseReplay.stop();
      FlutterError.onError = previous;
      await tester.pumpWidget(const SizedBox());
    }
  });
}
