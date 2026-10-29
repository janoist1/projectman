import Foundation

public struct EngineLocation: Codable {
    public let schemaVersion: Int
    public let node: String
    public let root: String
    public let home: String
    public let path: String
    public init(schemaVersion: Int, node: String, root: String, home: String, path: String) {
        self.schemaVersion = schemaVersion; self.node = node; self.root = root; self.home = home; self.path = path
    }
    /// An engine package (PM-1104) has `engine-package.json` in its root and runs the bundled CLI; a checkout runs tsx.
    public var isPackage: Bool { FileManager.default.fileExists(atPath: root + "/" + EngineLocator.packageFile) }
    public var cliPath: String { root + (isPackage ? "/scripts/engine/cli.js" : "/scripts/engine/cli.ts") }
    public var cliArguments: [String] { isPackage ? [cliPath] : ["--import", "tsx", cliPath] }
    public func command(_ args: [String], timeout: TimeInterval) -> CommandSpec {
        CommandSpec(node, cliArguments + args + ["--home", home], environment: EngineClient.environment(path: path), directory: root, timeout: timeout)
    }
}
public enum EngineLocator {
    public static let packageFile = "engine-package.json"
    public static let servicePlist = "Library/LaunchAgents/com.projectman.engine.plist"
    /// The engine service's plist first (it follows every switch), then the app's own `engine/current`, then the
    /// PM-1088 fallback file.
    public static func locate(userHome: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> EngineLocation {
        let plist = userHome.appendingPathComponent(servicePlist)
        let current = EngineLayout(userHome: userHome).current
        let fallback = userHome.appendingPathComponent("Library/Application Support/projectman/menubar.json")
        let location: EngineLocation
        if FileManager.default.fileExists(atPath: plist.path) {
            let data = try Data(contentsOf: plist)
            guard let values = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  let args = values["ProgramArguments"] as? [String], let node = args.first,
                  let root = values["WorkingDirectory"] as? String,
                  let env = values["EnvironmentVariables"] as? [String: String],
                  let home = env["PROJECTMAN_HOME"], let path = env["PATH"] else { throw LocationError.invalid(plist.path) }
            location = EngineLocation(schemaVersion: 1, node: node, root: root, home: home, path: path)
        } else if FileManager.default.fileExists(atPath: current.path) {
            let root = current.resolvingSymlinksInPath().path
            location = EngineLocation(schemaVersion: 1, node: root + "/bin/node", root: root,
                                      home: userHome.appendingPathComponent(".projectman").path,
                                      path: PathResolver.fallback(home: userHome.path))
        } else if FileManager.default.fileExists(atPath: fallback.path) {
            location = try JSONDecoder().decode(EngineLocation.self, from: Data(contentsOf: fallback))
        } else {
            throw LocationError.notInstalled
        }
        guard location.schemaVersion == 1, location.node.hasPrefix("/"), location.home.hasPrefix("/"), location.root.hasPrefix("/"), !location.path.isEmpty else { throw LocationError.invalid(location.root) }
        guard FileManager.default.fileExists(atPath: location.cliPath) else { throw LocationError.missingCLI(location.cliPath) }
        return location
    }
    public enum LocationError: Error, CustomStringConvertible {
        case invalid(String), missingCLI(String), notInstalled
        public var description: String {
            switch self {
            case .invalid(let path): return L10n.text(.locatorInvalid, path)
            case .missingCLI(let path): return L10n.text(.locatorMissing, path)
            case .notInstalled: return L10n.text(.notInstalled)
            }
        }
    }
}
