## 0.1.0

- First release: screen recording as rrweb events played by the PocketBase Replay viewer, with masking of text
  fields, `ReplayMask` areas, sensitive words, and all text or images on request or by the dashboard's `*` and
  `img` rules
- Touches and taps named after the tapped control, page changes from named routes, PocketBase calls through
  `ReplayPocketBaseClient`, network requests through `ReplayNetworkClient`, and console output
- Whole-session and trigger mode, `trigger()`, pause and resume with the app lifecycle, and the ingestion API key
- Dart errors and structured logs, with uncaught errors from `FlutterError.onError` and
  `PlatformDispatcher.onError`, `debugPrint` capture, `beforeSend` and grouping keys
