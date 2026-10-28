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
    var model: MenuModel { MenuModel.make(fetch: fetch, action: action, now: Date()) }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, NSWindowDelegate {
    let state = AppState()
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let id = Bundle.main.bundleIdentifier {
            for other in NSRunningApplication.runningApplications(withBundleIdentifier: id) where other.processIdentifier != ProcessInfo.processInfo.processIdentifier { other.terminate() }
        }
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        menu.delegate = self; menu.autoenablesItems = false; status.menu = menu
        render(); refresh()
    }
    func menuWillOpen(_ menu: NSMenu) { menuOpen = true; refresh() }
    func menuDidClose(_ menu: NSMenu) { menuOpen = false; scheduleRefresh() }
    func windowWillClose(_ notification: Notification) { window = nil; scheduleRefresh() }
    private func scheduleRefresh() {
        timer?.invalidate()
        guard !commandRunning, !fetching else { return }
        let interval: TimeInterval = state.action != nil ? 2 : (state.model.active || menuOpen || window != nil ? 15 : 60)
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
        guard !fetching, !commandRunning else { return }
        timer?.invalidate()
        fetching = true; lastFetch = Date()
        let includeLogs = window != nil
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let fetch: Fetch
            do {
                let result = try EngineClient.run(["status", "--json"], timeout: 20)
                fetch = result.status == 0 ? Fetch.decode(result.out) : .unavailable(result.error)
            } catch { fetch = .unavailable(String(describing: error)) }
            var logs: Logs?, logError: String?
            if includeLogs {
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
        let color: NSColor = model.icon == .running ? .systemGreen : model.icon == .noCloud ? .systemYellow : model.icon == .warning ? .systemRed : .systemGray
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
        case .copyInstall: copyText("npm run engine -- service install")
        case .copyUpdate: copyText("npm run engine -- app install")
        case .start: act(.start)
        case .stop: act(.stop)
        case .restart: act(.restart)
        }
    }
    private func act(_ action: EngineAction) {
        guard state.action == nil else { return }
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
            created.contentView = NSHostingView(rootView: DetailsView(state: state, retry: { [weak self] in self?.refresh() }))
            created.isReleasedWhenClosed = false; created.delegate = self; created.center(); window = created
        }
        NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil); refresh()
    }
}
func copyText(_ text: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
