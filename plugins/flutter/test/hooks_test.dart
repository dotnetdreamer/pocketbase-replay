import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/src/hooks.dart';

void main() {
  late DebugPrintCallback savedPrint;
  late FlutterExceptionHandler? savedHandler;

  setUp(() {
    savedPrint = debugPrint;
    savedHandler = FlutterError.onError;
    debugPrint = (message, {wrapWidth}) {};
  });

  tearDown(() {
    PrintHooks.reset();
    ErrorHooks.reset();
    debugPrint = savedPrint;
    FlutterError.onError = savedHandler;
  });

  test('debugPrint keeps working when the app wrapped it and capture stops and starts again', () {
    final lines = <String>[];
    final first = PrintHooks.subscribe(lines.add);
    // A logging package wraps debugPrint after ours, then capture stops for the background and starts on resume.
    final wrapped = debugPrint;
    debugPrint = (message, {wrapWidth}) => wrapped(message, wrapWidth: wrapWidth);
    first();
    debugPrint('while stopped');
    final second = PrintHooks.subscribe(lines.add);
    debugPrint('after resume');
    second();
    expect(lines, ['after resume']);
  });

  test('the app\'s own error handler keeps running when another wraps ours and capture starts again', () {
    var original = 0, wrapper = 0, ours = 0;
    FlutterError.onError = (details) => original++;
    final first = ErrorHooks.subscribe((error, stack, attributes) => ours++);
    final previous = FlutterError.onError;
    FlutterError.onError = (details) {
      wrapper++;
      previous?.call(details);
    };
    FlutterError.reportError(FlutterErrorDetails(exception: Exception('one')));
    first();
    final second = ErrorHooks.subscribe((error, stack, attributes) => ours++);
    FlutterError.reportError(FlutterErrorDetails(exception: Exception('two')));
    second();
    FlutterError.reportError(FlutterErrorDetails(exception: Exception('three')));
    expect([original, wrapper, ours], [3, 3, 2]);
  });

  test('errors the framework reports silently are passed on but not captured', () {
    final errors = <Object>[];
    var passed = 0;
    FlutterError.onError = (details) => passed++;
    final remove = ErrorHooks.subscribe((error, stack, attributes) => errors.add(error));
    FlutterError.reportError(FlutterErrorDetails(exception: Exception('image failed'), silent: true));
    FlutterError.reportError(FlutterErrorDetails(exception: Exception('broken'), library: 'widgets library'));
    remove();
    expect(errors.map((error) => '$error'), ['Exception: broken']);
    expect(passed, 2);
    expect(FlutterError.onError, isNot(same(ErrorHooks)));
  });

  test('inside runZoned each printed line is captured once, also lines debugPrint prints later', () async {
    debugPrint = debugPrintThrottled;
    final lines = <String>[];
    final remove = PrintHooks.subscribe(lines.add);
    // The outer zone only keeps the test's output quiet.
    await runZoned(
      () => runZonedWithPrints(() async {
        // Enough text that debugPrintThrottled prints part of it a second later, from a timer.
        for (var index = 0; index < 30; index++) {
          debugPrint('line $index ${'x' * 500}');
        }
        // ignore: avoid_print
        print('plain print');
        await Future<void>.delayed(const Duration(seconds: 3));
      }),
      zoneSpecification: ZoneSpecification(print: (self, parent, zone, line) {}),
    );
    remove();
    expect(lines.where((line) => line.startsWith('line ')).length, 30);
    expect(lines.where((line) => line == 'plain print').length, 1);
  });

  test(
      'callbacks registered in the print zone retain capture when dispatched outside it',
      () {
    final lines = <String>[];
    final remove = PrintHooks.subscribe(lines.add);
    late void Function() onInput;
    // Flutter registers its input callbacks in the binding's initialization zone. The documented main() must put
    // that initialization in the capture zone, together with start() and runApp().
    runZonedWithPrints(() {
      onInput = Zone.current.bindCallback(() {
        // ignore: avoid_print
        print('input callback');
      });
    });
    onInput();
    remove();
    expect(lines, ['input callback']);
  });
}
