import 'dart:convert';

// The same rules as the web client's observability-privacy.ts, so an entry reads the same from either.
final RegExp _privateKey = RegExp(r'password|passwd|secret|token|authorization|cookie|email|phone|credit.?card|api.?key', caseSensitive: false);
final RegExp _url = RegExp(r'''(?:https?|wss?)://[^\s<>"')]+''', caseSensitive: false);
final RegExp _bearer = RegExp(r'\bBearer\s+[^\s,;]+', caseSensitive: false);
final RegExp _jwt = RegExp(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b');
final RegExp _token = RegExp(r'\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b');
final RegExp _email = RegExp(r'\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,24}\b', caseSensitive: false);
final RegExp _assignment = RegExp(
  r'''\b(password|passwd|secret|token|authorization|cookie|api[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)''',
  caseSensitive: false,
);
final RegExp _control = RegExp(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]');
final RegExp _anyControl = RegExp(r'[\x00-\x1f\x7f]');

const int maxTextChars = 2000;

/// Cuts [value] to at most [limit] UTF-16 units without leaving half of a surrogate pair at the end.
String clip(String value, int limit) {
  if (value.length <= limit) return value;
  var end = limit;
  if (end > 0) {
    final last = value.codeUnitAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  return value.substring(0, end);
}

String _withoutQuery(String match) {
  final uri = Uri.tryParse(match);
  if (uri == null || uri.host.isEmpty) return '[redacted URL]';
  return Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null, path: uri.path).toString();
}

/// Removes credentials, email addresses, URL queries and the app's own [sensitiveText] from free text.
String redactText(String value, [List<String> sensitiveText = const [], int limit = maxTextChars]) {
  var text = clip(value, limit * 2 > 8000 ? limit * 2 : 8000);
  text = text
      .replaceAllMapped(_url, (match) => _withoutQuery(match[0]!))
      .replaceAll(_bearer, 'Bearer [redacted]')
      .replaceAll(_jwt, '[redacted]')
      .replaceAll(_token, '[redacted]')
      .replaceAll(_email, '[redacted]')
      .replaceAllMapped(_assignment, (match) => '${match[1]}=[redacted]');
  for (final secret in sensitiveText.take(100)) {
    if (secret.length < 2) continue;
    text = text.replaceAll(RegExp(RegExp.escape(clip(secret, 2000)), caseSensitive: false), '[redacted]');
  }
  return clip(text.replaceAll(_control, ''), limit);
}

/// A one-line label such as an error name or service, redacted like [redactText].
String redactLabel(String value, [List<String> sensitiveText = const [], int limit = 128]) =>
    redactText(value, sensitiveText, limit).replaceAll(_anyControl, '');

/// Replaces each occurrence of [sensitiveText] with `*`, as the recorder masks text on screen.
String maskSensitive(String value, List<String> sensitiveText) {
  var text = value;
  for (final secret in sensitiveText.take(100)) {
    if (secret.length < 2) continue;
    text = text.replaceAll(RegExp(RegExp.escape(clip(secret, 2000)), caseSensitive: false), '*');
  }
  return text;
}

/// A JSON-safe copy of [input] for attributes: bounded depth, size and string length, with private keys redacted.
Object? safeValue(Object? input, [List<String> sensitiveText = const []]) {
  var budget = 100;
  final seen = Set<Object>.identity();
  Object? visit(Object? value, int depth) {
    if (--budget < 0) return '[truncated]';
    if (value == null || value is bool) return value;
    if (value is String) return redactText(value, sensitiveText, 1024);
    if (value is num) return value.isFinite ? value : value.toString();
    if (value is DateTime) return value.toIso8601String();
    if (value is Enum) return value.name;
    if (seen.contains(value)) return '[circular]';
    if (depth >= 4) return '[truncated]';
    seen.add(value);
    try {
      if (value is Map) {
        final output = <String, Object?>{};
        for (final key in value.keys.take(20)) {
          final name = redactLabel(key.toString(), sensitiveText, 64);
          if (name.isEmpty || name == '__proto__' || name == 'constructor' || name == 'prototype') continue;
          output[name] = _privateKey.hasMatch(key.toString()) ? '[redacted]' : visit(value[key], depth + 1);
        }
        return output;
      }
      if (value is Iterable) return value.take(20).map((item) => visit(item, depth + 1)).toList();
      return redactText(value.toString(), sensitiveText, 1024);
    } catch (_) {
      return '[unserializable]';
    } finally {
      seen.remove(value);
    }
  }

  return visit(input, 0);
}

int byteLength(String value) => utf8.encode(value).length;

/// Attributes as the server accepts them: an object of at most 4 KiB, dropping its last keys until it fits.
Map<String, Object?>? safeAttributes(Map<String, Object?>? value, [List<String> sensitiveText = const []]) {
  if (value == null) return null;
  final output = safeValue(value, sensitiveText);
  if (output is! Map<String, Object?>) return null;
  final keys = output.keys.toList();
  while (keys.isNotEmpty && byteLength(jsonEncode(output)) > 4096) {
    output.remove(keys.removeLast());
  }
  return output;
}

/// A recorded address: without user info, query or fragment, with tokens and [sensitiveText] masked.
String cleanUrl(String value, [List<String> sensitiveText = const []]) {
  final text = value.trim();
  if (RegExp(r'^(?:data|blob|javascript):', caseSensitive: false)
      .hasMatch(text)) {
    return RegExp(r'^[a-z][a-z0-9+.-]*:', caseSensitive: false)
            .firstMatch(text)?[0] ??
        '';
  }
  final noQuery = text.split(RegExp(r'[?#]')).first;
  var cleaned = noQuery
      .replaceAllMapped(RegExp(r'(https?://)[^/@]+@', caseSensitive: false),
          (match) => match[1]!)
      .replaceAll(
          RegExp(r'[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}'),
          '[masked]');
  // Decode only the path, after removing the original query/fragment. Match across path separators too: a secret
  // such as alice/smith must remain private when an ordinary letter is percent-encoded in either segment.
  final prefix = RegExp(r'^[a-z][a-z0-9+.-]*://[^/]*', caseSensitive: false).firstMatch(cleaned)?[0] ?? '';
  final path = cleaned.substring(prefix.length);
  final decoded = path.split('/').map((part) {
    try {
      return Uri.decodeComponent(part);
    } catch (_) {
      return part;
    }
  }).join('/');
  final redacted = maskSensitive(decoded, sensitiveText);
  if (redacted != decoded) {
    // Escaped question marks and fragments remain path text, never decoded query/fragment data in the output.
    cleaned = prefix + Uri(path: redacted).toString();
  }
  // Also cover non-encoded secrets in an address's scheme or host.
  return maskSensitive(cleaned, sensitiveText).replaceAll(_anyControl, '');
}
