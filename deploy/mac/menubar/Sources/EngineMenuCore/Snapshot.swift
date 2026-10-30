import Foundation

public struct Snapshot: Decodable {
    public let schemaVersion: Int
    public let overall: String
    public let engine: Engine?
    public let service: Service
    public let process: EngineProcess
    public let link: Link
    public let sessions: [Session]
    public let work: Work
    public let keepAwake: KeepAwake
    public let machine: Machine
    public let logs: LogPaths
    /// The installed engine package (PM-1124) and the switch state; both are read leniently, so a shape the app does
    /// not know never turns the whole snapshot into "update the app".
    public let `package`: Lenient<EnginePackage>?
    public let `switch`: Lenient<SwitchState>?
    public var enginePackage: EnginePackage? { `package`?.value }
    public var switchState: SwitchState? { `switch`?.value }
    public struct Engine: Decodable { public let id: String; public let name: String?; public let cloudOrigin: String }
    /// `manager` (PM-1124; absent from an older engine's snapshot): `app` when the service runs an engine package
    /// (the app installed it), `checkout` for a git checkout.
    public struct Service: Decodable { public let installed: Bool; public let manager: String? }
    public struct EngineProcess: Decodable { public let pid: Int?; public let version: String?; public let releaseTag: String? }
    public struct Link: Decodable {
        public let state: String; public let since: String?; public let attempts: Int
        public let lastError: LinkError?; public let pendingEvents: Int; public let droppedEvents: Int
    }
    public struct LinkError: Decodable { public let at: String; public let code: String; public let message: String }
    public struct Session: Decodable { public let sessionId: String; public let label: String?; public let provider: String? }
    public struct Work: Decodable {
        public let sessions: Int; public let fullTests: Int; public let screenshots: Int
        public var total: Int { sessions + fullTests + screenshots }
    }
    public struct KeepAwake: Decodable { public let mode: String; public let holding: Bool; public let since: String?; public let supported: Bool }
    public struct Machine: Decodable {
        public let diskPath: String; public let diskFreeBytes: Double?; public let diskTotalBytes: Double?
        public let memTotalBytes: Double; public let memFreeBytes: Double; public let loadAverage1m: Double
    }
    public struct LogPaths: Decodable { public let out: String; public let err: String }
}
public struct Logs: Decodable { public let out: [String]; public let err: [String] }

/// A value that decodes to nil instead of failing.
public struct Lenient<Value: Decodable>: Decodable {
    public let value: Value?
    public init(from decoder: Decoder) throws { value = try? Value(from: decoder) }
}
/// `package` of the snapshot: what the engine service runs (absent without an installed service).
public struct EnginePackage: Decodable, Equatable {
    public let version: String; public let tag: String?; public let root: String
}
public struct PackageRef: Decodable, Equatable {
    public let version: String; public let tag: String?
    /// The tag; without one the first 7 characters of the version.
    public var label: String { tag ?? String(version.prefix(7)) }
}
/// `switch` of the snapshot (PM-1124): written only by the engine CLI's `service switch`.
public struct SwitchState: Decodable, Equatable {
    public enum Kind { case switching, rolledBack, recoveryRequired }
    public struct Failure: Decodable, Equatable { public let code: String; public let message: String }
    public let phase: String
    public let target: PackageRef
    public let previous: PackageRef?
    public let startedAt: String?
    public let updatedAt: String?
    public let error: Failure?
    public var kind: Kind? {
        switch phase {
        case "switching": return .switching
        case "rolled_back": return .rolledBack
        case "recovery_required": return .recoveryRequired
        default: return nil
        }
    }
    /// m disappears 24 hours after the rollback; an `updatedAt` that cannot be read keeps it visible.
    public func isRecent(now: Date) -> Bool {
        let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let updatedAt, let date = parser.date(from: updatedAt) ?? ISO8601DateFormatter().date(from: updatedAt) else { return true }
        return now.timeIntervalSince(date) <= 24 * 3600
    }
    /// `code: message`, the one line "Hiba másolása" copies.
    public var errorText: String { error.map { "\($0.code): \($0.message)" } ?? phase }
}
public enum Fetch {
    case loading, ready(Snapshot), updateNeeded, unavailable(String), notInstalled
    public static func decode(_ data: Data) -> Fetch {
        struct Version: Decodable { let schemaVersion: Int }
        let decoder = JSONDecoder()
        guard let version = try? decoder.decode(Version.self, from: data), version.schemaVersion == 1,
              let snapshot = try? decoder.decode(Snapshot.self, from: data),
              ["running", "no_cloud", "stopped", "not_initialised"].contains(snapshot.overall) else { return .updateNeeded }
        return .ready(snapshot)
    }
    public var snapshot: Snapshot? { if case .ready(let value) = self { return value }; return nil }
}
