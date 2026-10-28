import XCTest
@testable import EngineMenuCore

final class LocatorTests: XCTestCase {
    private var home: URL!
    private var root: URL!
    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        root = home.appendingPathComponent("checkout")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("scripts/engine"), withIntermediateDirectories: true)
        try Data().write(to: root.appendingPathComponent("scripts/engine/cli.ts"))
    }
    override func tearDownWithError() throws { try FileManager.default.removeItem(at: home) }
    private func writePlist(root: String? = nil) throws {
        let file = home.appendingPathComponent("Library/LaunchAgents/com.projectman.engine.plist")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let values: [String: Any] = ["ProgramArguments": ["/opt/node"], "WorkingDirectory": root ?? self.root.path,
                                     "EnvironmentVariables": ["PROJECTMAN_HOME": home.path + "/engine", "PATH": "/usr/bin"]]
        try PropertyListSerialization.data(fromPropertyList: values, format: .xml, options: 0).write(to: file)
    }
    private func fallback() throws {
        let file = home.appendingPathComponent("Library/Application Support/projectman/menubar.json")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let value = EngineLocation(schemaVersion: 1, node: "/fallback/node", root: root.path, home: home.path, path: "/usr/bin")
        try JSONEncoder().encode(value).write(to: file)
    }
    func testFallsBackOnlyWhenPlistIsAbsent() throws {
        try fallback()
        XCTAssertEqual(try EngineLocator.locate(userHome: home).node, "/fallback/node")
        try writePlist()
        XCTAssertEqual(try EngineLocator.locate(userHome: home).node, "/opt/node")
    }
    func testRereadsPlistAfterReleaseSwitch() throws {
        try writePlist()
        XCTAssertEqual(try EngineLocator.locate(userHome: home).root, root.path)
        let next = home.appendingPathComponent("new-checkout")
        try FileManager.default.copyItem(at: root, to: next)
        try writePlist(root: next.path)
        XCTAssertEqual(try EngineLocator.locate(userHome: home).root, next.path)
    }
    func testMissingCLIDoesNotUseStaleFallback() throws {
        try fallback(); try writePlist(root: home.path + "/missing")
        XCTAssertThrowsError(try EngineLocator.locate(userHome: home))
    }
    func testMissingBothLocationsIsAnError() {
        XCTAssertThrowsError(try EngineLocator.locate(userHome: home))
    }
}
