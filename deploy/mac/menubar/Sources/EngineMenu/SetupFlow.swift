import AppKit
import SwiftUI
import EngineMenuCore

/// How this Mac relates to the engine: the app installed it (`installed`), the app may install it (`offer`), or the
/// engine is a checkout's business and the app only shows it (`showOnly`).
enum EngineMode { case installed, offer, showOnly }

private enum Entry { case fresh, activate(String), start(String) }

/// First launch, engine install, approval, the switch from the PM-1088 app and removal (PM-1125). The logic is in
/// `EngineMenuCore`; this class drives it and owns the setup window.
final class SetupFlow: NSObject, ObservableObject, NSWindowDelegate {
    @Published private(set) var screen: SetupScreen = .welcome
    private(set) var overlay: MenuOverlay?
    /// Called when the overlay changes (the menu follows it).
    var onChange: () -> Void = {}
    /// Called when the engine on disk changed (installed, removed, started): the app fetches a fresh snapshot.
    var onEngineChanged: () -> Void = {}

    private(set) var busy = false
    /// The version that is unpacked and waits for the wiring (e).
    private(set) var awaiting: String?
    private var steps = StepList(includeLegacy: false)
    private var window: NSWindow?
    private var approvalTimer: Timer?
    private var toolsTimer: Timer?

    var isWatching: Bool { awaiting != nil || approvalTimer != nil }

    static func mode() -> EngineMode {
        let plist = Machine.home.appendingPathComponent(EngineLocator.servicePlist)
        if FileManager.default.fileExists(atPath: plist.path) { return .installed }
        if !BundledEngine.isAvailable { return .showOnly }
        // An engine that runs from a git checkout in a terminal is the admin's: the app only shows it.
        if let location = try? EngineLocator.locate(), !location.isPackage, !Machine.legacy.isPresent { return .showOnly }
        return .offer
    }

    private func setOverlay(_ value: MenuOverlay?) { overlay = value; onChange() }
    private func work(_ body: @escaping () -> Void) { DispatchQueue.global(qos: .userInitiated).async(execute: body) }
    private func later(_ body: @escaping () -> Void) { DispatchQueue.main.async(execute: body) }

    // MARK: first launch (a, r, r2, r3)

    /// a, or r / r3 when the Mac lacks something.
    func offer() {
        guard !busy else { showWindow(); return }
        guard awaiting == nil else { screen = .awaitingSetup; showWindow(); return }
        work { [weak self] in
            let report = Prerequisites.check(Prerequisites.system())
            self?.later { self?.route(report) }
        }
    }
    private func route(_ report: PrerequisiteReport) {
        if !report.unsupported.isEmpty { screen = .unsupported(report) }
        else if !report.fixable.isEmpty { screen = .missingTools(waiting: false) }
        else { screen = .welcome }
        showWindow()
    }
    /// Return to the menu's h ("Most nem").
    func dismiss() {
        toolsTimer?.invalidate(); toolsTimer = nil
        closeWindow()
    }
    /// r: the macOS installer runs `xcode-select --install`; the app polls every 5 s and continues by itself.
    func installTools() {
        screen = .missingTools(waiting: true)
        work { [weak self] in
            _ = try? SystemProcess.run(CommandSpec("/usr/bin/xcode-select", ["--install"], timeout: 30))
            self?.later { self?.pollTools() }
        }
    }
    private func pollTools() {
        toolsTimer?.invalidate()
        toolsTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] timer in
            self?.work {
                let report = Prerequisites.check(Prerequisites.system())
                self?.later {
                    guard report.ok else { return }
                    timer.invalidate(); self?.toolsTimer = nil
                    self?.install()
                }
            }
        }
    }

    // MARK: install (b, c, d, e, f)

    func install() { run(.fresh) }

    private func run(_ entry: Entry) {
        guard !busy else { return }
        busy = true
        let installer = Machine.installer
        if case .fresh = entry { steps = StepList(includeLegacy: installer.legacy.isPresent) }
        awaiting = nil
        screen = .installing(steps); setOverlay(.installing)
        let report: Installer.Progress = { [weak self] step, status in self?.later { self?.apply(step, status) } }
        work { [weak self] in
            do {
                let version: String
                switch entry {
                case .fresh:
                    switch try installer.prepare(progress: report) {
                    case .awaitingSetup(let unpacked): self?.later { self?.finishAwaiting(unpacked) }; return
                    case .ready(let unpacked): version = unpacked
                    }
                case .activate(let unpacked): version = unpacked
                case .start(let unpacked): version = unpacked
                }
                if case .start = entry {
                    try installer.start(version: version, progress: report)
                    self?.later { self?.finishRunning() }
                    return
                }
                switch try installer.activate(version: version, progress: report) {
                case .running: self?.later { self?.finishRunning() }
                case .needsApproval: self?.later { self?.awaitApproval(version) }
                }
            } catch let failure as InstallFailure {
                self?.later { self?.finishFailed(failure) }
            } catch {
                self?.later { self?.finishFailed(InstallFailure(step: .unpack, message: Installer.describe(error))) }
            }
        }
    }
    private func apply(_ step: InstallStep, _ status: StepStatus) {
        steps.apply(step, status)
        if busy { screen = .installing(steps) }
    }
    private func finishAwaiting(_ version: String) {
        busy = false; awaiting = version; screen = .awaitingSetup; setOverlay(nil); onEngineChanged()
    }
    private func finishRunning() {
        busy = false; awaiting = nil; screen = .running; setOverlay(nil)
        LoginItems.registerApp()
        onEngineChanged()
    }
    private func finishFailed(_ failure: InstallFailure) {
        busy = false
        steps.fail(failure.step)
        screen = .failed(steps, failure.message); setOverlay(nil)
        showWindow()
        onEngineChanged()
    }

    /// c: the background item needs the user's approval in System Settings; the app polls every 2 s.
    private func awaitApproval(_ version: String) {
        busy = false; screen = .approval; setOverlay(.needsApproval)
        showWindow()
        LoginItems.openSettings()
        watchApproval(version: version)
    }
    private func watchApproval(version: String?) {
        approvalTimer?.invalidate()
        approvalTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            if LoginItems.status().blocksEngine { return }
            timer.invalidate(); self.approvalTimer = nil
            if let version { self.run(.start(version)) } else { self.setOverlay(nil); self.onEngineChanged() }
        }
    }
    func openLoginItems() { LoginItems.openSettings() }

    /// Called after every snapshot: e continues once the wiring exists, i appears when the engine is installed
    /// but its background item is off.
    func observe(_ fetch: Fetch, mode: EngineMode) {
        if let version = awaiting, !busy, let snapshot = fetch.snapshot, snapshot.overall != "not_initialised" {
            run(.activate(version)); return
        }
        if mode == .installed, !busy, overlay == nil, approvalTimer == nil, LoginItems.status().blocksEngine {
            setOverlay(.needsApproval); watchApproval(version: nil)
        }
    }

    /// The menu's "Telepítés megjelenítése" (h2) and the Details window after a closed install window.
    func showInstall() { showWindow() }

    // MARK: removal (s, s1, s2, s3)

    func confirmRemoval(working: Int) {
        guard !busy else { return }
        let alert = NSAlert()
        alert.messageText = L10n.text(.removeTitle)
        alert.informativeText = working > 0 ? L10n.text(.removeBodyRunning, String(working)) : L10n.text(.removeBody)
        let cancel = alert.addButton(withTitle: L10n.text(.cancel))
        cancel.keyEquivalent = "\u{1b}"
        alert.window.defaultButtonCell = cancel.cell as? NSButtonCell
        let destructive = alert.addButton(withTitle: L10n.text(.remove))
        destructive.hasDestructiveAction = true; destructive.keyEquivalent = ""
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        removeEngine()
    }
    func removeEngine() {
        guard !busy else { return }
        busy = true; awaiting = nil
        approvalTimer?.invalidate(); approvalTimer = nil
        setOverlay(.uninstalling)
        let uninstaller = Uninstaller(userHome: Machine.home, runner: SystemProcess.runner, unregister: LoginItems.unregisterApp)
        work { [weak self] in
            do {
                try uninstaller.run()
                self?.later { self?.finishRemoved() }
            } catch {
                self?.later { self?.finishRemovalFailed(Installer.describe(error)) }
            }
        }
    }
    private func finishRemoved() {
        busy = false; screen = .removed; setOverlay(nil); showWindow(); onEngineChanged()
    }
    private func finishRemovalFailed(_ message: String) {
        busy = false; screen = .removalFailed(message); setOverlay(nil); showWindow(); onEngineChanged()
    }

    // MARK: window

    func copyError() {
        switch screen {
        case .failed(_, let message), .removalFailed(let message): copyText(message)
        default: break
        }
    }
    private func showWindow() {
        if window == nil {
            let controller = NSHostingController(rootView: SetupView(flow: self))
            controller.sizingOptions = [.preferredContentSize]
            let created = NSWindow(contentViewController: controller)
            created.title = L10n.text(.appTitle)
            created.styleMask = [.titled, .closable]
            created.isReleasedWhenClosed = false; created.delegate = self; created.center(); window = created
        }
        NSApp.activate(ignoringOtherApps: true); window?.makeKeyAndOrderFront(nil)
    }
    func closeWindow() { window?.close() }
    func windowWillClose(_ notification: Notification) { window = nil }
}
