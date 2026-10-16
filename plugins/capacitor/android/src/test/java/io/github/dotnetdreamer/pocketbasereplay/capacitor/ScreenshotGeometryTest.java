package io.github.dotnetdreamer.pocketbasereplay.capacitor;

import static org.junit.Assert.*;
import org.junit.Test;

public class ScreenshotGeometryTest {
    @Test
    public void boundsMemoryAndPreservesViewportAspectRatio() {
        assertArrayEquals(new int[] { 640, 1280 }, ScreenshotGeometry.fit(1200, 2400, 1280));
        assertArrayEquals(new int[] { 1280, 640 }, ScreenshotGeometry.fit(20000, 10000, 1280));
        assertArrayEquals(new int[] { 123, 234 }, ScreenshotGeometry.fit(123, 234, 1280));
        assertArrayEquals(new int[] { 1, 256 }, ScreenshotGeometry.fit(1, 20000, 256));
    }

    @Test
    public void masksIncludeAntialiasedEdgesAndClipToTheCapturedViewport() {
        assertArrayEquals(new int[] { 49, 24, 76, 51 }, ScreenshotGeometry.mask(100, 50, 50, 50, 400, 800, 200, 400));
        assertArrayEquals(new int[] { 0, 0, 17, 12 }, ScreenshotGeometry.mask(-10, -5, 25, 15, 400, 800, 400, 800));
        assertArrayEquals(new int[] { 388, 788, 400, 800 }, ScreenshotGeometry.mask(390, 790, 50, 50, 400, 800, 400, 800));
        assertArrayEquals(new int[] { 400, 0, 400, 12 }, ScreenshotGeometry.mask(500, 0, 10, 10, 400, 800, 400, 800));
    }

    @Test
    public void unsafeOrUnboundedGeometryFailsClosed() {
        assertFalse(ScreenshotGeometry.viewport(Double.NaN, 400));
        assertFalse(ScreenshotGeometry.viewport(400, Double.POSITIVE_INFINITY));
        assertFalse(ScreenshotGeometry.viewport(0, 400));
        assertFalse(ScreenshotGeometry.viewport(400, 20001));
        assertFalse(ScreenshotGeometry.rectangle(0, 0, -1, 20));
        assertFalse(ScreenshotGeometry.rectangle(Double.NEGATIVE_INFINITY, 0, 10, 20));
        assertFalse(ScreenshotGeometry.rectangle(0, 0, 10, Double.NaN));
        assertTrue(ScreenshotGeometry.rectangle(-30, 0, 50, 20));
        assertTrue(ScreenshotGeometry.viewport(400, 800));
    }
}
