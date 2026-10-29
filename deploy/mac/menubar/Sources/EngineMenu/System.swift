import AppKit
import ServiceManagement
import EngineMenuCore

/// The two macOS services the core only sees as seams: the background item of the engine's LaunchAgent and the
/// app's own login item.
enum LoginItems {
    static var enginePlist: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(EngineLocator.servicePlist) }
    static func status() -> ApprovalStatus {
        switch SMAppService.statusForLegacyPlist(at: enginePlist) {
        case .enabled: return .enabled
        case .requiresApproval: return .requiresApproval
        case .notRegistered: return .notRegistered
        case .notFound: return .notFound
        @unknown default: return .notFound
        }
    }
    static func openSettings() { SMAppService.openSystemSettingsLoginItems() }
    /// The app starts at login; a crash does not restart it, and the engine runs regardless.
    static func registerApp() {
        do { try SMAppService.mainApp.register() } catch { NSLog("projectman motor: login item registration failed: %@", String(describing: error)) }
    }
    static func unregisterApp() throws { try SMAppService.mainApp.unregister() }
}

enum BundledEngine {
    static var url: URL { (Bundle.main.resourceURL ?? URL(fileURLWithPath: "/nonexistent")).appendingPathComponent("engine") }
    /// Only the downloaded app carries an engine package; a development build (`swift run`) does not.
    static var isAvailable: Bool { FileManager.default.fileExists(atPath: url.appendingPathComponent(EngineLocator.packageFile).path) }
}

enum Machine {
    static var home: URL { FileManager.default.homeDirectoryForCurrentUser }
    static var legacy: LegacyApp {
        LegacyApp(userHome: home, uid: getuid(), runner: SystemProcess.runner) {
            !NSRunningApplication.runningApplications(withBundleIdentifier: LegacyApp.bundleIdentifier).isEmpty
        }
    }
    static var installer: Installer {
        Installer(userHome: home, bundleEngine: BundledEngine.url, uid: getuid(), runner: SystemProcess.runner,
                  copy: Installer.dittoCopy(runner: SystemProcess.runner), approval: LoginItems.status, legacy: legacy,
                  shell: ProcessInfo.processInfo.environment["SHELL"])
    }
}
