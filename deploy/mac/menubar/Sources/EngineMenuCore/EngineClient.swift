import Foundation

public enum EngineClient {
    public static func environment(path: String) -> [String: String] {
        ["PATH": path, "HOME": FileManager.default.homeDirectoryForCurrentUser.path, "TMPDIR": NSTemporaryDirectory()]
    }
    /// Runs off the main thread.
    public static func run(_ args: [String], timeout: TimeInterval, runner: CommandRunner = SystemProcess.runner) throws -> CommandResult {
        try runner(try EngineLocator.locate().command(args, timeout: timeout))
    }
}
