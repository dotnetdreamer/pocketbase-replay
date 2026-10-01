import Capacitor
import Foundation
import UIKit

@objc(PocketBaseReplayPlugin)
public class PocketBaseReplayPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "PocketBaseReplayPlugin"
    public let jsName = "PocketBaseReplay"
    // The bridge adds addListener and removeListener to every plugin.
    public let pluginMethods: [CAPPluginMethod] = []
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        // The notifications behind @capacitor/app's appStateChange, so recording pauses at the same moments.
        observe(UIApplication.didBecomeActiveNotification, isActive: true)
        observe(UIApplication.willResignActiveNotification, isActive: false)
    }

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    private func observe(_ name: Notification.Name, isActive: Bool) {
        observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("appStateChange", data: ["isActive": isActive])
        })
    }
}
