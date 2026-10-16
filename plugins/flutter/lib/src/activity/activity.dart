import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../engine.dart';
import '../errors.dart';
import '../events.dart';
import '../hooks.dart';
import '../privacy.dart';
import '../runtime.dart';
import 'pocketbase_rules.dart';

// Each kind has its own allowance per window, so a chatty console cannot crowd out network requests.
abstract final class ActivityLimits {
  static const int windowMs = 60000;
  static const int network = 100;
  static const int console = 100;
  static const int navigation = 50;
  static const int pocketbase = 150;
  static const int textChars = 1000;
  static const int urlChars = 2048;
  static const int linkRetryMs = 5 * 60 * 1000;
  // A PocketBase answer larger than this is passed on without being read for its counts.
  static const int answerBytes = 2 * 1024 * 1024;
}

enum ActivityKind { network, console, navigation, pocketbase }

const Map<ActivityKind, String> _skipped = {
  ActivityKind.network: 'network requests',
  ActivityKind.console: 'console messages',
  ActivityKind.navigation: 'page changes',
  ActivityKind.pocketbase: 'PocketBase calls',
};

const Map<ActivityKind, int> _allowance = {
  ActivityKind.network: ActivityLimits.network,
  ActivityKind.console: ActivityLimits.console,
  ActivityKind.navigation: ActivityLimits.navigation,
  ActivityKind.pocketbase: ActivityLimits.pocketbase,
};

// The replay and diagnostics clients post under this path. Recording those requests would feed the upload back into
// itself; the rest of the server is often the app's own PocketBase API, which is worth seeing.
const String replayApi = '/api/replay';

/// The address a screen is recorded under: route names are paths on this origin.
const String screenOrigin = 'flutter://app';

class _Budget {
  int start = 0;
  int count = 0;
  bool noticed = false;
}

enum _LinkState { pending, ok, failed }

class _LinkCheck {
  _LinkCheck(this.state, this.at);

  final _LinkState state;
  final int at;
}

int _clock() => DateTime.now().millisecondsSinceEpoch;

/// Activity notes the viewer lists beside the recording, emitted while a recorder runs: network requests, console
/// output, page changes and PocketBase calls, in the web client's `pbr/*` event formats.
class ActivityRecorder {
  ActivityRecorder(this._emit, this.settings) : _endpoint = Uri.tryParse(settings.endpoint);

  /// The recorder's activity while one runs, which the HTTP clients and the navigator observer write to.
  static ActivityRecorder? current;

  // Whether a replay server on another origin lets the link header through CORS and any proxy, learned once per page.
  static final Map<String, _LinkCheck> _linkChecks = {};

  final void Function(ReplayEvent event) _emit;
  final RecorderSettings settings;
  final Uri? _endpoint;
  final Map<ActivityKind, _Budget> _budgets = {for (final kind in ActivityKind.values) kind: _Budget()};
  final List<void Function()> _cleanup = [];
  bool _active = true;
  // Set while an event is built and handed over, so a print made by the engine or a callback is not captured again.
  bool _busy = false;

  /// Starts the parts the server asked for, and makes this the [current] activity.
  void start() {
    current = this;
    if (settings.recordConsole) {
      _cleanup.add(PrintHooks.subscribe((line) => console('log', line)));
      _cleanup.add(ErrorHooks.subscribe((error, stack, attributes) {
        final described = describeError(error, null, privateText());
        console('error', 'Uncaught ${described.name}: ${described.message}', uncaught: true);
      }));
    }
  }

  void stop() {
    if (!_active) return;
    _active = false;
    if (identical(current, this)) current = null;
    for (final cleanup in _cleanup.reversed) {
      try {
        cleanup();
      } catch (_) {
        // Cleanup must not reach the app.
      }
    }
    _cleanup.clear();
  }

  List<String> privateText() {
    try {
      return settings.sensitiveText();
    } catch (_) {
      return const [];
    }
  }

  void _send(String tag, Map<String, Object?> payload, int timestamp) {
    try {
      _emit(customEvent(tag, payload, timestamp));
    } catch (_) {
      // The engine counts its own failures.
    }
  }

  // One notice when a kind starts dropping, then nothing more of that kind until its window ends.
  bool _allowed(ActivityKind kind, int now) {
    final budget = _budgets[kind]!;
    if (now - budget.start >= ActivityLimits.windowMs || now < budget.start) {
      budget
        ..start = now
        ..count = 0
        ..noticed = false;
    }
    final allowance = _allowance[kind]!;
    if (budget.count < allowance) {
      budget.count++;
      return true;
    }
    if (!budget.noticed) {
      budget.noticed = true;
      _send('pbr/console', {'level': 'warn', 'text': 'Replay skipped ${_skipped[kind]}: more than $allowance in a minute'}, now);
    }
    return false;
  }

  // The allowance is checked before the payload is built, so dropped entries are never formatted.
  void _capture(ActivityKind kind, String tag, Map<String, Object?> Function() build) {
    if (!_active || _busy) return;
    _busy = true;
    try {
      final now = _clock();
      if (_allowed(kind, now)) _send(tag, build(), now);
    } catch (_) {
      // Capture must never reach the app.
    } finally {
      _busy = false;
    }
  }

  /// A console line, redacted, as `pbr/console`.
  void console(String level, String text, {bool uncaught = false}) {
    if (!settings.recordConsole) return;
    _capture(ActivityKind.console, 'pbr/console', () => {
          'level': level,
          'text': redactText(text, privateText(), ActivityLimits.textChars),
          if (uncaught) 'uncaught': true,
        });
  }

  /// A screen change, as `pbr/navigation`.
  void navigation(String url) {
    _capture(ActivityKind.navigation, 'pbr/navigation', () => {'url': cleanUrl(url, privateText())});
  }

  bool ownRequest(Uri url) {
    final endpoint = _endpoint;
    if (endpoint == null || endpoint.host.isEmpty) return false;
    final base = settings.endpoint.replaceAll(RegExp(r'/+$'), '');
    final text = url.toString();
    return text == '$base$replayApi' || text.startsWith('$base$replayApi/') || text.startsWith('$base$replayApi?');
  }

  /// A finished request through [ReplayNetworkClient], as `pbr/network`.
  void network(String method, Uri url, int status, int duration, {String? failed}) {
    if (!settings.recordNetwork || ownRequest(url)) return;
    _capture(ActivityKind.network, 'pbr/network', () => {
          'kind': 'fetch',
          'method': clip(method.trim().toUpperCase().replaceAll(RegExp('[^A-Z0-9_-]'), ''), 16),
          'url': clip(cleanUrl(url.toString(), privateText()), ActivityLimits.urlChars),
          'status': status > 0 ? status : 0,
          'duration': duration < 0 ? 0 : duration,
          if (failed != null) 'failed': failed,
        });
  }

  /// A finished PocketBase call, as `pbr/pocketbase`.
  void pocketbase(Map<String, Object?> Function() build) {
    if (!settings.recordPocketbase) return;
    _capture(ActivityKind.pocketbase, 'pbr/pocketbase', build);
  }

  // A call to the replay endpoint's own server can be explained by it later.
  bool sameServer(Uri url) {
    final replay = originOf(_endpoint);
    return replay.isNotEmpty && originOf(url) == replay;
  }

  // Native apps have no CORS, so the header always reaches the server. A web page on another origin than the replay
  // server sends one test request first, so a proxy that refuses unknown headers can never make the app's calls fail.
  bool linkReady() {
    if (!kIsWeb) return true;
    final replay = originOf(_endpoint);
    String page;
    try {
      page = originOf(Uri.base);
    } catch (_) {
      page = '';
    }
    if (replay.isEmpty || replay == page) return true;
    final check = _linkChecks[replay];
    final now = _clock();
    if (check?.state == _LinkState.ok) return true;
    if (check != null && (check.state == _LinkState.pending || now - check.at < ActivityLimits.linkRetryMs)) return false;
    _linkChecks[replay] = _LinkCheck(_LinkState.pending, now);
    final client = http.Client();
    final base = settings.endpoint.replaceAll(RegExp(r'/+$'), '');
    unawaited(client
        .get(Uri.parse('$base$replayApi/link'), headers: const {linkHeader: 'check'})
        .then((_) => _linkChecks[replay] = _LinkCheck(_LinkState.ok, _clock()),
            onError: (Object _) => _linkChecks[replay] = _LinkCheck(_LinkState.failed, _clock()))
        .whenComplete(client.close));
    return false;
  }
}

/// An `http.Client` whose requests are listed as network rows in the recording, while the server's **Record network
/// requests** setting is on: method, address without its query, status and time, never headers or bodies.
class ReplayNetworkClient extends http.BaseClient {
  ReplayNetworkClient([http.Client? inner]) : _inner = inner ?? http.Client();

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final activity = ActivityRecorder.current;
    if (activity == null || !activity.settings.recordNetwork) return _inner.send(request);
    final watch = Stopwatch()..start();
    try {
      final response = await _inner.send(request);
      activity.network(request.method, request.url, response.statusCode, watch.elapsedMilliseconds);
      return response;
    } catch (error) {
      activity.network(request.method, request.url, 0, watch.elapsedMilliseconds, failed: _failure(error));
      rethrow;
    }
  }

  @override
  void close() => _inner.close();
}

String _failure(Object error) {
  if (error is TimeoutException) return 'timeout';
  String text;
  try {
    text = error.toString().toLowerCase();
  } catch (_) {
    text = '';
  }
  return text.contains('abort') ? 'abort' : 'error';
}

Object? _decodeJson(String text) {
  try {
    return text.isEmpty ? null : jsonDecode(text);
  } catch (_) {
    return null;
  }
}

/// An `http.Client` for the PocketBase Dart SDK. While recording, and while the server records PocketBase calls,
/// each call is noted with its collection, action, status and counts, never the values sent or returned:
///
/// ```dart
/// final pb = PocketBase('https://api.example.com', httpClientFactory: ReplayPocketBaseClient.new);
/// ```
///
/// When the SDK talks to the replay server's own PocketBase, each call also carries an `X-Replay-Request` header, so
/// the dashboard can show why PocketBase refused it.
class ReplayPocketBaseClient extends http.BaseClient {
  ReplayPocketBaseClient([http.Client? inner]) : _inner = inner ?? http.Client();

  final http.Client _inner;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final activity = ActivityRecorder.current;
    if (activity == null || !activity.settings.recordPocketbase) return _inner.send(request);
    _Call? call;
    try {
      call = _Call.prepare(activity, request);
    } catch (_) {
      call = null;
    }
    if (call == null) return _inner.send(request);
    var outgoing = request;
    if (call.linked && activity.settings.tracePocketbaseRequests) {
      try {
        outgoing = _TracedRequest(request, request.url.replace(queryParameters: {
          ...request.url.queryParametersAll,
          '__replayRequest': request.headers[linkHeader]!,
        }));
      } catch (_) {
        // Optional tracing cannot interrupt the app's request.
      }
    }
    http.StreamedResponse response;
    try {
      response = await _inner.send(outgoing);
    } catch (error) {
      call.finish(0, null, failed: _failure(error));
      rethrow;
    }
    return call.observe(response);
  }

  @override
  void close() => _inner.close();
}

// BaseRequest URLs are immutable. Forward the original request rather than rebuilding its body, so multipart
// boundaries, streamed uploads, redirect settings and cancellation keep working with the opt-in trace marker.
class _TracedRequest extends http.BaseRequest implements http.Abortable {
  _TracedRequest(this._inner, Uri url) : super(_inner.method, url);

  final http.BaseRequest _inner;

  @override
  Map<String, String> get headers => _inner.headers;

  @override
  int? get contentLength => _inner.contentLength;
  @override
  set contentLength(int? value) => _inner.contentLength = value;

  @override
  bool get persistentConnection => _inner.persistentConnection;
  @override
  set persistentConnection(bool value) => _inner.persistentConnection = value;

  @override
  bool get followRedirects => _inner.followRedirects;
  @override
  set followRedirects(bool value) => _inner.followRedirects = value;

  @override
  int get maxRedirects => _inner.maxRedirects;
  @override
  set maxRedirects(int value) => _inner.maxRedirects = value;

  @override
  Future<void>? get abortTrigger {
    final inner = _inner;
    return inner is http.Abortable ? inner.abortTrigger : null;
  }

  @override
  http.ByteStream finalize() {
    super.finalize();
    return _inner.finalize();
  }
}

class _Call {
  _Call(this.activity, this.call, this.id, this.server, this.linked, this.query, this.body);

  final ActivityRecorder activity;
  final PocketBaseCall call;
  final String id;
  final bool server;
  final bool linked;
  final Map<String, Object?>? query;
  final Object? body;
  final Stopwatch watch = Stopwatch()..start();
  bool done = false;

  static _Call? prepare(ActivityRecorder activity, http.BaseRequest request) {
    final call = describeCall(request.method, request.url.path);
    if (call.path == replayApi || call.path.startsWith('$replayApi/')) return null;
    // The realtime connection stays open for as long as the app listens; only its subscription changes are calls.
    if (call.method == 'GET' && call.path == '/api/realtime') return null;
    final server = activity.sameServer(request.url);
    final id = requestId();
    var linked = false;
    if (server && activity.linkReady()) {
      try {
        request.headers[linkHeader] = linkValue(id, activity.settings.replaySession());
        linked = true;
      } catch (_) {
        // A request that cannot take the header is sent without it.
      }
    }
    Object? body;
    if (call.action == 'batch' || call.action == 'realtime') {
      // A batch with files travels as form data around the same JSON.
      final text = request is http.Request
          ? request.body
          : request is http.MultipartRequest
              ? request.fields['@jsonPayload'] ?? ''
              : '';
      body = _decodeJson(text);
    }
    return _Call(activity, call, id, server, linked, describeQuery(request.url.queryParameters), body);
  }

  // The SDK reads each answer whole, so the copy taken on the way is read for its counts once the answer ends.
  http.StreamedResponse observe(http.StreamedResponse response) {
    final status = response.statusCode;
    final type = response.headers['content-type'] ?? '';
    final readable = type.contains('json') && (response.contentLength ?? 0) <= ActivityLimits.answerBytes;
    final copy = <int>[];
    var overflow = false;
    final stream = response.stream.transform(StreamTransformer<List<int>, List<int>>.fromHandlers(
      handleData: (data, sink) {
        if (readable && !overflow) {
          if (copy.length + data.length > ActivityLimits.answerBytes) {
            overflow = true;
            copy.clear();
          } else {
            copy.addAll(data);
          }
        }
        sink.add(data);
      },
      handleError: (error, stack, sink) {
        finish(status, null, failed: _failure(error));
        sink.addError(error, stack);
      },
      handleDone: (sink) {
        Object? answer;
        if (readable && !overflow) {
          try {
            answer = _decodeJson(utf8.decode(copy, allowMalformed: true));
          } catch (_) {
            answer = null;
          }
        }
        finish(status, answer);
        sink.close();
      },
    ));
    return http.StreamedResponse(
      stream,
      status,
      contentLength: response.contentLength,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  void finish(int status, Object? answer, {String? failed}) {
    if (done) return;
    done = true;
    final duration = watch.elapsedMilliseconds;
    activity.pocketbase(() {
      final ok = failed == null && status > 0 && status < 400;
      final result = ok ? describeResult(call, answer) : const <String, Object?>{};
      final outcome = !ok && status > 0 ? describeFailure(status, answer, activity.privateText()) : const <String, Object?>{};
      final record = call.record ?? result['record'];
      final payload = <String, Object?>{
        'request': id,
        'method': call.method,
        'path': redactLabel(cleanUrl(call.path, activity.privateText()), activity.privateText(), PocketBaseLimits.pathChars),
        if (call.collection != null) 'collection': call.collection,
        if (call.action != null) 'action': call.action,
        if (record != null) 'record': record,
        'status': status > 0 ? status : 0,
        'duration': duration,
        if (failed != null && status <= 0) 'failed': failed == 'abort' ? 'abort' : 'error',
        if (linked) 'linked': true,
        if (server) 'server': true,
        for (final key in const ['items', 'total', 'page', 'perPage'])
          if (result[key] != null) key: result[key],
        if (query != null) 'query': query,
        if (outcome['message'] != null) 'message': outcome['message'],
        if (outcome['invalid'] != null) 'invalid': outcome['invalid'],
      };
      if (call.action == 'batch') {
        final batch = describeBatch(body, ok ? answer : null);
        if (batch.isNotEmpty) {
          final text = activity.privateText();
          for (final item in batch) {
            item['path'] = redactLabel(cleanUrl(item['path']! as String, text), text, PocketBaseLimits.pathChars);
          }
          payload['batch'] = batch;
        }
      }
      if (call.action == 'realtime') {
        final topics = describeTopics(body);
        if (topics.isNotEmpty) payload['topics'] = topics;
      }
      return payload;
    });
  }
}
