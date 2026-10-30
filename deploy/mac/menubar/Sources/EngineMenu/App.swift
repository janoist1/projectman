import AppKit
import SwiftUI
import EngineMenuCore

@main
enum EngineMenuApp {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        withExtendedLifetime(delegate) { app.run() }
    }
}

final class AppState: ObservableObject {
    @Published var fetch: Fetch = .loading
    @Published var action: EngineAction?
    @Published var logs: Logs?
    @Published var logError: String?
    @Published var overlay: MenuOverlay?
    /// The app's own update (j, k).
    @Published var update: AppUpdateStatus = .idle
    /// The label of the release this app is switching the engine to (l, while it runs the engine CLI).
    @Published var switching: String?
    /// The engine package in this app's bundle; nil without one (a development build).
    var bundled: BundledPackage?
    /// Targets whose switch failed in this session: the app does not retry them by itself.
    var failedTargets = Set<String>()
    private let identity = Updates.identity
    var model: MenuModel {
        let offer = fetch.snapshot.flatMap { SwitchPolicy.menuOffer($0, bundled: bundled, failed: failedTargets) }
        let context = UpdateContext(app: update, canSelfUpdate: identity.canSelfUpdate, canDownload: identity.latestReleaseURL != nil,
                                    switching: switching, offer: offer)
        return MenuModel.make(fetch: fetch, action: action, now: Date(), overlay: overlay, update: context)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    let state = AppState()
    let flow = SetupFlow()
    private var status: NSStatusItem!
    private let menu = NSMenu()
    private var window: NSWindow?
    private var timer: Timer?
    private var animation: Timer?
    private var phase = 0.0
    private var fetching = false
    private var menuOpen = false
    private var lastFetch = Date.distantPast
    private var targetPid: Int?
    private var actionDeadline: Date?
    private var commandRunning = false
    private var pendingAction: EngineAction?
    private var maintenance: Maintenance!

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard isPlaced() else { return }
        if let id = Bundle.main.bundleIdentifier {
            for other in NSRunningApplication.runningApplications(withBundleIdentifier: id) where other.processIdentifier != ProcessInfo.processInfo.processIdentifier { other.terminate() }
        }
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu.delegate = self; menu.autoenablesItems = false; status.menu = menu
        flow.onChange = { [weak self] in
            guard let self else { return }
            self.state.overlay = self.flow.overlay; self.render()
        }
        flow.onEngineChanged = { [weak self] in self?.refresh() }
        maintenance = Maintenance(state: state, idle: { [weak self] in
            guard let self else { return false }
            return !self.flow.busy && self.state.overlay == nil && self.state.action == nil && !self.commandRunning
        }, changed: { [weak self] in self?.render(); self?.refresh() })
        let mode = SetupFlow.mode()
        if mode == .installed { startInstalled() }
        maintenance.start()
        render(); refresh()
        if mode == .offer { flow.offer() }
    }
    /// At every start of an installed engine: `current` follows the service's plist root, the app's own login item is
    /// registered, and the PM-1088 app goes without a window. A failed removal is logged and retried at the next start.
    private func startInstalled() {
        guard BundledEngine.isAvailable else { return }
        DispatchQueue.global(qos: .utility).async {
            if let location = try? EngineLocator.locate() {
                do { try EngineLayout(userHome: Machine.home).follow(serviceRoot: location.root) }
                catch { NSLog("projectman motor: could not follow the service root: %@", String(describing: error)) }
            }
            let legacy = Machine.legacy
            if legacy.isPresent {
                do { try legacy.remove() } catch { NSLog("projectman motor: could not remove the old menu bar app: %@", String(describing: error)) }
            }
            DispatchQueue.main.async { LoginItems.registerApp() }
        }
    }
    /// q: the downloaded app runs from /Applications or ~/Applications, not from a disk image or a translocated copy.
    private func isPlaced() -> Bool {
        guard BundledEngine.isAvailable else { return true }
        let placement = AppPlacement(userHome: Machine.home, copy: Installer.dittoCopy(runner: SystemProcess.runner))
        let bundle = Bundle.main.bundleURL
        if placement.isPlaced(bundle, translocated: false) { return true }
        let alert = NSAlert()
        alert.messageText = L10n.text(.moveTitle); alert.informativeText = L10n.text(.moveBody)
        alert.addButton(withTitle: L10n.text(.move))
        let cancel = alert.addButton(withTitle: L10n.text(.quit)); cancel.keyEquivalent = "\u{1b}"
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { NSApp.terminate(nil); return false }
        switch placement.place(bundle, translocated: false) {
        case .inPlace: return true
        case .moved(let target):
            let configuration = NSWorkspace.OpenConfiguration(); configuration.createsNewApplicationInstance = true
            NSWorkspace.shared.openApplication(at: target, configuration: configuration) { _, _ in
                DispatchQueue.main.async { NSApp.terminate(nil) }
            }
        case .failed:
            let failed = NSAlert(); failed.alertStyle = .warning
            failed.messageText = L10n.text(.moveFailedTitle); failed.informativeText = L10n.text(.moveFailedBody)
            failed.addButton(withTitle: L10n.text(.quit))
            failed.runModal(); NSApp.terminate(nil)
        }
        return false
    }
    /// Opening the running app again (Finder, Dock, `open`) shows the details window, so the app stays reachable
    /// when its menu bar icon is hidden (for example behind the notch).
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard status != nil else { return true }
        openWindow()
        return true
    }
    func menuWillOpen(_ menu: NSMenu) { menuOpen = true; refresh() }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false; scheduleRefresh() }
    func windowWillClose(_ notification: Notification) { window = nil; scheduleRefresh() }
    private func scheduleRefresh() {
        timer?.invalidate()
        guard !commandRunning, !fetching else { return }
        let interval: TimeInterval = state.action != nil || state.switching != nil ? 2 : (flow.isWatching ? 5 : (menuOpen || window != nil ? 15 : 60))
        let remaining = max(0.1, interval - Date().timeIntervalSince(lastFetch))
        timer = Timer(timeInterval: remaining, repeats: false) { [weak self] _ in self?.refresh() }
        RunLoop.main.add(timer!, forMode: .common)
    }
    private func updateAnimation() {
        guard state.model.icon == .busy, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else {
            animation?.invalidate(); animation = nil; return
        }
        guard animation == nil else { return }
        animation = Timer(timeInterval: 0.3, repeats: true) { [weak self] _ in
            guard let self else { return }
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                self.animation?.invalidate(); self.animation = nil; return
            }
            self.phase += 0.3
            self.status.button?.image = StatusIcon.image(.busy, phase: self.phase)
        }
        RunLoop.main.add(animation!, forMode: .common)
    }
    private func refresh() {
        guard !fetching, !commandRunning, !flow.busy else { return }
        timer?.invalidate()
        fetching = true; lastFetch = Date()
        let includeLogs = window != nil
        let awaitingSetup = flow.awaiting != nil
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let fetch: Fetch
            let mode = SetupFlow.mode()
            if mode == .offer && !awaitingSetup {
                // Nothing is installed: h, not a status of an engine that does not exist.
                fetch = .notInstalled
            } else {
                do {
                    let result = try EngineClient.run(["status", "--json"], timeout: 20)
                    fetch = result.status == 0 ? Fetch.decode(result.out) : .unavailable(result.error)
                } catch { fetch = .unavailable(String(describing: error)) }
            }
            var logs: Logs?, logError: String?
            if includeLogs && fetch.snapshot != nil {
                do {
                    let result = try EngineClient.run(["logs", "--json", "--lines", "50"], timeout: 20)
                    if result.status == 0 { logs = try JSONDecoder().decode(Logs.self, from: result.out) }
                    else { logError = result.error }
                } catch { logError = String(describing: error) }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.fetching = false; self.state.fetch = fetch
                if includeLogs { self.state.logs = logs; self.state.logError = logError }
                if let action = self.state.action, self.actionDeadline != nil {
                    if let snapshot = fetch.snapshot, action.reached(snapshot, previousPid: self.targetPid) {
                        self.state.action = nil; self.actionDeadline = nil
                    } else if let deadline = self.actionDeadline, Date() >= deadline {
                        self.state.action = nil; self.actionDeadline = nil; self.showError(action, L10n.text(.timeout))
                    }
                }
                self.render()
                self.scheduleRefresh()
                self.flow.observe(fetch, mode: mode)
                self.maintenance.observe(fetch)
                if let pending = self.pendingAction {
                    self.pendingAction = nil; self.act(pending)
                }
            }
        }
    }
    private func render() {
        let model = state.model
        updateAnimation()
        status.button?.image = StatusIcon.image(model.icon)
        status.button?.imagePosition = .imageLeading
        status.button?.attributedTitle = NSAttributedString(string: model.count > 0 ? " \(model.count)" : "", attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)])
        let description = model.count > 0 ? L10n.text(.workAccessibility, model.header.text, String(model.count)) : model.header.text
        let accessibility = L10n.text(.accessibility, description)
        status.button?.setAccessibilityLabel(accessibility); status.button?.toolTip = accessibility
        menu.removeAllItems()
        let heading = NSMenuItem(title: model.header.text, action: nil, keyEquivalent: "")
        let color: NSColor = model.icon == .running ? .systemGreen : model.icon == .noCloud ? .systemYellow : model.icon == .warning ? .systemRed : model.icon == .caution ? .systemOrange : .systemGray
        let headingText = NSMutableAttributedString(string: "● " + model.header.text, attributes: [.font: NSFont.boldSystemFont(ofSize: 13)])
        headingText.addAttribute(.foregroundColor, value: color, range: NSRange(location: 0, length: 1))
        heading.attributedTitle = headingText; heading.isEnabled = false
        menu.addItem(heading)
        if let subtitle = model.subtitle {
            let item = NSMenuItem(title: subtitle.text, action: nil, keyEquivalent: ""); item.isEnabled = false; menu.addItem(item)
        }
        for row in model.rows {
            if row.isSeparator { menu.addItem(.separator()); continue }
            let rawTitle = row.title?.text ?? row.literal ?? ""
            var title = rawTitle
            if row.literal != nil {
                let font = NSFont.menuFont(ofSize: 0)
                let providerWidth = NSAttributedString(string: row.secondary ?? "", attributes: [.font: font]).size().width
                let width = max(100, 270 - providerWidth)
                while NSAttributedString(string: title, attributes: [.font: font]).size().width > width && title.count > 1 {
                    title = String(title.dropLast(title.hasSuffix("…") ? 2 : 1)) + "…"
                }
            }
            if row.section {
                if #available(macOS 14.0, *) { menu.addItem(.sectionHeader(title: title)); continue }
            }
            let item = NSMenuItem(title: title, action: row.command == nil ? nil : #selector(performCommand(_:)), keyEquivalent: row.command == .quit ? "q" : "")
            item.target = self; item.representedObject = row.command?.rawValue
            item.isEnabled = row.enabled && row.command != nil
            if let secondary = row.secondary {
                let paragraph = NSMutableParagraphStyle()
                paragraph.tabStops = [NSTextTab(textAlignment: .right, location: 290)]
                let attributed = NSMutableAttributedString(string: title, attributes: [.paragraphStyle: paragraph])
                attributed.append(NSAttributedString(string: "\t" + secondary, attributes: [.foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: paragraph]))
                item.attributedTitle = attributed
            }
            menu.addItem(item)
        }
    }
    @objc private func performCommand(_ sender: NSMenuItem) {
        guard let raw = sender.representedObject as? String, let command = MenuCommand(rawValue: raw) else { return }
        switch command {
        case .quit: NSApp.terminate(nil)
        case .retry: refresh()
        case .details: openWindow()
        case .cloud:
            if let origin = state.fetch.snapshot?.engine?.cloudOrigin, let url = URL(string: origin), let scheme = url.scheme, ["https", "http"].contains(scheme) { NSWorkspace.shared.open(url) }
        case .install: flow.offer()
        case .showInstall: flow.showInstall()
        case .openLoginItems: flow.openLoginItems()
        case .start: act(.start)
        case .stop: act(.stop)
        case .restart: act(.restart)
        case .retryUpdate: maintenance.retryUpdate()
        case .copyUpdateError: maintenance.copyUpdateError()
        case .downloadManually: maintenance.openDownloadPage()
        case .updateNow, .retrySwitch: maintenance.switchNow()
        case .copySwitchError: maintenance.copySwitchError()
        }
    }
    private func act(_ action: EngineAction) {
        guard state.action == nil, state.switching == nil else { return }
        if fetching { pendingAction = action; return }
        guard let snapshot = state.fetch.snapshot, snapshot.service.installed else { return }
        if action == .start && snapshot.overall != "stopped" { return }
        if action != .start && !state.model.active { return }
        let count = state.fetch.snapshot?.work.total ?? 0
        if action != .start && count > 0 {
            let alert = NSAlert()
            alert.messageText = L10n.text(action == .stop ? .stopTitle : .restartTitle)
            alert.informativeText = L10n.text(action == .stop ? .stopBody : .restartBody, String(count))
            let cancel = alert.addButton(withTitle: L10n.text(.cancel))
            cancel.keyEquivalent = "\u{1b}"
            alert.window.defaultButtonCell = cancel.cell as? NSButtonCell
            let destructive = alert.addButton(withTitle: L10n.text(action == .stop ? .stop : .restart))
            destructive.hasDestructiveAction = true; destructive.keyEquivalent = ""
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertSecondButtonReturn else { return }
        }
        targetPid = state.fetch.snapshot?.process.pid
        state.action = action; commandRunning = true; timer?.invalidate(); render()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let failure: String?
            do {
                let result = try EngineClient.run(["service", action.rawValue], timeout: action == .start ? 60 : 150)
                failure = result.status == 0 ? nil : result.error
            } catch { failure = String(describing: error) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.commandRunning = false
                if let failure { self.state.action = nil; self.showError(action, failure) }
                else { self.actionDeadline = Date().addingTimeInterval(120) }
                self.refresh(); self.render()
            }
        }
    }
    private func showError(_ action: EngineAction, _ message: String) {
        let alert = NSAlert(); alert.alertStyle = .warning
        alert.messageText = L10n.text(action.failure); alert.informativeText = message
        alert.addButton(withTitle: L10n.text(.ok))
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
    private func openWindow() {
        if window == nil {
            let created = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 440, height: 620), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            created.title = L10n.text(.appTitle); created.minSize = NSSize(width: 400, height: 440)
            let remove: () -> Void = { [weak self] in
                guard let self else { return }
                self.flow.confirmRemoval(working: self.state.fetch.snapshot?.work.total ?? 0)
            }
            created.contentView = NSHostingView(rootView: DetailsView(state: state, retry: { [weak self] in self?.refresh() }, remove: remove))
            created.isReleasedWhenClosed = false; created.delegate = self; created.center(); window = created
        }
        NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil); refresh()
    }
}
func copyText(_ text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
