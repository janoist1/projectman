import CryptoKit
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

    /// Keeps the running and the previous version (and nothing half unpacked), and the runtimes the kept versions'
    /// `bin/node` links still point at.
    public func prune(keep: Set<String>) {
        let files = FileManager.default
        let names = (try? files.contentsOfDirectory(atPath: versions.path)) ?? []
        for name in names where !keep.contains(name) { try? files.removeItem(at: versions.appendingPathComponent(name)) }
        let used = Set(names.filter(keep.contains).compactMap { runtimeName(ofVersion: $0) })
        for name in (try? files.contentsOfDirectory(atPath: runtimes.path)) ?? [] where !used.contains(name) {
            try? files.removeItem(at: runtimes.appendingPathComponent(name))
        }
    }

    // MARK: - Shared Node runtime (PM-1200)

    /// The Node binaries by content: `runtimes/<sha256>/node`. A version's `bin/node` is a link here, so the same Node
    /// runs from the same path in every version and the firewall asks only when the Node itself changes.
    public var runtimes: URL { base.appendingPathComponent("runtimes") }
    public func runtime(_ hash: String) -> URL { runtimes.appendingPathComponent(hash).appendingPathComponent("node") }
    /// The link a version's `bin/node` holds: relative, so it survives the `.partial` rename.
    public static func runtimeLink(_ hash: String) -> String { "../../../runtimes/\(hash)/node" }

    /// Moves `bin/node` of a copied (partial) version into `runtimes/<sha256>/node`, unless that runtime exists
    /// (then the copy is dropped), and leaves the relative link in its place.
    public func shareNode(in partial: URL) throws {
        let files = FileManager.default
        let node = partial.appendingPathComponent("bin/node")
        let hash = try EngineLayout.sha256(of: node)
        let target = runtime(hash), folder = target.deletingLastPathComponent()
        if files.fileExists(atPath: target.path) {
            try files.removeItem(at: node)
        } else {
            try files.createDirectory(at: folder, withIntermediateDirectories: true)
            let staging = folder.appendingPathComponent("node.partial")
            try? files.removeItem(at: staging)
            try files.moveItem(at: node, to: staging)
            try files.moveItem(at: staging, to: target)
        }
        try files.createSymbolicLink(atPath: node.path, withDestinationPath: EngineLayout.runtimeLink(hash))
    }

    /// The runtime folder name a version's `bin/node` link points at, or nil (a plain file, no link).
    func runtimeName(ofVersion name: String) -> String? {
        let link = version(name).appendingPathComponent("bin/node").path
        guard let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: link) else { return nil }
        let parts = destination.split(separator: "/")
        guard parts.count == 6, parts[3] == "runtimes" else { return nil }
        return String(parts[4])
    }

    static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hash.update(data: chunk) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
