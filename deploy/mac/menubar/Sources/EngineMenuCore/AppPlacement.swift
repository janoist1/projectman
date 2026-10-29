import Foundation

public enum Placement: Equatable {
    case inPlace
    case moved(URL)
    case failed
}

/// q: the app runs from `/Applications` or `~/Applications`, not from a DMG, the Downloads folder or a translocated copy.
public struct AppPlacement {
    public static let appName = "projectman motor.app"
    public let userHome: URL
    /// `/Applications` first, then `~/Applications`; tests name their own.
    public let directories: [URL]
    public let copy: (URL, URL) throws -> Void
    public init(userHome: URL, directories: [URL]? = nil, copy: @escaping (URL, URL) throws -> Void) {
        self.userHome = userHome
        self.directories = directories ?? [URL(fileURLWithPath: "/Applications"), userHome.appendingPathComponent("Applications")]
        self.copy = copy
    }
    public func isPlaced(_ bundle: URL, translocated: Bool) -> Bool {
        guard !translocated, !bundle.path.contains("/AppTranslocation/") else { return false }
        let parent = bundle.deletingLastPathComponent().standardizedFileURL.path
        return directories.contains { $0.standardizedFileURL.path == parent }
    }
    /// Copies the app to the first Applications folder that takes it and returns where it is; the caller relaunches it.
    public func place(_ bundle: URL, translocated: Bool) -> Placement {
        if isPlaced(bundle, translocated: translocated) { return .inPlace }
        let files = FileManager.default
        for directory in directories {
            let target = directory.appendingPathComponent(AppPlacement.appName)
            let staged = directory.appendingPathComponent(".projectman motor.app.partial")
            do {
                if !files.fileExists(atPath: directory.path) { try files.createDirectory(at: directory, withIntermediateDirectories: true) }
                guard files.isWritableFile(atPath: directory.path) else { continue }
                try? files.removeItem(at: staged)
                try copy(bundle, staged)
                try? files.removeItem(at: target)
                try files.moveItem(at: staged, to: target)
                return .moved(target)
            } catch {
                try? files.removeItem(at: staged)
            }
        }
        return .failed
    }
}
