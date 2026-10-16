import 'dart:async';
import 'dart:math';

/// Time and timers for the upload engines, replaced by a manual clock in tests.
class ReplayRuntime {
  const ReplayRuntime({required this.now, required this.schedule, required this.cancel});

  /// The wall clock in Unix milliseconds, as recordings and the server use it.
  final int Function() now;
  final Object Function(Duration delay, void Function() callback) schedule;
  final void Function(Object? timer) cancel;

  static final ReplayRuntime system = ReplayRuntime(
    now: () => DateTime.now().millisecondsSinceEpoch,
    schedule: (delay, callback) => Timer(delay, callback),
    cancel: (timer) {
      if (timer is Timer) timer.cancel();
    },
  );
}

final Random _random = () {
  try {
    return Random.secure();
  } catch (_) {
    return Random();
  }
}();

const String _idChars = 'abcdefghijklmnopqrstuvwxyz0123456789';

/// The id a PocketBase call carries in its link header: 20 lowercase letters and digits, as the server expects.
String requestId() {
  final buffer = StringBuffer();
  for (var index = 0; index < 20; index++) {
    buffer.write(_idChars[_random.nextInt(_idChars.length)]);
  }
  return buffer.toString();
}

/// A random version 4 UUID, used as a diagnostics entry id.
String eventId() {
  final bytes = List<int>.generate(16, (_) => _random.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  final hex = bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}
