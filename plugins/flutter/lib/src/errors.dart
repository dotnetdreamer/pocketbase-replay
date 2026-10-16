import 'dart:async';

import 'package:flutter/foundation.dart';

import 'privacy.dart';

final RegExp _vmFrame = RegExp(r'^#\d+\s+(.+?) \((.+)\)$');
final RegExp _typeName = RegExp(r'^_*([A-Za-z][A-Za-z0-9_$]*)(?:<.*>)?$');
const String _ownPackage = 'package:pocketbase_replay_flutter/';

/// A Dart stack trace in the shape the server groups by: `at function (file:line:column)`, as V8 writes it.
///
/// Dart VM frames such as `#0  Cart.pay (package:shop/cart.dart:12:5)` are rewritten. Web stacks are JavaScript
/// already, and the address-only lines of an obfuscated build are kept as they are.
String convertStack(String raw) {
  final lines = <String>[];
  for (final line in raw.split('\n')) {
    final text = line.trim();
    if (text.isEmpty || text == '<asynchronous suspension>') continue;
    final frame = _vmFrame.firstMatch(text);
    // A stack taken where the app called this package starts with the package's own frames, which are left out.
    if (lines.isEmpty && frame != null && frame[2]!.startsWith(_ownPackage)) continue;
    lines.add(frame == null ? line.trimRight() : '    at ${frame[1]} (${frame[2]})');
  }
  return lines.join('\n');
}

/// The name an error is grouped and shown by. Core error types are matched by type rather than by name, because a
/// web release build shortens type names.
String errorName(Object? error) {
  if (error == null || error is String) return 'Error';
  if (error is FlutterError) return 'FlutterError';
  if (error is TypeError) return 'TypeError';
  if (error is RangeError) return 'RangeError';
  if (error is ArgumentError) return 'ArgumentError';
  if (error is StateError) return 'StateError';
  if (error is UnimplementedError) return 'UnimplementedError';
  if (error is UnsupportedError) return 'UnsupportedError';
  if (error is ConcurrentModificationError) return 'ConcurrentModificationError';
  if (error is AssertionError) return 'AssertionError';
  if (error is NoSuchMethodError) return 'NoSuchMethodError';
  if (error is OutOfMemoryError) return 'OutOfMemoryError';
  if (error is StackOverflowError) return 'StackOverflowError';
  if (error is FormatException) return 'FormatException';
  if (error is TimeoutException) return 'TimeoutException';
  if (!(kIsWeb && kReleaseMode)) {
    final match = _typeName.firstMatch(error.runtimeType.toString());
    if (match != null) return match[1]!;
  }
  return error is Exception ? 'Exception' : 'Error';
}

/// The error's message without a repeat of its name, such as `Checkout failed` for `Exception('Checkout failed')`.
String errorMessage(Object? error, String name) {
  if (error is String) return error;
  // A framework error's first line says what happened; the rest is diagnostics such as the widget tree.
  if (error is FlutterError) {
    try {
      final summary = error.diagnostics.whereType<ErrorSummary>().firstOrNull?.toString();
      if (summary != null && summary.trim().isNotEmpty) return summary.trim();
      return error.message.split('\n').first;
    } catch (_) {
      // The full message follows.
    }
  }
  String text;
  try {
    text = error.toString();
  } catch (_) {
    return 'Unknown error';
  }
  for (final prefix in ['$name: ', 'Exception: ']) {
    if (text.startsWith(prefix) && text.length > prefix.length) return text.substring(prefix.length);
  }
  return text;
}

/// The name, message and converted stack of a thrown value, redacted.
({String name, String message, String? stack}) describeError(Object? error, StackTrace? stackTrace, List<String> sensitiveText) {
  final name = errorName(error);
  final message = errorMessage(error, name);
  StackTrace? stack = stackTrace;
  if (stack == null && error is Error) stack = error.stackTrace;
  final text = stack?.toString() ?? '';
  return (
    name: redactLabel(name, sensitiveText, 128),
    message: redactText(message.isEmpty ? name : message, sensitiveText),
    stack: text.trim().isEmpty ? null : redactText(convertStack(text), sensitiveText, 8000),
  );
}
