import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';

typedef ErrorListener = void Function(Object error, StackTrace? stack, Map<String, Object?>? attributes);

/// Shares `FlutterError.onError` and `PlatformDispatcher.onError` between diagnostics, trigger mode and the console
/// activity. The handlers the app set before are still called, and are put back when nothing listens.
///
/// A handler set after ours that calls ours keeps it in its chain, where it cannot be taken out again; it stays there
/// and only passes errors on while nothing listens, and is never put in a second time.
abstract final class ErrorHooks {
  static final Set<ErrorListener> _listeners = {};
  static FlutterExceptionHandler? _previousFlutter;
  static bool Function(Object, StackTrace)? _previousPlatform;
  static bool _flutterHooked = false;
  static bool _platformHooked = false;
  static bool _notifying = false;
  static bool _handling = false;

  static void Function() subscribe(ErrorListener listener) {
    _listeners.add(listener);
    _hook();
    return () {
      _listeners.remove(listener);
      if (_listeners.isEmpty) _unhook();
    };
  }

  static void _hook() {
    if (!_flutterHooked) {
      _flutterHooked = true;
      _previousFlutter = FlutterError.onError;
      FlutterError.onError = _onFlutterError;
    }
    if (!_platformHooked) {
      _platformHooked = true;
      _previousPlatform = PlatformDispatcher.instance.onError;
      PlatformDispatcher.instance.onError = _onPlatformError;
    }
  }

  static void _unhook() {
    if (_flutterHooked && FlutterError.onError == _onFlutterError) {
      FlutterError.onError = _previousFlutter;
      _previousFlutter = null;
      _flutterHooked = false;
    }
    if (_platformHooked && PlatformDispatcher.instance.onError == _onPlatformError) {
      PlatformDispatcher.instance.onError = _previousPlatform;
      _previousPlatform = null;
      _platformHooked = false;
    }
  }

  static void _notify(Object error, StackTrace? stack, Map<String, Object?>? attributes) {
    if (_notifying || _listeners.isEmpty) return;
    _notifying = true;
    try {
      for (final listener in _listeners.toList()) {
        try {
          listener(error, stack, attributes);
        } catch (_) {
          // Listeners must not reach the app.
        }
      }
    } finally {
      _notifying = false;
    }
  }

  static void _onFlutterError(FlutterErrorDetails details) {
    if (_handling) return;
    _handling = true;
    try {
      _handleFlutterError(details);
    } finally {
      _handling = false;
    }
  }

  static void _handleFlutterError(FlutterErrorDetails details) {
    // The framework reports some expected failures silently, such as an image that did not load; they are not errors
    // the app failed to handle.
    if (!details.silent) {
      String? context;
      try {
        context = details.context?.toDescription();
      } catch (_) {
        context = null;
      }
      _notify(details.exception, details.stack, {
        if (details.library != null) 'library': details.library,
        if (context != null && context.isNotEmpty) 'context': context,
      });
    }
    // The framework prints the error itself; that output is not captured again as console text.
    final previous = _previousFlutter;
    if (previous != null) PrintHooks.quietly(() => previous(details));
  }

  static bool _onPlatformError(Object error, StackTrace stack) {
    if (_handling) return false;
    _handling = true;
    try {
      _notify(error, stack, null);
      final previous = _previousPlatform;
      return previous != null && previous(error, stack);
    } finally {
      _handling = false;
    }
  }

  /// For tests: forget the listeners and handlers, taking ours out where that is still possible.
  @visibleForTesting
  static void reset() {
    _listeners.clear();
    _unhook();
    _flutterHooked = false;
    _platformHooked = false;
    _previousFlutter = null;
    _previousPlatform = null;
  }
}

typedef PrintListener = void Function(String line);

final Object _printZone = Object();

/// Shares `debugPrint`, and `print` inside [PocketBaseReplay.runZoned], between log capture and the console activity.
/// Like [ErrorHooks], a `debugPrint` wrapped by the app after ours stays in place and is never wrapped twice.
abstract final class PrintHooks {
  static final Set<PrintListener> _listeners = {};
  static DebugPrintCallback? _original;
  static bool _hooked = false;
  static int _quiet = 0;
  static int _depth = 0;

  static void Function() subscribe(PrintListener listener) {
    _listeners.add(listener);
    if (!_hooked) {
      _hooked = true;
      _original = debugPrint;
      debugPrint = _debugPrint;
    }
    return () {
      _listeners.remove(listener);
      if (_listeners.isEmpty && _hooked && debugPrint == _debugPrint) {
        debugPrint = _original ?? debugPrintThrottled;
        _original = null;
        _hooked = false;
      }
    };
  }

  static void _debugPrint(String? message, {int? wrapWidth}) {
    // A wrapper of ours that ends up calling us again would loop; Flutter's own printer ends it.
    if (_depth > 0) {
      debugPrintThrottled(message, wrapWidth: wrapWidth);
      return;
    }
    _depth++;
    try {
      (_original ?? debugPrintThrottled)(message, wrapWidth: wrapWidth);
    } finally {
      _depth--;
    }
    // Inside runZoned the zone sees each printed line, also those debugPrint prints later, and captures them there.
    if (Zone.current[_printZone] != true) emit(message ?? 'null');
  }

  /// Runs [action] without capturing what it prints, such as the framework's report of an error already captured.
  static void quietly(void Function() action) {
    _quiet++;
    try {
      action();
    } finally {
      _quiet--;
    }
  }

  static void emit(String line) {
    if (_quiet > 0 || _listeners.isEmpty) return;
    _quiet++;
    try {
      for (final listener in _listeners.toList()) {
        try {
          listener(line);
        } catch (_) {
          // Listeners must not reach the app.
        }
      }
    } finally {
      _quiet--;
    }
  }

  @visibleForTesting
  static void reset() {
    _listeners.clear();
    if (_hooked && debugPrint == _debugPrint) debugPrint = _original ?? debugPrintThrottled;
    _original = null;
    _hooked = false;
    _quiet = 0;
  }
}

/// Whether the app is on screen. Android counts as away once it leaves the screen, not while a dialog covers it;
/// iOS also when it resigns active, as for Control Center or a call; the web when its page is hidden.
abstract final class AppLifecycle {
  static final _Observer _observer = _Observer();
  static final Set<void Function(bool active)> _listeners = {};
  static bool _observing = false;

  static bool activeState(AppLifecycleState? state) {
    if (state == null || state == AppLifecycleState.resumed) return true;
    if (state == AppLifecycleState.inactive) return kIsWeb || defaultTargetPlatform != TargetPlatform.iOS;
    return false;
  }

  static bool get isActive => activeState(WidgetsBinding.instance.lifecycleState);

  static void Function() subscribe(void Function(bool active) listener) {
    _listeners.add(listener);
    if (!_observing) {
      _observing = true;
      _observer.active = isActive;
      WidgetsBinding.instance.addObserver(_observer);
    }
    return () {
      _listeners.remove(listener);
      if (_listeners.isEmpty && _observing) {
        _observing = false;
        WidgetsBinding.instance.removeObserver(_observer);
      }
    };
  }

  static void _changed(bool active) {
    for (final listener in _listeners.toList()) {
      try {
        listener(active);
      } catch (_) {
        // Listeners must not reach the app.
      }
    }
  }
}

class _Observer with WidgetsBindingObserver {
  bool active = true;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    final next = AppLifecycle.activeState(state);
    if (next == active) return;
    active = next;
    AppLifecycle._changed(next);
  }
}

/// Runs [body] in a zone that passes its `print` output to log and console capture.
R runZonedWithPrints<R>(R Function() body) => runZoned(
      body,
      zoneValues: {_printZone: true},
      zoneSpecification: ZoneSpecification(print: (self, parent, zone, line) {
        parent.print(zone, line);
        PrintHooks.emit(line);
      }),
    );
