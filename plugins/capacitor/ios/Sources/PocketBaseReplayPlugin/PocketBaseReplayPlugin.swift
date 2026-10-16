import Capacitor
import Foundation
import UIKit
import WebKit

@objc(PocketBaseReplayPlugin)
public class PocketBaseReplayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PocketBaseReplayPlugin"
    public let jsName = "PocketBaseReplay"
    // The bridge adds addListener and removeListener to every plugin.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "captureScreenshot", returnType: CAPPluginReturnPromise)
    ]
    private var observers: [NSObjectProtocol] = []
    private var capturingScreenshot = false
    private var screenshotGeneration: UUID?
    private var screenshotTimeout: DispatchWorkItem?
    private var pendingScreenshotCall: CAPPluginCall?

    override public func load() {
        // The notifications behind @capacitor/app's appStateChange, so recording pauses at the same moments.
        observe(UIApplication.didBecomeActiveNotification, isActive: true)
        observe(UIApplication.willResignActiveNotification, isActive: false)
    }

    deinit {
        screenshotTimeout?.cancel()
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    private func observe(_ name: Notification.Name, isActive: Bool) {
        observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            if !isActive, let call = self.pendingScreenshotCall, let generation = self.screenshotGeneration {
                self.finishScreenshot(call, generation: generation, error: "Screenshot capture paused while the app is inactive")
            }
            self.notifyListeners("appStateChange", data: ["isActive": isActive])
        })
    }

    /// Called only by the explicitly enabled screenshot recorder. Raw snapshots never cross the bridge.
    @objc public func captureScreenshot(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.reject("Screenshot recorder is unavailable"); return }
            guard let requestId = call.getString("requestId"), ScreenshotPlan.validRequestId(requestId) else {
                call.reject("Invalid screenshot request"); return
            }
            guard !self.capturingScreenshot else { call.reject("Screenshot capture is busy"); return }
            guard self.canCapture, let webView = self.webView else {
                call.reject("Screenshot capture requires an active WebView"); return
            }
            self.capturingScreenshot = true
            self.pendingScreenshotCall = call
            let generation = UUID()
            let deadline = DispatchTime.now() + .seconds(5)
            self.screenshotGeneration = generation
            let timeout = DispatchWorkItem { [weak self] in
                self?.finishScreenshot(call, generation: generation, error: "Screenshot capture timed out")
            }
            self.screenshotTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: deadline, execute: timeout)
            let maxDimension = min(1280, max(256, call.getInt("maxDimension") ?? 1280))
            self.screenshotPlan(webView, requestId: requestId) { [weak self, weak webView] plan in
                guard let self else { call.reject("Screenshot recorder is unavailable"); return }
                guard self.screenshotGeneration == generation else { return }
                guard self.canCapture, let webView, let plan else {
                    self.finishScreenshot(call, generation: generation, error: "Screenshot privacy inspection failed"); return
                }
                guard plan.covers(webView.bounds) else {
                    self.finishScreenshot(call, generation: generation, error: "Screenshot viewport does not fill the WebView"); return
                }
                let config = WKSnapshotConfiguration()
                config.rect = webView.bounds
                config.afterScreenUpdates = true
                // WK snapshots use the screen scale. Bound their physical pixels before allocating the image.
                let screenScale = max(1, webView.window?.screen.scale ?? 1)
                config.snapshotWidth = NSNumber(value: Double(maxDimension) *
                    Double(webView.bounds.width / max(webView.bounds.width, webView.bounds.height)) / Double(screenScale))
                webView.takeSnapshot(with: config) { [weak self, weak webView] snapshot, error in
                    guard let self else { call.reject("Screenshot recorder is unavailable"); return }
                    guard self.screenshotGeneration == generation else { return }
                    guard self.canCapture, let webView, let snapshot, error == nil else {
                        self.finishScreenshot(call, generation: generation, error: "WebView screenshot failed"); return
                    }
                    self.screenshotPlan(webView, requestId: requestId) { [weak self] after in
                        guard let self else { call.reject("Screenshot recorder is unavailable"); return }
                        guard self.screenshotGeneration == generation else { return }
                        guard self.canCapture, let after, plan.matches(after),
                              let data = plan.maskedPNG(snapshot, maxDimension: maxDimension),
                              DispatchTime.now().uptimeNanoseconds < deadline.uptimeNanoseconds else {
                            self.finishScreenshot(call, generation: generation, error: "Screenshot changed or exceeded the frame limit"); return
                        }
                        self.capturingScreenshot = false
                        self.pendingScreenshotCall = nil
                        self.screenshotGeneration = nil
                        self.screenshotTimeout?.cancel()
                        self.screenshotTimeout = nil
                        call.resolve([
                            "data": "data:image/png;base64," + data.base64EncodedString(),
                            "width": plan.width,
                            "height": plan.height
                        ])
                    }
                }
            }
        }
    }

    private var canCapture: Bool {
        guard UIApplication.shared.applicationState == .active, let webView, let window = webView.window,
              webView.bounds.width.isFinite, webView.bounds.width > 0,
              webView.bounds.height.isFinite, webView.bounds.height > 0 else { return false }
        // Older Capacitor apps may still manage their UIWindow through AppDelegate without scenes.
        if let scene = window.windowScene, scene.activationState != .foregroundActive { return false }
        return Self.visibleHierarchy(webView)
    }

    static func visibleHierarchy(_ view: UIView) -> Bool {
        var ancestor: UIView? = view
        while let current = ancestor {
            if current.isHidden || !current.alpha.isFinite || current.alpha <= 0 { return false }
            ancestor = current.superview
        }
        return true
    }

    private func finishScreenshot(_ call: CAPPluginCall, generation: UUID, error: String) {
        guard screenshotGeneration == generation else { return }
        capturingScreenshot = false
        pendingScreenshotCall = nil
        screenshotGeneration = nil
        screenshotTimeout?.cancel()
        screenshotTimeout = nil
        call.reject(error)
    }

    private func screenshotPlan(_ webView: WKWebView, requestId: String, completion: @escaping (ScreenshotPlan?) -> Void) {
        // requestId has an ASCII-only allowlist before it is interpolated into JavaScript.
        webView.evaluateJavaScript("window.__pocketbaseReplayScreenshot && window.__pocketbaseReplayScreenshot(\"\(requestId)\")") { value, error in
            guard error == nil, let text = value as? String else { completion(nil); return }
            completion(ScreenshotPlan(json: text, requestId: requestId))
        }
    }
}

/// The privacy plan is bounded and validated independently of the JavaScript caller.
struct ScreenshotPlan {
    let requestId: String
    let width: Double
    let height: Double
    let rects: [CGRect]
    let revision: String

    static func validRequestId(_ value: String) -> Bool {
        value.utf8.count == 20 && value.utf8.allSatisfy { (48...57).contains($0) || (97...122).contains($0) }
    }

    init?(json: String, requestId: String) {
        guard Self.validRequestId(requestId), json.utf8.count <= 512_000,
              let bytes = json.data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: bytes)) as? [String: Any],
              object["requestId"] as? String == requestId,
              let width = Self.number(object["width"]), (1...20_000).contains(width),
              let height = Self.number(object["height"]), (1...20_000).contains(height),
              let revision = object["revision"] as? String, !revision.isEmpty, revision.utf8.count <= 512,
              let values = object["rects"] as? [[String: Any]], values.count <= 2_000 else { return nil }
        var rects: [CGRect] = []
        for value in values {
            guard let x = Self.number(value["x"]), let y = Self.number(value["y"]),
                  let w = Self.number(value["width"]), w > 0,
                  let h = Self.number(value["height"]), h > 0,
                  abs(x) <= 1_000_000, abs(y) <= 1_000_000, w <= 1_000_000, h <= 1_000_000 else { return nil }
            let clipped = CGRect(x: x - 2, y: y - 2, width: w + 4, height: h + 4)
                .intersection(CGRect(x: 0, y: 0, width: width, height: height))
            if !clipped.isNull && !clipped.isEmpty { rects.append(clipped) }
        }
        self.requestId = requestId
        self.width = width
        self.height = height
        self.rects = rects
        self.revision = revision
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let result = value.doubleValue
        return result.isFinite ? result : nil
    }

    /// Masks are placed in the page's viewport and the snapshot covers the view's bounds, so both must be one area.
    /// Content insets (any ios.contentInset but "never") place a smaller viewport inside the view and would offset
    /// every mask, even where the aspect ratios look alike.
    func covers(_ bounds: CGRect) -> Bool {
        abs(Double(bounds.width) - width) <= 1 && abs(Double(bounds.height) - height) <= 1
    }

    func matches(_ other: ScreenshotPlan) -> Bool {
        requestId == other.requestId && width == other.width && height == other.height &&
            revision == other.revision && rects == other.rects
    }

    func maskedPNG(_ image: UIImage, maxDimension: Int) -> Data? {
        guard image.size.width > 0, image.size.height > 0,
              abs(Double(image.size.width / image.size.height) - width / height) < 0.02 else { return nil }
        var dimension = min(1280, max(256, maxDimension))
        while true {
            let scale = Double(dimension) / max(width, height)
            let size = CGSize(width: max(1, floor(width * scale)), height: max(1, floor(height * scale)))
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1
            format.opaque = true
            format.preferredRange = .standard
            let masked = UIGraphicsImageRenderer(size: size, format: format).image { context in
                UIColor.white.setFill()
                context.fill(CGRect(origin: .zero, size: size))
                image.draw(in: CGRect(origin: .zero, size: size))
                UIColor(white: 158.0 / 255.0, alpha: 1).setFill()
                for rect in rects {
                    // Round outwards so fractional pixel edges never retain sensitive pixels.
                    let x = floor(rect.minX * size.width / width)
                    let y = floor(rect.minY * size.height / height)
                    let right = ceil(rect.maxX * size.width / width)
                    let bottom = ceil(rect.maxY * size.height / height)
                    context.fill(CGRect(x: x, y: y, width: right - x, height: bottom - y))
                }
            }
            if let data = masked.pngData(), data.count <= 196_608 { return data }
            guard dimension > 256 else { return nil }
            dimension = max(256, Int(Double(dimension) * 0.75))
        }
    }
}
