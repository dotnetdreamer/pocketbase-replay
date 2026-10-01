import Capacitor
import UIKit
import XCTest
import PocketBaseReplayPlugin

final class PocketBaseReplayPluginTests: XCTestCase {
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
