// ignore_for_file: deprecated_member_use
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/pocketbase_replay_flutter.dart';
import 'package:pocketbase_replay_flutter/src/screen/inspect.dart';

final GlobalKey screen = GlobalKey();

Future<RenderObject> show(WidgetTester tester, Widget home) async {
  await tester.pumpWidget(RepaintBoundary(key: screen, child: MaterialApp(home: home)));
  return screen.currentContext!.findRenderObject()!;
}

ScreenMasks masksOf(RenderObject root, {bool images = false, List<String> sensitive = const []}) =>
    collectMasks(root, maskAllText: false, maskAllImages: images, sensitiveText: sensitive);

bool covered(ScreenMasks masks, Rect area) => masks.masked.any((rect) => rect.contains(area.center) && rect.overlaps(area));

TapResolution tap(WidgetTester tester, RenderObject root, Finder finder, {List<String> sensitive = const []}) =>
    resolveTap(root, tester.getCenter(finder), tester.view.viewId, maskAllText: false, sensitiveText: sensitive)!;

void main() {
  testWidgets('a text field hidden from accessibility but painted is still masked', (tester) async {
    final root = await show(
      tester,
      Scaffold(
        body: Column(children: [
          IgnorePointer(ignoring: false, ignoringSemantics: true, child: TextField(controller: TextEditingController(text: 'pin 1234'))),
          ExcludeSemantics(child: TextField(controller: TextEditingController(text: 'pin 5678'))),
        ]),
      ),
    );
    final masks = masksOf(root);
    expect(covered(masks, tester.getRect(find.byType(EditableText).at(0))), isTrue);
    expect(covered(masks, tester.getRect(find.byType(EditableText).at(1))), isTrue);
  });

  testWidgets('a text field scrolled under a see-through pinned header is masked there too', (tester) async {
    final scroll = ScrollController();
    final root = await show(
      tester,
      Scaffold(
        body: CustomScrollView(controller: scroll, slivers: [
          const SliverAppBar(pinned: true, toolbarHeight: 100, backgroundColor: Color(0x00000000), elevation: 0, scrolledUnderElevation: 0),
          SliverList(
            delegate: SliverChildListDelegate([
              for (var index = 0; index < 20; index++) SizedBox(height: 60, child: TextField(controller: TextEditingController(text: 'secret $index'))),
            ]),
          ),
        ]),
      ),
    );
    scroll.jumpTo(90);
    await tester.pump();
    final field = tester.getRect(find.byType(EditableText).at(1));
    expect(field.top, lessThan(100));
    final over = masksOf(root).masked.where((rect) => rect.overlaps(field));
    expect(over.any((rect) => rect.top <= field.top), isTrue);
  });

  testWidgets('a text selection magnifier is masked, since it shows an enlarged copy of the field', (tester) async {
    final root = await show(
      tester,
      const Scaffold(
        body: Stack(children: [
          Positioned(left: 0, top: 40, child: RawMagnifier(size: Size(300, 80), focalPointOffset: Offset(0, 180))),
        ]),
      ),
    );
    expect(covered(masksOf(root), const Rect.fromLTWH(0, 40, 300, 80)), isTrue);
  });

  testWidgets('maskAllImages covers images in shape decorations as well as image widgets', (tester) async {
    final image = MemoryImage(kTransparentImage);
    final keys = [GlobalKey(), GlobalKey(), GlobalKey()];
    final root = await show(
      tester,
      Column(children: [
        SizedBox(key: keys[0], width: 40, height: 40, child: Image(image: image)),
        SizedBox(key: keys[1], width: 40, height: 40, child: DecoratedBox(decoration: BoxDecoration(image: DecorationImage(image: image)))),
        SizedBox(
          key: keys[2],
          width: 40,
          height: 40,
          child: DecoratedBox(decoration: ShapeDecoration(shape: const CircleBorder(), image: DecorationImage(image: image))),
        ),
      ]),
    );
    final masks = masksOf(root, images: true);
    for (final key in keys) {
      expect(covered(masks, tester.getRect(find.byKey(key))), isTrue, reason: '$key');
    }
    expect(masksOf(root).masked, isEmpty);
  });

  testWidgets('a tap label never shows masked or sensitive text, and the tap inside a mask is placed at its centre',
      (tester) async {
    final root = await show(
      tester,
      Scaffold(
        body: Column(children: [
          ListTile(onTap: () {}, title: const Text('Balance'), trailing: const ReplayMask(child: Text('12,345.67 EUR'))),
          ElevatedButton(onPressed: () {}, child: const Text('Send money to account 4111 1111 1111 1111 now')),
          ReplayMask(
            child: SizedBox(width: 200, height: 100, child: Row(children: [ElevatedButton(onPressed: () {}, child: const Text('7'))])),
          ),
        ]),
      ),
    );
    final balance = tap(tester, root, find.text('Balance'));
    expect(balance.target.text, 'Balance *');
    expect(balance.maskedArea, isNull);
    final send = tap(tester, root, find.textContaining('Send money'), sensitive: ['4111 1111 1111 1111']);
    expect(send.target.text, '*');
    final key = tap(tester, root, find.text('7'));
    expect(key.target.text, '*');
    expect(key.maskedArea, tester.getRect(find.byType(ReplayMask).last));
    expect(key.target.rect, key.maskedArea, reason: 'a private control must not reveal its own bounds inside a mask');
    expect(key.target.tag, 'div');
  });
}

// A 1×1 transparent PNG.
const List<int> _png = [
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];
final kTransparentImage = Uint8List.fromList(_png);
