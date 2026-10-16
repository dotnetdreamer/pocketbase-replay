package io.github.dotnetdreamer.pocketbasereplay.capacitor;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class ScreenshotPlanTest {
    private static final String ID = "abcdefghij0123456789";

    private JSONObject plan() throws Exception {
        return new JSONObject().put("requestId", ID).put("revision", "revision-1")
            .put("width", 400).put("height", 800)
            .put("rects", new JSONArray().put(new JSONObject().put("x", 10).put("y", 20).put("width", 100).put("height", 30)));
    }

    private ScreenshotCapture.Plan parse(JSONObject value) throws Exception {
        // evaluateJavascript serializes the helper's JSON string a second time.
        return ScreenshotCapture.Plan.parse(JSONObject.quote(value.toString()), ID);
    }

    @Test
    public void acceptsOnlyTheRequestedPlanAndTheExpectedBridgeEncoding() throws Exception {
        assertEquals(400.0, parse(plan()).width, 0);
        assertThrows(Exception.class, () -> ScreenshotCapture.Plan.parse(plan().toString(), ID));
        assertThrows(Exception.class, () -> ScreenshotCapture.Plan.parse("null", ID));
        assertThrows(Exception.class, () -> parse(plan().put("requestId", "differentrequest0000")));
        assertThrows(Exception.class, () -> parse(plan().put("width", "400")));
        assertThrows(Exception.class, () -> parse(plan().put("height", 0)));
        assertThrows(Exception.class, () -> parse(plan().put("revision", "")));
    }

    @Test
    public void rejectsBothDocumentMutationAndGeometryChangesWithoutARevisionBump() throws Exception {
        ScreenshotCapture.Plan before = parse(plan());
        assertTrue(before.same(parse(plan())));
        assertFalse(before.same(parse(plan().put("revision", "revision-2"))));
        assertFalse(before.same(parse(plan().put("width", 401))));
        JSONObject moved = plan();
        moved.getJSONArray("rects").getJSONObject(0).put("x", 11);
        assertFalse(before.same(parse(moved)));
        assertFalse(before.same(parse(plan().put("rects", new JSONArray()))));
    }

    @Test
    public void malformedPrivateAreasFailInsteadOfBeingSilentlyDropped() throws Exception {
        JSONObject missing = plan();
        missing.getJSONArray("rects").getJSONObject(0).remove("width");
        assertThrows(Exception.class, () -> parse(missing));
        JSONObject empty = plan();
        empty.getJSONArray("rects").getJSONObject(0).put("height", 0);
        assertThrows(Exception.class, () -> parse(empty));
        JSONObject excessive = plan();
        JSONArray rects = excessive.getJSONArray("rects");
        JSONObject rect = rects.getJSONObject(0);
        for (int i = 0; i < 2000; i++) rects.put(rect);
        assertThrows(Exception.class, () -> parse(excessive));
    }
}
