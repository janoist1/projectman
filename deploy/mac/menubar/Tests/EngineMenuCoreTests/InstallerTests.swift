import XCTest
@testable import EngineMenuCore

/// A temp home with a bundled engine, and a scripted command runner in place of launchd and the engine CLI.
final class InstallerFixture {
    let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    var bundle: URL { home.appendingPathComponent("bundle/engine") }
    var layout: EngineLayout { EngineLayout(userHome: home) }
    var plist: URL { home.appendingPathComponent(EngineLocator.servicePlist) }
    var calls: [CommandSpec] = []
    var overall = "stopped"
    var approval = ApprovalStatus.enabled
    /// Names of the steps (`install`, `start`, ...) whose command fails.
    var failing: [String: String] = [:]
    var copyFails = false
    var legacyPresent = false

    init(version: String = "1.2.3") throws {
        let files = FileManager.default
        try files.createDirectory(at: bundle.appendingPathComponent("scripts/engine"), withIntermediateDirectories: true)
        try files.createDirectory(at: bundle.appendingPathComponent("bin"), withIntermediateDirectories: true)
        try Data("{\"version\":\"\(version)\"}".utf8).write(to: bundle.appendingPathComponent(EngineLocator.packageFile))
        try Data().write(to: bundle.appendingPathComponent("scripts/engine/cli.js"))
        try Data().write(to: bundle.appendingPathComponent("bin/node"))
    }
    deinit { try? FileManager.default.removeItem(at: home) }

    func calls(containing word: String) -> [CommandSpec] { calls.filter { $0.arguments.contains(word) } }

    private func run(_ spec: CommandSpec) throws -> CommandResult {
        calls.append(spec)
        if spec.arguments.contains("--home") {
            let verb = ["status", "service"].first { spec.arguments.contains($0) } ?? ""
            let sub = spec.arguments.first { ["install", "start", "uninstall", "switch"].contains($0) } ?? ""
            let name = verb == "service" ? sub : verb
            if let message = failing[name] {
                if name == "install" {
                    try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try Data("new".utf8).write(to: plist)
                }
                return CommandResult(status: 1, error: message)
            }
            if name == "install" {
                try FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
                try Data("new".utf8).write(to: plist)
            }
            if name == "status" { return CommandResult(status: 0, out: Data("{\"overall\":\"\(overall)\"}".utf8)) }
            return CommandResult(status: 0)
        }
        if spec.executable.hasSuffix("/zsh") {
            return CommandResult(status: 0, out: Data((PathResolver.startMarker + "/usr/bin:/bin" + PathResolver.endMarker).utf8))
        }
        return CommandResult(status: 0)
    }

    func installer() -> Installer {
        let legacy = LegacyApp(userHome: home, uid: 501, runner: { [unowned self] in try self.run($0) }, isRunning: { [unowned self] in self.legacyPresent })
        return Installer(userHome: home, bundleEngine: bundle, uid: 501, runner: { [unowned self] in try self.run($0) },
                         copy: { [unowned self] source, destination in
                             if self.copyFails {
                                 try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
                                 throw Installer.MessageError("copy failed")
                             }
                             try FileManager.default.copyItem(at: source, to: destination)
                         },
                         approval: { [unowned self] in self.approval }, legacy: legacy, shell: "/bin/zsh")
    }
}

final class InstallerTests: XCTestCase {
    private func steps() -> (Installer.Progress, () -> [String]) {
        var seen: [String] = []
        return ({ step, status in seen.append("\(step):\(status)") }, { seen })
    }

    func testPrepareUnpacksPointsCurrentAndWritesShim() throws {
        let fixture = try InstallerFixture()
        let outcome = try fixture.installer().prepare(progress: { _, _ in })
        XCTAssertEqual(outcome, .ready("1.2.3"))
        XCTAssertEqual(fixture.layout.currentVersion(), "1.2.3")
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.layout.version("1.2.3").appendingPathComponent("bin/node").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.layout.partial("1.2.3").path))
        XCTAssertEqual(try String(contentsOf: fixture.layout.shim), EngineLayout.shimContent)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: fixture.layout.shim.path))
    }
    func testPrepareWithoutWiringWaitsForSetup() throws {
        let fixture = try InstallerFixture()
        fixture.overall = "not_initialised"
        XCTAssertEqual(try fixture.installer().prepare(progress: { _, _ in }), .awaitingSetup("1.2.3"))
    }
    func testPrepareSkipsTheOldAppStepWhenAbsent() throws {
        let fixture = try InstallerFixture()
        let (progress, seen) = steps()
        _ = try fixture.installer().prepare(progress: progress)
        XCTAssertEqual(seen().first, "removeOldApp:skipped")
    }
    func testPrepareRemovesTheOldAppFirst() throws {
        let fixture = try InstallerFixture()
        fixture.legacyPresent = true
        let (progress, seen) = steps()
        _ = try fixture.installer().prepare(progress: progress)
        XCTAssertEqual(Array(seen().prefix(2)), ["removeOldApp:started", "removeOldApp:done"])
        XCTAssertEqual(fixture.calls.first?.arguments.first, "bootout")
    }
    func testCopyFailureLeavesNoPartialAndNoVersion() throws {
        let fixture = try InstallerFixture()
        fixture.copyFails = true
        XCTAssertThrowsError(try fixture.installer().prepare(progress: { _, _ in })) { error in
            XCTAssertEqual((error as? InstallFailure)?.step, .unpack)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.layout.partial("1.2.3").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.layout.version("1.2.3").path))
        XCTAssertNil(fixture.layout.currentVersion())
    }
    func testMissingBundleManifestIsARawError() throws {
        let fixture = try InstallerFixture()
        try FileManager.default.removeItem(at: fixture.bundle.appendingPathComponent(EngineLocator.packageFile))
        XCTAssertThrowsError(try fixture.installer().prepare(progress: { _, _ in })) { error in
            XCTAssertTrue((error as? InstallFailure)?.message.contains("bundle_engine_missing") == true)
        }
    }
    func testActivateInstallsThenStarts() throws {
        let fixture = try InstallerFixture()
        let installer = fixture.installer()
        _ = try installer.prepare(progress: { _, _ in })
        XCTAssertEqual(try installer.activate(version: "1.2.3", progress: { _, _ in }), .running)
        let verbs = fixture.calls.compactMap { call in ["install", "start"].first { call.arguments.contains($0) } }
        XCTAssertEqual(verbs, ["install", "start"])
        let install = try XCTUnwrap(fixture.calls(containing: "install").first)
        XCTAssertTrue(install.arguments.contains("--path"))
        XCTAssertTrue(install.arguments.contains("/usr/bin:/bin"))
    }
    func testActivateStopsAtApprovalWithoutStarting() throws {
        let fixture = try InstallerFixture()
        fixture.approval = .requiresApproval
        let installer = fixture.installer()
        _ = try installer.prepare(progress: { _, _ in })
        XCTAssertEqual(try installer.activate(version: "1.2.3", progress: { _, _ in }), .needsApproval)
        XCTAssertTrue(fixture.calls(containing: "start").isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.plist.path))
    }
    func testServiceInstallFailureRemovesTheNewPlist() throws {
        let fixture = try InstallerFixture()
        fixture.failing["install"] = "REFUSED [service_unsupported] no\nmore"
        let installer = fixture.installer()
        _ = try installer.prepare(progress: { _, _ in })
        XCTAssertThrowsError(try installer.activate(version: "1.2.3", progress: { _, _ in })) { error in
            let failure = error as? InstallFailure
            XCTAssertEqual(failure?.step, .serviceInstall)
            XCTAssertEqual(failure?.message, "REFUSED [service_unsupported] no")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.plist.path))
    }
    func testMissingKeyWaitsForSetupInsteadOfFailing() throws {
        let fixture = try InstallerFixture()
        fixture.failing["install"] = "REFUSED [key_missing] The engine key does not exist."
        let installer = fixture.installer()
        _ = try installer.prepare(progress: { _, _ in })
        XCTAssertEqual(try installer.activate(version: "1.2.3", progress: { _, _ in }), .awaitingSetup)
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.plist.path))
        XCTAssertTrue(fixture.calls(containing: "start").isEmpty)
    }
    func testServiceInstallFailureRestoresThePreviousPlist() throws {
        let fixture = try InstallerFixture()
        try FileManager.default.createDirectory(at: fixture.plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("old".utf8).write(to: fixture.plist)
        fixture.failing["install"] = "REFUSED [x] y"
        let installer = fixture.installer()
        _ = try installer.prepare(progress: { _, _ in })
        XCTAssertThrowsError(try installer.activate(version: "1.2.3", progress: { _, _ in }))
        XCTAssertEqual(try String(contentsOf: fixture.plist), "old")
    }
    func testStartFailureUndoesTheNewService() throws {
        let fixture = try InstallerFixture()
        fixture.failing["start"] = "REFUSED [start_failed] z"
        let installer = fixture.installer()
        _ = try installer.prepare(progress: { _, _ in })
        XCTAssertThrowsError(try installer.activate(version: "1.2.3", progress: { _, _ in })) { error in
            XCTAssertEqual((error as? InstallFailure)?.step, .start)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.plist.path))
        XCTAssertFalse(fixture.calls.filter { $0.arguments.first == "bootout" }.isEmpty)
    }
    func testSecondPrepareKeepsTheRunningAndPreviousVersionOnly() throws {
        let fixture = try InstallerFixture(version: "1.0.0")
        _ = try fixture.installer().prepare(progress: { _, _ in })
        for version in ["1.1.0", "1.2.0"] {
            try Data("{\"version\":\"\(version)\"}".utf8).write(to: fixture.bundle.appendingPathComponent(EngineLocator.packageFile))
            _ = try fixture.installer().prepare(progress: { _, _ in })
        }
        let kept = Set(try FileManager.default.contentsOfDirectory(atPath: fixture.layout.versions.path))
        XCTAssertEqual(kept, ["1.1.0", "1.2.0"])
        XCTAssertEqual(fixture.layout.currentVersion(), "1.2.0")
    }

    private func writeBundle(_ fixture: InstallerFixture, version: String, node: String) throws {
        try Data("{\"version\":\"\(version)\"}".utf8).write(to: fixture.bundle.appendingPathComponent(EngineLocator.packageFile))
        try Data(node.utf8).write(to: fixture.bundle.appendingPathComponent("bin/node"))
    }
    private func runtimeNames(_ fixture: InstallerFixture) -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: fixture.layout.runtimes.path)) ?? [])
    }
    func testStageMovesNodeToAContentAddressedRuntimeAndLinksIt() throws {
        let fixture = try InstallerFixture()
        try writeBundle(fixture, version: "1.0.0", node: "node-a")
        _ = try fixture.installer().stage()
        let hash = try EngineLayout.sha256(of: fixture.bundle.appendingPathComponent("bin/node"))
        let node = fixture.layout.version("1.0.0").appendingPathComponent("bin/node")
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: node.path), "../../../runtimes/\(hash)/node")
        XCTAssertEqual(try String(contentsOf: fixture.layout.runtime(hash)), "node-a")
        XCTAssertEqual(try String(contentsOf: node), "node-a")
        XCTAssertEqual(node.resolvingSymlinksInPath().path, fixture.layout.runtime(hash).resolvingSymlinksInPath().path)
    }
    func testSecondVersionWithTheSameNodeReusesTheRuntime() throws {
        let fixture = try InstallerFixture()
        try writeBundle(fixture, version: "1.0.0", node: "node-a")
        _ = try fixture.installer().stage()
        let runtime = try XCTUnwrap(runtimeNames(fixture).first)
        let before = try FileManager.default.attributesOfItem(atPath: fixture.layout.runtime(runtime).path)[.systemFileNumber] as? Int
        try writeBundle(fixture, version: "1.1.0", node: "node-a")
        _ = try fixture.installer().stage()
        XCTAssertEqual(runtimeNames(fixture), [runtime])
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: fixture.layout.runtime(runtime).path)[.systemFileNumber] as? Int, before)
        let link = fixture.layout.version("1.1.0").appendingPathComponent("bin/node").path
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: link), EngineLayout.runtimeLink(runtime))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.layout.runtime(runtime).deletingLastPathComponent().path), ["node"])
    }
    func testDifferentNodeGetsANewRuntime() throws {
        let fixture = try InstallerFixture()
        try writeBundle(fixture, version: "1.0.0", node: "node-a")
        _ = try fixture.installer().stage()
        try writeBundle(fixture, version: "1.1.0", node: "node-b")
        _ = try fixture.installer().stage()
        XCTAssertEqual(runtimeNames(fixture).count, 2)
    }
    func testPruneKeepsOnlyTheRuntimesOfKeptVersions() throws {
        let fixture = try InstallerFixture()
        for (version, node) in [("1.0.0", "node-a"), ("1.1.0", "node-b"), ("1.2.0", "node-b")] {
            try writeBundle(fixture, version: version, node: node)
            _ = try fixture.installer().prepare(progress: { _, _ in })
        }
        let kept = try EngineLayout.sha256(of: fixture.layout.version("1.2.0").appendingPathComponent("bin/node"))
        XCTAssertEqual(fixture.layout.runtimeName(ofVersion: "1.1.0"), kept)
        XCTAssertEqual(runtimeNames(fixture), [kept])
        XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.layout.runtime(kept).path))
    }
    func testFailedCopyLeavesNoPartialRuntimeLink() throws {
        let fixture = try InstallerFixture()
        fixture.copyFails = true
        XCTAssertThrowsError(try fixture.installer().stage())
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.layout.runtimes.path))
    }
}
