import Foundation

public enum StepState: Equatable { case pending, active, done, failed }
public struct StepRow: Equatable {
    public let step: InstallStep
    public var state: StepState
    public var title: L10n {
        switch step {
        case .removeOldApp: return .stepRemoveOldApp
        case .unpack: return .stepUnpack
        case .serviceInstall: return .stepService
        case .backgroundItem: return .stepBackgroundItem
        case .start: return .stepStart
        }
    }
}
/// The checklist of b and d. The first row exists only when the old app is on the machine.
public struct StepList: Equatable {
    public private(set) var rows: [StepRow]
    public init(includeLegacy: Bool) {
        rows = InstallStep.allCases.filter { includeLegacy || $0 != .removeOldApp }.map { StepRow(step: $0, state: .pending) }
    }
    public mutating func apply(_ step: InstallStep, _ status: StepStatus) {
        guard let index = rows.firstIndex(where: { $0.step == step }) else { return }
        switch status {
        case .started: rows[index].state = .active
        case .done: rows[index].state = .done
        case .skipped: rows.remove(at: index)
        }
    }
    public mutating func fail(_ step: InstallStep) {
        guard let index = rows.firstIndex(where: { $0.step == step }) else { return }
        rows[index].state = .failed
    }
    /// d shows the steps that succeeded and the one that failed, not the ones not reached.
    public var reached: [StepRow] { rows.filter { $0.state != .pending && $0.state != .active } }
}

public enum SetupScreen: Equatable {
    case welcome                                // a
    case missingTools(waiting: Bool)            // r, r2
    case unsupported(PrerequisiteReport)        // r3
    case installing(StepList)                   // b
    case approval                               // c
    case failed(StepList, String)               // d
    case awaitingSetup                          // e
    case running                                // f
    case removed                                // s2
    case removalFailed(String)                  // s3
}

extension Prerequisite {
    public var text: String {
        switch self {
        case .appleSilicon: return L10n.text(.reqSilicon)
        case .macOS(let version): return L10n.text(.reqMacOS, version)
        case .commandLineTools: return L10n.text(.reqTools)
        }
    }
}
