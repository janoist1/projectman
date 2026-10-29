import Foundation

public enum EngineAction: String { case start, stop, restart
    public var progress: L10n { switch self { case .start: return .starting; case .stop: return .stopping; case .restart: return .restarting } }
    public var failure: L10n { switch self { case .start: return .startFailed; case .stop: return .stopFailed; case .restart: return .restartFailed } }
    public func reached(_ snapshot: Snapshot, previousPid: Int?) -> Bool {
        if self == .stop { return snapshot.overall == "stopped" }
        return ["running", "no_cloud"].contains(snapshot.overall) && (self != .restart || (snapshot.process.pid != nil && snapshot.process.pid != previousPid))
    }
}
/// `warning` is red (the engine cannot be reached or is stuck), `caution` orange (something failed, the engine is fine).
public enum IconKind { case running, noCloud, stopped, unconfigured, warning, caution, busy }
public enum MenuCommand: String {
    case start, stop, restart, cloud, details, quit, retry, install, showInstall, openLoginItems
    case retryUpdate, copyUpdateError, downloadManually, updateNow, retrySwitch, copySwitchError
}
/// What the app knows about its own update and the release switch, on top of the engine's snapshot (PM-1126).
public struct UpdateContext: Equatable {
    public var app: AppUpdateStatus
    /// A signed build with a release repository: "Újrapróbálás" of k2 makes sense only then.
    public var canSelfUpdate: Bool
    /// "Letöltés kézzel…" needs a release repository.
    public var canDownload: Bool
    /// The label of the release this app is switching the engine to right now (it runs the CLI), nil otherwise.
    public var switching: String?
    /// o: the bundled package differs from the running one and work runs.
    public var offer: SwitchOffer?
    public init(app: AppUpdateStatus = .idle, canSelfUpdate: Bool = false, canDownload: Bool = false, switching: String? = nil, offer: SwitchOffer? = nil) {
        self.app = app; self.canSelfUpdate = canSelfUpdate; self.canDownload = canDownload; self.switching = switching; self.offer = offer
    }
}
/// What the app itself is doing, on top of the engine's state: installing (h2), waiting for the user's approval (i)
/// or removing the engine (s1).
public enum MenuOverlay: Equatable { case installing, needsApproval, uninstalling }
public struct MenuRow {
    public let title: Localized?
    public let literal: String?
    public let secondary: String?
    public let command: MenuCommand?
    public let enabled: Bool
    public let section: Bool
    public init(_ title: Localized? = nil, literal: String? = nil, secondary: String? = nil, command: MenuCommand? = nil, enabled: Bool = true, section: Bool = false) {
        self.title = title; self.literal = literal; self.secondary = secondary; self.command = command; self.enabled = enabled; self.section = section
    }
    public var isSeparator: Bool { title == nil && literal == nil }
}
public struct MenuModel {
    public var icon: IconKind = .busy
    public var count = 0
    public var header = Localized(.loading)
    public var subtitle: Localized?
    public var rows: [MenuRow] = []
    public var awake: Localized?
    public var active = false
    /// Header precedence, first wins: the app's own running operation, n (stuck), l (switching), the engine's own
    /// problems, k2 (app too old), k (update failed), m (rolled back), j (updating), the normal state with o.
    public static func make(fetch: Fetch, action: EngineAction?, now: Date, overlay: MenuOverlay? = nil, update: UpdateContext = UpdateContext()) -> MenuModel {
        var model = MenuModel()
        let separator = MenuRow()
        func item(_ key: L10n, _ command: MenuCommand, enabled: Bool = true) -> MenuRow {
            MenuRow(Localized(key), command: command, enabled: enabled)
        }
        func controlsDisabled(_ rows: [MenuRow]) -> [MenuRow] {
            rows.map { row in
                guard row.command == .start || row.command == .stop || row.command == .restart else { return row }
                return MenuRow(row.title, literal: row.literal, secondary: row.secondary, command: row.command, enabled: false, section: row.section)
            }
        }
        switch overlay {
        case .installing?:
            model.icon = .busy; model.header = Localized(.installing); model.subtitle = Localized(.installingReason)
            model.rows = [separator, item(.showInstall, .showInstall), separator, item(.quit, .quit)]
            return model
        case .needsApproval?:
            model.icon = .warning; model.header = Localized(.needsApproval); model.subtitle = Localized(.needsApprovalReason)
            model.rows = [separator, item(.openSettings, .openLoginItems), separator, item(.quit, .quit)]
            return model
        default: break
        }
        switch fetch {
        case .loading: model.rows = [item(.quitRunning, .quit)]
        case .notInstalled:
            model.icon = .unconfigured; model.header = Localized(.notInstalled); model.subtitle = Localized(.notInstalledReason)
            model.rows = [separator, item(.installEngine, .install), separator, item(.quit, .quit)]
        case .updateNeeded:
            // The engine is newer than this app: look for a newer app first (j), and only without one say so (k2).
            if update.app == .updating {
                model.icon = .busy; model.header = Localized(.appUpdating); model.subtitle = Localized(.appUpdatingReason)
                model.rows = [separator, item(.quit, .quit)]
            } else {
                model.icon = .warning; model.header = Localized(.appTooOld); model.subtitle = Localized(.appTooOldReason)
                model.rows = [separator]
                if update.canSelfUpdate { model.rows.append(item(.retry, .retryUpdate)) }
                if update.canDownload { model.rows.append(item(.downloadManually, .downloadManually)) }
                model.rows += [separator, item(.quit, .quit)]
            }
        case .unavailable:
            model.icon = .warning; model.header = Localized(.unavailable); model.subtitle = Localized(.unavailableReason)
            model.rows = [item(.retry, .retry), item(.details, .details), separator, item(.quit, .quit)]
        case .ready(let s):
            if s.keepAwake.supported {
                model.awake = s.keepAwake.holding ? Localized(.holding, relative: Format.relative(s.keepAwake.since, now: now)) : Localized(s.keepAwake.mode == "off" ? .awakeOff : .whileWorking)
            }
            model.active = ["running", "no_cloud"].contains(s.overall)
            if model.active {
                model.icon = s.overall == "running" ? .running : .noCloud
                model.count = s.work.total
                model.header = s.overall == "running" ? Localized(.running, relative: Format.relative(s.link.since, now: now)) : Localized(.noCloud)
                if s.overall == "no_cloud" { model.subtitle = Localized(.reconnecting, relative: Format.relative(s.link.since, now: now), prefix: [String(s.link.attempts)]) }
                else if let version = s.process.version, let release = s.process.releaseTag {
                    model.subtitle = Localized(.version, version, release)
                } else if let version = s.process.version { model.subtitle = Localized(.versionOnly, version)
                } else if let release = s.process.releaseTag { model.subtitle = Localized(.releaseOnly, release)
                }
                model.rows.append(separator)
                model.rows.append(MenuRow(Localized(.work, String(s.work.total)), enabled: false, section: true))
                if s.work.total == 0 { model.rows.append(MenuRow(Localized(.noWork), enabled: false)) }
                for session in s.sessions.prefix(5) {
                    model.rows.append(MenuRow(literal: session.label ?? session.sessionId, secondary: session.provider, command: .cloud))
                }
                if s.sessions.count > 5 { model.rows.append(MenuRow(Localized(.more, String(s.sessions.count - 5)), command: .cloud)) }
                if s.work.fullTests > 0 { model.rows.append(MenuRow(Localized(.fullTests, String(s.work.fullTests)), enabled: false)) }
                if s.work.screenshots > 0 { model.rows.append(MenuRow(Localized(.screenshots, String(s.work.screenshots)), enabled: false)) }
                if s.keepAwake.supported {
                    model.rows.append(MenuRow(model.awake, enabled: false))
                }
                model.rows += [separator, item(.cloud, .cloud), item(.details, .details), separator]
                if s.service.installed {
                    model.rows += [item(.restart, .restart), item(s.work.total > 0 ? .stopConfirm : .stop, .stop)]
                } else { model.rows.append(MenuRow(Localized(.terminal), enabled: false)) }
                model.rows += [separator, item(.quitRunning, .quit)]
            } else if s.overall == "stopped" {
                model.icon = .stopped; model.header = Localized(.stopped)
                model.subtitle = Localized(s.service.installed ? .idle : .notInstalled)
                var rows: [MenuRow] = [separator]
                if s.service.installed { rows.append(item(.start, .start)) }
                rows += [separator, item(.cloud, .cloud), item(.details, .details), separator, item(.quit, .quit)]
                model.rows = rows
            } else {
                model.icon = .unconfigured; model.header = Localized(.notInitialised); model.subtitle = Localized(.setup)
                model.rows = [separator, item(.quit, .quit)]
            }
        }
        if fetch.snapshot == nil, let label = update.switching, case .unavailable = fetch {
            // The engine restarts during the switch: its status may be unreachable for a moment, and l covers the gap.
            model.icon = .busy; model.count = 0; model.header = Localized(.switching, label); model.subtitle = Localized(.switchingReason)
        }
        if let snapshot = fetch.snapshot { applyUpdate(&model, snapshot: snapshot, now: now, update: update, controlsDisabled: controlsDisabled) }
        if action != nil || overlay == .uninstalling {
            let removing = overlay == .uninstalling
            model.icon = .busy; model.count = 0; model.header = Localized(removing ? .removing : (action ?? .stop).progress)
            model.subtitle = (removing || action == .stop) && (fetch.snapshot?.work.total ?? 0) > 0 ? Localized(.pausing) : nil
            model.rows = controlsDisabled(model.rows)
        }
        return model
    }

    /// The release switch (l, m, n, o) and the app's own update (j, k) on top of a snapshot. The rows come in front of
    /// the normal menu; the header changes only while the engine runs (its own problems come first).
    private static func applyUpdate(_ model: inout MenuModel, snapshot: Snapshot, now: Date, update: UpdateContext,
                                    controlsDisabled: ([MenuRow]) -> [MenuRow]) {
        let separator = MenuRow()
        let state = snapshot.switchState
        let running = model.active
        var extra: [MenuRow] = []
        var banner: (icon: IconKind, header: Localized, subtitle: Localized, count: Int?)?
        var overrides = false
        func claim(_ icon: IconKind, _ header: Localized, _ subtitle: Localized, count: Int? = nil) {
            if banner == nil { banner = (icon, header, subtitle, count) }
        }
        if state?.kind == .recoveryRequired {
            // n: no retry, no start; the user needs a person. n and l hold the header even when the engine itself is down.
            overrides = true
            claim(.warning, Localized(.stuck), Localized(.stuckReason), count: 0)
            model.rows = [separator, MenuRow(Localized(.copyError), command: .copySwitchError)] + controlsDisabled(model.rows)
        } else if state?.kind == .switching || update.switching != nil {
            let label = state?.kind == .switching ? state?.target.label : update.switching
            overrides = true
            claim(.busy, Localized(.switching, label ?? ""), Localized(.switchingReason), count: 0)
            model.rows = controlsDisabled(model.rows)
        } else {
            if case .failed = update.app {
                claim(.caution, Localized(.appUpdateFailed), Localized(.appUpdateFailedReason))
                extra += [separator, MenuRow(Localized(.retry), command: .retryUpdate), MenuRow(Localized(.copyError), command: .copyUpdateError)]
                if update.canDownload { extra.append(MenuRow(Localized(.downloadManually), command: .downloadManually)) }
            }
            if let state, state.kind == .rolledBack, state.isRecent(now: now) {
                let subtitle = state.previous.map { Localized(.rolledBackTo, $0.label) } ?? Localized(.rolledBackPrevious)
                claim(.caution, Localized(.rolledBack), subtitle)
                extra.append(separator)
                if snapshot.service.manager == "app" { extra.append(MenuRow(Localized(.retry), command: .retrySwitch)) }
                extra.append(MenuRow(Localized(.copyError), command: .copySwitchError))
            }
            if update.app == .updating { claim(.busy, Localized(.appUpdating), Localized(.appUpdatingReason)) }
            if let offer = update.offer, state?.kind == nil || state?.kind == .rolledBack {
                extra += [separator, MenuRow(Localized(.updateNow), secondary: L10n.text(.releaseOnly, offer.label), command: .updateNow),
                          MenuRow(Localized(.updateWhenIdle), enabled: false)]
            }
            model.rows = extra + model.rows
        }
        guard running || overrides, let banner else { return }
        model.icon = banner.icon; model.header = banner.header; model.subtitle = banner.subtitle
        if let count = banner.count { model.count = count }
    }
}
