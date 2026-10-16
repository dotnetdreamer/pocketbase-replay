import Capacitor
import UIKit
import XCTest
@testable import PocketBaseReplayPlugin

final class PocketBaseReplayPluginTests: XCTestCase {
    private let screenshotId = "0123456789abcdefghij"

    private func plan(_ overrides: [String: Any] = [:]) throws -> ScreenshotPlan? {
        var value: [String: Any] = [
            "requestId": screenshotId, "width": 100, "height": 200,
            "revision": "stable-layout-1", "rects": [["x": 20, "y": 30, "width": 10, "height": 10]]
        ]
        value.merge(overrides) { _, next in next }
        let bytes = try JSONSerialization.data(withJSONObject: value)
        return ScreenshotPlan(json: try XCTUnwrap(String(data: bytes, encoding: .utf8)), requestId: screenshotId)
    }

    func testScreenshotPlanRejectsMissingOrInvalidPrivacyInformation() throws {
        XCTAssertNotNil(try plan())
        for change: [String: Any] in [
            ["requestId": "another-request-id"], ["width": true], ["width": 0], ["height": 20_001],
            ["revision": ""], ["revision": String(repeating: "x", count: 513)],
            ["rects": [["x": 20, "y": 30, "width": -10, "height": 10]]],
            ["rects": [["x": 20, "y": 30, "width": 10]]],
            ["rects": Array(repeating: ["x": 1, "y": 1, "width": 1, "height": 1], count: 2_001)]
        ] {
            XCTAssertNil(try plan(change), "Accepted invalid plan: \(change.keys)")
        }
        XCTAssertNil(ScreenshotPlan(json: "{}", requestId: screenshotId))
        XCTAssertFalse(ScreenshotPlan.validRequestId("0123456789abcdefghi\""))
        XCTAssertFalse(ScreenshotPlan.validRequestId("0123456789ABCDEFGHIJ"))
    }

    func testScreenshotPlanExpandsAndClipsMasksAndRejectsChangedFrames() throws {
        let first = try XCTUnwrap(plan())
        XCTAssertEqual(first.rects, [CGRect(x: 18, y: 28, width: 14, height: 14)])
        XCTAssertTrue(first.matches(try XCTUnwrap(plan())))
        XCTAssertFalse(first.matches(try XCTUnwrap(plan(["revision": "changed"]))))
        XCTAssertFalse(first.matches(try XCTUnwrap(plan(["width": 101]))))
        XCTAssertFalse(first.matches(try XCTUnwrap(plan(["rects": []]))))
        let clipped = try XCTUnwrap(plan(["rects": [["x": -10, "y": -10, "width": 20, "height": 20]]]))
        XCTAssertEqual(clipped.rects, [CGRect(x: 0, y: 0, width: 12, height: 12)])
    }

    func testScreenshotPlanMustCoverTheWholeWebView() throws {
        let privacy = try XCTUnwrap(plan())
        XCTAssertTrue(privacy.covers(CGRect(x: 0, y: 0, width: 100, height: 200)))
        XCTAssertTrue(privacy.covers(CGRect(x: 0, y: 0, width: 100.5, height: 199.5)))
        // A 20 pt status bar inset keeps a similar aspect ratio but moves every mask.
        XCTAssertFalse(privacy.covers(CGRect(x: 0, y: 0, width: 100, height: 220)))
        XCTAssertFalse(privacy.covers(CGRect(x: 0, y: 0, width: 98, height: 200)))
    }

    private func pixel(_ image: CGImage, x: Int, y: Int) throws -> [UInt8] {
        let crop = try XCTUnwrap(image.cropping(to: CGRect(x: x, y: y, width: 1, height: 1)))
        var bytes = [UInt8](repeating: 0, count: 4)
        try bytes.withUnsafeMutableBytes { buffer in
            let context = try XCTUnwrap(CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8,
                bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(crop, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        return bytes
    }

    func testOnlyMaskedOpaqueBoundedPixelsAreEncoded() throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let source = UIGraphicsImageRenderer(size: CGSize(width: 100, height: 200), format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 100, height: 200))
        }
        let privacy = try XCTUnwrap(plan())
        let data = try XCTUnwrap(privacy.maskedPNG(source, maxDimension: 256))
        XCTAssertLessThanOrEqual(data.count, 196_608)
        let image = try XCTUnwrap(UIImage(data: data)?.cgImage)
        XCTAssertEqual(image.width, 128)
        XCTAssertEqual(image.height, 256)
        XCTAssertEqual(try pixel(image, x: 32, y: 44), [158, 158, 158, 255])
        // The extra two CSS pixels around the requested rectangle are also opaque.
        XCTAssertEqual(try pixel(image, x: 24, y: 38), [158, 158, 158, 255])
        XCTAssertEqual(try pixel(image, x: 100, y: 200), [255, 0, 0, 255])
        let wrongAspect = UIGraphicsImageRenderer(size: CGSize(width: 200, height: 100)).image { _ in }
        XCTAssertNil(privacy.maskedPNG(wrongAspect, maxDimension: 256))
    }

    func testIncompressibleFramesAreReducedBeforeReturningPNG() throws {
        let dimension = 640
        var bytes = [UInt8](repeating: 0, count: dimension * dimension * 4)
        var seed: UInt32 = 0x12345678
        for offset in stride(from: 0, to: bytes.count, by: 4) {
            for channel in 0..<3 {
                seed ^= seed << 13
                seed ^= seed >> 17
                seed ^= seed << 5
                // Six bits per channel still exceed the cap at 640px, but can fit after downscaling.
                bytes[offset + channel] = (UInt8(truncatingIfNeeded: seed) & 0x3f) << 2
            }
            bytes[offset + 3] = 255
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(bytes) as CFData))
        let cgImage = try XCTUnwrap(CGImage(width: dimension, height: dimension, bitsPerComponent: 8,
            bitsPerPixel: 32, bytesPerRow: dimension * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let source = UIImage(cgImage: cgImage)
        let privacy = try XCTUnwrap(plan(["width": dimension, "height": dimension, "rects": []]))
        let data = try XCTUnwrap(privacy.maskedPNG(source, maxDimension: dimension))
        XCTAssertLessThanOrEqual(data.count, 196_608)
        let image = try XCTUnwrap(UIImage(data: data)?.cgImage)
        XCTAssertGreaterThanOrEqual(image.width, 256)
        XCTAssertLessThan(image.width, dimension)
    }

    func testScreenshotMethodIsAvailableButCannotCaptureWithoutAnActiveWebView() throws {
        let plugin = loadedPlugin()
        XCTAssertTrue(plugin.pluginMethods.contains { $0.name == "captureScreenshot" })
        let rejected = expectation(description: "unattached WebView rejected")
        let call = try XCTUnwrap(CAPPluginCall(callbackId: "screenshot", methodName: "captureScreenshot",
            options: ["requestId": screenshotId, "maxDimension": 256],
            success: { _, _ in XCTFail("An unattached plugin must never return a screenshot") },
            error: { error in
                XCTAssertTrue(error?.message.contains("active WebView") == true)
                rejected.fulfill()
            }))
        plugin.captureScreenshot(call)
        wait(for: [rejected], timeout: 2)
    }

    func testNativeVisibilityIncludesHiddenAndTransparentAncestors() {
        let parent = UIView()
        let child = UIView()
        parent.addSubview(child)
        XCTAssertTrue(PocketBaseReplayPlugin.visibleHierarchy(child))
        parent.isHidden = true
        XCTAssertFalse(PocketBaseReplayPlugin.visibleHierarchy(child))
        parent.isHidden = false
        parent.alpha = 0
        XCTAssertFalse(PocketBaseReplayPlugin.visibleHierarchy(child))
        parent.alpha = 1
        child.isHidden = true
        XCTAssertFalse(PocketBaseReplayPlugin.visibleHierarchy(child))
        child.isHidden = false
        child.alpha = 0
        XCTAssertFalse(PocketBaseReplayPlugin.visibleHierarchy(child))
        child.alpha = 1
        let window = UIWindow()
        window.addSubview(parent)
        window.isHidden = true
        XCTAssertFalse(PocketBaseReplayPlugin.visibleHierarchy(child))
    }

    private func loadedPlugin() -> PocketBaseReplayPlugin {
        let plugin = PocketBaseReplayPlugin()
        plugin.eventListeners = NSMutableDictionary()
        plugin.retainedEventArguments = NSMutableDictionary()
        plugin.load()
        return plugin
    }

    private func listener(_ receive: @escaping (Bool) -> Void) throws -> CAPPluginCall {
        try XCTUnwrap(CAPPluginCall(
            callbackId: UUID().uuidString,
            methodName: "addListener",
            options: ["eventName": "appStateChange"],
            success: { result, _ in
                XCTAssertTrue(Thread.isMainThread)
                guard let active = result?.data?["isActive"] as? Bool else {
                    XCTFail("appStateChange must carry a boolean isActive")
                    return
                }
                receive(active)
            },
            error: { error in XCTFail(error?.message ?? "Listener rejected") }
        ))
    }

    func testResignActivePausesAndBecomeActiveResumesThroughCapacitorListener() throws {
        let plugin = loadedPlugin()
        var received: [Bool] = []
        let call = try listener { received.append($0) }
        plugin.addListener(call)
        XCTAssertTrue(call.keepAlive)

        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)

        XCTAssertEqual(received, [false, true, false, true])
    }

    func testBackgroundAndForegroundNotificationsDoNotDuplicateActiveEvents() throws {
        let plugin = loadedPlugin()
        var received: [Bool] = []
        plugin.addListener(try listener { received.append($0) })

        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.willEnterForegroundNotification, object: nil)
        XCTAssertEqual(received, [false])
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertEqual(received, [false, true])
    }

    func testRemovedListenerStopsReceivingLifecycleEvents() throws {
        let plugin = loadedPlugin()
        var received: [Bool] = []
        let call = try listener { received.append($0) }
        plugin.addListener(call)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        plugin.removeEventListener("appStateChange", listener: call)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)

        XCTAssertEqual(received, [false])
        XCTAssertFalse(plugin.hasListeners("appStateChange"))
    }

    func testNotificationsDoNotRetainPluginAfterRelease() throws {
        var plugin: PocketBaseReplayPlugin? = loadedPlugin()
        weak var releasedPlugin = plugin
        var received: [Bool] = []
        plugin?.addListener(try listener { received.append($0) })
        plugin = nil

        XCTAssertNil(releasedPlugin)
        NotificationCenter.default.post(name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        XCTAssertTrue(received.isEmpty)
    }
}
