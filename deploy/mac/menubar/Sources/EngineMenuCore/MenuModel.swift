import Foundation

public enum EngineAction: String { case start, stop, restart
    public var progress: L10n { switch self { case .start: return .starting; case .stop: return .stopping; case .restart: return .restarting } }
    public var failure: L10n { switch self { case .start: return .startFailed; case .stop: return .stopFailed; case .restart: return .restartFailed } }
    public func reached(_ snapshot: Snapshot, previousPid: Int?) -> Bool {
        if self == .stop { return snapshot.overall == "stopped" }
        return ["running", "no_cloud"].contains(snapshot.overall) && (self != .restart || (snapshot.process.pid != nil && snapshot.process.pid != previousPid))
    }
}
public enum IconKind { case running, noCloud, stopped, unconfigured, warning, busy }
public enum MenuCommand: String { case start, stop, restart, cloud, details, quit, retry, install, showInstall, openLoginItems }
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
    public static func make(fetch: Fetch, action: EngineAction?, now: Date, overlay: MenuOverlay? = nil) -> MenuModel {
        var model = MenuModel()
        let separator = MenuRow()
        func item(_ key: L10n, _ command: MenuCommand, enabled: Bool = true) -> MenuRow {
            MenuRow(Localized(key), command: command, enabled: enabled)
        }
        switch overlay {
        case .installing?:
            model.icon = .busy; model.header = Localized(.installing); model.subtitle = Localized(.installingReason)
            model.rows = [separator, item(.showInstall, .showInstall), separator, item(.quit, .quit)]
            return model
        case .needsApproval?:
            model.icon = .warning; model.header = Localized(.needsApproval); model.subtitle = Localized(.needsApprovalReason)
            model.rows = [separator, item(.openLoginItems, .openLoginItems), separator, item(.quit, .quit)]
            return model
        default: break
        }
        switch fetch {
        case .loading: model.rows = [item(.quitRunning, .quit)]
        case .notInstalled:
            model.icon = .unconfigured; model.header = Localized(.notInstalled); model.subtitle = Localized(.notInstalledReason)
            model.rows = [separator, item(.install, .install), separator, item(.quit, .quit)]
        case .updateNeeded:
            model.icon = .warning; model.header = Localized(.update); model.subtitle = Localized(.updateReason)
            model.rows = [separator, item(.quit, .quit)]
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
        if action != nil || overlay == .uninstalling {
            let removing = overlay == .uninstalling
            model.icon = .busy; model.count = 0; model.header = Localized(removing ? .removing : (action ?? .stop).progress)
            model.subtitle = (removing || action == .stop) && (fetch.snapshot?.work.total ?? 0) > 0 ? Localized(.pausing) : nil
            model.rows = model.rows.map { row in
                guard row.command == .start || row.command == .stop || row.command == .restart else { return row }
                return MenuRow(row.title, literal: row.literal, secondary: row.secondary, command: row.command, enabled: false, section: row.section)
            }
        }
        return model
    }
}
