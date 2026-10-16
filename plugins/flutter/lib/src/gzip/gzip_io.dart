import 'dart:io';

// Level 1, as the web client compresses: screen frames are already compressed images.
final GZipCodec _codec = GZipCodec(level: 1);

List<int> gzipBytes(List<int> data) => _codec.encode(data);
