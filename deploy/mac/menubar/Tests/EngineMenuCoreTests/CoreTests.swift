import XCTest
@testable import EngineMenuCore

final class CoreTests: XCTestCase {
    private func data(_ name: String = "running") throws -> Data {
        try Data(contentsOf: Bundle.module.url(forResource: "status-" + name, withExtension: "json", subdirectory: "Fixtures")!)
    }
    private func snapshot(_ name: String = "running", change: (inout [String: Any]) -> Void = { _ in }) throws -> Snapshot {
        var object = try JSONSerialization.jsonObject(with: data(name)) as! [String: Any]
        change(&object)
        return try JSONDecoder().decode(Snapshot.self, from: JSONSerialization.data(withJSONObject: object))
    }
    private func model(_ s: Snapshot, action: EngineAction? = nil) -> MenuModel { MenuModel.make(fetch: .ready(s), action: action, now: Date(timeIntervalSince1970: 1793160000)) }
    func testDecodesNullableSessionAndIgnoresAdditionalKeys() throws {
        let s = try snapshot { $0["future"] = true }
        XCTAssertNil(s.sessions[0].label); XCTAssertEqual(s.work.total, 3)
    }
    func testRejectsUnknownVersionBeforeDecodingFields() {
        guard case .updateNeeded = Fetch.decode(Data("{\"schemaVersion\":2}".utf8)) else { return XCTFail() }
    }
    func testRejectsMalformedJSON() {
        guard case .updateNeeded = Fetch.decode(Data("invalid".utf8)) else { return XCTFail() }
    }
    func testRunningShowsCountAndWork() throws {
        let m = model(try snapshot())
        XCTAssertEqual(m.icon, .running); XCTAssertEqual(m.count, 3)
        XCTAssertTrue(m.rows.contains { $0.title?.key == .work }); XCTAssertEqual(m.awake?.key, .holding)
    }
    func testNoCloudUsesOverallAndReconnectSubtitle() throws {
        let m = model(try snapshot("no-cloud"))
        XCTAssertEqual(m.icon, .noCloud); XCTAssertEqual(m.count, 3); XCTAssertEqual(m.subtitle?.key, .reconnecting)
    }
    func testStoppedOffersStart() throws {
        let m = model(try snapshot("stopped")); XCTAssertEqual(m.count, 0)
        XCTAssertTrue(m.rows.contains { $0.command == .start })
    }
    func testUnconfiguredOnlyOffersQuit() throws {
        let m = model(try snapshot("not-initialised"))
        XCTAssertEqual(m.icon, .unconfigured); XCTAssertEqual(m.rows.compactMap(\.command), [.quit])
    }
    func testStoppedWithoutServiceOffersInstall() throws {
        let m = model(try snapshot("stopped") { $0["service"] = ["installed": false] })
        XCTAssertTrue(m.rows.contains { $0.command == .copyInstall }); XCTAssertFalse(m.rows.contains { $0.command == .start })
    }
    func testTerminalEngineCannotBeStopped() throws {
        let m = model(try snapshot { $0["service"] = ["installed": false] })
        XCTAssertTrue(m.rows.contains { $0.title?.key == .terminal }); XCTAssertFalse(m.rows.contains { $0.command == .stop || $0.command == .restart })
    }
    func testIdleHasNoCounter() throws {
        let m = model(try snapshot { $0["work"] = ["sessions": 0, "fullTests": 0, "screenshots": 0]; $0["sessions"] = [] })
        XCTAssertEqual(m.count, 0); XCTAssertTrue(m.rows.contains { $0.title?.key == .noWork })
    }
    func testUnsupportedKeepAwakeIsHidden() throws {
        let m = model(try snapshot { $0["keepAwake"] = ["supported": false, "holding": false, "mode": "off", "since": NSNull()] })
        XCTAssertNil(m.awake)
    }
    func testWorkListIsCapped() throws {
        let m = model(try snapshot { object in
            let session = (object["sessions"] as! [[String: Any]])[0]
            object["sessions"] = Array(repeating: session, count: 8)
        })
        XCTAssertEqual(m.rows.filter { $0.literal != nil }.count, 5)
        XCTAssertEqual(m.rows.first { $0.title?.key == .more }?.title?.args, ["3"])
    }
    func testActionsDisableControlsAndClearCounter() throws {
        for action in [EngineAction.start, .stop, .restart] {
            let m = model(try snapshot(), action: action)
            XCTAssertEqual(m.icon, .busy); XCTAssertEqual(m.count, 0); XCTAssertEqual(m.header.key, action.progress)
            XCTAssertEqual(m.rows.filter { ($0.command == .start || $0.command == .stop || $0.command == .restart) && !$0.enabled }.count, 3)
        }
    }
    func testUnreachableOffersRetryAndDetails() {
        let m = MenuModel.make(fetch: .unavailable("error"), action: nil, now: Date())
        XCTAssertEqual(m.header.key, .unavailable); XCTAssertEqual(m.rows.compactMap(\.command), [.retry, .details, .quit])
    }
    func testUpdateOffersInstallCommand() {
        let m = MenuModel.make(fetch: .updateNeeded, action: nil, now: Date())
        XCTAssertTrue(m.rows.contains { $0.command == .copyUpdate })
    }
    func testRestartWaitsForNewPid() throws {
        XCTAssertFalse(EngineAction.restart.reached(try snapshot(), previousPid: 123))
        XCTAssertTrue(EngineAction.restart.reached(try snapshot(), previousPid: 122))
        XCTAssertFalse(EngineAction.start.reached(try snapshot("stopped"), previousPid: nil))
        XCTAssertTrue(EngineAction.stop.reached(try snapshot("stopped"), previousPid: 123))
    }
    func testRelativeTimeBoundaries() {
        let now = Date(timeIntervalSince1970: 1793160000)
        let iso = ISO8601DateFormatter()
        for (seconds, key) in [(0.0, L10n.now), (60, .minutes), (3600, .hours), (86400, .days)] {
            XCTAssertEqual(Format.relative(iso.string(from: now.addingTimeInterval(-seconds)), now: now).key, key)
        }
    }
    func testHungarianDecimal() { XCTAssertEqual(Format.number(9.1), "9,1") }
    func testKeepAwakeModes() throws {
        for (mode, key) in [("off", L10n.awakeOff), ("while_working", .whileWorking)] {
            let m = model(try snapshot { $0["keepAwake"] = ["supported": true, "holding": false, "mode": mode, "since": NSNull()] })
            XCTAssertEqual(m.awake?.key, key)
        }
    }
    func testFirstQueryShowsLoading() {
        let m = MenuModel.make(fetch: .loading, action: nil, now: Date())
        XCTAssertEqual(m.header.key, .loading); XCTAssertEqual(m.icon, .busy)
    }
    func testLogFixtureDecodes() throws {
        let data = try Data(contentsOf: Bundle.module.url(forResource: "logs", withExtension: "json", subdirectory: "Fixtures")!)
        let logs = try JSONDecoder().decode(Logs.self, from: data)
        XCTAssertEqual(logs.out.count, 1); XCTAssertTrue(logs.err.isEmpty)
    }
    func testAllLocalizationKeysExist() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("Resources/hu.lproj/Localizable.strings"))
        let strings = try PropertyListSerialization.propertyList(from: data, format: nil) as! [String: String]
        XCTAssertEqual(Set(L10n.allCases.map(\.rawValue)), Set(strings.keys))
    }
}
