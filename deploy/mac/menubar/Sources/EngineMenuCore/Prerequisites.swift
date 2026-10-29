import Foundation

public enum Prerequisite: Equatable {
    case appleSilicon
    case macOS(String)
    case commandLineTools
}
public struct MachineProbe {
    public var isAppleSilicon: Bool
    public var osVersion: OperatingSystemVersion
    public var commandLineToolsInstalled: () -> Bool
    public init(isAppleSilicon: Bool, osVersion: OperatingSystemVersion, commandLineToolsInstalled: @escaping () -> Bool) {
        self.isAppleSilicon = isAppleSilicon; self.osVersion = osVersion; self.commandLineToolsInstalled = commandLineToolsInstalled
    }
}
public struct PrerequisiteReport: Equatable {
    /// The Mac cannot run the engine (r3); nothing the user can install fixes it.
    public let unsupported: [Prerequisite]
    /// What the user can install (r).
    public let fixable: [Prerequisite]
    public var ok: Bool { unsupported.isEmpty && fixable.isEmpty }
}
public enum Prerequisites {
    public static let minimumMajorVersion = 13
    /// The Node is in the app; only git (Xcode command line tools) is needed on the Mac.
    public static func check(_ probe: MachineProbe) -> PrerequisiteReport {
        var unsupported: [Prerequisite] = []
        if !probe.isAppleSilicon { unsupported.append(.appleSilicon) }
        if probe.osVersion.majorVersion < minimumMajorVersion {
            unsupported.append(.macOS("\(probe.osVersion.majorVersion).\(probe.osVersion.minorVersion)"))
        }
        // With an unsupported Mac, the tools are not asked about: r3 is the only window.
        let fixable: [Prerequisite] = unsupported.isEmpty && !probe.commandLineToolsInstalled() ? [.commandLineTools] : []
        return PrerequisiteReport(unsupported: unsupported, fixable: fixable)
    }
    public static func system(runner: @escaping CommandRunner = SystemProcess.runner) -> MachineProbe {
        #if arch(arm64)
        let silicon = true
        #else
        let silicon = false
        #endif
        return MachineProbe(isAppleSilicon: silicon, osVersion: ProcessInfo.processInfo.operatingSystemVersion) {
            let result = try? runner(CommandSpec("/usr/bin/xcode-select", ["-p"], timeout: 10))
            return result?.status == 0
        }
    }
}
