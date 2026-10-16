package io.github.dotnetdreamer.pocketbasereplay.capacitor;

/** Geometry shared by the native capture and its JVM tests. All mask coordinates are CSS pixels. */
final class ScreenshotGeometry {
    static final int MAX_DIMENSION = 1280;
    static final int MIN_DIMENSION = 256;
    static final int MAX_PNG_BYTES = 196608;

    private ScreenshotGeometry() {}

    static boolean finite(double value) {
        return !Double.isNaN(value) && !Double.isInfinite(value);
    }

    static boolean viewport(double width, double height) {
        return finite(width) && finite(height) && width >= 1 && height >= 1 && width <= 20000 && height <= 20000;
    }

    static boolean rectangle(double x, double y, double width, double height) {
        return finite(x) && finite(y) && finite(width) && finite(height)
            && Math.abs(x) <= 40000 && Math.abs(y) <= 40000
            && width > 0 && height > 0 && width <= 40000 && height <= 40000;
    }

    static int[] fit(int width, int height, int maximum) {
        if (width <= 0 || height <= 0 || maximum < 1) {
            throw new IllegalArgumentException("Invalid screenshot dimensions");
        }
        double scale = Math.min(1.0, (double) maximum / Math.max(width, height));
        return new int[] { Math.max(1, (int) Math.round(width * scale)), Math.max(1, (int) Math.round(height * scale)) };
    }

    static int[] mask(double x, double y, double width, double height, double cssWidth, double cssHeight, int pixelWidth, int pixelHeight) {
        // Expand before rounding so antialiased private edges cannot survive at any output scale.
        int left = (int) Math.floor(Math.max(0, x - 2) / cssWidth * pixelWidth);
        int top = (int) Math.floor(Math.max(0, y - 2) / cssHeight * pixelHeight);
        int right = (int) Math.ceil(Math.min(cssWidth, x + width + 2) / cssWidth * pixelWidth);
        int bottom = (int) Math.ceil(Math.min(cssHeight, y + height + 2) / cssHeight * pixelHeight);
        return new int[] {
            Math.max(0, Math.min(pixelWidth, left)), Math.max(0, Math.min(pixelHeight, top)),
            Math.max(0, Math.min(pixelWidth, right)), Math.max(0, Math.min(pixelHeight, bottom))
        };
    }
}
