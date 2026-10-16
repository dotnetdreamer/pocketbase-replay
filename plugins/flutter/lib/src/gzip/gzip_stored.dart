import 'dart:typed_data';

final Uint32List _table = () {
  final table = Uint32List(256);
  for (var index = 0; index < 256; index++) {
    var value = index;
    for (var bit = 0; bit < 8; bit++) {
      value = value & 1 != 0 ? 0xedb88320 ^ (value >> 1) : value >> 1;
    }
    table[index] = value;
  }
  return table;
}();

int crc32(List<int> data) {
  var crc = 0xffffffff;
  for (final byte in data) {
    crc = _table[(crc ^ byte) & 0xff] ^ (crc >> 8);
  }
  return (crc ^ 0xffffffff) & 0xffffffff;
}

/// A valid gzip member whose deflate data is stored, not compressed. The web has no zlib in Dart, and screen frames
/// are compressed images already, so this costs little and needs no dependency.
List<int> gzipBytes(List<int> data) {
  const block = 0xffff;
  final blocks = data.isEmpty ? 1 : (data.length + block - 1) ~/ block;
  final output = BytesBuilder(copy: false)
    ..add(const [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff]);
  for (var index = 0; index < blocks; index++) {
    final start = index * block;
    final end = start + block < data.length ? start + block : data.length;
    final length = end - start;
    output
      ..addByte(index == blocks - 1 ? 1 : 0)
      ..add([length & 0xff, length >> 8, ~length & 0xff, (~length >> 8) & 0xff])
      ..add(data is Uint8List ? Uint8List.sublistView(data, start, end) : data.sublist(start, end));
  }
  final trailer = ByteData(8)
    ..setUint32(0, crc32(data), Endian.little)
    ..setUint32(4, data.length & 0xffffffff, Endian.little);
  output.add(trailer.buffer.asUint8List());
  return output.takeBytes();
}
