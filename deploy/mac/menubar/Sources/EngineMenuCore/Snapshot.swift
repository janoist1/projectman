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
    public struct Engine: Decodable { public let id: String; public let name: String?; public let cloudOrigin: String }
    public struct Service: Decodable { public let installed: Bool }
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
public enum Fetch {
    case loading, ready(Snapshot), updateNeeded, unavailable(String)
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
