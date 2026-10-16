import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/gestures.dart';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pocketbase_replay_flutter/pocketbase_replay_flutter.dart';
import 'package:pocketbase_replay_flutter/src/engine.dart';
import 'package:pocketbase_replay_flutter/src/events.dart';
import 'package:pocketbase_replay_flutter/src/screen/document.dart';
import 'package:pocketbase_replay_flutter/src/screen/recorder.dart';

const Color mask = Color(0xFF9E9E9E);

RecorderSettings settings({bool maskAllText = false, List<String> sensitive = const []}) => RecorderSettings(
      endpoint: 'https://replay.test',
      maskAllText: maskAllText,
      maskAllImages: false,
      recordNetwork: false,
      recordConsole: false,
      recordPocketbase: false,
      sensitiveText: () => sensitive,
      replaySession: () => null,
      frameInterval: const Duration(milliseconds: 100),
    );

/// Gives the engine real time to render and encode, then lets the test's zone run what it finished.
Future<void> waitFor(WidgetTester tester, bool Function() done, {String reason = 'condition'}) async {
  for (var attempt = 0; attempt < 150 && !done(); attempt++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 20)));
    await tester.pump(const Duration(milliseconds: 50));
  }
  expect(done(), isTrue, reason: 'timed out waiting for $reason');
}

String screenImage(List<ReplayEvent> events) {
  final full = events.lastWhere((event) => event.type == EventType.fullSnapshot);
  String? found;
  void visit(Object? node) {
    if (node is Map) {
      if (node['id'] == ScreenDocument.screen) found = (node['attributes']! as Map)['src'] as String;
      final children = node['childNodes'];
      if (children is List) children.forEach(visit);
    }
  }

  visit(full.data['node']);
  return found!;
}

Future<Color> pixel(WidgetTester tester, String dataUrl, Offset at) async {
  final color = await tester.runAsync(() async {
    final codec = await ui.instantiateImageCodec(base64Decode(dataUrl.split(',').last));
    final image = (await codec.getNextFrame()).image;
    final data = (await image.toByteData(format: ui.ImageByteFormat.rawStraightRgba))!;
    final offset = (at.dy.round() * image.width + at.dx.round()) * 4;
    final value = Color.fromARGB(data.getUint8(offset + 3), data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2));
    image.dispose();
    return value;
  });
  return color!;
}

Future<int> colorCount(WidgetTester tester, String dataUrl, Rect region, Color color) async {
  final count = await tester.runAsync(() async {
    final codec = await ui.instantiateImageCodec(base64Decode(dataUrl.split(',').last));
    final image = (await codec.getNextFrame()).image;
    try {
      final data = (await image.toByteData(format: ui.ImageByteFormat.rawStraightRgba))!;
      var matches = 0;
      for (var y = region.top.floor().clamp(0, image.height); y < region.bottom.ceil().clamp(0, image.height); y++) {
        for (var x = region.left.floor().clamp(0, image.width); x < region.right.ceil().clamp(0, image.width); x++) {
          final offset = (y * image.width + x) * 4;
          if (Color.fromARGB(data.getUint8(offset + 3), data.getUint8(offset), data.getUint8(offset + 1), data.getUint8(offset + 2)) ==
              color) {
            matches++;
          }
        }
      }
      return matches;
    } finally {
      image.dispose();
      codec.dispose();
    }
  });
  return count!;
}

List<Map<String, Object?>> tapNodes(Iterable<ReplayEvent> events) => [
      for (final event in events)
        if (event.data['source'] == IncrementalSource.mutation)
          for (final add in event.data['adds'] as List? ?? const [])
            if ((add as Map)['parentId'] == 8) add['node'] as Map<String, Object?>,
    ];

Future<List<ReplayEvent>> record(WidgetTester tester, Widget app, {RecorderSettings? with_}) async {
  await tester.pumpWidget(PocketBaseReplayWidget(child: app));
  final events = <ReplayEvent>[];
  final stop = ScreenRecorder.instance.start(events.add, with_ ?? settings());
  addTearDown(() => stop?.call());
  await waitFor(tester, () => events.any((event) => event.type == EventType.fullSnapshot), reason: 'a full snapshot');
  return events;
}

class _FailingBoundary extends RenderRepaintBoundary {
  int attempts = 0;

  @override
  Future<ui.Image> toImage({double pixelRatio = 1.0}) {
    attempts++;
    return Future.error(StateError('Not supported'));
  }
}

class _Failing extends SingleChildRenderObjectWidget {
  const _Failing({super.key, super.child});

  @override
  _FailingBoundary createRenderObject(BuildContext context) => _FailingBoundary();
}

class _Host implements ScreenHost {
  _Host(this.boundary);

  @override
  final RenderRepaintBoundary boundary;

  @override
  int get viewId => 0;
}

void main() {
  testWidgets('a screen that cannot be captured is tried again after growing waits, and given up after a few', (tester) async {
    final key = GlobalKey();
    await tester.pumpWidget(_Failing(key: key, child: const SizedBox.expand()));
    final boundary = key.currentContext!.findRenderObject()! as _FailingBoundary;
    final host = _Host(boundary);
    ScreenRecorder.instance.attach(host);
    final stop = ScreenRecorder.instance.start((_) {}, settings());
    await tester.pump();
    await tester.pump();
    expect(boundary.attempts, 1, reason: 'no retry without a wait');
    for (var minute = 0; minute < 20; minute++) {
      await tester.pump(const Duration(minutes: 1));
    }
    expect(boundary.attempts, ScreenLimits.failures);
    stop?.call();
    ScreenRecorder.instance.detach(host);
  });

  testWidgets('records the screen as a meta event and a full PNG snapshot, with text fields masked', (tester) async {
    final events = await record(
      tester,
      MaterialApp(
        home: Scaffold(
          body: Column(children: [
            const Text('Hello'),
            SizedBox(width: 300, child: TextField(controller: TextEditingController(text: 'card 4242 4242'))),
          ]),
        ),
      ),
    );
    expect(events.take(2).map((event) => event.type), [EventType.meta, EventType.fullSnapshot]);
    expect(events.first.data, {'href': 'flutter://app/', 'width': 800, 'height': 600});
    final image = screenImage(events);
    expect(image, startsWith('data:image/png;base64,'));
    final field = tester.getRect(find.byType(EditableText));
    expect(await pixel(tester, image, field.center), mask);
    expect(await pixel(tester, image, const Offset(790, 590)), isNot(mask));
  });

  testWidgets('ReplayMask areas and text holding a sensitive word are painted over', (tester) async {
    final events = await record(
      tester,
      const MaterialApp(
        home: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ReplayMask(child: SizedBox(width: 200, height: 40, child: ColoredBox(color: Color(0xFF00FF00)))),
          SizedBox(width: 200, height: 40, child: ColoredBox(color: Color(0xFF00FF00))),
          Text('Hi Alice Smith'),
          Text('Plain words'),
        ]),
      ),
      with_: settings(sensitive: ['alice smith']),
    );
    final image = screenImage(events);
    expect(await pixel(tester, image, const Offset(100, 20)), mask);
    expect(await pixel(tester, image, const Offset(100, 60)), const Color(0xFF00FF00));
    expect(await pixel(tester, image, tester.getRect(find.text('Hi Alice Smith')).centerLeft + const Offset(2, 0)), mask);
    expect(await pixel(tester, image, tester.getRect(find.text('Plain words')).centerLeft + const Offset(2, 0)), isNot(mask));
  });

  testWidgets('a route covered by another page is not painted, so its text field is not masked over the screen', (tester) async {
    final navigator = GlobalKey<NavigatorState>();
    await tester.pumpWidget(PocketBaseReplayWidget(
      child: MaterialApp(
        navigatorKey: navigator,
        home: const Align(alignment: Alignment.topLeft, child: SizedBox(width: 300, child: Material(child: TextField()))),
      ),
    ));
    final field = tester.getRect(find.byType(EditableText));
    navigator.currentState!
        .push(MaterialPageRoute<void>(builder: (_) => const ColoredBox(color: Color(0xFF00FF00), child: SizedBox.expand())));
    await tester.pumpAndSettle();
    final events = <ReplayEvent>[];
    final stop = ScreenRecorder.instance.start(events.add, settings());
    addTearDown(() => stop?.call());
    await waitFor(tester, () => events.any((event) => event.type == EventType.fullSnapshot), reason: 'a full snapshot');
    expect(await pixel(tester, screenImage(events), field.center), const Color(0xFF00FF00));
  });

  testWidgets('a small change is sent as the area that changed, drawn over the screen image', (tester) async {
    final color = ValueNotifier(const Color(0xFFFF0000));
    final events = await record(
      tester,
      MaterialApp(
        home: Align(
          alignment: Alignment.topLeft,
          child: ValueListenableBuilder<Color>(
            valueListenable: color,
            builder: (_, value, __) => SizedBox(width: 50, height: 40, child: ColoredBox(color: value)),
          ),
        ),
      ),
    );
    final before = events.length;
    color.value = const Color(0xFF0000FF);
    await waitFor(tester, () => events.length > before, reason: 'a changed frame');
    final change = events[before];
    expect(change.type, EventType.incrementalSnapshot);
    expect(change.data['source'], IncrementalSource.mutation);
    final added = ((change.data['adds']! as List).single as Map)['node'] as Map;
    expect(added['tagName'], 'img');
    final style = (added['attributes']! as Map)['style'] as String;
    expect(style, 'position:absolute;left:0px;top:0px;width:50px;height:40px');
    expect((added['attributes']! as Map)['src'], startsWith('data:image/png;base64,'));
    expect(ScreenRecorder.instance.frames, greaterThanOrEqualTo(2));
  });

  testWidgets('a tap is recorded as a touch and a click on the tapped control, named for the activity panel', (tester) async {
    final events = await record(
      tester,
      MaterialApp(
        home: Scaffold(
          body: Column(children: [
            ElevatedButton(onPressed: () {}, child: const Text('Pay now')),
            ReplayMask(child: ElevatedButton(onPressed: () {}, child: const Text('Secret'))),
          ]),
        ),
      ),
    );
    var from = events.length;
    await tester.tap(find.text('Pay now'));
    var taps = events.sublist(from);
    expect(taps.map((event) => event.data['type']), [MouseInteraction.touchStart, MouseInteraction.touchEnd, null, MouseInteraction.click]);
    final target = ((taps[2].data['adds']! as List).single as Map)['node'] as Map;
    expect(target['tagName'], 'button');
    expect(target['childNodes'], [
      {'type': 3, 'id': (target['id']! as int) + 1, 'textContent': 'Pay now'},
    ]);
    expect(taps[3].data['id'], target['id']);
    expect(taps.first.data['id'], ScreenDocument.screen);

    from = events.length;
    await tester.tap(find.text('Secret'));
    taps = events.sublist(from);
    final masked = ((taps[2].data['adds']! as List).single as Map)['node'] as Map;
    expect((masked['childNodes']! as List).single, containsPair('textContent', '*'));
    // Inside a mask a touch is placed at the mask's centre, so where it landed cannot be read back.
    final centre = tester.getRect(find.byType(ReplayMask)).center;
    for (final touch in taps.where((event) => event.data['source'] == IncrementalSource.mouseInteraction)) {
      expect([touch.data['x'], touch.data['y']], [centre.dx.round(), centre.dy.round()]);
    }
  });

  testWidgets('keys in one mask have identical uploaded targets and coarsened hover and drag positions', (tester) async {
    final maskKey = GlobalKey();
    final events = await record(
      tester,
      MaterialApp(
          home: Scaffold(
              body: Padding(
        padding: const EdgeInsets.only(top: 80),
        child: ReplayMask(
            key: maskKey,
            child: SizedBox(
                width: 400,
                height: 100,
                child: Row(children: [
                  SizedBox(width: 120, child: ElevatedButton(onPressed: () {}, child: const Text('PIN1'))),
                  const SizedBox(width: 80),
                  SizedBox(width: 120, child: ElevatedButton(onPressed: () {}, child: const Text('PIN2'))),
                ]))),
      ))),
    );
    final from = events.length;
    await tester.tap(find.text('PIN1'));
    await tester.tap(find.text('PIN2'));
    final targets = tapNodes(events.sublist(from));
    expect(targets, hasLength(2));
    expect(targets[0]['attributes'], targets[1]['attributes']);
    expect(targets.map((node) => node['tagName']), everyElement('div'));
    expect(targets.map((node) => ((node['childNodes'] as List).single as Map)['textContent']), everyElement('*'));
    final center = tester.getRect(find.byKey(maskKey)).center;
    for (final event in events.sublist(from).where((event) => event.data['source'] == IncrementalSource.mouseInteraction)) {
      expect([event.data['x'], event.data['y']], [center.dx.round(), center.dy.round()]);
    }
    for (final finder in [find.text('PIN1'), find.text('PIN2')]) {
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 120)));
      ScreenRecorder.instance.pointerHover(PointerHoverEvent(kind: ui.PointerDeviceKind.mouse, position: tester.getCenter(finder)));
    }
    final hovers = events.where((event) => event.data['source'] == IncrementalSource.mouseMove);
    expect(hovers, hasLength(2));
    for (final hover in hovers) {
      expect((hover.data['positions'] as List).single, containsPair('x', center.dx.round()));
      expect((hover.data['positions'] as List).single, containsPair('y', center.dy.round()));
    }
    // A drag that begins outside the mask must not disclose where it enters the private keypad either.
    ScreenRecorder.instance.pointerDown(const PointerDownEvent(pointer: 77, position: Offset(20, 20)));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 120)));
    ScreenRecorder.instance.pointerMove(PointerMoveEvent(pointer: 77, position: tester.getCenter(find.text('PIN1'))));
    ScreenRecorder.instance.pointerUp(PointerUpEvent(pointer: 77, position: tester.getCenter(find.text('PIN1'))));
    final move = events.lastWhere((event) => event.data['source'] == IncrementalSource.touchMove);
    expect((move.data['positions'] as List).single, containsPair('x', center.dx.round()));
    expect((move.data['positions'] as List).single, containsPair('y', center.dy.round()));
  });

  testWidgets('an accessibility label cannot repeat a masked descendant in uploaded activity', (tester) async {
    final events = await record(
        tester,
        MaterialApp(
            home: Scaffold(
                body: Align(
          alignment: Alignment.topLeft,
          child: Semantics(
              button: true,
              label: 'Balance 12345',
              onTap: () {},
              child: const Row(mainAxisSize: MainAxisSize.min, children: [
                Text('Balance'),
                ReplayMask(child: Text('12345')),
              ])),
        ))));
    final from = events.length;
    await tester.tap(find.text('Balance'));
    final encoded = jsonEncode(events.sublist(from).map((event) => event.data).toList());
    expect(encoded, isNot(contains('12345')));
    final target = tapNodes(events.sublist(from)).single;
    expect(target['childNodes'], contains(containsPair('textContent', 'Balance *')));
  });

  testWidgets('a mask covers translated and overflowing descendants in the actual encoded PNG', (tester) async {
    final translated = GlobalKey(), overflowing = GlobalKey();
    const green = Color(0xFF00FF00);
    final events = await record(
        tester,
        MaterialApp(
            home: Scaffold(
                body: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          ReplayMask(
              child: Transform.translate(
                  offset: const Offset(150, 0), child: SizedBox(width: 100, height: 40, child: ColoredBox(key: translated, color: green)))),
          ReplayMask(
              child: SizedBox(
                  width: 20,
                  height: 40,
                  child: OverflowBox(
                      maxWidth: 200,
                      alignment: Alignment.topLeft,
                      child: SizedBox(width: 200, height: 40, child: ColoredBox(key: overflowing, color: green))))),
        ]))));
    for (final key in [translated, overflowing]) {
      final region = tester.getRect(find.byKey(key)).deflate(2);
      expect(await colorCount(tester, screenImage(events), region, green), 0);
      expect(await colorCount(tester, screenImage(events), region, mask), greaterThan(100));
    }
  });

  testWidgets('visible sensitive text overflow is removed from the encoded PNG', (tester) async {
    const green = Color(0xFF00FF00);
    final textKey = GlobalKey();
    final events = await record(
        tester,
        MaterialApp(
            home: Scaffold(
                body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
              width: 20,
              height: 48,
              child: Text('SECRET-WIDE-TEXT',
                  key: textKey, softWrap: false, overflow: TextOverflow.visible, style: const TextStyle(fontSize: 24, color: green))),
        ))),
        with_: settings(sensitive: ['SECRET']));
    final bounds = tester.getRect(find.byKey(textKey));
    final region = Rect.fromLTRB(bounds.left, bounds.top, bounds.right + 500, bounds.bottom);
    expect(await colorCount(tester, screenImage(events), region, green), 0);
  });

  testWidgets('alternate TextSpan semantics do not bypass masking of the actual painted text', (tester) async {
    const green = Color(0xFF00FF00);
    final textKey = GlobalKey();
    final events = await record(
        tester,
        MaterialApp(
            home: Scaffold(
                body: Align(
          alignment: Alignment.topLeft,
          child: RichText(
              key: textKey,
              text:
                  const TextSpan(text: 'SECRET', semanticsLabel: 'Public accessible label', style: TextStyle(fontSize: 24, color: green))),
        ))),
        with_: settings(sensitive: ['SECRET']));
    final area = tester.getRect(find.byKey(textKey));
    expect(await colorCount(tester, screenImage(events), area, green), 0);
    expect(await colorCount(tester, screenImage(events), area, mask), greaterThan(100));
  });
}
