import Foundation

public struct CommandResult { public let status: Int32; public let out: Data; public let error: String }
public enum EngineClient {
    /// Runs off the main thread. Both pipes drain concurrently, including during launchd's shutdown wait.
    public static func run(_ args: [String], timeout: TimeInterval) throws -> CommandResult {
        let location = try EngineLocator.locate()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: location.node)
        process.arguments = ["--import", "tsx", location.root + "/scripts/engine/cli.ts"] + args + ["--home", location.home]
        process.currentDirectoryURL = URL(fileURLWithPath: location.root)
        process.environment = ["PATH": location.path, "HOME": FileManager.default.homeDirectoryForCurrentUser.path, "TMPDIR": NSTemporaryDirectory()]
        let out = Pipe(), err = Pipe()
        process.standardOutput = out; process.standardError = err
        try process.run()
        let readers = DispatchGroup()
        let output = DataBox(), errors = DataBox()
        readers.enter()
        DispatchQueue.global().async { output.data = out.fileHandleForReading.readDataToEndOfFile(); readers.leave() }
        readers.enter()
        DispatchQueue.global().async { errors.data = err.fileHandleForReading.readDataToEndOfFile(); readers.leave() }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        let timedOut = process.isRunning
        if timedOut { process.terminate() }
        process.waitUntilExit()
        readers.wait()
        return CommandResult(status: timedOut ? -1 : process.terminationStatus, out: output.data,
                             error: timedOut ? L10n.text(.timeout) : String(decoding: errors.data, as: UTF8.self))
    }
    private final class DataBox: @unchecked Sendable { var data = Data() }
}
