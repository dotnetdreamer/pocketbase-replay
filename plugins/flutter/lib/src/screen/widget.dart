import 'dart:ui' show PlatformDispatcher;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'recorder.dart';

/// Marks the part of the app that is recorded, normally all of it:
///
/// ```dart
/// runApp(const PocketBaseReplayWidget(child: MyApp()));
/// ```
///
/// It adds a repaint boundary and a pointer listener, and changes nothing else. Without it nothing is recorded,
/// since activity such as PocketBase calls travels inside the recording; errors and logs still work.
class PocketBaseReplayWidget extends StatefulWidget {
  const PocketBaseReplayWidget({super.key, required this.child});

  final Widget child;

  @override
  State<PocketBaseReplayWidget> createState() => _PocketBaseReplayWidgetState();
}

class _PocketBaseReplayWidgetState extends State<PocketBaseReplayWidget> implements ScreenHost {
  final GlobalKey _key = GlobalKey(debugLabel: 'PocketBaseReplayWidget');

  @override
  void initState() {
    super.initState();
    ScreenRecorder.instance.attach(this);
  }

  @override
  void dispose() {
    ScreenRecorder.instance.detach(this);
    super.dispose();
  }

  @override
  RenderRepaintBoundary? get boundary {
    final object = _key.currentContext?.findRenderObject();
    return object is RenderRepaintBoundary ? object : null;
  }

  @override
  int get viewId {
    if (mounted) {
      final view = View.maybeOf(context);
      if (view != null) return view.viewId;
    }
    return PlatformDispatcher.instance.implicitView?.viewId ?? 0;
  }

  @override
  Widget build(BuildContext context) {
    final recorder = ScreenRecorder.instance;
    return RepaintBoundary(
      key: _key,
      child: Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: recorder.pointerDown,
        onPointerMove: recorder.pointerMove,
        onPointerUp: recorder.pointerUp,
        onPointerCancel: recorder.pointerCancel,
        onPointerHover: recorder.pointerHover,
        child: widget.child,
      ),
    );
  }
}
