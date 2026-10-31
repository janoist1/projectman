import Foundation

/// `YYYYMMDD.N` (the `CFBundleVersion` of the app and `bundleVersion` of the manifest) compared as numbers.
public struct BuildNumber: Comparable, Equatable {
    public let date: Int
    public let sequence: Int
    public init?(_ text: String) {
        if text == "0" { date = 0; sequence = 0; return }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 8, let date = Int(parts[0]), let sequence = Int(parts[1]), sequence >= 0 else { return nil }
        self.date = date; self.sequence = sequence
    }
    public static func < (lhs: BuildNumber, rhs: BuildNumber) -> Bool { (lhs.date, lhs.sequence) < (rhs.date, rhs.sequence) }
}

/// Why an update was not installed. The `code` is the line the menu's "Hiba másolása" copies, with the message.
public struct UpdateFailure: Error, Equatable, CustomStringConvertible {
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) { self.code = code; self.message = message }
    public var description: String { "\(code): \(message)" }
}

/// `projectman-motor.json` next to the release assets (PM-1122, PM-1123); the dmg entry is for people, not the app.
public struct UpdateManifest: Decodable, Equatable {
    public struct Asset: Decodable, Equatable { public let name: String; public let sha256: String; public let size: Int }
    public let schemaVersion: Int
    public let tag: String?
    public let version: String
    public let bundleVersion: String
    public let minimumMacOS: String
    public let arch: String
    public let teamId: String
    public let zip: Asset

    public static func decode(_ data: Data) throws -> UpdateManifest {
        struct Schema: Decodable { let schemaVersion: Int }
        if let schema = try? JSONDecoder().decode(Schema.self, from: data), schema.schemaVersion != 1 {
            throw UpdateFailure("manifest_unsupported", "Manifest schema \(schema.schemaVersion) is not supported.")
        }
        do { return try JSONDecoder().decode(UpdateManifest.self, from: data) }
        catch { throw UpdateFailure("manifest_invalid", "The release manifest cannot be read.") }
    }

    /// The manifest says this build can be installed here: schema 1, Apple Silicon, a macOS that is new enough.
    public func supported(on os: OperatingSystemVersion) throws {
        guard schemaVersion == 1 else { throw UpdateFailure("manifest_unsupported", "Manifest schema \(schemaVersion) is not supported.") }
        guard arch == "arm64" else { throw UpdateFailure("manifest_unsupported", "The release is for \(arch), this app needs arm64.") }
        let parts = minimumMacOS.split(separator: ".").compactMap { Int($0) }
        guard let major = parts.first else { throw UpdateFailure("manifest_invalid", "minimumMacOS \(minimumMacOS) cannot be read.") }
        let required = (major, parts.count > 1 ? parts[1] : 0)
        guard required <= (os.majorVersion, os.minorVersion) else {
            throw UpdateFailure("macos_too_old", "The release needs macOS \(minimumMacOS).")
        }
    }

    /// The signing requirement of PM-1104: Apple's chain, our bundle identifier and our team.
    public static func requirement(teamId: String) -> String {
        "anchor apple generic and identifier \"\(AppIdentity.bundleIdentifier)\" and certificate leaf[subject.OU] = \"\(teamId)\""
    }

    /// An ad-hoc signature has no chain to anchor to (PM-1199): the trust is the GitHub attestation, the signature only
    /// has to be valid and carry our bundle identifier.
    public static let adHocRequirement = "identifier \"\(AppIdentity.bundleIdentifier)\""
}

/// Why the app trusts a release: Apple's signature of our team (`team`), the GitHub build attestation of the release
/// workflow (`attestation`, PM-1199) or nothing, so it never updates itself (`none`).
public enum UpdateTrust: Equatable { case team, attestation, none }

/// What the app knows about itself from its Info.plist. A build with neither a team id nor the attestation trust has
/// nothing to check a release against, so it never updates itself.
public struct AppIdentity: Equatable {
    public static let bundleIdentifier = "com.projectman.engine-app"
    /// The workflow that builds and attests the ad-hoc release (`.github/workflows/`).
    public static let releaseWorkflow = "projectman-engine-release.yml"
    public let bundleVersion: String
    /// `owner/name` of the release repository.
    public let releaseRepo: String?
    /// The 10-character Apple team id; nil for an ad-hoc build.
    public let teamId: String?
    /// `refs/heads/<branch>` the attested workflow must have run from; nil unless the build trusts the attestation.
    public let sourceRef: String?

    public init(bundleVersion: String, releaseRepo: String?, teamId: String?, updateTrust: String? = nil, sourceRef: String? = nil) {
        self.bundleVersion = bundleVersion
        self.releaseRepo = releaseRepo.flatMap { AppIdentity.isRepo($0) ? $0 : nil }
        self.teamId = teamId.flatMap { $0.range(of: "^[A-Z0-9]{10}$", options: .regularExpression) != nil ? $0 : nil }
        self.sourceRef = updateTrust == "github-attestation"
            ? sourceRef.flatMap { $0.range(of: "^refs/heads/[A-Za-z0-9._/-]+$", options: .regularExpression) != nil ? $0 : nil } : nil
    }
    public init(info: [String: Any]) {
        self.init(bundleVersion: info["CFBundleVersion"] as? String ?? "", releaseRepo: info["ProjectmanReleaseRepo"] as? String,
                  teamId: info["ProjectmanTeamId"] as? String, updateTrust: info["ProjectmanUpdateTrust"] as? String,
                  sourceRef: info["ProjectmanUpdateSourceRef"] as? String)
    }
    static func isRepo(_ text: String) -> Bool { text.range(of: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", options: .regularExpression) != nil }

    /// The Team ID is the primary trust; the attestation applies to a build without one.
    public var updateTrust: UpdateTrust { teamId != nil ? .team : sourceRef != nil ? .attestation : .none }
    /// `owner/name/.github/workflows/projectman-engine-release.yml`, the signer workflow `gh attestation verify` pins.
    public var signerWorkflow: String? { releaseRepo.map { "\($0)/.github/workflows/\(AppIdentity.releaseWorkflow)" } }
    /// A build without a tag (`"0"`) never updates, so a development build someone installed on purpose stays.
    public var canSelfUpdate: Bool {
        releaseRepo != nil && updateTrust != .none && (BuildNumber(bundleVersion).map { $0 > BuildNumber("0")! } ?? false)
    }
    public var manifestURL: URL? { releaseRepo.flatMap { URL(string: "https://github.com/\($0)/releases/latest/download/projectman-motor.json") } }
    /// The page "Letöltés kézzel…" opens.
    public var latestReleaseURL: URL? { releaseRepo.flatMap { URL(string: "https://github.com/\($0)/releases/latest") } }
    public func assetURL(tag: String, name: String) -> URL? {
        guard let releaseRepo, tag.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil,
              name.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil else { return nil }
        return URL(string: "https://github.com/\(releaseRepo)/releases/download/\(tag)/\(name)")
    }
}
