import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/src/gzip/gzip.dart';
import 'package:pocketbase_replay_flutter/src/gzip/gzip_stored.dart' as stored;

void main() {
  test('chunks are gzip members that base64 to the H4sI prefix the server checks', () {
    final data = utf8.encode('[{"type":4,"timestamp":1,"data":{}}]');
    final compressed = gzipBytes(data);
    expect(base64Encode(compressed), startsWith('H4sI'));
    expect(gzip.decode(compressed), data);
  });

  test('the web\'s stored gzip decodes to the same bytes at any size', () {
    expect(stored.crc32(utf8.encode('123456789')), 0xcbf43926);
    for (final size in [0, 1, 65535, 65536, 200000]) {
      final data = Uint8List.fromList(List.generate(size, (index) => (index * 31) % 251));
      final compressed = stored.gzipBytes(data);
      expect(base64Encode(compressed), startsWith('H4sI'));
      expect(gzip.decode(compressed), data, reason: '$size bytes');
    }
  });
}
