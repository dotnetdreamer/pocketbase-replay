import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

/// A non-2xx answer from the replay server.
class ReplayHttpException implements Exception {
  const ReplayHttpException(this.status);

  final int status;

  @override
  String toString() => 'ReplayHttpException($status)';
}

/// How replay and diagnostics reach the server.
///
/// [post] returns the decoded JSON answer and throws [ReplayHttpException] for a non-2xx status. Any other error
/// counts as a network failure, like 408, 429 and 5xx, so the session and queue are kept and the request retried.
abstract class ReplayTransport {
  Future<Object?> post(Uri url, String body);
}

/// The default transport: `package:http` with a `text/plain` body, which a browser sends without a CORS preflight.
class HttpReplayTransport implements ReplayTransport {
  HttpReplayTransport({http.Client? client, this.timeout = const Duration(seconds: 10)}) : _client = client ?? http.Client();

  final http.Client _client;
  final Duration timeout;

  @override
  Future<Object?> post(Uri url, String body) async {
    final response = await _client
        .post(url, headers: const {'Content-Type': 'text/plain;charset=UTF-8'}, body: body)
        .timeout(timeout);
    if (response.statusCode < 200 || response.statusCode >= 300) throw ReplayHttpException(response.statusCode);
    final text = response.body;
    return text.isEmpty ? null : jsonDecode(text);
  }

  void close() => _client.close();
}

int statusOf(Object? error) => error is ReplayHttpException ? error.status : 0;

/// No status, 408, 429 and 5xx are worth trying again; any other refusal is final.
bool retryable(int status) => status <= 0 || status == 408 || status == 429 || status >= 500;

Map<String, Object?> answerOf(Object? value) => value is Map<String, Object?> ? value : const {};
