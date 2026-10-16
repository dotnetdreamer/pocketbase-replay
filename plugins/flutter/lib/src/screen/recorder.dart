import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/scheduler.dart';

import '../activity/activity.dart';
import '../activity/navigation.dart';
import '../engine.dart';
import '../events.dart';
import 'document.dart';
import 'frames.dart';
import 'inspect.dart';

/// The widget whose subtree is recorded, which [PocketBaseReplayWidget] provides.
abstract class ScreenHost {
  RenderRepaintBoundary? get boundary;

  /// The view the recorded screen is in, for hit testing a tap.
  int get viewId;
}

abstract final class ScreenLimits {
  // A larger frame is taken again at a lower pixel ratio, so one event stays well inside an upload.
  static const int framePngBytes = 240 * 1024;
  // Changed areas drawn over one screen image before the next whole image replaces them.
  static const int patches = 24;
  static const int touchMoveMs = 50;
  static const int mouseMoveMs = 100;
  static const int doubleTapMs = 300;
  static const double doubleTapDistance = 40;
  // Captures that fail in a row wait longer each time, and stop for good after this many.
  static const int failures = 8;
  static const int failureWaitMs = 60000;
}

const Color _maskColor = Color(0xFF9E9E9E);
const Color _blockColor = Color(0xFFD9D9D9);

Rect _imageRect(Rect rect, double ratio) => Rect.fromLTRB(
      (rect.left * ratio).floorToDouble(),
      (rect.top * ratio).floorToDouble(),
      (rect.right * ratio).ceilToDouble(),
      (rect.bottom * ratio).ceilToDouble(),
    );

/// Records the app's screen as rrweb events: an image of the screen whenever it changed, at most once per frame
/// interval, as a whole image or as the area that changed, with masks painted in before it leaves the device; and
/// touches, with the tapped widget named for the activity panel.
class ScreenRecorder implements ReplayRecorder {
  ScreenRecorder._();

  static final ScreenRecorder instance = ScreenRecorder._();
  static bool _hooked = false;
  static bool _warned = false;

  /// Called when a [PocketBaseReplayWidget] puts a screen in place, so recording can start.
  void Function()? onAttach;

  ScreenHost? _host;
  void Function(ReplayEvent event)? _emit;
  RecorderSettings? _settings;
  ActivityRecorder? _activity;
  bool _running = false;
  int _generation = 0;
  final ScreenDocument _document = ScreenDocument();
  bool _needFull = true;
  bool _dirty = true;
  bool _busy = false;
  bool _afterFrame = false;
  Timer? _timer;
  int _lastCapture = 0;
  Uint32List? _previous;
  Size? _previousSize;
  double _previousRatio = 0;
  int _shrink = 0;
  int _frames = 0;
  int _failures = 0;
  // Whether the wait after the last failed capture has passed.
  bool _retryReady = false;

  int? _pointer;
  bool _mouse = false;
  Offset _downAt = Offset.zero;
  double _travel = 0;
  TapResolution? _tap;
  int _lastMove = 0;
  int? _lastClickAt;
  Offset _lastClick = Offset.zero;

  @override
  int get frames => _frames;

  @override
  bool get available => _host != null;

  /// Whether a recorder runs and the screen it records is on screen.
  @visibleForTesting
  bool get capturing => _running && _host != null;

  int _now() => DateTime.now().millisecondsSinceEpoch;

  List<String> _sensitiveText() {
    try {
      return _settings?.sensitiveText() ?? const [];
    } catch (_) {
      return const [];
    }
  }

  void attach(ScreenHost host) {
    _host = host;
    _needFull = true;
    _previous = null;
    _failures = 0;
    _retryReady = false;
    _request(immediate: true);
    try {
      onAttach?.call();
    } catch (_) {
      // Recording stays optional.
    }
  }

  void detach(ScreenHost host) {
    if (!identical(_host, host)) return;
    _host = null;
    // Nothing is on screen to capture until a screen attaches again.
    _timer?.cancel();
    _timer = null;
  }

  @override
  void Function()? start(void Function(ReplayEvent event) emit, RecorderSettings settings) {
    _stop();
    // Without a screen there is nothing to record; the engine asks again once one attaches.
    if (_host == null) {
      if (kDebugMode && !_warned) {
        _warned = true;
        debugPrint('PocketBaseReplay: wrap your app in PocketBaseReplayWidget to record its screen');
      }
      return null;
    }
    final generation = ++_generation;
    _emit = emit;
    _settings = settings;
    _running = true;
    _needFull = true;
    _dirty = true;
    _shrink = 0;
    _failures = 0;
    _retryReady = false;
    _previous = null;
    _document.reset();
    _activity = ActivityRecorder(emit, settings)..start();
    if (!_hooked) {
      _hooked = true;
      // Persistent callbacks cannot be removed, so one serves every recorder and does nothing while none runs.
      SchedulerBinding.instance.addPersistentFrameCallback((_) => instance._onFrame());
    }
    _request(immediate: true);
    return () {
      if (generation == _generation) _stop();
    };
  }

  @override
  void snapshot() {
    if (!_running) return;
    _needFull = true;
    _request(immediate: true);
  }

  void _stop() {
    if (!_running) return;
    _running = false;
    _generation++;
    // A capture still finishing belongs to the old recording and is dropped when it ends.
    _busy = false;
    _afterFrame = false;
    _timer?.cancel();
    _timer = null;
    _activity?.stop();
    _activity = null;
    _emit = null;
    _settings = null;
    _previous = null;
    _document.reset();
    _pointer = null;
    _tap = null;
  }

  void _onFrame() {
    if (!_running) return;
    _dirty = true;
    _request();
  }

  void _request({bool immediate = false}) {
    if (!_running || _busy || _afterFrame || _host == null || _failures >= ScreenLimits.failures) return;
    if (!_dirty && !_needFull) return;
    final int interval = _settings!.frameInterval.inMilliseconds.clamp(100, 60000);
    // After a failure the next attempt waits, twice as long each time, so a screen that cannot be captured costs
    // nothing in a loop.
    if (_failures > 0 && !_retryReady) {
      _timer ??= Timer(Duration(milliseconds: min(interval << min(_failures, 9), ScreenLimits.failureWaitMs)), () {
        _timer = null;
        _retryReady = true;
        _request();
      });
      return;
    }
    final int wait = _failures > 0 || immediate || _needFull ? 0 : _lastCapture + interval - _now();
    if (wait > 0) {
      _timer ??= Timer(Duration(milliseconds: wait), () {
        _timer = null;
        _request();
      });
      return;
    }
    final binding = SchedulerBinding.instance;
    final phase = binding.schedulerPhase;
    // Between frames, or once this one is painted, the screen can be captured now; a frame on its way calls back.
    if (phase == SchedulerPhase.idle || phase == SchedulerPhase.postFrameCallbacks) {
      if (phase == SchedulerPhase.idle && binding.hasScheduledFrame) return;
      unawaited(_capture());
      return;
    }
    // Inside a frame the screen is captured once it has been painted.
    _afterFrame = true;
    binding.addPostFrameCallback((_) {
      _afterFrame = false;
      unawaited(_capture());
    });
  }

  Future<ui.Image> _paintMasks(ui.Image image, ScreenMasks masks, double ratio) async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder)..drawImage(image, Offset.zero, Paint());
    final mask = Paint()..color = _maskColor;
    final block = Paint()..color = _blockColor;
    for (final rect in masks.masked) {
      canvas.drawRect(_imageRect(rect, ratio), mask);
    }
    for (final rect in masks.blocked) {
      canvas.drawRect(_imageRect(rect, ratio), block);
    }
    final picture = recorder.endRecording();
    try {
      return await picture.toImage(image.width, image.height);
    } finally {
      picture.dispose();
    }
  }

  Future<Uint8List?> _png(ui.Image image, [PixelRegion? region]) async {
    if (region == null) {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      return data?.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    }
    final recorder = ui.PictureRecorder();
    Canvas(recorder).drawImageRect(
      image,
      Rect.fromLTRB(region.left.toDouble(), region.top.toDouble(), region.right.toDouble(), region.bottom.toDouble()),
      Rect.fromLTWH(0, 0, region.width.toDouble(), region.height.toDouble()),
      Paint()..filterQuality = FilterQuality.none,
    );
    final picture = recorder.endRecording();
    ui.Image? crop;
    try {
      crop = await picture.toImage(region.width, region.height);
      final data = await crop.toByteData(format: ui.ImageByteFormat.png);
      return data?.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
    } finally {
      crop?.dispose();
      picture.dispose();
    }
  }

  Future<void> _capture() async {
    if (!_running || _busy) return;
    final boundary = _host?.boundary;
    final settings = _settings;
    if (boundary == null || settings == null || !boundary.attached || !boundary.hasSize || boundary.size.isEmpty) return;
    // Painted with the next frame, which asks again.
    if (kDebugMode && boundary.debugNeedsPaint) return;
    final generation = _generation;
    final size = boundary.size;
    final ratio = frameRatio(settings.pixelRatio, size.width, size.height, steps: _shrink);
    // A frame whose masks cannot be worked out is not recorded at all.
    final ScreenMasks masks;
    final Future<ui.Image> shot;
    try {
      masks =
          collectMasks(boundary, maskAllText: settings.maskAllText, maskAllImages: settings.maskAllImages, sensitiveText: _sensitiveText());
      shot = boundary.toImage(pixelRatio: ratio);
    } catch (_) {
      _failures++;
      _retryReady = false;
      _lastCapture = _now();
      return;
    }
    final full = _needFull || _previous == null || _previousSize != size || _previousRatio != ratio;
    _retryReady = false;
    _busy = true;
    _dirty = false;
    _needFull = false;
    _lastCapture = _now();
    ui.Image? image, frame;
    var failed = true;
    try {
      image = await shot;
      if (masks.isEmpty) {
        frame = image;
      } else {
        frame = await _paintMasks(image, masks, ratio);
        image.dispose();
      }
      image = null;
      if (generation != _generation) return;
      final width = frame.width, height = frame.height;
      final raw = await frame.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (raw == null || generation != _generation) return;
      final pixels = raw.buffer.asUint32List(raw.offsetInBytes, width * height);
      PixelRegion? region;
      if (!full) {
        final changed = changedRegion(_previous!, pixels, width, height);
        if (changed == null) {
          failed = false;
          return;
        }
        region = alignRegion(changed, pixelAlignment(ratio), width, height);
      }
      final patch = region != null && region.area * 2 < width * height && _document.patchCount < ScreenLimits.patches;
      final png = await _png(frame, patch ? region : null);
      if (png == null || generation != _generation) return;
      if (png.length > ScreenLimits.framePngBytes) {
        failed = false;
        // Taken again, whole and smaller; too large even at the smallest size, it is skipped until the screen changes.
        if (ratio > 0.25) {
          _shrink++;
          _needFull = true;
        }
        return;
      }
      final emit = _emit;
      if (emit == null) return;
      final data = 'data:image/png;base64,${base64Encode(png)}';
      final now = _now();
      if (full) {
        for (final event in _document.fullSnapshot(
          href: ReplayNavigatorObserver.currentUrl,
          width: size.width,
          height: size.height,
          image: data,
          timestamp: now,
        )) {
          emit(event);
        }
      } else if (patch) {
        emit(_document.addPatch(
          data,
          Rect.fromLTRB(region.left / ratio, region.top / ratio, region.right / ratio, region.bottom / ratio),
          now,
        ));
      } else {
        emit(_document.replaceScreen(data, now));
      }
      _frames++;
      _previous = pixels;
      _previousSize = size;
      _previousRatio = ratio;
      failed = false;
    } catch (_) {
      // A failed frame is taken again whole, after a wait.
    } finally {
      image?.dispose();
      frame?.dispose();
      if (generation == _generation) {
        if (failed) {
          _failures++;
          _needFull = true;
        } else {
          _failures = 0;
        }
        _busy = false;
        _request();
      }
    }
  }

  bool get _input => _running && _document.ready && _emit != null;

  void _interaction(int type, int id, Offset position) {
    _emit?.call(ReplayEvent(EventType.incrementalSnapshot, _now(), {
      'source': IncrementalSource.mouseInteraction,
      'type': type,
      'id': id,
      'x': position.dx.round(),
      'y': position.dy.round(),
      'pointerType': _mouse ? 0 : 2,
    }));
  }

  void _move(Offset position, Offset global) {
    final now = _now();
    if (now - _lastMove < (_mouse ? ScreenLimits.mouseMoveMs : ScreenLimits.touchMoveMs)) return;
    _lastMove = now;
    position = _place(position, global);
    _emit?.call(ReplayEvent(EventType.incrementalSnapshot, now, {
      'source': _mouse ? IncrementalSource.mouseMove : IncrementalSource.touchMove,
      'positions': [
        {'x': position.dx.round(), 'y': position.dy.round(), 'id': ScreenDocument.screen, 'timeOffset': 0},
      ],
    }));
  }

  TapResolution? _resolve(Offset global) {
    final host = _host, settings = _settings;
    final boundary = host?.boundary;
    if (host == null || settings == null || boundary == null) return null;
    try {
      return resolveTap(boundary, global, host.viewId, maskAllText: settings.maskAllText, sensitiveText: _sensitiveText());
    } catch (_) {
      // If a mask cannot be inspected, no exact location or control name is safe to upload.
      final area = Offset.zero & boundary.size;
      return TapResolution(TapTarget(tag: 'div', text: '*', rect: area), area);
    }
  }

  // A touch inside a ReplayMask is recorded at the mask's centre, so the keys of a masked PIN pad cannot be read
  // back from where they were pressed.
  Offset _place(Offset position, Offset global) => _tap?.maskedArea?.center ?? _resolve(global)?.maskedArea?.center ?? position;

  void pointerDown(PointerDownEvent event) {
    if (!_input || _pointer != null) return;
    _pointer = event.pointer;
    _mouse = event.kind == PointerDeviceKind.mouse;
    _downAt = event.localPosition;
    _travel = 0;
    // Named now, before the tap changes the screen.
    _tap = _resolve(event.position);
    _interaction(_mouse ? MouseInteraction.mouseDown : MouseInteraction.touchStart, ScreenDocument.screen,
        _place(event.localPosition, event.position));
  }

  void pointerMove(PointerMoveEvent event) {
    if (event.pointer != _pointer || !_input) return;
    _travel = max(_travel, (event.localPosition - _downAt).distance);
    if (_tap?.maskedArea == null) _move(event.localPosition, event.position);
  }

  void pointerUp(PointerUpEvent event) {
    if (event.pointer != _pointer) return;
    _pointer = null;
    final tap = _tap;
    if (!_input) {
      _tap = null;
      return;
    }
    final position = _place(event.localPosition, event.position);
    _tap = null;
    _interaction(_mouse ? MouseInteraction.mouseUp : MouseInteraction.touchEnd, ScreenDocument.screen, position);
    if (_travel > kTouchSlop) return;
    var id = ScreenDocument.screen;
    if (tap != null) {
      final (written, tapId) = _document.tapTarget(tap.target, _now());
      _emit?.call(written);
      id = tapId;
    }
    _interaction(MouseInteraction.click, id, position);
    final now = _now();
    final last = _lastClickAt;
    if (last != null && now - last < ScreenLimits.doubleTapMs && (position - _lastClick).distance < ScreenLimits.doubleTapDistance) {
      _interaction(MouseInteraction.dblClick, id, position);
      _lastClickAt = null;
    } else {
      _lastClickAt = now;
      _lastClick = position;
    }
  }

  void pointerCancel(PointerCancelEvent event) {
    if (event.pointer != _pointer) return;
    _pointer = null;
    final position = _place(event.localPosition, event.position);
    _tap = null;
    if (_input && !_mouse) _interaction(MouseInteraction.touchCancel, ScreenDocument.screen, position);
  }

  void pointerHover(PointerHoverEvent event) {
    if (!_input || event.kind != PointerDeviceKind.mouse || _pointer != null) return;
    _mouse = true;
    _move(event.localPosition, event.position);
  }
}
