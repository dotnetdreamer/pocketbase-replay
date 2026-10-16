// Runs only against a replay server, with its superuser:
// REPLAY_TEST_ENDPOINT=http://127.0.0.1:8090 REPLAY_TEST_EMAIL=... REPLAY_TEST_PASSWORD=... flutter test test/server_test.dart
// The server's recording and diagnostics settings are changed, so use a throwaway one.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:pocketbase/pocketbase.dart';
import 'package:pocketbase_replay_flutter/pocketbase_replay_flutter.dart';

final String? endpoint = Platform.environment['REPLAY_TEST_ENDPOINT'];
final String email = Platform.environment['REPLAY_TEST_EMAIL'] ?? '';
final String password = Platform.environment['REPLAY_TEST_PASSWORD'] ?? '';

class Admin {
  Admin(this.token);

  final String token;

  static Future<Admin> signIn() async {
    final answer = await call('POST', '/api/collections/_superusers/auth-with-password', {'identity': email, 'password': password});
    return Admin(answer['token']! as String);
  }

  static Future<Map<String, Object?>> call(String method, String path, [Object? body, String? token]) async {
    final request = http.Request(method, Uri.parse('$endpoint$path'))
      ..headers['Content-Type'] = 'application/json'
      ..body = body == null ? '' : jsonEncode(body);
    if (token != null) request.headers['Authorization'] = token;
    final response = await http.Response.fromStream(await request.send());
    if (response.statusCode >= 400) throw StateError('$method $path: ${response.statusCode} ${response.body}');
    final decoded = response.body.isEmpty ? null : jsonDecode(response.body);
    return decoded is Map<String, Object?> ? decoded : {'items': decoded};
  }

  Future<Map<String, Object?>> get(String path) => call('GET', path, null, token);
  Future<Map<String, Object?>> post(String path, Object? body) => call('POST', path, body, token);
}

// Real time for the network and the engine's image work, and frames between, as a running app draws them.
Future<void> waitFor(WidgetTester tester, bool Function() done, String what) async {
  for (var attempt = 0; attempt < 200 && !done(); attempt++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 20));
  }
  expect(done(), isTrue, reason: 'timed out waiting for $what');
}

int recorded() => PocketBaseReplay.getMetrics()?.events ?? 0;

List<Map<String, Object?>> decode(List<Object?> chunks) => [
      for (final chunk in chunks.cast<Map<String, Object?>>())
        ...(jsonDecode(utf8.decode(gzip.decode(base64Decode(chunk['data']! as String)))) as List).cast<Map<String, Object?>>(),
    ];

List<Map<String, Object?>> tagged(List<Map<String, Object?>> events, String tag) => [
      for (final event in events)
        if (event['type'] == 5 && (event['data']! as Map)['tag'] == tag) (event['data']! as Map)['payload']! as Map<String, Object?>,
    ];

void main() {
  testWidgets('a Flutter app is recorded, explained and linked by a real replay server', (tester) async {
    HttpOverrides.global = null;
    final navigator = GlobalKey<NavigatorState>();
    final device = 'flutter-e2e-${DateTime.now().millisecondsSinceEpoch}';
    await tester.pumpWidget(PocketBaseReplayWidget(
      child: MaterialApp(
        navigatorKey: navigator,
        navigatorObservers: [PocketBaseReplay.navigatorObserver],
        routes: {'/checkout': (_) => const Scaffold(body: Text('Checkout'))},
        home: Scaffold(
          body: Column(children: [
            ElevatedButton(onPressed: () {}, child: const Text('Pay now')),
            const SizedBox(width: 300, child: TextField()),
          ]),
        ),
      ),
    ));

    late Admin admin;
    late bool explains;
    await tester.runAsync(() async {
      admin = await Admin.signIn();
      await admin.post('/api/replay/settings', {
        'mode': 'percentage', 'percentage': 100, 'account_ids': <String>[], 'retention_days': 14,
        'record_network': true, 'record_console': true, 'upload_mode': 'session',
      });
      final diagnostics = await admin.get('/api/replay/observability/settings');
      await admin.post('/api/replay/observability/settings', {...diagnostics, 'errors_enabled': true, 'logs_enabled': true});
      try {
        await admin.get('/api/collections/flutter_notes');
      } catch (_) {
        await admin.post('/api/collections', {
          'name': 'flutter_notes', 'type': 'base', 'listRule': '', 'viewRule': '', 'createRule': '@request.auth.id != ""',
          'fields': [{'name': 'title', 'type': 'text', 'required': true}],
        });
      }
      await admin.post('/api/collections/flutter_notes/records', {'title': 'hello'});
      final answer = await Admin.call('POST', '/api/replay/config', {'deviceId': device, 'platform': 'android', 'features': ['trigger']});
      explains = answer['recordPocketbase'] == true;

      await PocketBaseReplay.start(PocketBaseReplayOptions(
        endpoint: endpoint!,
        metadata: () => ReplayMetadata(deviceId: device, appVersion: 'flutter-e2e'),
        errors: const ErrorTrackingOptions(captureUnhandled: true),
        logs: const LogCaptureOptions(capturePrint: true),
        service: 'flutter-e2e',
      ));
    });
    await waitFor(tester, () => recorded() > 0, 'the first frame');

    await tester.tap(find.text('Pay now'));
    navigator.currentState!.pushNamed('/checkout');
    await tester.pumpAndSettle();
    debugPrint('Checkout opened');

    String? sessionId;
    await tester.runAsync(() async {
      final pb = PocketBase(endpoint!, httpClientFactory: ReplayPocketBaseClient.new);
      expect((await pb.collection('flutter_notes').getList()).items, isNotEmpty);
      await expectLater(pb.collection('flutter_notes').create(body: {'title': 'x'}), throwsA(isA<ClientException>()));
      await ReplayNetworkClient().get(Uri.parse('$endpoint/api/health'));
      try {
        throw StateError('Payment declined for order 1234');
      } catch (error, stack) {
        expect(PocketBaseReplay.captureException(error, stackTrace: stack, attributes: {'step': 'pay'}), isNotNull);
      }
      sessionId = await PocketBaseReplay.trigger('report');
      await PocketBaseReplay.flush();
      final metrics = PocketBaseReplay.getMetrics()!;
      printOnFailure('uploaded ${metrics.uploadedChunks} dropped ${metrics.droppedChunks}/${metrics.droppedEvents} errors ${metrics.errors} events ${metrics.events}');
      await PocketBaseReplay.stop();
      expect(sessionId, isNotNull);

      final session = await admin.get('/api/replay/sessions?device=$device');
      expect((session['items']! as List).single, containsPair('platform', 'android'));
      final chunks = <Object?>[];
      for (var page = 1;; page++) {
        final answer = await admin.get('/api/replay/sessions/$sessionId/chunks?page=$page');
        chunks.addAll(answer['items']! as List);
        if (page >= (answer['totalPages']! as int)) break;
      }
      final events = decode(chunks);
      printOnFailure('events: ${events.map((event) => '${event['type']}/${(event['data']! as Map)['source'] ?? (event['data']! as Map)['tag'] ?? ''}').join(' ')}');
      expect(events.take(2).map((event) => event['type']), [4, 2]);
      expect(jsonEncode(events[1]), contains('data:image/png;base64,'));
      final clicks = events.where((event) => event['type'] == 3 && (event['data']! as Map)['source'] == 2 && (event['data']! as Map)['type'] == 2);
      expect(clicks, isNotEmpty);
      expect(jsonEncode(events), contains('"textContent":"Pay now"'));
      expect(tagged(events, 'pbr/navigation').map((page) => page['url']), contains('flutter://app/checkout'));
      expect(tagged(events, 'pbr/console').map((line) => line['text']), contains('Checkout opened'));
      expect(tagged(events, 'pbr/network').single['url'], '$endpoint/api/health');
      expect(tagged(events, 'pbr/trigger').single['reason'], 'report');

      final errors = await admin.get('/api/replay/errors?sessionId=$sessionId');
      final error = (errors['items']! as List).cast<Map<String, Object?>>().singleWhere((item) => item['name'] == 'StateError');
      expect(error['message'], 'Bad state: Payment declined for order 1234');
      expect(error['stack'], contains('    at main.<anonymous closure> ('));
      expect(error['replayAvailable'], isTrue);
      final logs = await admin.get('/api/replay/logs?sessionId=$sessionId');
      expect((logs['items']! as List).cast<Map<String, Object?>>().map((log) => log['message']), contains('Checkout opened'));

      final calls = tagged(events, 'pbr/pocketbase');
      if (explains) {
        final list = calls.firstWhere((call) => call['action'] == 'list');
        expect(list['items'], greaterThan(0));
        expect(list['items'], list['total']);
        expect(list, containsPair('linked', true));
        expect(list, containsPair('server', true));
        final create = calls.firstWhere((call) => call['action'] == 'create');
        expect(create['status'], anyOf(400, 403));
        final explained = await admin.post('/api/replay/requests', {
          'sessionId': sessionId,
          'requests': [
            {'request': create['request'], 'method': 'POST', 'path': create['path'], 'status': create['status']},
          ],
        });
        // PocketBase writes its request log a few seconds late, so the log part of an answer may still be missing.
        final item = (explained['items']! as List).cast<Map<String, Object?>>().single;
        expect(item['rule'], containsPair('name', 'createRule'));
      } else {
        expect(calls, isEmpty, reason: 'a server without PocketBase call recording leaves it off');
      }
      final dump = Platform.environment['REPLAY_TEST_DUMP'];
      if (dump != null) {
        File(dump).writeAsStringSync(jsonEncode({'chunks': chunks, 'errors': errors['items'], 'logs': logs['items']}));
      }
    });
  }, skip: endpoint == null);

  testWidgets('in trigger mode nothing is uploaded until something breaks', (tester) async {
    HttpOverrides.global = null;
    final device = 'flutter-trigger-${DateTime.now().millisecondsSinceEpoch}';
    await tester.pumpWidget(const PocketBaseReplayWidget(child: MaterialApp(home: Scaffold(body: Text('Basket')))));
    await tester.runAsync(() async {
      final admin = await Admin.signIn();
      await admin.post('/api/replay/settings', {
        'mode': 'percentage', 'percentage': 100, 'account_ids': <String>[], 'retention_days': 14, 'upload_mode': 'trigger',
      });
      await PocketBaseReplay.start(PocketBaseReplayOptions(
        endpoint: endpoint!,
        metadata: () => ReplayMetadata(deviceId: device, appVersion: 'flutter-e2e'),
      ));
    });
    await waitFor(tester, () => recorded() > 0, 'the first frame');
    await tester.runAsync(() async {
      final admin = await Admin.signIn();
      await PocketBaseReplay.flush();
      expect((await admin.get('/api/replay/sessions?device=$device'))['items'], isEmpty);
      final sessionId = await PocketBaseReplay.trigger('checkout failed');
      expect(sessionId, isNotNull);
      await PocketBaseReplay.flush();
      final metrics = PocketBaseReplay.getMetrics()!;
      printOnFailure('uploaded ${metrics.uploadedChunks} dropped ${metrics.droppedChunks}/${metrics.droppedEvents} errors ${metrics.errors} '
          'events ${metrics.events} buffered ${metrics.bufferedBytes} queued ${metrics.queuedBytes} session ${metrics.sessionId}');
      await PocketBaseReplay.stop();
      final session = ((await admin.get('/api/replay/sessions?device=$device'))['items']! as List).single as Map;
      expect(session['trigger'], 'checkout failed');
      final events = decode((await admin.get('/api/replay/sessions/$sessionId/chunks'))['items']! as List);
      expect(events.take(2).map((event) => event['type']), [4, 2]);
      expect(tagged(events, 'pbr/trigger').single['reason'], 'checkout failed');
      await admin.post('/api/replay/settings', {'mode': 'percentage', 'percentage': 100, 'account_ids': <String>[], 'retention_days': 14, 'upload_mode': 'session'});
    });
  }, skip: endpoint == null);
}
