import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/src/privacy.dart';

void main() {
  test('free text loses URL queries, credentials, tokens, email addresses and the app\'s own words', () {
    final text = redactText(
      'GET https://user:pw@api.example.com/orders?token=abc#top failed for alice@example.test '
      'with Authorization: Bearer abc.def password="hunter 2" api_key=xyz and '
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl for Wonderland',
      ['wonderland'],
    );
    expect(text, contains('https://api.example.com/orders'));
    expect(text, isNot(contains('token=abc')));
    expect(text, isNot(contains('user:pw')));
    expect(text, isNot(contains('alice@example.test')));
    // As in the web client, the header name is redacted with its bearer token.
    expect(text, contains('Authorization=[redacted] [redacted]'));
    expect(text, isNot(contains('abc.def')));
    expect(redactText('sent Bearer abc.def'), 'sent Bearer [redacted]');
    expect(text, contains('password=[redacted]'));
    expect(text, contains('api_key=[redacted]'));
    expect(text, isNot(contains('eyJhbGciOiJIUzI1NiJ9')));
    expect(text, isNot(contains('Wonderland')));
  });

  test('text is cut to its limit without control characters or half of an emoji', () {
    expect(redactText('a\u0000b\u0007c\nd'), 'abc\nd');
    expect(redactText('x' * 3000).length, 2000);
    expect(clip('ab😀', 3), 'ab');
    expect(redactLabel('line\nbreak'), 'linebreak');
  });

  test('attribute values are bounded, private keys redacted and the whole fits in 4 KiB', () {
    final value = safeValue({
      'password': 'hunter2',
      'nested': {
        'a': {
          'b': {
            'c': {'d': 'deep'},
          },
        },
      },
      'list': List.generate(30, (index) => index),
      'when': DateTime.utc(2026, 10, 15),
      'nan': double.nan,
      'email': 'alice@example.test',
      'note': 'mail alice@example.test',
    }) as Map<String, Object?>;
    expect(value['password'], '[redacted]');
    expect(value['email'], '[redacted]');
    expect(value['note'], 'mail [redacted]');
    expect((value['list'] as List).length, 20);
    expect(value['when'], '2026-10-15T00:00:00.000Z');
    expect(value['nan'], 'NaN');
    expect(jsonEncode(value), contains('[truncated]'));
    final big = safeAttributes({for (var index = 0; index < 20; index++) 'key$index': 'x' * 900});
    expect(utf8.encode(jsonEncode(big)).length, lessThanOrEqualTo(4096));
    expect(big!.containsKey('key0'), isTrue);
    expect(big.containsKey('key19'), isFalse);
  });

  test('network addresses keep their path, never their query, fragment, user info or tokens', () {
    expect(cleanUrl('https://user:pw@api.example.com/v1/items?secret=1#x'), 'https://api.example.com/v1/items');
    expect(cleanUrl('data:image/png;base64,AAAA'), 'data:');
    expect(cleanUrl('https://a.test/customer/W%6Fnderland', ['wonderland']), 'https://a.test/customer/*');
    expect(cleanUrl('flutter://app/Alice%20Smith/details?token=secret', ['alice smith']), 'flutter://app/*/details');
    expect(cleanUrl('flutter://app/alice/smith/details', ['alice/smith']), 'flutter://app/*/details');
    expect(cleanUrl('flutter://app/A%6Cice/Smith/details?token=drop-me#private', ['alice/smith']), 'flutter://app/*/details');
    expect(cleanUrl('https://a.test/A%6Cice/Smith/name%3Fpath%23text?token=drop-me', ['alice/smith']),
        'https://a.test/*/name%3Fpath%23text');
    expect(cleanUrl('https://a.test/W%6Fnderland/alice@example.test', ['wonderland']),
        'https://a.test/*/alice@example.test');
    expect(cleanUrl('https://a.test/files/abcdefghijklmnopqrstu.abcdefghijklmnopqrstu.abcdefghij/x'), 'https://a.test/files/[masked]/x');
  });

  test('sensitive words on screen become stars', () {
    expect(maskSensitive('Welcome back, Alice Smith', ['alice smith']), 'Welcome back, *');
    expect(maskSensitive('a', ['a']), 'a');
  });
}
