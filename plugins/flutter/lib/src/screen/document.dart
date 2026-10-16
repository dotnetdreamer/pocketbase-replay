import 'dart:ui' show Rect;

import '../events.dart';

/// A pixel length for inline CSS, without needless decimals.
String px(double value) {
  final rounded = (value * 100).round() / 100;
  return rounded == rounded.truncateToDouble() ? '${rounded.toInt()}px' : '${rounded}px';
}

/// What a tapped widget is written as, so the viewer's activity panel can name the tap, as `button "Pay now"`.
class TapTarget {
  const TapTarget({required this.tag, required this.text, required this.rect});

  final String tag;
  final String text;

  /// Where the widget is, in logical pixels of the recorded screen.
  final Rect rect;
}

/// The recorded screen as rrweb's DOM: a full-size image of the screen, images of the areas that changed since,
/// and invisible elements that name tapped widgets. rrweb's player and the dashboard's activity panel read it as
/// any recorded page.
class ScreenDocument {
  static const int _document = 1;
  static const int _doctype = 2;
  static const int _html = 3;
  static const int _head = 4;
  static const int _body = 5;
  static const int screen = 6;
  static const int _changes = 7;
  static const int _taps = 8;

  int _nextId = 9;
  final List<int> _patches = [];
  int? _tap;
  bool _ready = false;

  /// Whether a full snapshot has been written, which every other event refers to.
  bool get ready => _ready;

  /// Changed areas drawn over the last full screen image.
  int get patchCount => _patches.length;

  static Map<String, Object?> _element(int id, String tag, Map<String, Object?> attributes, [List<Map<String, Object?>> children = const []]) =>
      {'type': 2, 'id': id, 'tagName': tag, 'attributes': attributes, 'childNodes': children};

  static String _layer(double width, double height) =>
      'position:absolute;left:0;top:0;width:${px(width)};height:${px(height)};pointer-events:none;overflow:hidden';

  /// A meta event and a full snapshot showing [image] at [width] by [height] logical pixels.
  List<ReplayEvent> fullSnapshot({
    required String href,
    required double width,
    required double height,
    required String image,
    required int timestamp,
  }) {
    _nextId = 9;
    _patches.clear();
    _tap = null;
    _ready = true;
    final size = 'width:${px(width)};height:${px(height)}';
    final node = {
      'type': 0,
      'id': _document,
      'childNodes': [
        {'type': 1, 'id': _doctype, 'name': 'html', 'publicId': '', 'systemId': ''},
        _element(_html, 'html', {'style': 'margin:0;padding:0;background:#000'}, [
          _element(_head, 'head', const {}),
          _element(_body, 'body', {'style': 'margin:0;padding:0;position:relative;overflow:hidden;background:#000;$size'}, [
            _element(screen, 'img', {
              'src': image,
              'alt': '',
              'style': 'position:absolute;left:0;top:0;display:block;$size',
            }),
            _element(_changes, 'div', {'style': _layer(width, height)}),
            _element(_taps, 'div', {'style': '${_layer(width, height)};opacity:0'}),
          ]),
        ]),
      ],
    };
    return [
      ReplayEvent(EventType.meta, timestamp, {'href': href, 'width': width.round(), 'height': height.round()}),
      ReplayEvent(EventType.fullSnapshot, timestamp, {
        'node': node,
        'initialOffset': const {'top': 0, 'left': 0},
      }),
    ];
  }

  static ReplayEvent _mutation(
    int timestamp, {
    List<Map<String, Object?>> adds = const [],
    List<Map<String, Object?>> removes = const [],
    List<Map<String, Object?>> attributes = const [],
  }) =>
      ReplayEvent(EventType.incrementalSnapshot, timestamp, {
        'source': IncrementalSource.mutation,
        'texts': const <Object?>[],
        'attributes': attributes,
        'removes': removes,
        'adds': adds,
      });

  /// Replaces the whole screen image and drops the changed areas drawn over the old one.
  ReplayEvent replaceScreen(String image, int timestamp) {
    final removes = [for (final id in _patches) {'parentId': _changes, 'id': id}];
    _patches.clear();
    return _mutation(timestamp, removes: removes, attributes: [
      {
        'id': screen,
        'attributes': {'src': image},
      },
    ]);
  }

  /// Draws [image] over the area [rect] of the screen, in logical pixels.
  ReplayEvent addPatch(String image, Rect rect, int timestamp) {
    final id = _nextId++;
    _patches.add(id);
    return _mutation(timestamp, adds: [
      {
        'parentId': _changes,
        'nextId': null,
        'node': _element(id, 'img', {
          'src': image,
          'alt': '',
          'style': 'position:absolute;left:${px(rect.left)};top:${px(rect.top)};width:${px(rect.width)};height:${px(rect.height)}',
        }),
      },
    ]);
  }

  /// Writes an invisible element for a tapped widget, replacing the last one, and returns it with its node id.
  (ReplayEvent, int) tapTarget(TapTarget target, int timestamp) {
    final id = _nextId++;
    final previous = _tap;
    _tap = id;
    final text = target.text;
    final rect = target.rect;
    return (
      _mutation(timestamp, removes: [
        if (previous != null) {'parentId': _taps, 'id': previous},
      ], adds: [
        {
          'parentId': _taps,
          'nextId': null,
          'node': _element(
            id,
            target.tag,
            {
              'style': 'position:absolute;left:${px(rect.left)};top:${px(rect.top)};width:${px(rect.width)};height:${px(rect.height)}',
            },
            [
              if (text.isNotEmpty) {'type': 3, 'id': _nextId++, 'textContent': text},
            ],
          ),
        },
      ]),
      id,
    );
  }

  void reset() {
    _ready = false;
    _patches.clear();
    _tap = null;
  }
}
