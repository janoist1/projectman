import AppKit
import Security
import EngineMenuCore

/// The live seams of the app's self-update (PM-1126): HTTPS to GitHub, `ditto`, the Security framework and
/// `FileManager.replaceItemAt`. The core (`AppUpdater`) holds the order of the steps and is tested without them.
enum Updates {
    static var identity: AppIdentity { AppIdentity(info: Bundle.main.infoDictionary ?? [:]) }
    /// `~/Library/Caches/com.projectman.engine-app/updates`; emptied after every attempt.
    static var cache: URL { Machine.home.appendingPathComponent("Library/Caches/\(AppIdentity.bundleIdentifier)/updates") }

    static func updater() -> AppUpdater {
        AppUpdater(identity: identity, bundle: Bundle.main.bundleURL, cache: cache, os: ProcessInfo.processInfo.operatingSystemVersion, seams: seams)
    }

    static let seams = UpdateSeams(
        fetchManifest: fetchManifest,
        download: download,
        run: SystemProcess.runner,
        verifySignature: verifySignature,
        bundleVersion: { Bundle(url: $0)?.infoDictionary?["CFBundleVersion"] as? String },
        replace: { bundle, replacement in _ = try FileManager.default.replaceItemAt(bundle, withItemAt: replacement) })

    private final class Outcome: @unchecked Sendable {
        var data: Data?
        var location: URL?
        var status = 0
        var error: Error?
    }
    private static func session(timeout: TimeInterval) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = timeout
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration)
    }

    /// A 404 is an older release without a manifest; any other trouble is the network, so the next check retries.
    static func fetchManifest(_ url: URL) -> ManifestFetch {
        guard url.scheme == "https" else { return .unreachable }
        let outcome = Outcome(), done = DispatchSemaphore(value: 0)
        let session = session(timeout: 60)
        session.dataTask(with: URLRequest(url: url)) { data, response, error in
            outcome.data = data; outcome.error = error; outcome.status = (response as? HTTPURLResponse)?.statusCode ?? 0
            done.signal()
        }.resume()
        done.wait()
        session.finishTasksAndInvalidate()
        if outcome.status == 404 { return .notFound }
        guard outcome.error == nil, outcome.status == 200, let data = outcome.data, data.count < 1 << 20 else { return .unreachable }
        return .found(data)
    }

    static func download(_ source: URL, _ destination: URL) throws {
        guard source.scheme == "https" else { throw UpdateFailure("download_failed", "Only https downloads are allowed.") }
        let outcome = Outcome(), done = DispatchSemaphore(value: 0)
        let session = session(timeout: 900)
        session.downloadTask(with: source) { location, response, error in
            outcome.error = error; outcome.status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if let location {
                // The temporary file is deleted when this handler returns.
                do { try FileManager.default.moveItem(at: location, to: destination); outcome.location = destination } catch { outcome.error = error }
            }
            done.signal()
        }.resume()
        done.wait()
        session.finishTasksAndInvalidate()
        if let error = outcome.error { throw UpdateFailure("download_failed", error.localizedDescription) }
        guard outcome.status == 200, outcome.location != nil else { throw UpdateFailure("download_failed", "GitHub answered \(outcome.status).") }
    }

    /// The new app must be signed by our team under our bundle identifier (`UpdateManifest.requirement`), whole bundle
    /// and every architecture, before it may replace this one.
    static func verifySignature(_ app: URL, _ requirementText: String) throws {
        var code: SecStaticCode?
        guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code else {
            throw UpdateFailure("signature_invalid", "The downloaded app cannot be read.")
        }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess, let requirement else {
            throw UpdateFailure("signature_invalid", "The signing requirement is invalid.")
        }
        var failure: Unmanaged<CFError>?
        let flags = SecCSFlags(rawValue: kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate)
        let status = SecStaticCodeCheckValidityWithErrors(code, flags, requirement, &failure)
        guard status == errSecSuccess else {
            let reason = failure.map { CFErrorCopyDescription($0.takeRetainedValue()) as String } ?? "status \(status)"
            throw UpdateFailure("signature_invalid", reason)
        }
    }

    /// The new copy starts after this one has quit; the engine keeps running throughout.
    static func relaunch() throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 1; /usr/bin/open \"$1\"", "sh", Bundle.main.bundleURL.path]
        try process.run()
        NSApp.terminate(nil)
    }
}
