import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

import 'document.dart';
import 'mask.dart';

/// Areas of a frame painted over before it leaves the device, in logical pixels of the recorded screen.
class ScreenMasks {
  const ScreenMasks(this.masked, this.blocked);

  /// Text fields, [ReplayMask] areas, magnifiers, sensitive text, and all text or images when the options ask for it.
  final List<Rect> masked;

  /// Platform views and textures, which a screen image cannot show.
  final List<Rect> blocked;

  bool get isEmpty => masked.isEmpty && blocked.isEmpty;
}

bool _hasImage(Decoration decoration) =>
    (decoration is BoxDecoration && decoration.image != null) || (decoration is ShapeDecoration && decoration.image != null);

bool _platformView(RenderObject node) =>
    node is PlatformViewRenderBox || node is RenderAndroidView || node is RenderUiKitView || node is RenderAppKitView || node is TextureBox;

// A backdrop filter other than a blur, such as the text selection magnifier, shows an enlarged copy of what lies
// under it, which may be a masked text field.
bool _copiesBackdrop(RenderObject node) {
  if (node is RenderBackdropFilter) return false;
  try {
    // ignore: invalid_use_of_protected_member
    return node.layer is BackdropFilterLayer;
  } catch (_) {
    return false;
  }
}

bool _containsAny(String text, List<String> lowered) {
  if (lowered.isEmpty) return false;
  final value = text.toLowerCase();
  return lowered.any(value.contains);
}

List<String> _lowered(List<String> sensitiveText) =>
    sensitiveText.take(100).where((value) => value.length >= 2).map((value) => value.toLowerCase()).toList();

// Children the way Flutter paints them: offstage routes, hidden IndexedStack children and fully transparent widgets
// are left out, as their semantics are. A widget that only hides its children from accessibility still paints them.
void _visitPainted(RenderObject node, RenderObjectVisitor visitor) {
  final hidesSemantics = (node is RenderExcludeSemantics && node.excluding) ||
      (node is RenderSemanticsAnnotations && node.excludeSemantics) ||
      // ignore: deprecated_member_use
      (node is RenderIgnorePointer && node.ignoringSemantics == true) ||
      // ignore: deprecated_member_use
      (node is RenderAbsorbPointer && node.ignoringSemantics == true) ||
      // ignore: deprecated_member_use
      (node is RenderSliverIgnorePointer && node.ignoringSemantics == true);
  if (hidesSemantics) {
    node.visitChildren(visitor);
  } else {
    node.visitChildrenForSemantics(visitor);
  }
}

// What a parent clips its child to. A viewport paints a sliver under a pinned header too, which its own paint clip
// leaves out, so the whole viewport counts.
Rect? _paintClip(RenderObject parent, RenderObject child) {
  if (parent is RenderViewportBase) return parent.clipBehavior == Clip.none ? null : Offset.zero & parent.size;
  return parent.describeApproximatePaintClip(child);
}

Rect? _bounds(RenderObject node, Matrix4 transform, Rect clip) {
  if (node is RenderBox && !node.hasSize) return null;
  var local = node.paintBounds;
  if (node is RenderParagraph) {
    // paintBounds is the layout box even when TextOverflow.visible paints glyphs beyond it.
    // Selection boxes come from the paragraph Flutter actually laid out, including inline spans.
    final length = node.text.toPlainText(includeSemanticsLabels: false).length;
    for (final box in node.getBoxesForSelection(TextSelection(baseOffset: 0, extentOffset: length))) {
      local = local.expandToInclude(box.toRect());
    }
  }
  final transformed = MatrixUtils.transformRect(transform, local);
  if (!transformed.isFinite) throw StateError('Cannot place private screen content');
  final rect = transformed.intersect(clip);
  return rect.isEmpty || rect.width <= 0 || rect.height <= 0 ? null : rect;
}

/// Finds what to paint over in the subtree of [root], which is the recorded screen.
ScreenMasks collectMasks(
  RenderObject root, {
  required bool maskAllText,
  required bool maskAllImages,
  required List<String> sensitiveText,
}) {
  final masked = <Rect>[], blocked = <Rect>[];
  final lowered = _lowered(sensitiveText);
  final screen = root is RenderBox && root.hasSize ? Offset.zero & root.size : Rect.largest;

  void visit(RenderObject node, Matrix4 transform, Rect clip, {bool insideMask = false}) {
    if (node is RenderBox && !node.hasSize) return;
    var hide = insideMask || (node is RenderReplayMask && node.enabled) || node is RenderEditable || _copiesBackdrop(node);
    if (node is RenderParagraph && !hide) {
      // Accessibility text may differ from the glyphs that are painted.
      hide = maskAllText || _containsAny(node.text.toPlainText(includeSemanticsLabels: false), lowered);
    }
    hide = hide || (maskAllImages && (node is RenderImage || (node is RenderDecoratedBox && _hasImage(node.decoration))));
    if (hide) {
      final rect = _bounds(node, transform, clip);
      if (rect != null) masked.add(rect);
    }
    if (_platformView(node)) {
      final rect = _bounds(node, transform, clip);
      if (rect != null) blocked.add(rect);
      return;
    }
    _visitPainted(node, (child) {
      final childTransform = transform.clone();
      node.applyPaintTransform(child, childTransform);
      var childClip = clip;
      final local = _paintClip(node, child);
      if (local != null) childClip = childClip.intersect(MatrixUtils.transformRect(transform, local));
      if (childClip.isEmpty) return;
      // A mask's layout rectangle need not contain what its children paint (Transform, OverflowBox, etc.).
      // Inspect every painted descendant in its own coordinate system too. Inspection errors reject the frame.
      visit(child, childTransform, childClip, insideMask: hide);
    });
  }

  visit(root, Matrix4.identity(), screen);
  return ScreenMasks(masked, blocked);
}

// Icon fonts draw their glyphs from the private use area, which read as noise in a label.
final RegExp _glyphs = RegExp('[\u{E000}-\u{F8FF}\u{FFFC}]|[\u{DB80}-\u{DBFF}][\u{DC00}-\u{DFFF}]');

String _cleanLabel(String value) => value.replaceAll(_glyphs, ' ').replaceAll(RegExp(r'\s+'), ' ').trim();

String? _controlTag(RenderObject node) {
  if (node is RenderEditable) return 'input';
  if (node is RenderSemanticsAnnotations) {
    final properties = node.properties;
    if (properties.textField == true) return 'input';
    if (properties.link == true) return 'a';
    if (properties.button == true) return 'button';
    if (properties.checked != null || properties.toggled != null || properties.slider == true) return 'input';
  }
  if (node is RenderSemanticsGestureHandler && node.onTap != null) return 'div';
  return null;
}

String? _semanticLabel(RenderObject node) {
  if (node is! RenderSemanticsAnnotations) return null;
  final label = node.properties.label ?? node.properties.tooltip;
  return label == null ? null : _cleanLabel(label);
}

// The texts inside a widget in paint order, as the viewer names a clicked element. Text inside a mask counts as `*`.
(List<String>, bool) _textsOf(RenderObject root, List<String> lowered) {
  final parts = <String>[];
  var length = 0, visited = 0;
  var private = false;
  void visit(RenderObject node) {
    if (visited++ > 10000) {
      private = true;
      return;
    }
    if ((node is RenderReplayMask && node.enabled) || node is RenderEditable || _platformView(node)) {
      private = true;
      if (length <= 80) parts.add('*');
      return;
    }
    if (node is RenderParagraph) {
      String text;
      try {
        final visible = node.text.toPlainText(includeSemanticsLabels: false);
        if (_containsAny(visible, lowered)) private = true;
        text = _containsAny(visible, lowered) ? '*' : _cleanLabel(visible);
      } catch (_) {
        private = true;
        text = '*';
      }
      if (_containsAny(text, lowered)) {
        private = true;
        text = '*';
      }
      if (text.isNotEmpty && length <= 80) {
        parts.add(text);
        length += text.length + 1;
      }
      return;
    }
    _visitPainted(node, visit);
  }

  visit(root);
  return (parts, private);
}

/// A tapped widget's name, and the [ReplayMask] area the tap was in, if any.
class TapResolution {
  const TapResolution(this.target, this.maskedArea);

  final TapTarget target;

  /// Where an enabled [ReplayMask] around the tap is, so the tap's exact position is not recorded.
  final Rect? maskedArea;
}

/// Names the widget at [position], in the coordinates of the view [viewId], for the viewer's list of clicks.
TapResolution? resolveTap(
  RenderObject root,
  Offset position,
  int viewId, {
  required bool maskAllText,
  required List<String> sensitiveText,
}) {
  final result = HitTestResult();
  WidgetsBinding.instance.hitTestInView(result, position, viewId);
  RenderObject? control, deepest, mask, labelOwner;
  String? tag, label;
  // A tooltip or label just above the control, as an icon button has, names it too.
  var above = 0;
  for (final entry in result.path) {
    final target = entry.target;
    if (target is! RenderObject) continue;
    if (identical(target, root)) break;
    deepest ??= target;
    // The outermost mask owns the whole gesture; nested controls must be indistinguishable.
    if (target is RenderReplayMask && target.enabled) mask = target;
    if (control == null || (label == null && above++ < 4)) {
      final candidate = _semanticLabel(target);
      if (label == null && candidate != null) {
        label = candidate;
        labelOwner = target;
      }
    }
    if (control == null) {
      final kind = _controlTag(target);
      if (kind != null) {
        control = target;
        tag = kind;
      }
    }
  }
  final node = control ?? deepest;
  if (node == null) return null;
  // Only a widget inside the recorded screen counts.
  RenderObject? ancestor = node;
  while (ancestor != null && !identical(ancestor, root)) {
    ancestor = ancestor.parent;
  }
  if (ancestor == null) return null;
  Rect? place(RenderObject object) {
    try {
      final rect = MatrixUtils.transformRect(object.getTransformTo(root), object.paintBounds);
      return rect.isFinite ? rect : null;
    } catch (_) {
      return null;
    }
  }

  final lowered = _lowered(sensitiveText);
  final (visibleTexts, _) = _textsOf(node, lowered);
  // A merged accessibility label can repeat a masked descendant's value. Only use it if its entire subtree
  // is public; otherwise name the control from the visible, individually redacted text.
  final labelIsPrivate = labelOwner != null && _textsOf(labelOwner, lowered).$2;
  final parts = tag == 'input' ? const <String>[] : (label != null && label.isNotEmpty && !labelIsPrivate ? [label] : visibleTexts);
  var text = '';
  if (parts.isNotEmpty) {
    // A text holding a sensitive word reads `*`, as it is painted over on screen. Masking comes before the cut, so
    // no piece of such a text survives at the end of a long label.
    text = mask != null || maskAllText ? '*' : parts.map((part) => _containsAny(part, lowered) ? '*' : part).join(' ');
    if (text.length > 40) text = '${text.substring(0, 40).trimRight()}…';
  }
  final maskedArea = mask == null ? null : place(mask);
  if (mask != null && maskedArea == null) throw StateError('Cannot place a ReplayMask');
  return TapResolution(
    TapTarget(
      tag: mask != null ? 'div' : tag ?? (node is RenderImage ? 'img' : 'div'),
      text: mask != null ? '*' : text,
      rect: maskedArea ?? place(node) ?? Rect.fromCenter(center: position, width: 1, height: 1),
    ),
    maskedArea,
  );
}
