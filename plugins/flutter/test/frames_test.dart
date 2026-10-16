import 'dart:typed_data';
import 'dart:ui' show Rect;

import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/src/screen/document.dart';
import 'package:pocketbase_replay_flutter/src/screen/frames.dart';

void main() {
  test('the changed area is the smallest rectangle holding every differing pixel', () {
    const width = 10, height = 8;
    final previous = Uint32List(width * height);
    final next = Uint32List.fromList(previous);
    expect(changedRegion(previous, next, width, height), isNull);
    next[2 * width + 3] = 1;
    next[5 * width + 7] = 1;
    expect(changedRegion(previous, next, width, height), const PixelRegion(3, 2, 8, 6));
    next[0] = 2;
    expect(changedRegion(previous, next, width, height), const PixelRegion(0, 0, 8, 6));
  });

  test('changed areas line up with whole CSS pixels at every supported ratio', () {
    expect(pixelAlignment(1), 1);
    expect(pixelAlignment(0.5), 1);
    expect(pixelAlignment(0.75), 3);
    expect(pixelAlignment(1.25), 5);
    expect(pixelAlignment(1.5), 3);
    expect(pixelAlignment(2), 2);
    expect(alignRegion(const PixelRegion(4, 5, 7, 8), 3, 10, 9), const PixelRegion(3, 3, 9, 9));
    expect(alignRegion(const PixelRegion(4, 5, 7, 8), 1, 10, 9), const PixelRegion(4, 5, 7, 8));
  });

  test('a frame is at most 1280 pixels on its longer side and shrinks in quarter steps', () {
    expect(frameRatio(1, 390, 844), 1);
    expect(frameRatio(1, 1024, 1366), 0.75);
    expect(frameRatio(3, 390, 844), 1.5);
    expect(frameRatio(1, 390, 844, steps: 2), 0.5);
    expect(frameRatio(1, 390, 844, steps: 9), 0.25);
    expect(frameRatio(double.nan, 390, 844), 1);
  });

  test('a full snapshot is a meta event and an rrweb document holding the screen image', () {
    final document = ScreenDocument();
    expect(document.ready, isFalse);
    final events = document.fullSnapshot(href: 'flutter://app/checkout', width: 392.7, height: 850.9, image: 'data:image/png;base64,AAAA', timestamp: 5);
    expect(document.ready, isTrue);
    expect(events.map((event) => event.type), [4, 2]);
    expect(events[0].data, {'href': 'flutter://app/checkout', 'width': 393, 'height': 851});
    final node = events[1].data['node']! as Map<String, Object?>;
    expect(node['type'], 0);
    final html = (node['childNodes']! as List)[1] as Map<String, Object?>;
    final body = (html['childNodes']! as List)[1] as Map<String, Object?>;
    final screen = (body['childNodes']! as List).first as Map<String, Object?>;
    expect(screen['id'], ScreenDocument.screen);
    expect(screen['tagName'], 'img');
    expect((screen['attributes']! as Map)['src'], 'data:image/png;base64,AAAA');
    expect((screen['attributes']! as Map)['style'], contains('width:392.7px;height:850.9px'));
  });

  test('changes are drawn over the screen image until a whole image replaces them', () {
    final document = ScreenDocument()..fullSnapshot(href: 'flutter://app/', width: 100, height: 200, image: 'a', timestamp: 1);
    final patch = document.addPatch('b', const Rect.fromLTRB(10, 20, 30, 50), 2);
    expect(patch.type, 3);
    expect(patch.data['source'], 0);
    final added = (patch.data['adds']! as List).single as Map<String, Object?>;
    final node = added['node']! as Map<String, Object?>;
    expect(node['tagName'], 'img');
    expect((node['attributes']! as Map)['style'], 'position:absolute;left:10px;top:20px;width:20px;height:30px');
    expect(document.patchCount, 1);
    final replaced = document.replaceScreen('c', 3);
    expect(replaced.data['attributes'], [
      {
        'id': ScreenDocument.screen,
        'attributes': {'src': 'c'},
      },
    ]);
    expect((replaced.data['removes']! as List).single, {'parentId': 7, 'id': node['id']});
    expect(document.patchCount, 0);
  });

  test('a tapped widget is an invisible element named as the viewer names clicks, replacing the last one', () {
    final document = ScreenDocument()..fullSnapshot(href: 'flutter://app/', width: 100, height: 200, image: 'a', timestamp: 1);
    final (first, firstId) = document.tapTarget(const TapTarget(tag: 'button', text: 'Pay now', rect: Rect.fromLTWH(1, 2, 3, 4)), 2);
    final node = ((first.data['adds']! as List).single as Map)['node'] as Map<String, Object?>;
    expect(node['id'], firstId);
    expect(node['tagName'], 'button');
    expect(node['childNodes'], [
      {'type': 3, 'id': firstId + 1, 'textContent': 'Pay now'},
    ]);
    final (second, _) = document.tapTarget(const TapTarget(tag: 'input', text: '', rect: Rect.zero), 3);
    expect((second.data['removes']! as List).single, {'parentId': 8, 'id': firstId});
    expect((((second.data['adds']! as List).single as Map)['node'] as Map)['childNodes'], isEmpty);
    expect(px(1.0), '1px');
    expect(px(1.256), '1.26px');
  });
}
