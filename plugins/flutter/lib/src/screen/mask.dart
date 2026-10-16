import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

/// Hides [child] in recordings: its area is painted over before a frame leaves the device, and a tap inside it is
/// listed as `*`. Text fields are always masked; use this for other private content, such as names, balances or
/// messages.
class ReplayMask extends SingleChildRenderObjectWidget {
  const ReplayMask({super.key, this.enabled = true, super.child});

  /// Set false to show [child] again, for example when the content stops being private.
  final bool enabled;

  @override
  RenderReplayMask createRenderObject(BuildContext context) => RenderReplayMask(enabled: enabled);

  @override
  void updateRenderObject(BuildContext context, RenderReplayMask renderObject) {
    renderObject.enabled = enabled;
  }
}

/// The render object of [ReplayMask], which the recorder looks for. It paints its child unchanged.
class RenderReplayMask extends RenderProxyBox {
  RenderReplayMask({bool enabled = true, RenderBox? child})
      : _enabled = enabled,
        super(child);

  bool _enabled;

  bool get enabled => _enabled;

  set enabled(bool value) {
    if (value == _enabled) return;
    _enabled = value;
    // The next frame is recorded with the new mask.
    markNeedsPaint();
  }
}
