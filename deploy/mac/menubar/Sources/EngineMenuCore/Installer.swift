import Foundation

public enum InstallStep: String, CaseIterable, Equatable {
    case removeOldApp, unpack, serviceInstall, backgroundItem, start
}
public enum StepStatus: Equatable { case started, done, skipped }
public enum PrepareOutcome: Equatable {
    /// Unpacked; the engine is wired to the cloud (or this is a re-install): the service can be installed.
    case ready(String)
    /// Unpacked, but there is no `engine.json` or key yet (e): the service waits for the wiring.
    case awaitingSetup(String)
}
public enum ActivateOutcome: Equatable {
    case running, needsApproval
    /// `service install` refused with `key_missing`: `engine.json` exists but the engine key does not (e).
    case awaitingSetup
}

public struct InstallFailure: Error, Equatable, CustomStringConvertible {
    public let step: InstallStep
    /// The CLI's `REFUSED [code] …` line, or the nearest raw error.
    public let message: String
    public var description: String { message }
    public init(step: InstallStep, message: String) { self.step = step; self.message = message }
}

/// The install state machine of the downloaded app (PM-1125): remove the old app, unpack, `service install`, the
/// background item, start. A failing step leaves nothing half done: the `.partial` folder and a new plist are
/// undone. Every machine access is a seam, so the tests run without launchd.
public struct Installer {
    public typealias Progress = (InstallStep, StepStatus) -> Void
    public static let serviceLabel = "com.projectman.engine"

    public let userHome: URL
    public let home: URL
    public let bundleEngine: URL
    public let layout: EngineLayout
    public let uid: UInt32
    public let runner: CommandRunner
    public let copy: (URL, URL) throws -> Void
    public let approval: () -> ApprovalStatus
    public let legacy: LegacyApp
    public let shell: String?

    public init(userHome: URL, bundleEngine: URL, uid: UInt32, runner: @escaping CommandRunner, copy: @escaping (URL, URL) throws -> Void,
                approval: @escaping () -> ApprovalStatus, legacy: LegacyApp, shell: String?) {
        self.userHome = userHome; self.home = userHome.appendingPathComponent(".projectman"); self.bundleEngine = bundleEngine
        self.layout = EngineLayout(userHome: userHome); self.uid = uid; self.runner = runner; self.copy = copy
        self.approval = approval; self.legacy = legacy; self.shell = shell
    }
    /// The real copy: `ditto` keeps the signatures, modes and links of the bundle's engine.
    public static func dittoCopy(runner: @escaping CommandRunner) -> (URL, URL) throws -> Void {
        { source, destination in
            let result = try runner(CommandSpec("/usr/bin/ditto", [source.path, destination.path], timeout: 600))
            if result.status != 0 { throw MessageError(RawError.text(result)) }
        }
    }
    struct MessageError: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }
    private var plist: URL { userHome.appendingPathComponent(EngineLocator.servicePlist) }

    public static func describe(_ error: Error) -> String {
        (error as? CustomStringConvertible)?.description ?? error.localizedDescription
    }
    private func fail<T>(_ step: InstallStep, _ body: () throws -> T) throws -> T {
        do { return try body() } catch let failure as InstallFailure { throw failure } catch { throw InstallFailure(step: step, message: Installer.describe(error)) }
    }
    private func location(_ version: String, path: String? = nil) -> EngineLocation {
        let root = layout.version(version).path
        return EngineLocation(schemaVersion: 1, node: root + "/bin/node", root: root, home: home.path, path: path ?? PathResolver.fallback(home: userHome.path))
    }

    /// Steps 1 and 2.
    public func prepare(progress: Progress) throws -> PrepareOutcome {
        progress(.removeOldApp, .started)
        if legacy.isPresent {
            try fail(.removeOldApp) { try legacy.remove() }
            progress(.removeOldApp, .done)
        } else { progress(.removeOldApp, .skipped) }
        progress(.unpack, .started)
        let version = try fail(.unpack) { try unpack() }
        let overall = try fail(.unpack) { () -> String? in
            let result = try runner(location(version).command(["status", "--json"], timeout: 60))
            guard result.status == 0 else { throw InstallFailure(step: .unpack, message: RawError.text(result)) }
            return (try? JSONSerialization.jsonObject(with: result.out) as? [String: Any])?["overall"] as? String
        }
        progress(.unpack, .done)
        return overall == "not_initialised" ? .awaitingSetup(version) : .ready(version)
    }

    private func bundleVersion() throws -> String {
        let manifest = bundleEngine.appendingPathComponent(EngineLocator.packageFile)
        guard let data = try? Data(contentsOf: manifest),
              let version = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["version"] as? String,
              EngineLayout.isSafeVersion(version) else { throw MessageError("REFUSED [bundle_engine_missing] \(manifest.path)") }
        return version
    }
    /// `versions/<version>.partial` is renamed to `versions/<version>` only when complete; the running and the
    /// previous version stay.
    private func unpack() throws -> String {
        let version = try bundleVersion()
        let files = FileManager.default
        let destination = layout.version(version), partial = layout.partial(version)
        let previous = layout.currentVersion()
        if !files.fileExists(atPath: destination.appendingPathComponent(EngineLocator.packageFile).path) {
            try files.createDirectory(at: layout.versions, withIntermediateDirectories: true)
            try? files.removeItem(at: partial)
            try? files.removeItem(at: destination)
            do {
                try copy(bundleEngine, partial)
                try files.moveItem(at: partial, to: destination)
            } catch {
                try? files.removeItem(at: partial)
                throw error
            }
        }
        try layout.writeShim()
        try layout.point(to: version)
        layout.prune(keep: Set([version] + (previous.map { [$0] } ?? [])))
        return version
    }

    /// Steps 3 to 5; a step that fails undoes the new plist.
    public func activate(version: String, progress: Progress) throws -> ActivateOutcome {
        let backup = try? Data(contentsOf: plist)
        progress(.serviceInstall, .started)
        let path = PathResolver.resolve(shell: shell, home: userHome.path, runner: runner)
        let engine = location(version, path: path)
        do {
            try run(.serviceInstall, engine, ["service", "install", "--path", path], timeout: 180, undo: backup)
        } catch let failure as InstallFailure where failure.message.contains("[key_missing]") {
            return .awaitingSetup
        }
        progress(.serviceInstall, .done)
        progress(.backgroundItem, .started)
        if approval().blocksEngine { return .needsApproval }
        progress(.backgroundItem, .done)
        try start(version: version, progress: progress, backup: backup)
        return .running
    }
    /// Step 5; also what follows the user's approval.
    public func start(version: String, progress: Progress, backup: Data? = nil) throws {
        progress(.backgroundItem, .done)
        progress(.start, .started)
        try run(.start, location(version), ["service", "start"], timeout: 120, undo: backup)
        progress(.start, .done)
    }
    private func run(_ step: InstallStep, _ engine: EngineLocation, _ args: [String], timeout: TimeInterval, undo backup: Data?) throws {
        let result: CommandResult
        do { result = try runner(engine.command(args, timeout: timeout)) } catch {
            undoService(backup)
            throw InstallFailure(step: step, message: Installer.describe(error))
        }
        guard result.status == 0 else {
            undoService(backup)
            throw InstallFailure(step: step, message: RawError.text(result))
        }
    }
    /// Unloads the job and puts the previous plist back, or removes the new one.
    private func undoService(_ backup: Data?) {
        _ = try? runner(CommandSpec("/bin/launchctl", ["bootout", "gui/\(uid)/\(Installer.serviceLabel)"], timeout: 120))
        if let backup {
            try? backup.write(to: plist)
            _ = try? runner(CommandSpec("/bin/launchctl", ["bootstrap", "gui/\(uid)", plist.path], timeout: 60))
        } else {
            try? FileManager.default.removeItem(at: plist)
        }
    }
}
