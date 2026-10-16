package io.github.dotnetdreamer.pocketbasereplay.capacitor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PocketBaseReplay")
public class PocketBaseReplayPlugin extends Plugin {

    static final String EVENT_APP_STATE_CHANGE = "appStateChange";
    private ScreenshotCapture screenshots;
    boolean screenshotPaused;

    @PluginMethod
    public void captureScreenshot(PluginCall call) {
        if (getActivity() == null) {
            call.reject("Screenshot capture is inactive");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (screenshots == null) screenshots = new ScreenshotCapture(this);
            screenshots.capture(call);
        });
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        screenshotPaused = true;
        if (screenshots != null) screenshots.invalidate();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        screenshotPaused = true;
        if (screenshots != null) screenshots.invalidate();
    }

    // The lifecycle hooks, not the bridge's app status listener: that has one slot, and @capacitor/app takes it.
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        screenshotPaused = false;
        notifyAppState(true);
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        // BridgeActivity marks the app inactive just before this, once its last activity stops.
        // A sheet or dialog over the app only pauses it, so recording carries on, as with @capacitor/app.
        if (!getBridge().getApp().isActive()) {
            if (screenshots != null) screenshots.invalidate();
            notifyAppState(false);
        }
    }

    private void notifyAppState(boolean isActive) {
        JSObject data = new JSObject();
        data.put("isActive", isActive);
        notifyListeners(EVENT_APP_STATE_CHANGE, data);
    }
}
