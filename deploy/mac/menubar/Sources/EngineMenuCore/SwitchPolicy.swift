import Foundation

/// The engine package the app brings in its bundle (`Resources/engine/engine-package.json`).
public struct BundledPackage: Equatable {
    public let version: String
    public let tag: String?
    public init(version: String, tag: String?) { self.version = version; self.tag = tag }
    public static func read(at root: URL) -> BundledPackage? {
        guard let data = try? Data(contentsOf: root.appendingPathComponent(EngineLocator.packageFile)),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let version = object["version"] as? String, EngineLayout.isSafeVersion(version) else { return nil }
        return BundledPackage(version: version, tag: object["tag"] as? String)
    }
    public var label: String { tag ?? String(version.prefix(7)) }
}

/// A release the bundled package could switch the engine to.
public struct SwitchOffer: Equatable {
    public let version: String
    public let label: String
    public init(version: String, label: String) { self.version = version; self.label = label }
}
public enum SwitchDecision: Equatable {
    case none
    case now(SwitchOffer)
    /// Work is running: p asks first.
    case confirm(SwitchOffer, work: Int)
}

/// When the app moves the engine to the package it brought (o, p and the automatic switch). Only a package (`app`)
/// engine switches; a checkout engine is updated by hand (`service install`), and `service switch` refuses it.
public enum SwitchPolicy {
    /// The bundled package differs from the one the service runs, and no switch is running or stuck.
    public static func candidate(_ snapshot: Snapshot, bundled: BundledPackage?) -> SwitchOffer? {
        guard snapshot.service.manager == "app", snapshot.service.installed, let bundled, let running = snapshot.enginePackage,
              running.version != bundled.version else { return nil }
        if let kind = snapshot.switchState?.kind, kind != .rolledBack { return nil }
        return SwitchOffer(version: bundled.version, label: bundled.label)
    }
    /// A target that rolled back, or failed in this session, is not tried again by itself (no switching in circles).
    public static func isBlocked(_ snapshot: Snapshot, _ offer: SwitchOffer, failed: Set<String>) -> Bool {
        if failed.contains(offer.version) { return true }
        guard let state = snapshot.switchState, state.kind == .rolledBack else { return false }
        return state.target.version == offer.version
    }
    /// o: the row appears only while work runs; with none the app switches without asking.
    public static func menuOffer(_ snapshot: Snapshot, bundled: BundledPackage?, failed: Set<String>) -> SwitchOffer? {
        guard let offer = candidate(snapshot, bundled: bundled), !isBlocked(snapshot, offer, failed: failed), snapshot.work.total > 0 else { return nil }
        return offer
    }
    /// `manual` is the user's choice ("Frissítés most…", "Újrapróbálás" of m): it ignores a blocked target and asks when
    /// work runs. The automatic decision switches only an idle engine.
    public static func decide(_ snapshot: Snapshot, bundled: BundledPackage?, failed: Set<String>, manual: Bool) -> SwitchDecision {
        guard let offer = candidate(snapshot, bundled: bundled) else { return .none }
        if !manual && isBlocked(snapshot, offer, failed: failed) { return .none }
        let work = snapshot.work.total
        if work == 0 { return .now(offer) }
        return manual ? .confirm(offer, work: work) : .none
    }
}
