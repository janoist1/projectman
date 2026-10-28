import Foundation

public struct EngineLocation: Codable {
    public let schemaVersion: Int
    public let node: String
    public let root: String
    public let home: String
    public let path: String
}
public enum EngineLocator {
    public static func locate(userHome: URL = FileManager.default.homeDirectoryForCurrentUser) throws -> EngineLocation {
        let plist = userHome.appendingPathComponent("Library/LaunchAgents/com.projectman.engine.plist")
        let location: EngineLocation
        if FileManager.default.fileExists(atPath: plist.path) {
            let data = try Data(contentsOf: plist)
            guard let values = try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                  let args = values["ProgramArguments"] as? [String], let node = args.first,
                  let root = values["WorkingDirectory"] as? String,
                  let env = values["EnvironmentVariables"] as? [String: String],
                  let home = env["PROJECTMAN_HOME"], let path = env["PATH"] else { throw LocationError.invalid(plist.path) }
            location = EngineLocation(schemaVersion: 1, node: node, root: root, home: home, path: path)
        } else {
            location = try JSONDecoder().decode(EngineLocation.self, from: Data(contentsOf: userHome.appendingPathComponent("Library/Application Support/projectman/menubar.json")))
        }
        guard location.schemaVersion == 1, location.node.hasPrefix("/"), location.home.hasPrefix("/"), location.root.hasPrefix("/"), !location.path.isEmpty else { throw LocationError.invalid(location.root) }
        guard FileManager.default.fileExists(atPath: location.root + "/scripts/engine/cli.ts") else { throw LocationError.missingCLI(location.root + "/scripts/engine/cli.ts") }
        return location
    }
    enum LocationError: Error, CustomStringConvertible {
        case invalid(String), missingCLI(String)
        var description: String {
            switch self {
            case .invalid(let path): return L10n.text(.locatorInvalid, path)
            case .missingCLI(let path): return L10n.text(.locatorMissing, path)
            }
        }
    }
}
