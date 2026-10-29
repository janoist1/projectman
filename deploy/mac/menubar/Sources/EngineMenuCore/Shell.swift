import Foundation

public struct CommandResult {
    public let status: Int32
    public let out: Data
    public let error: String
    public init(status: Int32, out: Data = Data(), error: String = "") { self.status = status; self.out = out; self.error = error }
    public var outText: String { String(decoding: out, as: UTF8.self) }
}
/// One child process. Everything the app runs goes through a `CommandRunner`, so tests substitute their own.
public struct CommandSpec {
    public var executable: String
    public var arguments: [String]
    public var environment: [String: String]?
    public var directory: String?
    public var timeout: TimeInterval
    public init(_ executable: String, _ arguments: [String] = [], environment: [String: String]? = nil, directory: String? = nil, timeout: TimeInterval) {
        self.executable = executable; self.arguments = arguments; self.environment = environment; self.directory = directory; self.timeout = timeout
    }
}
public typealias CommandRunner = (CommandSpec) throws -> CommandResult

public enum SystemProcess {
    public static let runner: CommandRunner = { spec in try SystemProcess.run(spec) }
    /// Runs off the main thread. Both pipes drain concurrently, including during launchd's shutdown wait.
    public static func run(_ spec: CommandSpec) throws -> CommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: spec.executable)
        process.arguments = spec.arguments
        if let directory = spec.directory { process.currentDirectoryURL = URL(fileURLWithPath: directory) }
        if let environment = spec.environment { process.environment = environment }
        let out = Pipe(), err = Pipe()
        process.standardOutput = out; process.standardError = err
        try process.run()
        let readers = DispatchGroup()
        let output = DataBox(), errors = DataBox()
        readers.enter()
        DispatchQueue.global().async { output.data = out.fileHandleForReading.readDataToEndOfFile(); readers.leave() }
        readers.enter()
        DispatchQueue.global().async { errors.data = err.fileHandleForReading.readDataToEndOfFile(); readers.leave() }
        let deadline = Date().addingTimeInterval(spec.timeout)
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

public enum RawError {
    /// The CLI prints `REFUSED [code] message`; that line is the raw error the windows show. Without one, the whole text.
    public static func text(_ result: CommandResult) -> String {
        let combined = [result.error, result.outText].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.joined(separator: "\n")
        if let line = combined.split(separator: "\n").first(where: { $0.contains("REFUSED [") }) { return String(line) }
        return combined.isEmpty ? "exit \(result.status)" : String(combined.suffix(4000))
    }
}
