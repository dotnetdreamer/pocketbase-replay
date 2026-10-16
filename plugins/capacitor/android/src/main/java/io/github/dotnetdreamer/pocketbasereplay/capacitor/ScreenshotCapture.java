package io.github.dotnetdreamer.pocketbasereplay.capacitor;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.ByteArrayOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

/** Captures only the WebView, and never releases pixels without two matching privacy plans. */
final class ScreenshotCapture {
    private final PocketBaseReplayPlugin plugin;
    private final Handler main = new Handler(Looper.getMainLooper());
    private Pending pending;
    private long generation;

    ScreenshotCapture(PocketBaseReplayPlugin plugin) {
        this.plugin = plugin;
    }

    void capture(PluginCall call) {
        main.post(() -> begin(call));
    }

    void invalidate() {
        generation++;
        if (pending != null) finish(pending, "Screenshot capture is inactive");
    }

    private void begin(PluginCall call) {
        String requestId = call.getString("requestId");
        Object dimension = call.getData().opt("maxDimension");
        int maximum = ScreenshotGeometry.MAX_DIMENSION;
        if (requestId == null || !requestId.matches("[a-z0-9]{20}")) {
            call.reject("Invalid screenshot request");
            return;
        }
        if (dimension != null && dimension != JSONObject.NULL) {
            if (!(dimension instanceof Number)) {
                call.reject("Invalid screenshot dimensions");
                return;
            }
            double value = ((Number) dimension).doubleValue();
            if (!ScreenshotGeometry.finite(value) || value != Math.rint(value)
                || value < ScreenshotGeometry.MIN_DIMENSION || value > ScreenshotGeometry.MAX_DIMENSION) {
                call.reject("Invalid screenshot dimensions");
                return;
            }
            maximum = (int) value;
        }
        if (pending != null) {
            call.reject("Screenshot capture is busy");
            return;
        }
        WebView view = plugin.getBridge().getWebView();
        if (!available(view)) {
            call.reject("Screenshot capture is inactive");
            return;
        }
        Pending request = new Pending(call, requestId, maximum, view, generation);
        pending = request;
        request.timeout = () -> finish(request, "Screenshot privacy check timed out");
        main.postDelayed(request.timeout, 5000);
        probe(request, false);
    }

    private boolean available(WebView view) {
        Activity activity = plugin.getActivity();
        return activity != null && !activity.isFinishing() && !activity.isDestroyed()
            && !plugin.screenshotPaused && plugin.getBridge().getApp().isActive()
            && (activity.getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) == 0
            && view != null && view.isAttachedToWindow() && view.getWindowVisibility() == View.VISIBLE
            && view.getVisibility() == View.VISIBLE && view.hasWindowFocus() && view.isShown()
            && view.getWidth() > 0 && view.getHeight() > 0;
    }

    private boolean current(Pending request) {
        return pending == request && generation == request.generation && available(request.view)
            && request.nativeWidth == request.view.getWidth() && request.nativeHeight == request.view.getHeight();
    }

    private void probe(Pending request, boolean afterCapture) {
        if (!current(request)) {
            finish(request, "Screenshot capture is inactive");
            return;
        }
        // The validated identifier contains no characters requiring JavaScript escaping.
        String script = "window.__pocketbaseReplayScreenshot && window.__pocketbaseReplayScreenshot(\"" + request.id + "\")";
        try {
            request.view.evaluateJavascript(script, result -> {
                if (pending != request) return;
                if (!current(request)) {
                    finish(request, "Screenshot capture is inactive");
                    return;
                }
                try {
                    Plan plan = Plan.parse(result, request.id);
                    if (afterCapture) {
                        if (!request.plan.same(plan)) throw new IllegalArgumentException("Screenshot privacy plan changed");
                        encode(request);
                    } else {
                        request.plan = plan;
                        // Wait until this plan's preceding DOM changes are included in WebView's next draw.
                        // Without this fence, pixels could still show a private node at its old position.
                        request.view.postVisualStateCallback(request.generation, new WebView.VisualStateCallback() {
                            @Override
                            public void onComplete(long requestId) {
                                if (pending != request) return;
                                if (!current(request)) {
                                    finish(request, "Screenshot capture is inactive");
                                    return;
                                }
                                try {
                                    draw(request);
                                } catch (Exception | OutOfMemoryError error) {
                                    finish(request, "Screenshot capture failed");
                                }
                            }
                        });
                    }
                } catch (Exception | OutOfMemoryError error) {
                    finish(request, "Screenshot privacy check failed");
                }
            });
        } catch (Exception error) {
            finish(request, "Screenshot privacy check failed");
        }
    }

    private void draw(Pending request) {
        int[] size = ScreenshotGeometry.fit(request.nativeWidth, request.nativeHeight, request.maximum);
        request.bitmap = Bitmap.createBitmap(size[0], size[1], Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(request.bitmap);
        canvas.save();
        canvas.scale((float) size[0] / request.nativeWidth, (float) size[1] / request.nativeHeight);
        request.view.draw(canvas);
        canvas.restore();
        Paint mask = new Paint();
        mask.setColor(Color.rgb(158, 158, 158));
        mask.setStyle(Paint.Style.FILL);
        for (double[] rectangle : request.plan.rectangles) {
            int[] area = ScreenshotGeometry.mask(rectangle[0], rectangle[1], rectangle[2], rectangle[3],
                request.plan.width, request.plan.height, size[0], size[1]);
            if (area[2] > area[0] && area[3] > area[1]) canvas.drawRect(area[0], area[1], area[2], area[3], mask);
        }
        // JavaScript may have moved private content while WebView.draw was pending; discard on any change.
        probe(request, true);
    }

    private void encode(Pending request) {
        byte[] png = null;
        // Four bounded attempts cover 1280 -> 640 -> 320 -> 256 for high entropy frames.
        for (int attempt = 0; attempt < 4; attempt++) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            if (!request.bitmap.compress(Bitmap.CompressFormat.PNG, 100, bytes)) {
                finish(request, "Screenshot encoding failed");
                return;
            }
            if (bytes.size() <= ScreenshotGeometry.MAX_PNG_BYTES) {
                png = bytes.toByteArray();
                break;
            }
            int longest = Math.max(request.bitmap.getWidth(), request.bitmap.getHeight());
            if (longest <= ScreenshotGeometry.MIN_DIMENSION || attempt == 3) break;
            int[] next = ScreenshotGeometry.fit(request.bitmap.getWidth(), request.bitmap.getHeight(), Math.max(256, longest / 2));
            Bitmap reduced = Bitmap.createScaledBitmap(request.bitmap, next[0], next[1], true);
            request.bitmap.recycle();
            request.bitmap = reduced;
        }
        if (png == null || !current(request)) {
            finish(request, "Screenshot exceeds the upload limit or capture became inactive");
            return;
        }
        JSObject result = new JSObject();
        result.put("data", "data:image/png;base64," + Base64.encodeToString(png, Base64.NO_WRAP));
        result.put("width", request.plan.width);
        result.put("height", request.plan.height);
        finish(request, null);
        request.call.resolve(result);
    }

    private void finish(Pending request, String failure) {
        if (pending != request) return;
        pending = null;
        main.removeCallbacks(request.timeout);
        if (request.bitmap != null && !request.bitmap.isRecycled()) request.bitmap.recycle();
        request.bitmap = null;
        if (failure != null) request.call.reject(failure);
    }

    private static final class Pending {
        final PluginCall call;
        final String id;
        final int maximum;
        final WebView view;
        final long generation;
        final int nativeWidth;
        final int nativeHeight;
        Runnable timeout;
        Plan plan;
        Bitmap bitmap;

        Pending(PluginCall call, String id, int maximum, WebView view, long generation) {
            this.call = call;
            this.id = id;
            this.maximum = maximum;
            this.view = view;
            this.generation = generation;
            nativeWidth = view.getWidth();
            nativeHeight = view.getHeight();
        }
    }

    static final class Plan {
        String revision;
        double width;
        double height;
        double[][] rectangles;

        static Plan parse(String evaluated, String requestId) throws Exception {
            if (evaluated == null || evaluated.length() > 1048576) throw new IllegalArgumentException("Invalid screenshot plan");
            Object decoded = new JSONTokener(evaluated).nextValue();
            if (!(decoded instanceof String)) throw new IllegalArgumentException("Missing screenshot plan");
            JSONObject json = new JSONObject((String) decoded);
            if (!requestId.equals(json.get("requestId"))) throw new IllegalArgumentException("Unmatched screenshot plan");
            Object revision = json.get("revision");
            if (!(revision instanceof String) || ((String) revision).length() < 1 || ((String) revision).length() > 512) {
                throw new IllegalArgumentException("Invalid screenshot revision");
            }
            Plan plan = new Plan();
            plan.revision = (String) revision;
            plan.width = number(json, "width");
            plan.height = number(json, "height");
            if (!ScreenshotGeometry.viewport(plan.width, plan.height)) throw new IllegalArgumentException("Invalid screenshot viewport");
            JSONArray rectangles = json.getJSONArray("rects");
            if (rectangles.length() > 2000) throw new IllegalArgumentException("Screenshot mask limit exceeded");
            plan.rectangles = new double[rectangles.length()][4];
            for (int index = 0; index < rectangles.length(); index++) {
                JSONObject rect = rectangles.getJSONObject(index);
                double[] values = { number(rect, "x"), number(rect, "y"), number(rect, "width"), number(rect, "height") };
                if (!ScreenshotGeometry.rectangle(values[0], values[1], values[2], values[3])) {
                    throw new IllegalArgumentException("Invalid screenshot mask");
                }
                plan.rectangles[index] = values;
            }
            return plan;
        }

        private static double number(JSONObject object, String name) throws Exception {
            Object value = object.get(name);
            if (!(value instanceof Number)) throw new IllegalArgumentException("Invalid screenshot number");
            return ((Number) value).doubleValue();
        }

        boolean same(Plan other) {
            if (!revision.equals(other.revision) || width != other.width || height != other.height || rectangles.length != other.rectangles.length) return false;
            for (int index = 0; index < rectangles.length; index++) {
                for (int coordinate = 0; coordinate < 4; coordinate++) {
                    if (rectangles[index][coordinate] != other.rectangles[index][coordinate]) return false;
                }
            }
            return true;
        }
    }
}
