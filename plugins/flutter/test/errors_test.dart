import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/src/errors.dart';

class PaymentDeclined implements Exception {
  @override
  String toString() => 'PaymentDeclined: card ending 4242 was declined';
}

void main() {
  test('Dart VM frames become the frames the server groups by', () {
    const raw = '#0      CartState._pay (package:shop/cart.dart:42:7)\n'
        '#1      _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1170:21)\n'
        '<asynchronous suspension>\n'
        '#2      main.<anonymous closure> (file:///app/lib/main.dart:10:5)\n';
    expect(
      convertStack(raw),
      '    at CartState._pay (package:shop/cart.dart:42:7)\n'
      '    at _InkResponseState.handleTap (package:flutter/src/material/ink_well.dart:1170:21)\n'
      '    at main.<anonymous closure> (file:///app/lib/main.dart:10:5)',
    );
  });

  test('web stacks and obfuscated frames are kept, and this package\'s own leading frames dropped', () {
    const web = 'TypeError: x is undefined\n    at Object.a2 (https://app.example.com/main.dart.js:12345:67)';
    expect(convertStack(web), web);
    const obfuscated = '    #00 abs 0000007b8d0e2e5f virt 00000000001e2e5f _kDartIsolateSnapshotInstructions+0x1d6e5f';
    expect(convertStack(obfuscated), obfuscated);
    const own = '#0      PocketBaseReplay.captureException (package:pocketbase_replay_flutter/src/pocketbase_replay.dart:150:5)\n'
        '#1      CheckoutPage.submit (package:shop/checkout.dart:20:3)';
    expect(convertStack(own), '    at CheckoutPage.submit (package:shop/checkout.dart:20:3)');
  });

  test('errors are named by type and keep a message without their name repeated', () {
    expect(errorName(StateError('no element')), 'StateError');
    expect(errorName(RangeError.index(3, [1, 2])), 'RangeError');
    expect(errorName(ArgumentError('bad')), 'ArgumentError');
    expect(errorName(UnimplementedError()), 'UnimplementedError');
    expect(errorName(const FormatException('bad number')), 'FormatException');
    expect(errorName(TimeoutException('slow')), 'TimeoutException');
    expect(errorName('plain text'), 'Error');
    expect(errorName(Exception('Checkout failed')), 'Exception');
    expect(errorName(PaymentDeclined()), 'PaymentDeclined');
    expect(errorMessage(Exception('Checkout failed'), 'Exception'), 'Checkout failed');
    expect(errorMessage(const FormatException('bad number'), 'FormatException'), 'bad number');
    expect(errorMessage(PaymentDeclined(), 'PaymentDeclined'), 'card ending 4242 was declined');
    expect(errorMessage(StateError('no element'), 'StateError'), 'Bad state: no element');
  });

  test('a framework error is described by its summary line', () {
    final error = FlutterError.fromParts([
      ErrorSummary('A RenderFlex overflowed by 42 pixels on the right.'),
      ErrorDescription('The relevant error-causing widget was Row.'),
    ]);
    final described = describeError(error, null, const []);
    expect(described.name, 'FlutterError');
    expect(described.message, 'A RenderFlex overflowed by 42 pixels on the right.');
  });

  test('a description is redacted and carries the converted stack', () {
    Object? thrown;
    StackTrace? stack;
    try {
      throw StateError('no order for alice@example.test');
    } catch (error, trace) {
      thrown = error;
      stack = trace;
    }
    final described = describeError(thrown, stack, const []);
    expect(described.name, 'StateError');
    expect(described.message, 'Bad state: no order for [redacted]');
    expect(described.stack, startsWith('    at main.<anonymous closure> (file://'));
  });
}
