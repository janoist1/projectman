import Foundation

/// The menu bar app of PM-1088 (`npm run engine -- app install`): replaced by this app, removed without a window.
public struct LegacyApp {
    public static let bundleIdentifier = "com.projectman.engine-menubar"
    public static let label = "com.projectman.engine-menubar"
    public struct RemovalError: Error, Equatable, CustomStringConvertible {
        public let message: String
        public var description: String { message }
    }
    public let userHome: URL
    public let uid: UInt32
    public let runner: CommandRunner
    /// Whether a process with the legacy bundle identifier runs (the app target asks AppKit).
    public let isRunning: () -> Bool
    public init(userHome: URL, uid: UInt32, runner: @escaping CommandRunner, isRunning: @escaping () -> Bool = { false }) {
        self.userHome = userHome; self.uid = uid; self.runner = runner; self.isRunning = isRunning
    }
    public var plist: URL { userHome.appendingPathComponent("Library/LaunchAgents/\(LegacyApp.label).plist") }
    public var app: URL { userHome.appendingPathComponent("Applications/projectman motor.app") }
    public var config: URL { userHome.appendingPathComponent("Library/Application Support/projectman/menubar.json") }
    /// The old app's launch agent, its fallback file or a running copy: any of them means the switch is still to do.
    public var isPresent: Bool {
        FileManager.default.fileExists(atPath: plist.path) || FileManager.default.fileExists(atPath: config.path) || isRunning()
    }

    /// The service plist of the engine: when it exists, the engine is installed and the old app goes silently.
    public var engineInstalled: Bool { FileManager.default.fileExists(atPath: userHome.appendingPathComponent(EngineLocator.servicePlist).path) }

    private var appIsLegacy: Bool {
        let info = app.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: info),
              let values = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return false }
        return values["CFBundleIdentifier"] as? String == LegacyApp.bundleIdentifier
    }

    /// `launchctl bootout`, then the plist, the app and the fallback location. The app is deleted only if it is the old
    /// one: this app may itself live at the same path in `~/Applications`.
    public func remove() throws {
        let result = try runner(CommandSpec("/bin/launchctl", ["bootout", "gui/\(uid)/\(LegacyApp.label)"], timeout: 30))
        // 3: no such process; 113: could not find the service. Both mean it was not loaded.
        guard [0, 3, 113].contains(result.status) else { throw RemovalError(message: RawError.text(result)) }
        var failures: [String] = []
        var targets = [plist, config]
        if appIsLegacy { targets.append(app) }
        for target in targets where FileManager.default.fileExists(atPath: target.path) {
            do { try FileManager.default.removeItem(at: target) } catch { failures.append("\(target.path): \(error.localizedDescription)") }
        }
        if !failures.isEmpty { throw RemovalError(message: failures.joined(separator: "\n")) }
    }
}
