import 'dart:math';
import 'dart:typed_data';

/// A rectangle of image pixels, with exclusive right and bottom edges.
class PixelRegion {
  const PixelRegion(this.left, this.top, this.right, this.bottom);

  final int left;
  final int top;
  final int right;
  final int bottom;

  int get width => right - left;
  int get height => bottom - top;
  int get area => width * height;

  @override
  bool operator ==(Object other) =>
      other is PixelRegion && other.left == left && other.top == top && other.right == right && other.bottom == bottom;

  @override
  int get hashCode => Object.hash(left, top, right, bottom);

  @override
  String toString() => 'PixelRegion($left, $top, $right, $bottom)';
}

/// The smallest rectangle holding every pixel that differs between two frames of the same size, or null when none
/// does. Pixels are compared as whole RGBA words.
PixelRegion? changedRegion(Uint32List previous, Uint32List next, int width, int height) {
  var top = -1;
  for (var y = 0; y < height && top < 0; y++) {
    final row = y * width;
    for (var x = 0; x < width; x++) {
      if (previous[row + x] != next[row + x]) {
        top = y;
        break;
      }
    }
  }
  if (top < 0) return null;
  var bottom = top;
  for (var y = height - 1; y > top; y--) {
    final row = y * width;
    var differs = false;
    for (var x = 0; x < width; x++) {
      if (previous[row + x] != next[row + x]) {
        differs = true;
        break;
      }
    }
    if (differs) {
      bottom = y;
      break;
    }
  }
  var left = width, right = -1;
  for (var y = top; y <= bottom; y++) {
    final row = y * width;
    for (var x = 0; x < left; x++) {
      if (previous[row + x] != next[row + x]) {
        left = x;
        break;
      }
    }
    for (var x = width - 1; x > right; x--) {
      if (previous[row + x] != next[row + x]) {
        right = x;
        break;
      }
    }
  }
  return PixelRegion(left, top, right + 1, bottom + 1);
}

int _gcd(int a, int b) => b == 0 ? a : _gcd(b, a % b);

/// How many image pixels make a whole number of CSS pixels at [ratio], a multiple of 0.25, so a changed area drawn
/// over the screen image lines up with it exactly.
int pixelAlignment(double ratio) {
  final quarters = max(1, (ratio * 4).round());
  return quarters ~/ _gcd(quarters, 4);
}

/// [region] grown outward to multiples of [align], within the image.
PixelRegion alignRegion(PixelRegion region, int align, int width, int height) {
  if (align <= 1) return region;
  return PixelRegion(
    region.left ~/ align * align,
    region.top ~/ align * align,
    min(width, (region.right + align - 1) ~/ align * align),
    min(height, (region.bottom + align - 1) ~/ align * align),
  );
}

/// The image pixels per logical pixel for a screen of [width] by [height]: the requested ratio, at most 1280 pixels
/// on the longer side, rounded down to a multiple of 0.25 and at least 0.25.
double frameRatio(double requested, double width, double height, {int steps = 0}) {
  var ratio = requested.isFinite ? requested.clamp(0.25, 2.0) : 1.0;
  final longest = max(width, height);
  if (longest > 0 && longest * ratio > 1280) ratio = 1280 / longest;
  ratio = (ratio * 4).floor() / 4 - steps * 0.25;
  return max(0.25, ratio);
}
