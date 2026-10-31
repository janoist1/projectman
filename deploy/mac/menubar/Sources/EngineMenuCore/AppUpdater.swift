import Foundation
import CryptoKit

/// What the menu shows about the app's own update: nothing (`idle`), j (`updating`) or k (`failed`).
public enum AppUpdateStatus: Equatable { case idle, updating, failed(UpdateFailure) }

public enum ManifestFetch: Equatable {
    case found(Data)
    /// The release has no manifest (404): an older release, so there is nothing to update to and nothing to show.
    case notFound
    /// No network, GitHub unreachable or an unexpected status: nothing is wrong with the app, the next check retries.
    case unreachable
}

public enum UpdateOutcome: Equatable {
    /// No update is possible or published (ad-hoc build, no manifest, offline).
    case none
    case upToDate
    /// The new app replaced this one; the caller restarts it.
    case replaced
}

/// Everything the update touches outside the process, so the tests run without a network, `ditto` or a signature.
public struct UpdateSeams {
    public var fetchManifest: (URL) -> ManifestFetch
    /// Downloads to the given file.
    public var download: (URL, URL) throws -> Void
    public var run: CommandRunner
    /// Checks the code signature of an app against a requirement text (`SecStaticCodeCheckValidity`).
    public var verifySignature: (URL, String) throws -> Void
    /// Checks the GitHub build attestation of the downloaded zip (`AttestationVerifier`); attestation mode only (PM-1199).
    public var verifyAttestation: (_ zip: URL, _ repo: String, _ signerWorkflow: String, _ sourceRef: String) throws -> Void
    public var bundleVersion: (URL) -> String?
    /// Puts the new app in place of the old one (`FileManager.replaceItemAt`).
    public var replace: (URL, URL) throws -> Void
    public init(fetchManifest: @escaping (URL) -> ManifestFetch, download: @escaping (URL, URL) throws -> Void, run: @escaping CommandRunner,
                verifySignature: @escaping (URL, String) throws -> Void,
                verifyAttestation: @escaping (URL, String, String, String) throws -> Void,
                bundleVersion: @escaping (URL) -> String?, replace: @escaping (URL, URL) throws -> Void) {
        self.fetchManifest = fetchManifest; self.download = download; self.run = run
        self.verifySignature = verifySignature; self.verifyAttestation = verifyAttestation
        self.bundleVersion = bundleVersion; self.replace = replace
    }
}

/// `gh attestation verify` of the downloaded zip (PM-1199): the build must come from the release workflow, on the
/// default branch, on a GitHub-hosted runner. `gh` is found on the engine's PATH, the one its sessions use.
public enum AttestationVerifier {
    public static let timeout: TimeInterval = 120

    public static func ghPath(on path: String, isExecutable: (String) -> Bool) -> String? {
        path.split(separator: ":").map { "\($0)/gh" }.first(where: isExecutable)
    }
    public static func arguments(zip: URL, repo: String, signerWorkflow: String, sourceRef: String) -> [String] {
        ["attestation", "verify", zip.path, "--repo", repo, "--signer-workflow", signerWorkflow, "--source-ref", sourceRef, "--deny-self-hosted-runners"]
    }
    public static func verify(zip: URL, repo: String, signerWorkflow: String, sourceRef: String, path: String, home: String,
                              isExecutable: (String) -> Bool, run: CommandRunner) throws {
        guard let gh = ghPath(on: path, isExecutable: isExecutable) else {
            throw UpdateFailure("gh_missing", "The gh command (2.49 or newer) is not on the engine's PATH.")
        }
        let environment = ["PATH": path, "HOME": home, "GH_PROMPT_DISABLED": "1", "NO_COLOR": "1"]
        let spec = CommandSpec(gh, arguments(zip: zip, repo: repo, signerWorkflow: signerWorkflow, sourceRef: sourceRef), environment: environment, timeout: timeout)
        let result: CommandResult
        do { result = try run(spec) } catch { throw UpdateFailure("attestation_invalid", Installer.describe(error)) }
        if result.status != 0 { throw UpdateFailure("attestation_invalid", RawError.text(result)) }
    }
}

public enum FileDigest {
    public static func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// The app's self-update (PM-1126): manifest, download, size and sha256, unpack, signature, version, replace.
/// Any failure leaves the running app and its files as they were; the cache is removed either way.
public struct AppUpdater {
    public let identity: AppIdentity
    /// The running app bundle, which the new one replaces.
    public let bundle: URL
    /// `~/Library/Caches/com.projectman.engine-app/updates`.
    public let cache: URL
    public let os: OperatingSystemVersion
    public let seams: UpdateSeams

    public init(identity: AppIdentity, bundle: URL, cache: URL, os: OperatingSystemVersion, seams: UpdateSeams) {
        self.identity = identity; self.bundle = bundle; self.cache = cache; self.os = os; self.seams = seams
    }

    private func step<T>(_ code: String, _ body: () throws -> T) throws -> T {
        do { return try body() } catch let failure as UpdateFailure { throw failure } catch { throw UpdateFailure(code, Installer.describe(error)) }
    }

    /// `onUpdating` is called once a newer app is found, before the download (the menu shows j from then on).
    public func run(onUpdating: () -> Void) throws -> UpdateOutcome {
        guard identity.canSelfUpdate, let manifestURL = identity.manifestURL, let current = BuildNumber(identity.bundleVersion) else { return .none }
        let requirement: String
        switch identity.updateTrust {
        case .team: requirement = UpdateManifest.requirement(teamId: identity.teamId ?? "")
        case .attestation: requirement = UpdateManifest.adHocRequirement
        case .none: return .none
        }
        let data: Data
        switch seams.fetchManifest(manifestURL) {
        case .notFound, .unreachable: return .none
        case .found(let found): data = found
        }
        let manifest = try UpdateManifest.decode(data)
        try manifest.supported(on: os)
        guard let offered = BuildNumber(manifest.bundleVersion) else { throw UpdateFailure("manifest_invalid", "bundleVersion \(manifest.bundleVersion) cannot be read.") }
        guard offered > current else { return .upToDate }
        // An attestation build takes only an ad-hoc release; a Developer ID release is installed by hand the first time.
        guard manifest.teamId == (identity.teamId ?? "") else { throw UpdateFailure("team_mismatch", "The release is signed by another team.") }
        guard let tag = manifest.tag, let source = identity.assetURL(tag: tag, name: manifest.zip.name) else {
            throw UpdateFailure("manifest_invalid", "The release has no downloadable app.")
        }
        onUpdating()

        let files = FileManager.default
        let work = cache.appendingPathComponent(manifest.bundleVersion)
        try step("download_failed") {
            try? files.removeItem(at: cache)
            try files.createDirectory(at: work, withIntermediateDirectories: true)
        }
        defer { try? files.removeItem(at: cache) }
        let zip = work.appendingPathComponent(manifest.zip.name)
        try step("download_failed") { try seams.download(source, zip) }
        let size = ((try? files.attributesOfItem(atPath: zip.path))?[.size] as? NSNumber)?.intValue
        guard size == manifest.zip.size else { throw UpdateFailure("size_mismatch", "Downloaded \(size.map(String.init) ?? "nothing"), expected \(manifest.zip.size) bytes.") }
        let digest = try step("sha256_mismatch") { try FileDigest.sha256(of: zip) }
        guard digest == manifest.zip.sha256.lowercased() else { throw UpdateFailure("sha256_mismatch", "The download does not match the manifest.") }
        if identity.updateTrust == .attestation, let repo = identity.releaseRepo, let workflow = identity.signerWorkflow, let ref = identity.sourceRef {
            try step("attestation_invalid") { try seams.verifyAttestation(zip, repo, workflow, ref) }
        }

        let unpacked = work.appendingPathComponent("unpacked")
        try step("unpack_failed") {
            let result = try seams.run(CommandSpec("/usr/bin/ditto", ["-x", "-k", zip.path, unpacked.path], timeout: 600))
            if result.status != 0 { throw UpdateFailure("unpack_failed", RawError.text(result)) }
        }
        let apps = ((try? files.contentsOfDirectory(atPath: unpacked.path)) ?? []).filter { $0.hasSuffix(".app") }
        guard apps.count == 1 else { throw UpdateFailure("unpack_invalid", "The download holds \(apps.count) apps, expected one.") }
        let app = unpacked.appendingPathComponent(apps[0])

        try step("signature_invalid") { try seams.verifySignature(app, requirement) }
        let unpackedVersion = seams.bundleVersion(app)
        guard unpackedVersion == manifest.bundleVersion else {
            throw UpdateFailure("version_mismatch", "The app is \(unpackedVersion ?? "unreadable"), the manifest says \(manifest.bundleVersion).")
        }
        if identity.updateTrust == .attestation {
            // The attestation covers the zip, not what the manifest claims: the bundled engine must be the commit it names.
            let bundledCommit = BundledPackage.read(at: app.appendingPathComponent("Contents/Resources/engine"))?.version
            guard bundledCommit == manifest.version else {
                throw UpdateFailure("version_mismatch", "The bundled engine is \(bundledCommit ?? "unreadable"), the manifest says \(manifest.version).")
            }
        }
        try step("replace_failed") { try seams.replace(bundle, app) }
        return .replaced
    }
}
