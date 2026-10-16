import '../privacy.dart';

// How a call through the app's PocketBase client is recorded: how PocketBase routes it and how it ended, never the
// values sent or returned. These are the web client's rules in src/pocketbase.ts, which the server shares.
abstract final class PocketBaseLimits {
  static const int pathChars = 300;
  static const int messageChars = 500;
  static const int fieldMessageChars = 200;
  static const int fields = 20;
  static const int batch = 50;
  static const int topics = 20;
  static const int queryChars = 200;
}

/// The header that lets the replay server find a call in PocketBase's request log.
const String linkHeader = 'X-Replay-Request';

const Set<String> _authActions = {
  'auth-methods', 'auth-refresh', 'auth-with-password', 'auth-with-oauth2', 'auth-with-otp', 'request-otp',
  'request-password-reset', 'confirm-password-reset', 'request-verification', 'confirm-verification',
  'request-email-change', 'confirm-email-change',
};
final RegExp _collection = RegExp(r'^[A-Za-z0-9_]{1,100}$');
final RegExp _record = RegExp(r'^[A-Za-z0-9_-]{1,128}$');
final RegExp _field = RegExp(r'^[A-Za-z0-9_.-]{1,64}$');
final RegExp _code = RegExp(r'^[A-Za-z0-9_.-]{1,64}$');
// Field names, sort keys and modifiers such as excerpt(200,true); anything else may hold a value and is left out.
final RegExp _identifiers = RegExp(r'^[A-Za-z0-9_.,:@()+\- ]+$');
final RegExp _session = RegExp(r'^[a-z0-9]{15}$');
// Fixed PocketBase responses support explanations without retaining arbitrary server text, which can echo values.
const Set<String> _safeMessages = {
  'Failed to create record.',
  'Failed to update record.',
  'Failed to delete record.',
  "The requested resource wasn't found.",
  'Only superusers can perform this action.',
  'Something went wrong while processing your request.',
  'Failed to authenticate.',
  'Missing or invalid authentication.',
};


class PocketBaseCall {
  const PocketBaseCall(this.method, this.path, {this.collection, this.action, this.record});

  final String method;
  final String path;
  final String? collection;
  final String? action;
  final String? record;

  Map<String, Object?> toJson() => {
        'method': method,
        'path': path,
        if (collection != null) 'collection': collection,
        if (action != null) 'action': action,
        if (record != null) 'record': record,
      };
}

String _decode(String part) {
  try {
    return Uri.decodeComponent(part);
  } catch (_) {
    return part;
  }
}

// A whole number of at least zero, as JSON gives it; anything else counts as absent.
int? _count(Object? value) {
  if (value is int) return value >= 0 ? value : null;
  if (value is double && value.isFinite && value >= 0 && value == value.truncateToDouble()) return value.toInt();
  return null;
}

String methodOf(Object? value) {
  final text = value is String ? value.trim().toUpperCase().replaceAll(RegExp('[^A-Z]'), '') : '';
  return text.isEmpty ? 'GET' : clip(text, 10);
}

/// The path PocketBase routes, without query or fragment, and the collection, action and record it names.
PocketBaseCall describeCall(Object? method, Object? path) {
  final verb = methodOf(method);
  var clean = path is String ? path.split(RegExp('[?#]')).first.replaceAll(RegExp(r'[\x00-\x1f\x7f]'), '') : '';
  if (!clean.startsWith('/')) clean = '/$clean';
  clean = clip(clean, PocketBaseLimits.pathChars);
  final parts = clean.split('/').skip(1).map(_decode).toList();
  if (parts.isEmpty || parts[0] != 'api') return PocketBaseCall(verb, clean);
  if (parts.length == 2 && parts[1] == 'batch' && verb == 'POST') return PocketBaseCall(verb, clean, action: 'batch');
  if (parts.length == 2 && parts[1] == 'realtime' && verb == 'POST') return PocketBaseCall(verb, clean, action: 'realtime');
  if (parts.length == 3 && parts[1] == 'files' && parts[2] == 'token' && verb == 'POST') {
    return PocketBaseCall(verb, clean, action: 'file-token');
  }
  if (parts.length < 3 || parts[1] != 'collections' || !_collection.hasMatch(parts[2])) return PocketBaseCall(verb, clean);
  final collection = parts[2];
  final rest = parts.sublist(3);
  if (rest.length == 1 && rest[0] == 'records') {
    final action = verb == 'GET' ? 'list' : verb == 'POST' ? 'create' : null;
    return PocketBaseCall(verb, clean, collection: collection, action: action);
  }
  if (rest.length == 2 && rest[0] == 'records' && _record.hasMatch(rest[1])) {
    final action = verb == 'GET' ? 'view' : verb == 'PATCH' ? 'update' : verb == 'DELETE' ? 'delete' : null;
    return PocketBaseCall(verb, clean, collection: collection, action: action, record: rest[1]);
  }
  if (rest.length == 1 && _authActions.contains(rest[0])) return PocketBaseCall(verb, clean, collection: collection, action: rest[0]);
  if (rest.length == 2 && rest[0] == 'impersonate' && _record.hasMatch(rest[1]) && verb == 'POST') {
    return PocketBaseCall(verb, clean, collection: collection, action: 'impersonate', record: rest[1]);
  }
  return PocketBaseCall(verb, clean, collection: collection);
}

/// Whether a filter was used, and the field names a list sorted, expanded or picked. A filter's text holds values.
Map<String, Object?>? describeQuery(Map<String, String> query) {
  final result = <String, Object?>{};
  final filter = query['filter'];
  if (filter != null && filter.trim().isNotEmpty) result['filter'] = true;
  for (final key in const ['sort', 'expand', 'fields']) {
    final text = query[key]?.trim() ?? '';
    if (text.isEmpty) continue;
    if (text.length <= PocketBaseLimits.queryChars && _identifiers.hasMatch(text)) {
      result[key] = text;
    } else {
      result['unreadable'] = true;
    }
  }
  final skip = query['skipTotal'];
  if (skip == '1' || skip == 'true') result['skipTotal'] = true;
  return result.isEmpty ? null : result;
}

Object? _read(Object? owner, String key) => owner is Map ? owner[key] : null;

/// Counts from a successful answer: a list's items and total, or the id a record call returned.
Map<String, Object?> describeResult(PocketBaseCall call, Object? data) {
  final result = <String, Object?>{};
  if (call.action == 'list') {
    final items = _read(data, 'items');
    if (items is List) result['items'] = items.length;
    final total = _count(_read(data, 'totalItems'));
    if (total != null) result['total'] = total;
    final page = _count(_read(data, 'page')), perPage = _count(_read(data, 'perPage'));
    if (page != null && page > 0) result['page'] = page;
    if (perPage != null && perPage > 0) result['perPage'] = perPage;
  } else if (call.action == 'create' || call.action == 'view' || call.action == 'update') {
    final id = _read(data, 'id');
    if (id is String && _record.hasMatch(id)) result['record'] = id;
  } else if (call.collection != null && call.action != null && RegExp(r'^auth-(?:with|refresh)').hasMatch(call.action!)) {
    // Only who signed in; the token in the same answer is never read.
    final id = _read(_read(data, 'record'), 'id');
    if (id is String && _record.hasMatch(id)) result['record'] = id;
  }
  return result;
}

/// How a call failed: its status, a fixed PocketBase response, and refused field names and codes. Arbitrary error
/// messages can repeat rejected values, so neither custom top-level messages nor field messages are retained.
Map<String, Object?> describeFailure(int status, Object? answer, List<String> sensitiveText) {
  final outcome = <String, Object?>{'status': status};
  final message = _read(answer, 'message');
  if (message is String && _safeMessages.contains(message.trim())) {
    outcome['message'] = redactText(message.trim(), sensitiveText, PocketBaseLimits.messageChars);
  }
  final fields = _read(answer, 'data');
  final invalid = <Map<String, Object?>>[];
  if (fields is Map) {
    for (final entry in fields.entries) {
      if (invalid.length >= PocketBaseLimits.fields) break;
      final field = entry.key, detail = entry.value;
      final code = _read(detail, 'code');
      if (field is! String || !_field.hasMatch(field) || code is! String || !_code.hasMatch(code)) continue;
      invalid.add({
        'field': field,
        'code': code,
      });
    }
  }
  if (invalid.isNotEmpty) outcome['invalid'] = invalid;
  return outcome;
}

/// The calls inside a batch, by method and path only, with the status each got; their bodies stay unread.
List<Map<String, Object?>> describeBatch(Object? body, Object? answers) {
  final requests = _read(body, 'requests');
  if (requests is! List) return const [];
  final statuses = answers is List ? answers : const [];
  final result = <Map<String, Object?>>[];
  for (var index = 0; index < requests.length && index < PocketBaseLimits.batch; index++) {
    final item = requests[index];
    result.add({
      ...describeCall(_read(item, 'method'), _read(item, 'url')).toJson(),
      'status': _count(_read(index < statuses.length ? statuses[index] : null, 'status')) ?? 0,
    });
  }
  return result;
}

/// The collections a realtime subscription listens to; record ids and options after them are left out.
List<String> describeTopics(Object? body) {
  final subscriptions = _read(body, 'subscriptions');
  if (subscriptions is! List) return const [];
  final topics = <String>{};
  for (final topic in subscriptions) {
    final collection = topic is String ? topic.split(RegExp('[/?]')).first : '';
    if (_collection.hasMatch(collection)) topics.add(collection);
    if (topics.length >= PocketBaseLimits.topics) break;
  }
  return topics.toList();
}

String linkValue(String id, String? session) => session != null && _session.hasMatch(session) ? '$id.$session' : id;

/// The scheme, host and port of an http(s) address, or an empty string.
String originOf(Uri? url) {
  if (url == null || !(url.scheme == 'http' || url.scheme == 'https') || url.host.isEmpty) return '';
  try {
    return url.origin;
  } catch (_) {
    return '';
  }
}
