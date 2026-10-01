package io.github.dotnetdreamer.pocketbasereplay.capacitor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PocketBaseReplay")
public class PocketBaseReplayPlugin extends Plugin {

    static final String EVENT_APP_STATE_CHANGE = "appStateChange";

    // The lifecycle hooks, not the bridge's app status listener: that has one slot, and @capacitor/app takes it.
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        notifyAppState(true);
    }

    @Override
    protected void handleOnStop() {
        super.handleOnStop();
        // BridgeActivity marks the app inactive just before this, once its last activity stops.
        // A sheet or dialog over the app only pauses it, so recording carries on, as with @capacitor/app.
        if (!getBridge().getApp().isActive()) {
            notifyAppState(false);
        }
    }

    private void notifyAppState(boolean isActive) {
        JSObject data = new JSObject();
        data.put("isActive", isActive);
        notifyListeners(EVENT_APP_STATE_CHANGE, data);
    }
}
