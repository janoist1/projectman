import XCTest
@testable import EngineMenuCore

final class SwitchTests: XCTestCase {
    private func data(_ name: String) throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: "status-" + name, withExtension: "json", subdirectory: "Fixtures")!)
    }
    private func snapshot(_ name: String, change: (inout [String: Any]) -> Void = { _ in }) throws -> Snapshot {
        var object = try JSONSerialization.jsonObject(with: data(name)) as! [String: Any]
        change(&object)
        return try JSONDecoder().decode(Snapshot.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func model(_ snapshot: Snapshot, update: UpdateContext = UpdateContext(), action: EngineAction? = nil,
                       now: Date = ISO8601DateFormatter().date(from: "2026-10-29T12:00:00Z")!) -> MenuModel {
        MenuModel.make(fetch: .ready(snapshot), action: action, now: now, update: update)
    }
    private let bundled = BundledPackage(version: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", tag: "v2026.10.29")
    private func idle(_ s: inout [String: Any]) { s["work"] = ["sessions": 0, "fullTests": 0, "screenshots": 0]; s["sessions"] = [] }
    private func controls(_ m: MenuModel) -> [Bool] { m.rows.filter { [.start, .stop, .restart].contains($0.command) }.map(\.enabled) }

    // MARK: Snapshot

    func testSwitchAndPackageAreOptionalAndLenient() throws {
        XCTAssertNil(try snapshot("running").switchState)
        XCTAssertNil(try snapshot("running") { $0["switch"] = ["phase": 5] }.switchState)
        XCTAssertEqual(try snapshot("switching").switchState?.kind, .switching)
        XCTAssertEqual(try snapshot("rolled-back").enginePackage?.tag, "v2026.10.28")
    }
    func testReleaseLabelIsTheTagOrTheShortVersion() {
        XCTAssertEqual(PackageRef(version: "0123456789abcdef", tag: "v1").label, "v1")
        XCTAssertEqual(PackageRef(version: "0123456789abcdef", tag: nil).label, "0123456")
    }
    func testRollbackIsRecentOnlyForADay() throws {
        let state = try XCTUnwrap(try snapshot("rolled-back").switchState)
        let parser = ISO8601DateFormatter()
        XCTAssertTrue(state.isRecent(now: parser.date(from: "2026-10-30T11:00:00Z")!))
        XCTAssertFalse(state.isRecent(now: parser.date(from: "2026-10-30T11:03:00Z")!))
    }

    // MARK: Menu states

    func testSwitchingShowsTheTargetAndDisablesTheControls() throws {
        let m = model(try snapshot("switching"))
        XCTAssertEqual(m.header.key, .switching); XCTAssertEqual(m.header.args, ["v2026.10.29"])
        XCTAssertEqual(m.icon, .busy); XCTAssertEqual(m.count, 0)
        XCTAssertEqual(controls(m), [false])
    }
    func testSwitchingKeepsTheHeaderWhileTheEngineIsDown() {
        let m = MenuModel.make(fetch: .unavailable("down"), action: nil, now: Date(), update: UpdateContext(switching: "v2"))
        XCTAssertEqual(m.header.key, .switching); XCTAssertEqual(m.icon, .busy)
    }
    func testRolledBackOffersRetryForAPackageEngine() throws {
        let m = model(try snapshot("rolled-back"))
        XCTAssertEqual(m.header.key, .rolledBack); XCTAssertEqual(m.subtitle?.key, .rolledBackTo)
        XCTAssertEqual(m.subtitle?.args, ["v2026.10.28"]); XCTAssertEqual(m.icon, .caution); XCTAssertEqual(m.count, 1)
        XCTAssertEqual(m.rows.compactMap(\.command).prefix(2), [.retrySwitch, .copySwitchError])
    }
    func testRolledBackOfACheckoutEngineHasNoRetry() throws {
        let m = model(try snapshot("rolled-back") { $0["service"] = ["installed": true, "manager": "checkout"] })
        XCTAssertEqual(m.header.key, .rolledBack)
        XCTAssertFalse(m.rows.contains { $0.command == .retrySwitch }); XCTAssertTrue(m.rows.contains { $0.command == .copySwitchError })
    }
    func testRolledBackWithoutPreviousNamesNoRelease() throws {
        let m = model(try snapshot("rolled-back") { object in
            var state = object["switch"] as! [String: Any]; state["previous"] = NSNull(); object["switch"] = state
        })
        XCTAssertEqual(m.subtitle?.key, .rolledBackPrevious)
    }
    func testRolledBackFadesAfterADay() throws {
        let later = ISO8601DateFormatter().date(from: "2026-10-30T12:00:00Z")!
        let m = model(try snapshot("rolled-back"), now: later)
        XCTAssertEqual(m.header.key, .running); XCTAssertFalse(m.rows.contains { $0.command == .copySwitchError })
    }
    func testRecoveryRequiredIsRedWithoutRetryAndWithDisabledControls() throws {
        let m = model(try snapshot("recovery-required"))
        XCTAssertEqual(m.header.key, .stuck); XCTAssertEqual(m.icon, .warning)
        XCTAssertEqual(m.rows.compactMap(\.command), [.copySwitchError, .start, .cloud, .details, .quit])
        XCTAssertFalse(m.rows.contains { $0.command == .retrySwitch || $0.command == .retry })
        XCTAssertEqual(controls(m), [false])
    }
    func testStuckBeatsSwitchingAndTheOwnAction() throws {
        let stuck = try snapshot("recovery-required")
        XCTAssertEqual(model(stuck, update: UpdateContext(switching: "v2")).header.key, .stuck)
        XCTAssertEqual(model(stuck, action: .stop).header.key, EngineAction.stop.progress)
    }
    func testUpdateRowAppearsOnlyWithAnOffer() throws {
        let running = try snapshot("rolled-back") { $0["switch"] = NSNull() }
        XCTAssertFalse(model(running).rows.contains { $0.command == .updateNow })
        let offer = SwitchOffer(version: bundled.version, label: bundled.label)
        let m = model(running, update: UpdateContext(offer: offer))
        XCTAssertEqual(m.header.key, .running)
        XCTAssertEqual(m.rows.first { $0.command == .updateNow }?.secondary, L10n.text(.releaseOnly, "v2026.10.29"))
        XCTAssertEqual(m.rows.first { $0.title?.key == .updateWhenIdle }?.enabled, false)
    }

    // MARK: App update states

    func testUpdatingShowsBusyAndKeepsTheCount() throws {
        let m = model(try snapshot("running"), update: UpdateContext(app: .updating))
        XCTAssertEqual(m.header.key, .appUpdating); XCTAssertEqual(m.icon, .busy); XCTAssertEqual(m.count, 3)
    }
    func testFailedUpdateOffersRetryCopyAndDownload() throws {
        let failure = UpdateFailure("sha256_mismatch", "bad")
        let m = model(try snapshot("running"), update: UpdateContext(app: .failed(failure), canSelfUpdate: true, canDownload: true))
        XCTAssertEqual(m.header.key, .appUpdateFailed); XCTAssertEqual(m.icon, .caution); XCTAssertEqual(m.count, 3)
        XCTAssertEqual(m.rows.compactMap(\.command).prefix(3), [.retryUpdate, .copyUpdateError, .downloadManually])
    }
    func testFailedUpdateDoesNotHideAStoppedEngineAndLeavesNoOrphanRows() throws {
        let m = model(try snapshot("stopped"), update: UpdateContext(app: .failed(UpdateFailure("x", "y")), canDownload: true))
        XCTAssertEqual(m.header.key, .stopped)
        XCTAssertFalse(m.rows.contains { [.retryUpdate, .copyUpdateError, .downloadManually].contains($0.command) })
    }
    func testOnlyTheWinningBannerBringsItsRows() throws {
        let update = UpdateContext(app: .failed(UpdateFailure("x", "y")), canSelfUpdate: true, canDownload: true)
        let m = model(try snapshot("rolled-back"), update: update)
        XCTAssertEqual(m.header.key, .appUpdateFailed)
        let commands = m.rows.compactMap(\.command)
        XCTAssertEqual(commands.filter { $0 == .copyUpdateError }.count, 1)
        XCTAssertFalse(commands.contains(.retrySwitch)); XCTAssertFalse(commands.contains(.copySwitchError))
    }
    func testFailedUpdateBeatsRolledBackBeatsUpdating() throws {
        let rolled = try snapshot("rolled-back")
        XCTAssertEqual(model(rolled, update: UpdateContext(app: .failed(UpdateFailure("x", "y")))).header.key, .appUpdateFailed)
        XCTAssertEqual(model(rolled, update: UpdateContext(app: .updating)).header.key, .rolledBack)
    }
    func testTooOldAppOffersDownloadAndRetryOnlyWhenItCanUpdate() {
        let signed = MenuModel.make(fetch: .updateNeeded, action: nil, now: Date(), update: UpdateContext(canSelfUpdate: true, canDownload: true))
        XCTAssertEqual(signed.header.key, .appTooOld)
        XCTAssertEqual(signed.rows.compactMap(\.command), [.retryUpdate, .downloadManually, .quit])
        let adHoc = MenuModel.make(fetch: .updateNeeded, action: nil, now: Date(), update: UpdateContext(canDownload: true))
        XCTAssertEqual(adHoc.rows.compactMap(\.command), [.downloadManually, .quit])
    }
    func testTooOldAppLooksForAnUpdateFirst() {
        let m = MenuModel.make(fetch: .updateNeeded, action: nil, now: Date(), update: UpdateContext(app: .updating, canSelfUpdate: true))
        XCTAssertEqual(m.header.key, .appUpdating); XCTAssertEqual(m.rows.compactMap(\.command), [.quit])
    }

    // MARK: Switch policy

    private func running(_ name: String = "rolled-back", change: (inout [String: Any]) -> Void = { _ in }) throws -> Snapshot {
        try snapshot(name) { object in object["switch"] = NSNull(); change(&object) }
    }
    func testIdlePackageEngineSwitchesByItself() throws {
        let s = try running { idle(&$0) }
        XCTAssertEqual(SwitchPolicy.decide(s, bundled: bundled, failed: [], manual: false), .now(SwitchOffer(version: bundled.version, label: "v2026.10.29")))
    }
    func testBusyPackageEngineSwitchesOnlyAfterConfirmation() throws {
        let s = try running()
        XCTAssertEqual(SwitchPolicy.decide(s, bundled: bundled, failed: [], manual: false), .none)
        XCTAssertEqual(SwitchPolicy.decide(s, bundled: bundled, failed: [], manual: true), .confirm(SwitchOffer(version: bundled.version, label: "v2026.10.29"), work: 1))
    }
    func testWorkThatEndedBeforeTheQuestionSkipsIt() throws {
        let s = try running { idle(&$0) }
        XCTAssertEqual(SwitchPolicy.decide(s, bundled: bundled, failed: [], manual: true), .now(SwitchOffer(version: bundled.version, label: "v2026.10.29")))
    }
    func testCheckoutEngineNeverSwitches() throws {
        let s = try running { idle(&$0); $0["service"] = ["installed": true, "manager": "checkout"] }
        XCTAssertEqual(SwitchPolicy.decide(s, bundled: bundled, failed: [], manual: true), .none)
        XCTAssertNil(SwitchPolicy.menuOffer(s, bundled: bundled, failed: []))
    }
    func testStoppedEngineIsNeverSwitched() throws {
        for overall in ["stopped", "not_initialised"] {
            let s = try running { idle(&$0); $0["overall"] = overall }
            XCTAssertEqual(SwitchPolicy.decide(s, bundled: bundled, failed: [], manual: false), .none)
            XCTAssertEqual(SwitchPolicy.decide(s, bundled: bundled, failed: [], manual: true), .none)
        }
    }
    func testSameVersionAndMissingBundleDoNotSwitch() throws {
        let s = try running { idle(&$0) }
        let same = BundledPackage(version: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", tag: nil)
        XCTAssertEqual(SwitchPolicy.decide(s, bundled: same, failed: [], manual: true), .none)
        XCTAssertEqual(SwitchPolicy.decide(s, bundled: nil, failed: [], manual: true), .none)
    }
    func testNothingSwitchesWhileASwitchRunsOrIsStuck() throws {
        for name in ["switching", "recovery-required"] {
            XCTAssertEqual(SwitchPolicy.decide(try snapshot(name), bundled: bundled, failed: [], manual: true), .none)
        }
    }
    func testARolledBackTargetIsNotTriedAgainByItself() throws {
        let rolled = try snapshot("rolled-back") { idle(&$0) }
        XCTAssertEqual(SwitchPolicy.decide(rolled, bundled: bundled, failed: [], manual: false), .none)
        XCTAssertNil(SwitchPolicy.menuOffer(try snapshot("rolled-back"), bundled: bundled, failed: []))
        XCTAssertEqual(SwitchPolicy.decide(rolled, bundled: bundled, failed: [], manual: true), .now(SwitchOffer(version: bundled.version, label: "v2026.10.29")))
    }
    func testANewerPackageAfterARollbackIsOffered() throws {
        let rolled = try snapshot("rolled-back") { idle(&$0) }
        let newer = BundledPackage(version: "cccccccccccccccccccccccccccccccccccccccc", tag: "v2026.10.30")
        XCTAssertEqual(SwitchPolicy.decide(rolled, bundled: newer, failed: [], manual: false), .now(SwitchOffer(version: newer.version, label: "v2026.10.30")))
    }
    func testAFailedTargetIsNotRetriedInTheSameSession() throws {
        let s = try running { idle(&$0) }
        XCTAssertEqual(SwitchPolicy.decide(s, bundled: bundled, failed: [bundled.version], manual: false), .none)
        XCTAssertNil(SwitchPolicy.menuOffer(try running(), bundled: bundled, failed: [bundled.version]))
    }

    // MARK: Installer.switchEngine

    private func engine(_ fixture: InstallerFixture) -> EngineLocation {
        let root = fixture.layout.version("old").path
        return EngineLocation(schemaVersion: 1, node: root + "/bin/node", root: root, home: fixture.home.appendingPathComponent(".projectman").path, path: "/usr/bin:/bin")
    }
    private func prepareRunning(_ fixture: InstallerFixture) throws {
        let files = FileManager.default
        for name in ["old", "older"] {
            try files.createDirectory(at: fixture.layout.version(name), withIntermediateDirectories: true)
        }
        try fixture.layout.point(to: "old")
    }
    func testSwitchRunsTheNewPackagesCliThenPointsCurrentAndPrunes() throws {
        let fixture = try InstallerFixture(version: "1.2.3")
        try prepareRunning(fixture)
        try fixture.installer().switchEngine(to: SwitchOffer(version: "1.2.3", label: "1.2.3"), running: "old", engine: engine(fixture))
        let call = try XCTUnwrap(fixture.calls(containing: "switch").first)
        XCTAssertEqual(call.executable, fixture.layout.version("1.2.3").path + "/bin/node")
        XCTAssertEqual(call.arguments.suffix(4).prefix(2), ["--to", fixture.layout.version("1.2.3").path])
        XCTAssertEqual(fixture.layout.currentVersion(), "1.2.3")
        let kept = Set(try FileManager.default.contentsOfDirectory(atPath: fixture.layout.versions.path))
        XCTAssertEqual(kept, ["1.2.3", "old"])
    }
    func testFailedSwitchLeavesCurrentAndTheOldVersions() throws {
        let fixture = try InstallerFixture(version: "1.2.3")
        try prepareRunning(fixture)
        fixture.failing["switch"] = "REFUSED [switch_rolled_back] not healthy"
        XCTAssertThrowsError(try fixture.installer().switchEngine(to: SwitchOffer(version: "1.2.3", label: "1.2.3"), running: "old", engine: engine(fixture))) { error in
            XCTAssertTrue(Installer.describe(error).contains("switch_rolled_back"))
        }
        XCTAssertEqual(fixture.layout.currentVersion(), "old")
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.layout.version("older").path))
    }
    func testSwitchRefusesABundleThatChangedSinceTheOffer() throws {
        let fixture = try InstallerFixture(version: "1.2.3")
        try prepareRunning(fixture)
        XCTAssertThrowsError(try fixture.installer().switchEngine(to: SwitchOffer(version: "9.9.9", label: "9.9.9"), running: "old", engine: engine(fixture)))
        XCTAssertTrue(fixture.calls(containing: "switch").isEmpty); XCTAssertEqual(fixture.layout.currentVersion(), "old")
    }
}
