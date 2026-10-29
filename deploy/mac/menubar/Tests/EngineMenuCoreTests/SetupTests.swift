import XCTest
@testable import EngineMenuCore

final class PathResolverTests: XCTestCase {
    private func result(_ text: String, status: Int32 = 0) -> CommandRunner { { _ in CommandResult(status: status, out: Data(text.utf8)) } }
    private let start = PathResolver.startMarker, end = PathResolver.endMarker

    func testTakesTheTextBetweenTheMarkersAndIgnoresShellNoise() {
        XCTAssertEqual(PathResolver.parse("welcome\n\(start)/a:/b\(end)\nbye"), "/a:/b")
    }
    func testMissingOrEmptyMarkersGiveNothing() {
        XCTAssertNil(PathResolver.parse("/a:/b"))
        XCTAssertNil(PathResolver.parse("\(start)\(end)"))
        XCTAssertNil(PathResolver.parse("\(start)/a\n/b\(end)"))
    }
    func testResolveUsesTheShellsPath() {
        XCTAssertEqual(PathResolver.resolve(shell: "/bin/zsh", home: "/h", runner: result("\(start)/x:/y\(end)")), "/x:/y")
    }
    func testResolveFallsBackOnFailureTimeoutAndGarbage() {
        let fallback = PathResolver.fallback(home: "/h")
        XCTAssertEqual(PathResolver.resolve(shell: nil, home: "/h", runner: result("", status: 1)), fallback)
        XCTAssertEqual(PathResolver.resolve(shell: nil, home: "/h", runner: result("\(start)/x\(end)", status: -1)), fallback)
        XCTAssertEqual(PathResolver.resolve(shell: nil, home: "/h", runner: result("nothing")), fallback)
        XCTAssertEqual(PathResolver.resolve(shell: nil, home: "/h", runner: { _ in throw CocoaError(.fileNoSuchFile) }), fallback)
    }
    func testFallbackListsTheUsualToolFolders() {
        XCTAssertEqual(PathResolver.fallback(home: "/h"), "/opt/homebrew/bin:/usr/local/bin:/h/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
    }
    func testResolveRunsALoginInteractiveShellWithATenSecondTimeout() throws {
        var spec: CommandSpec?
        _ = PathResolver.resolve(shell: "/bin/bash", home: "/h", runner: { spec = $0; return CommandResult(status: 1) })
        XCTAssertEqual(spec?.executable, "/bin/bash"); XCTAssertEqual(Array(spec?.arguments.prefix(3) ?? []), ["-l", "-i", "-c"])
        XCTAssertEqual(spec?.timeout, 10)
    }
    func testARelativeShellIsNotRun() {
        var spec: CommandSpec?
        _ = PathResolver.resolve(shell: "zsh", home: "/h", runner: { spec = $0; return CommandResult(status: 1) })
        XCTAssertEqual(spec?.executable, "/bin/zsh")
    }
}

final class LayoutTests: XCTestCase {
    private var home: URL!
    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: home) }
    private var layout: EngineLayout { EngineLayout(userHome: home) }
    private func version(_ name: String) throws {
        try FileManager.default.createDirectory(at: layout.version(name), withIntermediateDirectories: true)
    }

    func testShimResolvesCurrentAndExecsTheBundledNode() {
        XCTAssertTrue(EngineLayout.shimContent.hasPrefix("#!/bin/sh\n"))
        XCTAssertTrue(EngineLayout.shimContent.contains("cd \"$(dirname \"$0\")/../current\" && pwd -P"))
        XCTAssertTrue(EngineLayout.shimContent.contains("exec \"$root/bin/node\" \"$root/scripts/engine/cli.js\" \"$@\""))
    }
    func testVersionNamesBecomeSafeFolderNames() {
        XCTAssertTrue(EngineLayout.isSafeVersion("1.2.3-rc.1+b5"))
        for bad in ["", ".", "..", ".hidden", "a/b", "a b", "../x"] { XCTAssertFalse(EngineLayout.isSafeVersion(bad), bad) }
    }
    func testPointSwitchesCurrentInOneStep() throws {
        try version("1"); try version("2")
        try layout.point(to: "1"); XCTAssertEqual(layout.currentVersion(), "1")
        try layout.point(to: "2"); XCTAssertEqual(layout.currentVersion(), "2")
        XCTAssertFalse(FileManager.default.fileExists(atPath: layout.base.appendingPathComponent("current.new").path))
    }
    func testFollowMovesCurrentToTheServiceRoot() throws {
        try version("1"); try version("2"); try layout.point(to: "1")
        XCTAssertTrue(try layout.follow(serviceRoot: layout.version("2").path))
        XCTAssertEqual(layout.currentVersion(), "2")
        XCTAssertFalse(try layout.follow(serviceRoot: layout.version("2").path))
    }
    func testFollowIgnoresARootOutsideTheLayout() throws {
        try version("1"); try layout.point(to: "1")
        XCTAssertFalse(try layout.follow(serviceRoot: "/some/checkout"))
        XCTAssertEqual(layout.currentVersion(), "1")
    }
    func testPruneKeepsOnlyTheNamedVersions() throws {
        for name in ["1", "2", "3", "4.partial"] { try version(name) }
        layout.prune(keep: ["2", "3"])
        XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: layout.versions.path)), ["2", "3"])
    }
}

final class LocatorPackageTests: XCTestCase {
    private var home: URL!
    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let root = EngineLayout(userHome: home).version("1.0.0")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts/engine"), withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent("scripts/engine/cli.js"))
        try Data("{}".utf8).write(to: root.appendingPathComponent(EngineLocator.packageFile))
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: home) }
    private var layout: EngineLayout { EngineLayout(userHome: home) }

    func testPackageRunsTheBundledCliWithoutTsx() throws {
        try layout.point(to: "1.0.0")
        let location = try EngineLocator.locate(userHome: home)
        XCTAssertTrue(location.isPackage)
        XCTAssertEqual(location.node, location.root + "/bin/node")
        let command = location.command(["status", "--json"], timeout: 5)
        XCTAssertEqual(command.arguments, [location.root + "/scripts/engine/cli.js", "status", "--json", "--home", home.path + "/.projectman"])
    }
    func testCheckoutRunsTsx() {
        let location = EngineLocation(schemaVersion: 1, node: "/n", root: "/no/such/checkout", home: "/h", path: "/p")
        XCTAssertFalse(location.isPackage)
        XCTAssertEqual(location.cliArguments, ["--import", "tsx", "/no/such/checkout/scripts/engine/cli.ts"])
    }
    func testCurrentLinkIsResolvedBeforeUse() throws {
        try layout.point(to: "1.0.0")
        XCTAssertEqual(try EngineLocator.locate(userHome: home).root, layout.version("1.0.0").resolvingSymlinksInPath().path)
    }
    func testNothingInstalledIsNotInstalled() throws {
        let empty = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertThrowsError(try EngineLocator.locate(userHome: empty)) { error in
            guard case EngineLocator.LocationError.notInstalled = error else { return XCTFail("\(error)") }
        }
    }
}

final class LegacyAppTests: XCTestCase {
    private var home: URL!
    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: home) }
    private func legacy(status: Int32 = 0, running: Bool = false) -> LegacyApp {
        LegacyApp(userHome: home, uid: 501, runner: { _ in CommandResult(status: status) }, isRunning: { running })
    }
    private func write(_ url: URL, _ text: String = "x") throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
    }
    private func appBundle(id: String) throws {
        let info: [String: Any] = ["CFBundleIdentifier": id]
        let url = legacy().app.appendingPathComponent("Contents/Info.plist")
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: url)
    }

    func testNothingOnTheMachineIsNotPresent() { XCTAssertFalse(legacy().isPresent) }
    func testItsPlistFallbackFileOrProcessMakeItPresent() throws {
        XCTAssertTrue(legacy(running: true).isPresent)
        try write(legacy().plist); XCTAssertTrue(legacy().isPresent)
        try FileManager.default.removeItem(at: legacy().plist)
        try write(legacy().config); XCTAssertTrue(legacy().isPresent)
    }
    func testRemoveDeletesPlistConfigAndTheOldApp() throws {
        let app = legacy()
        try write(app.plist); try write(app.config); try appBundle(id: LegacyApp.bundleIdentifier)
        try app.remove()
        for url in [app.plist, app.config, app.app] { XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), url.lastPathComponent) }
    }
    func testRemoveKeepsAnAppWithAnotherBundleIdentifier() throws {
        let app = legacy()
        try write(app.plist); try appBundle(id: "com.projectman.engine-app")
        try app.remove()
        XCTAssertFalse(FileManager.default.fileExists(atPath: app.plist.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: app.app.path))
    }
    func testNotLoadedJobIsFineAndOtherBootoutErrorsAreRaised() throws {
        try legacy(status: 113).remove()
        XCTAssertThrowsError(try legacy(status: 5).remove())
    }
    func testEngineInstalledMeansTheServicePlistExists() throws {
        XCTAssertFalse(legacy().engineInstalled)
        try write(home.appendingPathComponent(EngineLocator.servicePlist))
        XCTAssertTrue(legacy().engineInstalled)
    }
}

final class PrerequisitesTests: XCTestCase {
    private func probe(silicon: Bool = true, major: Int = 14, tools: Bool = true) -> MachineProbe {
        MachineProbe(isAppleSilicon: silicon, osVersion: OperatingSystemVersion(majorVersion: major, minorVersion: 1, patchVersion: 0), commandLineToolsInstalled: { tools })
    }
    func testSupportedMacWithToolsIsOk() { XCTAssertTrue(Prerequisites.check(probe()).ok) }
    func testMissingToolsAreFixable() {
        let report = Prerequisites.check(probe(tools: false))
        XCTAssertEqual(report.fixable, [.commandLineTools]); XCTAssertTrue(report.unsupported.isEmpty)
    }
    func testIntelAndOldMacOSAreUnsupportedAndHideTheToolsRow() {
        let report = Prerequisites.check(probe(silicon: false, major: 12, tools: false))
        XCTAssertEqual(report.unsupported, [.appleSilicon, .macOS("12.1")]); XCTAssertTrue(report.fixable.isEmpty)
    }
}

final class AppPlacementTests: XCTestCase {
    private var root: URL!
    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Downloads/projectman motor.app"), withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: root) }
    private var bundle: URL { root.appendingPathComponent("Downloads/projectman motor.app") }
    private func placement(_ directories: [URL], copyFails: Bool = false) -> AppPlacement {
        AppPlacement(userHome: root, directories: directories, copy: { source, destination in
            if copyFails { throw CocoaError(.fileWriteUnknown) }
            try FileManager.default.copyItem(at: source, to: destination)
        })
    }

    func testAnAppInAnApplicationsFolderStays() {
        let applications = root.appendingPathComponent("Applications")
        let there = applications.appendingPathComponent("projectman motor.app")
        XCTAssertTrue(placement([applications]).isPlaced(there, translocated: false))
        XCTAssertEqual(placement([applications]).place(there, translocated: false), .inPlace)
    }
    func testATranslocatedOrDownloadedAppIsNotPlaced() {
        let applications = root.appendingPathComponent("Applications")
        XCTAssertFalse(placement([applications]).isPlaced(bundle, translocated: false))
        XCTAssertFalse(placement([applications]).isPlaced(applications.appendingPathComponent("projectman motor.app"), translocated: true))
        XCTAssertFalse(placement([applications]).isPlaced(URL(fileURLWithPath: "/private/var/AppTranslocation/x/d/projectman motor.app"), translocated: false))
    }
    func testMovesToTheFirstFolderThatTakesIt() throws {
        let first = root.appendingPathComponent("A"), second = root.appendingPathComponent("B")
        guard case .moved(let target) = placement([first, second]).place(bundle, translocated: false) else { return XCTFail() }
        XCTAssertEqual(target, first.appendingPathComponent("projectman motor.app"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.appendingPathComponent(".projectman motor.app.partial").path))
    }
    func testFallsBackToTheNextFolderWhenTheFirstIsNotWritable() throws {
        let locked = root.appendingPathComponent("Locked"), open = root.appendingPathComponent("Open")
        try FileManager.default.createDirectory(at: locked, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: locked.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: locked.path) }
        guard case .moved(let target) = placement([locked, open]).place(bundle, translocated: false) else { return XCTFail() }
        XCTAssertEqual(target.deletingLastPathComponent(), open)
    }
    func testFailsWhenNoFolderTakesIt() {
        XCTAssertEqual(placement([root.appendingPathComponent("A")], copyFails: true).place(bundle, translocated: false), .failed)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("A/.projectman motor.app.partial").path))
    }
}

final class UninstallerTests: XCTestCase {
    private var fixture: InstallerFixture!
    private var calls: [[String]] = []
    private var unregistered = 0
    override func setUpWithError() throws {
        fixture = try InstallerFixture()
        calls = []; unregistered = 0
        // An installed engine: a service plist that points at a package, and the app's folder.
        let values: [String: Any] = ["ProgramArguments": ["/opt/node"], "WorkingDirectory": fixture.bundle.path,
                                     "EnvironmentVariables": ["PROJECTMAN_HOME": fixture.home.path + "/.projectman", "PATH": "/usr/bin"]]
        try FileManager.default.createDirectory(at: fixture.plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try PropertyListSerialization.data(fromPropertyList: values, format: .xml, options: 0).write(to: fixture.plist)
        try FileManager.default.createDirectory(at: fixture.layout.versions, withIntermediateDirectories: true)
    }
    private func uninstaller(serviceStatus: Int32 = 0, unregisterFails: Bool = false) -> Uninstaller {
        let plist = fixture.plist
        return Uninstaller(userHome: fixture.home, runner: { [unowned self] spec in
            self.calls.append(spec.arguments)
            if serviceStatus == 0 { try? FileManager.default.removeItem(at: plist) }
            return CommandResult(status: serviceStatus, error: serviceStatus == 0 ? "" : "REFUSED [service_busy] later")
        }, unregister: { [unowned self] in
            self.unregistered += 1
            if unregisterFails { throw CocoaError(.userCancelled) }
        })
    }

    func testRemovesTheServiceTheFolderAndTheLoginItemButNotTheData() throws {
        let data = fixture.home.appendingPathComponent(".projectman"); try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        try uninstaller().run()
        XCTAssertEqual(calls.count, 1); XCTAssertTrue(calls[0].contains("service")); XCTAssertTrue(calls[0].contains("uninstall"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.layout.base.path))
        XCTAssertEqual(unregistered, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: data.path))
    }
    func testAFailingServiceUninstallKeepsTheFolderAndTheLoginItem() {
        XCTAssertThrowsError(try uninstaller(serviceStatus: 1).run()) { error in
            XCTAssertEqual((error as? UninstallFailure)?.step, .service)
            XCTAssertEqual((error as? UninstallFailure)?.message, "REFUSED [service_busy] later")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.layout.base.path)); XCTAssertEqual(unregistered, 0)
    }
    func testRetryAfterTheServiceIsGoneSkipsTheCli() throws {
        try FileManager.default.removeItem(at: fixture.plist)
        try uninstaller().run()
        XCTAssertTrue(calls.isEmpty); XCTAssertEqual(unregistered, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.layout.base.path))
    }
    func testALoginItemFailureIsReportedAtItsStep() {
        XCTAssertThrowsError(try uninstaller(unregisterFails: true).run()) { error in
            XCTAssertEqual((error as? UninstallFailure)?.step, .loginItem)
        }
    }
}

final class StepListTests: XCTestCase {
    func testTheOldAppRowExistsOnlyWhenItIsOnTheMachine() {
        XCTAssertEqual(StepList(includeLegacy: true).rows.map(\.step), InstallStep.allCases)
        XCTAssertFalse(StepList(includeLegacy: false).rows.contains { $0.step == .removeOldApp })
    }
    func testSkippedStepLeavesTheList() {
        var list = StepList(includeLegacy: true)
        list.apply(.removeOldApp, .skipped)
        XCTAssertFalse(list.rows.contains { $0.step == .removeOldApp })
    }
    func testFailedViewShowsTheDoneAndTheFailedStepsOnly() {
        var list = StepList(includeLegacy: false)
        list.apply(.unpack, .started); list.apply(.unpack, .done)
        list.apply(.serviceInstall, .started); list.fail(.serviceInstall)
        XCTAssertEqual(list.reached.map(\.step), [.unpack, .serviceInstall])
        XCTAssertEqual(list.reached.map(\.state), [.done, .failed])
    }
}

final class ApprovalTests: XCTestCase {
    func testOnlyRequiresApprovalBlocksTheEngine() {
        XCTAssertTrue(ApprovalStatus.requiresApproval.blocksEngine)
        for status in [ApprovalStatus.enabled, .notRegistered, .notFound] { XCTAssertFalse(status.blocksEngine) }
    }
}
