import XCTest
import CryptoKit
@testable import EngineMenuCore

/// The app's self-update without a network, `ditto` or a signature: every machine access is a seam.
private final class UpdateFixture {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    var bundle: URL { root.appendingPathComponent("Applications/projectman motor.app") }
    var cache: URL { root.appendingPathComponent("cache/updates") }
    var identity = AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo", teamId: "ABCDE12345")
    var os = OperatingSystemVersion(majorVersion: 14, minorVersion: 5, patchVersion: 0)
    var payload = Data("zip contents".utf8)
    /// The manifest the release serves; nil builds a matching one.
    var manifest: ManifestFetch?
    var manifestChanges: (inout [String: Any]) -> Void = { _ in }
    var unpackedApps = ["projectman motor.app"]
    var unpackedVersion: String? = "20261029.0"
    var failing = Set<String>()
    var fetched: [URL] = []
    var downloaded: [URL] = []
    var unpackArguments: [[String]] = []
    var verified: [String] = []
    var attested: [[String]] = []
    /// The commit in the unpacked app's engine-package.json; nil leaves the file out.
    var bundledCommit: String? = String(repeating: "a", count: 40)
    var replaced: [(URL, URL)] = []
    var updating = 0

    init() throws { try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true) }
    deinit { try? FileManager.default.removeItem(at: root) }

    func manifestData() throws -> Data {
        var object: [String: Any] = [
            "schemaVersion": 1, "tag": "v2026.10.29", "version": String(repeating: "a", count: 40), "bundleVersion": "20261029.0",
            "minimumMacOS": "13.0", "arch": "arm64", "teamId": "ABCDE12345",
            "zip": ["name": "projectman-motor.zip", "sha256": SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined(), "size": payload.count],
        ]
        manifestChanges(&object)
        return try JSONSerialization.data(withJSONObject: object)
    }
    var seams: UpdateSeams {
        UpdateSeams(
            fetchManifest: { [self] url in
                fetched.append(url)
                if let manifest { return manifest }
                return (try? manifestData()).map { ManifestFetch.found($0) } ?? .unreachable
            },
            download: { [self] url, destination in
                downloaded.append(url)
                if failing.contains("download") { throw Installer.MessageError("offline") }
                try payload.write(to: destination)
            },
            run: { [self] spec in
                unpackArguments.append(spec.arguments)
                if failing.contains("unpack") { return CommandResult(status: 1, error: "ditto: broken") }
                let destination = URL(fileURLWithPath: spec.arguments[3])
                for name in unpackedApps {
                    let engine = destination.appendingPathComponent(name).appendingPathComponent("Contents/Resources/engine")
                    try FileManager.default.createDirectory(at: engine, withIntermediateDirectories: true)
                    if let bundledCommit { try Data("{\"version\":\"\(bundledCommit)\"}".utf8).write(to: engine.appendingPathComponent("engine-package.json")) }
                }
                return CommandResult(status: 0)
            },
            verifySignature: { [self] app, requirement in
                verified.append(requirement)
                if failing.contains("signature") { throw Installer.MessageError("a sealed resource is missing") }
            },
            verifyAttestation: { [self] zip, repo, workflow, ref in
                attested.append([zip.lastPathComponent, repo, workflow, ref])
                if failing.contains("attestation") { throw UpdateFailure("attestation_invalid", "no matching attestation") }
            },
            bundleVersion: { [self] _ in unpackedVersion },
            replace: { [self] bundle, app in
                if failing.contains("replace") { throw Installer.MessageError("permission denied") }
                replaced.append((bundle, app))
            })
    }
    func run() throws -> UpdateOutcome {
        try AppUpdater(identity: identity, bundle: bundle, cache: cache, os: os, seams: seams).run(onUpdating: { updating += 1 })
    }
}

final class UpdateTests: XCTestCase {
    private func fixtureManifest(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> Data {
        let url = Bundle.module.url(forResource: "projectman-motor", withExtension: "json", subdirectory: "Fixtures")!
        var object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        change(&object)
        return try JSONSerialization.data(withJSONObject: object)
    }
    private func failure(_ body: () throws -> Any) -> UpdateFailure? {
        do { _ = try body(); return nil } catch { return error as? UpdateFailure }
    }

    // MARK: Manifest

    func testManifestOfTheReleaseWorkflowDecodes() throws {
        let manifest = try UpdateManifest.decode(fixtureManifest())
        XCTAssertEqual(manifest.bundleVersion, "20261029.0"); XCTAssertEqual(manifest.zip.name, "projectman-motor.zip")
        XCTAssertEqual(manifest.zip.size, 12345); XCTAssertEqual(manifest.teamId, "ABCDE12345")
        XCTAssertNoThrow(try manifest.supported(on: OperatingSystemVersion(majorVersion: 13, minorVersion: 0, patchVersion: 0)))
    }
    func testManifestWithAnotherSchemaIsUnsupported() throws {
        XCTAssertEqual(failure { try UpdateManifest.decode(self.fixtureManifest { $0["schemaVersion"] = 2 }) }?.code, "manifest_unsupported")
    }
    func testManifestThatCannotBeReadIsInvalid() throws {
        XCTAssertEqual(failure { try UpdateManifest.decode(Data("nope".utf8)) }?.code, "manifest_invalid")
        XCTAssertEqual(failure { try UpdateManifest.decode(self.fixtureManifest { $0["zip"] = nil }) }?.code, "manifest_invalid")
    }
    func testManifestForAnotherArchitectureIsUnsupported() throws {
        let manifest = try UpdateManifest.decode(fixtureManifest { $0["arch"] = "x86_64" })
        XCTAssertEqual(failure { try manifest.supported(on: OperatingSystemVersion(majorVersion: 14, minorVersion: 0, patchVersion: 0)) }?.code, "manifest_unsupported")
    }
    func testManifestNeedingANewerMacOSIsRefused() throws {
        let manifest = try UpdateManifest.decode(fixtureManifest { $0["minimumMacOS"] = "14.2" })
        XCTAssertEqual(failure { try manifest.supported(on: OperatingSystemVersion(majorVersion: 14, minorVersion: 1, patchVersion: 0)) }?.code, "macos_too_old")
        XCTAssertNoThrow(try manifest.supported(on: OperatingSystemVersion(majorVersion: 15, minorVersion: 0, patchVersion: 0)))
    }
    func testBuildNumbersCompareAsNumbers() throws {
        XCTAssertTrue(try XCTUnwrap(BuildNumber("20261029.10")) > XCTUnwrap(BuildNumber("20261029.9")))
        XCTAssertTrue(try XCTUnwrap(BuildNumber("20261101.0")) > XCTUnwrap(BuildNumber("20261029.12")))
        XCTAssertTrue(try XCTUnwrap(BuildNumber("0")) < XCTUnwrap(BuildNumber("20260101.0")))
        XCTAssertNil(BuildNumber("2026102.1")); XCTAssertNil(BuildNumber("abc")); XCTAssertNil(BuildNumber("20261029"))
    }
    func testRequirementPinsTheBundleIdentifierAndTheTeam() {
        let text = UpdateManifest.requirement(teamId: "ABCDE12345")
        XCTAssertEqual(text, "anchor apple generic and identifier \"com.projectman.engine-app\" and certificate leaf[subject.OU] = \"ABCDE12345\"")
    }

    // MARK: Identity

    func testAdHocBuildCannotUpdateItself() {
        XCTAssertFalse(AppIdentity(bundleVersion: "0", releaseRepo: "owner/repo", teamId: "").canSelfUpdate)
        XCTAssertFalse(AppIdentity(bundleVersion: "20261028.0", releaseRepo: nil, teamId: "ABCDE12345").canSelfUpdate)
        XCTAssertTrue(AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo", teamId: "ABCDE12345").canSelfUpdate)
    }
    func testReleaseUrlsComeFromTheRepositoryOnly() {
        let identity = AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo", teamId: "ABCDE12345")
        XCTAssertEqual(identity.manifestURL?.absoluteString, "https://github.com/owner/repo/releases/latest/download/projectman-motor.json")
        XCTAssertEqual(identity.latestReleaseURL?.absoluteString, "https://github.com/owner/repo/releases/latest")
        XCTAssertEqual(identity.assetURL(tag: "v1", name: "projectman-motor.zip")?.absoluteString, "https://github.com/owner/repo/releases/download/v1/projectman-motor.zip")
        XCTAssertNil(identity.assetURL(tag: "../x", name: "a.zip"))
        XCTAssertNil(AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo/../x", teamId: "ABCDE12345").manifestURL)
    }

    // MARK: AppUpdater

    func testNewerReleaseReplacesTheAppAndCleansTheCache() throws {
        let fixture = try UpdateFixture()
        XCTAssertEqual(try fixture.run(), .replaced)
        XCTAssertEqual(fixture.updating, 1)
        XCTAssertEqual(fixture.downloaded.map(\.absoluteString), ["https://github.com/owner/repo/releases/download/v2026.10.29/projectman-motor.zip"])
        XCTAssertEqual(fixture.unpackArguments.first?.prefix(2), ["-x", "-k"])
        XCTAssertEqual(fixture.verified, [UpdateManifest.requirement(teamId: "ABCDE12345")])
        XCTAssertEqual(fixture.replaced.map(\.0), [fixture.bundle]); XCTAssertEqual(fixture.replaced.first?.1.lastPathComponent, "projectman motor.app")
        XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.cache.path))
    }
    func testSameOrOlderReleaseIsUpToDate() throws {
        for version in ["20261028.0", "20261027.5"] {
            let fixture = try UpdateFixture()
            fixture.manifestChanges = { $0["bundleVersion"] = version }
            XCTAssertEqual(try fixture.run(), .upToDate)
            XCTAssertEqual(fixture.updating, 0); XCTAssertTrue(fixture.downloaded.isEmpty)
        }
    }
    func testReleaseWithoutManifestOrOfflineIsSilent() throws {
        for answer in [ManifestFetch.notFound, .unreachable] {
            let fixture = try UpdateFixture()
            fixture.manifest = answer
            XCTAssertEqual(try fixture.run(), .none); XCTAssertEqual(fixture.updating, 0)
        }
    }
    func testAdHocBuildDoesNotEvenLookForAnUpdate() throws {
        let fixture = try UpdateFixture()
        fixture.identity = AppIdentity(bundleVersion: "0", releaseRepo: "owner/repo", teamId: "")
        XCTAssertEqual(try fixture.run(), .none); XCTAssertTrue(fixture.fetched.isEmpty)
    }
    func testManifestFromAnotherTeamIsRefusedBeforeTheDownload() throws {
        let fixture = try UpdateFixture()
        fixture.manifestChanges = { $0["teamId"] = "ZZZZZ99999" }
        XCTAssertThrowsError(try fixture.run()) { XCTAssertEqual(($0 as? UpdateFailure)?.code, "team_mismatch") }
        XCTAssertTrue(fixture.downloaded.isEmpty)
    }
    func testEveryFailedStepKeepsTheOldAppAndNamesTheStep() throws {
        let cases: [(String, (UpdateFixture) -> Void)] = [
            ("download_failed", { $0.failing = ["download"] }),
            ("size_mismatch", { $0.manifestChanges = { object in object["zip"] = ["name": "projectman-motor.zip", "sha256": String(repeating: "a", count: 64), "size": 1] } }),
            ("sha256_mismatch", { fixture in
                let size = fixture.payload.count
                fixture.manifestChanges = { object in object["zip"] = ["name": "projectman-motor.zip", "sha256": String(repeating: "a", count: 64), "size": size] }
            }),
            ("unpack_failed", { $0.failing = ["unpack"] }),
            ("unpack_invalid", { $0.unpackedApps = [] }),
            ("unpack_invalid", { $0.unpackedApps = ["a.app", "b.app"] }),
            ("signature_invalid", { $0.failing = ["signature"] }),
            ("version_mismatch", { $0.unpackedVersion = "20261029.1" }),
            ("replace_failed", { $0.failing = ["replace"] }),
        ]
        for (code, arrange) in cases {
            let fixture = try UpdateFixture()
            arrange(fixture)
            XCTAssertThrowsError(try fixture.run(), code) { XCTAssertEqual(($0 as? UpdateFailure)?.code, code) }
            XCTAssertTrue(fixture.replaced.isEmpty, code)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.cache.path), code)
        }
    }
    // MARK: Attestation mode (PM-1199)

    private func attestationFixture() throws -> UpdateFixture {
        let fixture = try UpdateFixture()
        fixture.identity = AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo", teamId: "", updateTrust: "github-attestation", sourceRef: "refs/heads/main")
        fixture.manifestChanges = { $0["teamId"] = "" }
        return fixture
    }
    func testAttestationTrustLetsAnAdHocTaggedBuildUpdate() {
        let identity = AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo", teamId: "", updateTrust: "github-attestation", sourceRef: "refs/heads/main")
        XCTAssertEqual(identity.updateTrust, .attestation); XCTAssertTrue(identity.canSelfUpdate)
        XCTAssertEqual(identity.signerWorkflow, "owner/repo/.github/workflows/projectman-engine-release.yml")
    }
    func testBuildWithoutATagNeverUpdatesWhateverItsTrust() {
        XCTAssertFalse(AppIdentity(bundleVersion: "0", releaseRepo: "owner/repo", teamId: "", updateTrust: "github-attestation", sourceRef: "refs/heads/main").canSelfUpdate)
        XCTAssertFalse(AppIdentity(bundleVersion: "0", releaseRepo: "owner/repo", teamId: "ABCDE12345").canSelfUpdate)
    }
    func testAttestationTrustNeedsAValidSourceRefAndTheTrustKey() {
        XCTAssertEqual(AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo", teamId: "", updateTrust: "github-attestation", sourceRef: "refs/tags/v1").updateTrust, .none)
        XCTAssertEqual(AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo", teamId: "", updateTrust: nil, sourceRef: "refs/heads/main").updateTrust, .none)
        XCTAssertEqual(AppIdentity(info: ["CFBundleVersion": "20261028.0", "ProjectmanReleaseRepo": "owner/repo", "ProjectmanTeamId": "",
                                          "ProjectmanUpdateTrust": "github-attestation", "ProjectmanUpdateSourceRef": "refs/heads/main"]).updateTrust, .attestation)
    }
    func testTeamIdIsThePrimaryTrust() {
        let identity = AppIdentity(bundleVersion: "20261028.0", releaseRepo: "owner/repo", teamId: "ABCDE12345", updateTrust: "github-attestation", sourceRef: "refs/heads/main")
        XCTAssertEqual(identity.updateTrust, .team)
    }
    func testAttestedReleaseReplacesTheAppAfterEveryCheck() throws {
        let fixture = try attestationFixture()
        XCTAssertEqual(try fixture.run(), .replaced)
        XCTAssertEqual(fixture.attested, [["projectman-motor.zip", "owner/repo", "owner/repo/.github/workflows/projectman-engine-release.yml", "refs/heads/main"]])
        XCTAssertEqual(fixture.verified, [UpdateManifest.adHocRequirement])
        XCTAssertEqual(fixture.replaced.count, 1)
    }
    func testTeamSignedReleaseIsRefusedInAttestationModeBeforeTheDownload() throws {
        let fixture = try attestationFixture()
        fixture.manifestChanges = { $0["teamId"] = "ABCDE12345" }
        XCTAssertThrowsError(try fixture.run()) { XCTAssertEqual(($0 as? UpdateFailure)?.code, "team_mismatch") }
        XCTAssertTrue(fixture.downloaded.isEmpty)
    }
    func testEveryFailedAttestationStepKeepsTheOldAppAndNamesTheStep() throws {
        let cases: [(String, (UpdateFixture) -> Void)] = [
            ("attestation_invalid", { $0.failing = ["attestation"] }),
            ("version_mismatch", { $0.bundledCommit = String(repeating: "b", count: 40) }),
            ("version_mismatch", { $0.bundledCommit = nil }),
            ("signature_invalid", { $0.failing = ["signature"] }),
        ]
        for (code, arrange) in cases {
            let fixture = try attestationFixture()
            arrange(fixture)
            XCTAssertThrowsError(try fixture.run(), code) { XCTAssertEqual(($0 as? UpdateFailure)?.code, code) }
            XCTAssertTrue(fixture.replaced.isEmpty, code)
            XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.cache.path), code)
        }
    }
    func testFailedAttestationStopsBeforeUnpacking() throws {
        let fixture = try attestationFixture()
        fixture.failing = ["attestation"]
        XCTAssertThrowsError(try fixture.run())
        XCTAssertTrue(fixture.unpackArguments.isEmpty)
    }
    func testVerifierRunsGhWithTheSignerWorkflowTheSourceRefAndNoSelfHostedRunner() throws {
        var spec: CommandSpec?
        try AttestationVerifier.verify(zip: URL(fileURLWithPath: "/c/a.zip"), repo: "owner/repo", signerWorkflow: "owner/repo/.github/workflows/w.yml", sourceRef: "refs/heads/main",
                                       path: "/x/bin:/opt/homebrew/bin", home: "/h", isExecutable: { $0 == "/opt/homebrew/bin/gh" }, run: { spec = $0; return CommandResult(status: 0) })
        XCTAssertEqual(spec?.executable, "/opt/homebrew/bin/gh")
        XCTAssertEqual(spec?.arguments, ["attestation", "verify", "/c/a.zip", "--repo", "owner/repo", "--signer-workflow", "owner/repo/.github/workflows/w.yml",
                                         "--source-ref", "refs/heads/main", "--deny-self-hosted-runners"])
        XCTAssertEqual(spec?.environment?["PATH"], "/x/bin:/opt/homebrew/bin")
    }
    func testVerifierNamesAMissingGhAndARefusedAttestation() {
        XCTAssertEqual(failure { try AttestationVerifier.verify(zip: URL(fileURLWithPath: "/a.zip"), repo: "o/r", signerWorkflow: "w", sourceRef: "refs/heads/main", path: "/x",
                                                                 home: "/h", isExecutable: { _ in false }, run: { _ in CommandResult(status: 0) }) }?.code, "gh_missing")
        XCTAssertEqual(failure { try AttestationVerifier.verify(zip: URL(fileURLWithPath: "/a.zip"), repo: "o/r", signerWorkflow: "w", sourceRef: "refs/heads/main", path: "/x",
                                                                home: "/h", isExecutable: { _ in true }, run: { _ in CommandResult(status: 1, error: "no attestations found") }) }?.code, "attestation_invalid")
    }

    func testUnsupportedManifestFailsBeforeTheDownload() throws {
        let fixture = try UpdateFixture()
        fixture.manifestChanges = { $0["minimumMacOS"] = "15.0" }
        XCTAssertThrowsError(try fixture.run()) { XCTAssertEqual(($0 as? UpdateFailure)?.code, "macos_too_old") }
        XCTAssertEqual(fixture.updating, 0); XCTAssertTrue(fixture.downloaded.isEmpty)
    }
}
