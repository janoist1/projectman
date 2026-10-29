import Foundation

/// Where the app keeps the engine it installed: `versions/<version>` (a copy of the bundle's `Resources/engine`),
/// `current` (a link to the running version) and `bin/projectman-engine` (the shim that follows `current`).
/// The engine's data (`~/.projectman`) is elsewhere and never touched here.
public struct EngineLayout {
    public let base: URL
    public init(base: URL) { self.base = base }
    public init(userHome: URL) { self.init(base: userHome.appendingPathComponent("Library/Application Support/projectman/engine")) }
    public var versions: URL { base.appendingPathComponent("versions") }
    public var current: URL { base.appendingPathComponent("current") }
    public var shim: URL { base.appendingPathComponent("bin/projectman-engine") }
    public func version(_ name: String) -> URL { versions.appendingPathComponent(name) }
    public func partial(_ name: String) -> URL { versions.appendingPathComponent(name + ".partial") }

    public static let shimContent = """
    #!/bin/sh
    root="$(cd "$(dirname "$0")/../current" && pwd -P)"
    exec "$root/bin/node" "$root/scripts/engine/cli.js" "$@"

    """

    /// A version name becomes a folder name: no separators, no dots-only names.
    public static func isSafeVersion(_ name: String) -> Bool {
        !name.isEmpty && !name.hasPrefix(".") && name.range(of: "^[A-Za-z0-9._+-]+$", options: .regularExpression) != nil
    }

    public func writeShim() throws {
        try FileManager.default.createDirectory(at: shim.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(EngineLayout.shimContent.utf8).write(to: shim, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: shim.path)
    }

    /// The version `current` points at, or nil.
    public func currentVersion() -> String? {
        guard let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: current.path) else { return nil }
        return URL(fileURLWithPath: destination, relativeTo: base).standardized.lastPathComponent
    }

    /// Points `current` at a version in one step: a new link is made beside it and renamed over it.
    public func point(to name: String) throws {
        let next = base.appendingPathComponent("current.new")
        try? FileManager.default.removeItem(at: next)
        try FileManager.default.createSymbolicLink(atPath: next.path, withDestinationPath: "versions/" + name)
        if rename(next.path, current.path) != 0 {
            let code = errno
            try? FileManager.default.removeItem(at: next)
            throw POSIXError(POSIXErrorCode(rawValue: code) ?? .EIO)
        }
    }

    /// At every start `current` follows the service's plist root, if that is one of our versions.
    @discardableResult
    public func follow(serviceRoot: String) throws -> Bool {
        let root = URL(fileURLWithPath: serviceRoot).standardizedFileURL
        guard root.deletingLastPathComponent().standardizedFileURL.path == versions.standardizedFileURL.path,
              EngineLayout.isSafeVersion(root.lastPathComponent), currentVersion() != root.lastPathComponent else { return false }
        try point(to: root.lastPathComponent)
        return true
    }

    /// Keeps the running and the previous version (and nothing half unpacked).
    public func prune(keep: Set<String>) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: versions.path)) ?? []
        for name in names where !keep.contains(name) { try? FileManager.default.removeItem(at: versions.appendingPathComponent(name)) }
    }
}
