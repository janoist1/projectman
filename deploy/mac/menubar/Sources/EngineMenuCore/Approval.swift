import Foundation

/// `SMAppService.statusForLegacyPlist(at:)` for the engine's LaunchAgent, as the core sees it.
public enum ApprovalStatus: Equatable {
    case enabled, requiresApproval, notRegistered, notFound
    /// Only a background item the user has switched off blocks the engine (c, menu i).
    public var blocksEngine: Bool { self == .requiresApproval }
}
