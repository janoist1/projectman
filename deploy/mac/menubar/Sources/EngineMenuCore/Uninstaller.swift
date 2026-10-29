import Foundation

public enum UninstallStep: String, CaseIterable, Equatable { case service, files, loginItem }
public struct UninstallFailure: Error, Equatable, CustomStringConvertible {
    public let step: UninstallStep
    public let message: String
    public var description: String { message }
    public init(step: UninstallStep, message: String) { self.step = step; self.message = message }
}

/// "Motor eltávolítása…" (s): `service uninstall`, the `engine/` folder, the app's own login item. `~/.projectman`
/// stays. A retry after a failure picks up where it stopped: a folder that is already gone needs no CLI.
public struct Uninstaller {
    public let userHome: URL
    public let layout: EngineLayout
    public let runner: CommandRunner
    /// `SMAppService.mainApp.unregister()` (the app target); throws its error.
    public let unregister: () throws -> Void
    public init(userHome: URL, runner: @escaping CommandRunner, unregister: @escaping () throws -> Void) {
        self.userHome = userHome; self.layout = EngineLayout(userHome: userHome); self.runner = runner; self.unregister = unregister
    }
    public func run(progress: (UninstallStep) -> Void = { _ in }) throws {
        let files = FileManager.default
        progress(.service)
        if files.fileExists(atPath: userHome.appendingPathComponent(EngineLocator.servicePlist).path) {
            do {
                let result = try runner(try EngineLocator.locate(userHome: userHome).command(["service", "uninstall"], timeout: 180))
                guard result.status == 0 else { throw UninstallFailure(step: .service, message: RawError.text(result)) }
            } catch let failure as UninstallFailure { throw failure } catch {
                throw UninstallFailure(step: .service, message: Installer.describe(error))
            }
        }
        progress(.files)
        // Only the app's own folder is deleted, never a path that merely looks like it.
        if files.fileExists(atPath: layout.base.path) {
            guard layout.base.lastPathComponent == "engine" else { throw UninstallFailure(step: .files, message: layout.base.path) }
            do { try files.removeItem(at: layout.base) } catch { throw UninstallFailure(step: .files, message: Installer.describe(error)) }
        }
        progress(.loginItem)
        do { try unregister() } catch { throw UninstallFailure(step: .loginItem, message: Installer.describe(error)) }
    }
}
