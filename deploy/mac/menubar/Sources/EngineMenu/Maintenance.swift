import AppKit
import EngineMenuCore

/// The app's own update (j, k) and the release switch (l, m, n, o, p) of PM-1126. Everything here runs on the main
/// thread; the slow parts (download, `ditto`, the engine CLI) run on a background queue and report back.
final class Maintenance {
    private let state: AppState
    private let identity = Updates.identity
    /// No install, engine action or other app operation is running.
    private let idle: () -> Bool
    /// Redraws the menu and fetches a fresh status.
    private let changed: () -> Void
    private var timer: Timer?
    private var updating = false
    private var switching = false
    /// A check was due while the app was busy; it runs at the next opportunity.
    private var wanted = false
    private var schemaTried = false
    private var triggeredFor: String?

    init(state: AppState, idle: @escaping () -> Bool, changed: @escaping () -> Void) {
        self.state = state; self.idle = idle; self.changed = changed
    }

    /// At launch, then every 6 hours.
    func start() {
        state.bundled = BundledEngine.isAvailable ? BundledPackage.read(at: BundledEngine.url) : nil
        check()
        let repeating = Timer(timeInterval: 6 * 3600, repeats: true) { [weak self] _ in self?.check() }
        RunLoop.main.add(repeating, forMode: .common)
        timer = repeating
    }

    /// Called after every status fetch.
    func observe(_ fetch: Fetch) {
        if case .updateNeeded = fetch {
            // The engine is newer than this app: the one thing that can help is a newer app.
            if !schemaTried { schemaTried = true; check() }
        } else { schemaTried = false }
        if let snapshot = fetch.snapshot {
            if let version = snapshot.process.version, let bundled = state.bundled, version != bundled.version, triggeredFor != version {
                triggeredFor = version; check()
            }
            evaluate(snapshot)
        }
        if wanted { check() }
    }

    // MARK: App update

    func check() {
        guard identity.canSelfUpdate, !updating else { return }
        guard !switching, idle() else { wanted = true; return }
        wanted = false; updating = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result: Result<UpdateOutcome, Error>
            do {
                result = .success(try Updates.updater().run(onUpdating: {
                    DispatchQueue.main.async { self?.state.update = .updating; self?.changed() }
                }))
            } catch { result = .failure(error) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.updating = false
                switch result {
                case .success(.replaced): self.state.update = .idle; Updates.relaunch()
                case .success: self.state.update = .idle
                case .failure(let error):
                    self.state.update = .failed((error as? UpdateFailure) ?? UpdateFailure("update_failed", Installer.describe(error)))
                }
                self.changed()
            }
        }
    }

    func retryUpdate() { schemaTried = true; check() }

    func openDownloadPage() {
        if let url = identity.latestReleaseURL { NSWorkspace.shared.open(url) }
    }

    func copyUpdateError() {
        if case .failed(let failure) = state.update { copyText(failure.description) }
    }

    func copySwitchError() {
        if let text = state.fetch.snapshot?.switchState?.errorText { copyText(text) }
    }

    // MARK: Release switch

    /// The automatic switch: only an idle engine, and never a target that rolled back or failed already.
    private func evaluate(_ snapshot: Snapshot) {
        guard !switching, !updating, idle() else { return }
        if case .now(let offer) = SwitchPolicy.decide(snapshot, bundled: state.bundled, failed: state.failedTargets, manual: false) {
            perform(offer, running: snapshot.enginePackage?.version, manual: false)
        }
    }

    /// "Frissítés most…" (o) and "Újrapróbálás" (m): the work count is read now; with no work left there is no question.
    func switchNow() {
        guard !switching, !updating, idle(), let snapshot = state.fetch.snapshot else { return }
        switch SwitchPolicy.decide(snapshot, bundled: state.bundled, failed: state.failedTargets, manual: true) {
        case .none: return
        case .now(let offer): perform(offer, running: snapshot.enginePackage?.version, manual: true)
        case .confirm(let offer, let work):
            if confirm(offer, work: work) { perform(offer, running: snapshot.enginePackage?.version, manual: true) }
        }
    }

    /// p. "Frissítés" is the default button (Return), "Mégse" answers Esc.
    private func confirm(_ offer: SwitchOffer, work: Int) -> Bool {
        let alert = NSAlert()
        alert.messageText = L10n.text(.updateConfirmTitle)
        alert.informativeText = L10n.text(.updateConfirmBody, offer.label, String(work)) + "\n\n" + L10n.text(.updateConfirmInfo)
        alert.addButton(withTitle: L10n.text(.updateConfirm))
        let cancel = alert.addButton(withTitle: L10n.text(.cancel)); cancel.keyEquivalent = "\u{1b}"
        NSApp.activate(ignoringOtherApps: true)
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func perform(_ offer: SwitchOffer, running: String?, manual: Bool) {
        guard let running else { return }
        switching = true; state.switching = offer.label
        if manual { state.failedTargets.remove(offer.version) }
        changed()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let failure: String?
            do {
                try Machine.installer.switchEngine(to: offer, running: running, engine: try EngineLocator.locate())
                failure = nil
            } catch { failure = Installer.describe(error) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.switching = false; self.state.switching = nil
                if let failure {
                    self.state.failedTargets.insert(offer.version)
                    if manual { self.showFailure(failure) }
                }
                self.changed()
            }
        }
    }

    private func showFailure(_ message: String) {
        let alert = NSAlert(); alert.alertStyle = .warning
        alert.messageText = L10n.text(.rolledBack); alert.informativeText = message
        alert.addButton(withTitle: L10n.text(.ok))
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}
