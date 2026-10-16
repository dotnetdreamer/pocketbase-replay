import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:pocketbase/pocketbase.dart';
import 'package:pocketbase_replay_flutter/src/activity/activity.dart';
import 'package:pocketbase_replay_flutter/src/activity/navigation.dart';
import 'package:pocketbase_replay_flutter/src/engine.dart';
import 'package:pocketbase_replay_flutter/src/events.dart';
import 'package:pocketbase_replay_flutter/src/hooks.dart';

const String recording = 'abcdefghij12345';

RecorderSettings settings({bool network = false, bool console = false, bool pocketbase = true, bool trace = false, String? session = recording}) => RecorderSettings(
      endpoint: 'https://pb.test',
      maskAllText: false,
      maskAllImages: false,
      recordNetwork: network,
      recordConsole: console,
      recordPocketbase: pocketbase,
      tracePocketbaseRequests: trace,
      sensitiveText: () => ['Wonderland'],
      replaySession: () => session,
    );

List<Map<String, Object?>> payloads(List<ReplayEvent> events, String tag) => [
      for (final event in events)
        if (event.type == EventType.custom && event.data['tag'] == tag) event.data['payload']! as Map<String, Object?>,
    ];

http.Response json(Object? body, int status) => http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

void main() {
  late List<ReplayEvent> events;
  late List<http.BaseRequest> requests;
  late ActivityRecorder activity;

  MockClient server(http.Response Function(http.Request request) answer) => MockClient((request) async {
        requests.add(request);
        return answer(request);
      });

  setUp(() {
    events = [];
    requests = [];
  });

  tearDown(() {
    activity.stop();
    ErrorHooks.reset();
    PrintHooks.reset();
  });

  test('a PocketBase SDK call is noted by collection, action, status and counts, and linked to the server log', () async {
    activity = ActivityRecorder(events.add, settings())..start();
    final pb = PocketBase(
      'https://pb.test',
      httpClientFactory: () => ReplayPocketBaseClient(server((request) => json({
            'page': 1,
            'perPage': 30,
            'totalItems': 2,
            'totalPages': 1,
            'items': [
              {'id': 'a1', 'collectionId': 'c', 'collectionName': 'posts', 'title': 'secret'},
              {'id': 'a2', 'collectionId': 'c', 'collectionName': 'posts', 'title': 'secret'},
            ],
          }, 200))),
    );
    final list = await pb.collection('posts').getList(filter: 'title = "secret"', sort: '-created');
    expect(list.items, hasLength(2), reason: 'the app gets its answer unchanged');
    final header = requests.single.headers['X-Replay-Request']!;
    expect(header, matches(RegExp(r'^[a-z0-9]{20}\.abcdefghij12345$')));
    final call = payloads(events, 'pbr/pocketbase').single;
    expect(call['request'], header.split('.').first);
    expect(call, containsPair('method', 'GET'));
    expect(call, containsPair('path', '/api/collections/posts/records'));
    expect(call, containsPair('collection', 'posts'));
    expect(call, containsPair('action', 'list'));
    expect(call, containsPair('status', 200));
    expect(call['items'], 2);
    expect(call['total'], 2);
    expect(call['page'], 1);
    expect(call['perPage'], 30);
    expect(call['linked'], true);
    expect(call['server'], true);
    expect(call['query'], containsPair('filter', true));
    expect(call['query'], containsPair('sort', '-created'));
    expect(call['duration'], isA<int>());
    expect(jsonEncode(call), isNot(contains('secret')));
    expect(requests.single.url.queryParameters.containsKey('__replayRequest'), isFalse,
        reason: 'request-log query markers are opt-in');
  });

  test('request tracing adds its marker only to this server and preserves repeated query values', () async {
    activity = ActivityRecorder(events.add, settings(trace: true))..start();
    final client = ReplayPocketBaseClient(server((request) => json({}, 200)));
    addTearDown(client.close);
    await client.get(Uri.parse('https://pb.test/api/collections/orders/records?expand=owner&expand=items&__replayRequest=old'));
    final sent = requests.single;
    expect(sent.url.queryParameters['__replayRequest'], sent.headers['X-Replay-Request']);
    expect(sent.url.queryParametersAll['expand'], ['owner', 'items']);
    expect(sent.url.queryParametersAll['__replayRequest'], hasLength(1));
    final note = payloads(events, 'pbr/pocketbase').single;
    expect(note['path'], '/api/collections/orders/records');
    expect(jsonEncode(note), isNot(contains('__replayRequest')));

    await client.get(Uri.parse('https://another.test/api/collections/orders/records'));
    await client.get(Uri.parse('https://pb.test/api/realtime'));
    await client.post(Uri.parse('https://pb.test/api/replay/chunks'));
    expect(requests.skip(1).every((request) => !request.url.queryParameters.containsKey('__replayRequest')), isTrue);
  });

  test('request tracing preserves multipart headers and files, stream bodies, settings and cancellation', () async {
    activity = ActivityRecorder(events.add, settings(trace: true))..start();
    final abort = Completer<void>();
    final bodies = <String>[];
    final outgoing = <http.BaseRequest>[];
    final client = ReplayPocketBaseClient(MockClient.streaming((request, stream) async {
      outgoing.add(request);
      bodies.add(await stream.bytesToString());
      expect(request.url.queryParameters['__replayRequest'], request.headers['X-Replay-Request']);
      expect(request.followRedirects, isFalse);
      expect(request.maxRedirects, 2);
      expect(request.persistentConnection, isFalse);
      return http.StreamedResponse(Stream.value(utf8.encode('{}')), 200, headers: {'content-type': 'application/json'});
    }));
    addTearDown(client.close);
    void configure(http.BaseRequest request) {
      request.followRedirects = false;
      request.maxRedirects = 2;
      request.persistentConnection = false;
    }

    final multipart = http.MultipartRequest('POST', Uri.parse('https://pb.test/api/collections/orders/records'))
      ..fields['title'] = 'multipart title'
      ..files.add(http.MultipartFile.fromString('file', 'original file bytes', filename: 'sample.txt'));
    configure(multipart);
    await http.Response.fromStream(await client.send(multipart));
    expect(outgoing[0].headers['content-type'], startsWith('multipart/form-data; boundary='));
    expect(outgoing[0].contentLength, utf8.encode(bodies[0]).length);
    expect(bodies[0], contains('multipart title'));
    expect(bodies[0], contains('original file bytes'));

    final streamed = http.StreamedRequest('POST', Uri.parse('https://pb.test/api/health'));
    configure(streamed);
    final sending = client.send(streamed);
    streamed.sink.add(utf8.encode('streamed bytes'));
    await streamed.sink.close();
    await http.Response.fromStream(await sending);
    expect(bodies[1], 'streamed bytes');

    final abortable = http.AbortableRequest('POST', Uri.parse('https://pb.test/api/health'), abortTrigger: abort.future)..body = 'abortable bytes';
    configure(abortable);
    await http.Response.fromStream(await client.send(abortable));
    expect((outgoing[2] as http.Abortable).abortTrigger, same(abort.future));
    expect(bodies[2], 'abortable bytes');
    abort.complete();
  });

  test('a refused SDK call omits echoed values in server and field messages while retaining field names and codes', () async {
    activity = ActivityRecorder(events.add, settings())..start();
    final pb = PocketBase('https://pb.test', httpClientFactory: () => ReplayPocketBaseClient(server((request) => json({
          'status': 400,
          'message': 'PIN 827461 refused',
          'data': {
            'total': {'code': 'validation_required', 'message': 'PIN 827461 refused'},
          },
        }, 400))));
    await expectLater(pb.collection('orders').create(body: {'total': '827461'}), throwsA(isA<ClientException>().having((error) => error.statusCode, 'status', 400)));
    final call = payloads(events, 'pbr/pocketbase').single;
    expect(call['action'], 'create');
    expect(call['status'], 400);
    expect(call.containsKey('message'), isFalse);
    expect(call['invalid'], [
      {'field': 'total', 'code': 'validation_required'},
    ]);
    expect(jsonEncode(call), isNot(contains('827461')));
  });

  test('a call that never got an answer has status 0, and the app still sees the failure', () async {
    activity = ActivityRecorder(events.add, settings())..start();
    final client = ReplayPocketBaseClient(MockClient((request) async => throw http.ClientException('Connection refused')));
    await expectLater(client.get(Uri.parse('https://pb.test/api/collections/posts/records/abc123')), throwsA(isA<http.ClientException>()));
    final call = payloads(events, 'pbr/pocketbase').single;
    expect(call, containsPair('status', 0));
    expect(call, containsPair('failed', 'error'));
    expect(call, containsPair('action', 'view'));
    expect(call, containsPair('record', 'abc123'));
  });

  test('a batch lists its calls and a subscription its collections', () async {
    activity = ActivityRecorder(events.add, settings())..start();
    final client = ReplayPocketBaseClient(server((request) => request.url.path == '/api/batch'
        ? json([
            {'status': 200, 'body': {}},
            {'status': 404, 'body': {}},
          ], 200)
        : http.Response('', 204)));
    await client.post(Uri.parse('https://pb.test/api/batch'), body: jsonEncode({
      'requests': [
        {'method': 'POST', 'url': '/api/collections/orders/records', 'body': {'total': 1}},
        {'method': 'DELETE', 'url': '/api/collections/orders/records/o1'},
      ],
    }));
    await client.post(Uri.parse('https://pb.test/api/realtime'), body: jsonEncode({'clientId': 'c1', 'subscriptions': ['orders/o1', 'posts']}));
    final calls = payloads(events, 'pbr/pocketbase');
    expect(calls.first['batch'], [
      {'method': 'POST', 'path': '/api/collections/orders/records', 'collection': 'orders', 'action': 'create', 'status': 200},
      {'method': 'DELETE', 'path': '/api/collections/orders/records/o1', 'collection': 'orders', 'action': 'delete', 'record': 'o1', 'status': 404},
    ]);
    expect(calls.last['topics'], ['orders', 'posts']);
    expect(calls.last['status'], 204);
  });

  test('the realtime stream, the replay API and other servers are never linked; nothing is noted while off', () async {
    activity = ActivityRecorder(events.add, settings())..start();
    final client = ReplayPocketBaseClient(server((request) => json({}, 200)));
    await client.get(Uri.parse('https://pb.test/api/realtime'));
    await client.post(Uri.parse('https://pb.test/api/replay/chunks'), body: '{}');
    expect(payloads(events, 'pbr/pocketbase'), isEmpty);
    expect(requests.map((request) => request.headers.containsKey('X-Replay-Request')), [false, false]);
    await client.get(Uri.parse('https://api.other.test/api/collections/posts/records'));
    final other = payloads(events, 'pbr/pocketbase').single;
    expect(other.containsKey('server'), isFalse);
    expect(other.containsKey('linked'), isFalse);
    expect(requests.last.headers.containsKey('X-Replay-Request'), isFalse);
    activity.stop();

    events.clear();
    requests.clear();
    activity = ActivityRecorder(events.add, settings(pocketbase: false))..start();
    await client.get(Uri.parse('https://pb.test/api/collections/posts/records'));
    expect(events, isEmpty);
    expect(requests.single.headers.containsKey('X-Replay-Request'), isFalse);
    activity.stop();
    await client.get(Uri.parse('https://pb.test/api/collections/posts/records'));
    expect(events, isEmpty);
  });

  test('a link carries only the request id between triggers', () async {
    activity = ActivityRecorder(events.add, settings(session: null))..start();
    final client = ReplayPocketBaseClient(server((request) => json({}, 200)));
    await client.get(Uri.parse('https://pb.test/api/collections/posts/records/abc'));
    expect(requests.single.headers['X-Replay-Request'], matches(RegExp(r'^[a-z0-9]{20}$')));
  });

  test('network rows keep the method, address without query, status and time, never the replay API', () async {
    activity = ActivityRecorder(events.add, settings(network: true))..start();
    final client = ReplayNetworkClient(server((request) => http.Response('ok', 201)));
    await client.post(Uri.parse('https://api.example.test/v1/orders?token=secret'), body: 'payload');
    await client.post(Uri.parse('https://pb.test/api/replay/logs'), body: '{}');
    final row = payloads(events, 'pbr/network').single;
    expect(row, {'kind': 'fetch', 'method': 'POST', 'url': 'https://api.example.test/v1/orders', 'status': 201, 'duration': row['duration']});
    activity.stop();
    events.clear();
    activity = ActivityRecorder(events.add, settings())..start();
    await client.get(Uri.parse('https://api.example.test/v1/orders'));
    expect(events, isEmpty, reason: 'Record network requests is off');
  });

  test(
      'sensitive words are removed from network paths, named routes and the snapshot address',
      () async {
    activity = ActivityRecorder(events.add, settings(network: true))..start();
    final client =
        ReplayNetworkClient(server((request) => http.Response('ok', 200)));
    addTearDown(client.close);
    await client.get(Uri.parse(
        'https://api.example.test/customer/W%6Fnderland?token=drop-me'));
    final observer = ReplayNavigatorObserver();
    observer.didPush(
        MaterialPageRoute<void>(
          settings:
              const RouteSettings(name: '/customer/Wonderland?token=drop-me'),
          builder: (_) => const SizedBox(),
        ),
        null);
    final uploaded = jsonEncode([for (final event in events) event.toJson()]);
    expect(uploaded, isNot(contains('Wonderland')));
    expect(uploaded, isNot(contains('W%6Fnderland')));
    expect(uploaded, isNot(contains('drop-me')));
    expect(payloads(events, 'pbr/network').single['url'],
        'https://api.example.test/customer/*');
    expect(payloads(events, 'pbr/navigation').single['url'],
        'flutter://app/customer/*');
    expect(ReplayNavigatorObserver.currentUrl, 'flutter://app/customer/*');
  });

  test('route privacy is applied before clipping long snapshot and activity addresses', () {
    activity = ActivityRecorder(events.add, settings())..start();
    final prefix = '/${'a' * (ActivityLimits.urlChars - screenOrigin.length - 5)}/';
    ReplayNavigatorObserver().didPush(MaterialPageRoute<void>(
      settings: RouteSettings(name: '${prefix}Wonderland/details'),
      builder: (_) => const SizedBox(),
    ), null);
    final recorded = payloads(events, 'pbr/navigation').single['url']! as String;
    expect(recorded.length, lessThanOrEqualTo(ActivityLimits.urlChars));
    expect(recorded, isNot(contains('Won')));
    expect(ReplayNavigatorObserver.currentUrl, recorded);
  });

  test(
      'a custom PocketBase route redacts private path text and email addresses',
      () async {
    activity = ActivityRecorder(events.add, settings())..start();
    final client = ReplayPocketBaseClient(server((request) => json({}, 200)));
    addTearDown(client.close);
    await client.get(Uri.parse(
        'https://pb.test/api/customer/W%6Fnderland/alice@example.test'));
    final call = payloads(events, 'pbr/pocketbase').single;
    expect(call['path'], '/api/customer/*/[redacted]');
    expect(jsonEncode(call), isNot(contains('Wonderland')));
    expect(jsonEncode(call), isNot(contains('alice@example.test')));
  });

  test('console output is redacted and capped per minute with one notice', () {
    final saved = debugPrint;
    debugPrint = (message, {wrapWidth}) {};
    addTearDown(() => debugPrint = saved);
    activity = ActivityRecorder(events.add, settings(console: true))..start();
    debugPrint('Paid by alice@example.test in Wonderland');
    for (var index = 0; index < 105; index++) {
      debugPrint('line $index');
    }
    final lines = payloads(events, 'pbr/console');
    expect(lines.first, {'level': 'log', 'text': 'Paid by [redacted] in [redacted]'});
    expect(lines, hasLength(101));
    expect(lines.last, {'level': 'warn', 'text': 'Replay skipped console messages: more than 100 in a minute'});
    activity.stop();
    events.clear();
    debugPrint('after stop');
    expect(events, isEmpty);
  });

  test('an uncaught error shows as console output, and the app\'s own handler still runs', () {
    final handled = <Object>[];
    final saved = FlutterError.onError;
    FlutterError.onError = (details) => handled.add(details.exception);
    activity = ActivityRecorder(events.add, settings(console: true))..start();
    FlutterError.reportError(FlutterErrorDetails(exception: StateError('stock for Wonderland ran out')));
    expect(payloads(events, 'pbr/console').single, {'level': 'error', 'text': 'Uncaught StateError: Bad state: stock for [redacted] ran out', 'uncaught': true});
    expect(handled, hasLength(1));
    activity.stop();
    ErrorHooks.reset();
    expect(FlutterError.onError, isNot(saved));
    FlutterError.onError = saved;
  });

  test('named page routes become page changes, without query; dialogs and unnamed routes do not', () {
    activity = ActivityRecorder(events.add, settings())..start();
    final observer = ReplayNavigatorObserver();
    final checkout = MaterialPageRoute<void>(builder: (_) => const SizedBox(), settings: const RouteSettings(name: '/checkout?coupon=SECRET'));
    observer.didPush(checkout, null);
    observer.didPush(RawDialogRoute<void>(pageBuilder: (context, animation, secondary) => const SizedBox()), checkout);
    observer.didPush(MaterialPageRoute<void>(builder: (_) => const SizedBox()), checkout);
    final cart = MaterialPageRoute<void>(builder: (_) => const SizedBox(), settings: const RouteSettings(name: 'cart'));
    observer.didPush(cart, checkout);
    observer.didPop(cart, checkout);
    expect(payloads(events, 'pbr/navigation').map((payload) => payload['url']),
        ['flutter://app/checkout', 'flutter://app/cart', 'flutter://app/checkout']);
    expect(ReplayNavigatorObserver.currentUrl, 'flutter://app/checkout');
  });
}
