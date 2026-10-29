import Foundation

/// The PATH the engine's sessions find their tools on: the user's login shell's, read once at install time.
public enum PathResolver {
    public static let startMarker = "__PROJECTMAN_PATH_START__"
    public static let endMarker = "__PROJECTMAN_PATH_END__"
    public static let timeout: TimeInterval = 10

    public static func fallback(home: String) -> String {
        ["/opt/homebrew/bin", "/usr/local/bin", home + "/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].joined(separator: ":")
    }
    /// The text between the markers; an interactive shell's startup files may print around them.
    public static func parse(_ output: String) -> String? {
        guard let start = output.range(of: startMarker), let end = output.range(of: endMarker, range: start.upperBound..<output.endIndex) else { return nil }
        let value = String(output[start.upperBound..<end.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || value.contains("\n") ? nil : value
    }
    public static func resolve(shell: String?, home: String, runner: CommandRunner) -> String {
        let executable = shell.flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"
        let script = "printf '%s%s%s' '\(startMarker)' \"$PATH\" '\(endMarker)'"
        let spec = CommandSpec(executable, ["-l", "-i", "-c", script], environment: ["HOME": home, "TERM": "dumb"], timeout: timeout)
        guard let result = try? runner(spec), result.status == 0, let path = parse(result.outText) else { return fallback(home: home) }
        return path
    }
}
