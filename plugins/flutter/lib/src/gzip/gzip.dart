import 'gzip_stored.dart' if (dart.library.io) 'gzip_io.dart' as platform;

/// Gzip for upload chunks: zlib where `dart:io` exists, and stored blocks on the web, where it does not.
List<int> gzipBytes(List<int> data) => platform.gzipBytes(data);
