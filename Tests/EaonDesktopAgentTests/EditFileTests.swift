import Foundation
import XCTest
@testable import Eaon_desktop

final class EditFileTests: XCTestCase {
    private func makeScratchDirectory() throws -> URL {
        let id = UUID().uuidString
        let systemTemp = FileManager.default.temporaryDirectory
            .appendingPathComponent(id, isDirectory: true)
        let homeFallback = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".eaon-test-scratch-\(id)", isDirectory: true)
        let directory = [systemTemp, homeFallback].first {
            DesktopControlService.isModifiablePath(
                DesktopControlService.normalizedPath($0.path)
            )
        } ?? homeFallback

        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        addTeardownBlock {
            try? FileManager.default.removeItem(at: directory)
        }
        return directory
    }

    private func makeFile(_ content: String) throws -> URL {
        let url = try makeScratchDirectory().appendingPathComponent("fixture.txt")
        try content.write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    private func edit(
        _ url: URL,
        search: String,
        replace: String,
        replaceAll: Bool? = nil
    ) async -> DesktopResult {
        var arguments: [String: Any] = [
            "path": url.path,
            "search": search,
            "replace": replace,
        ]
        if let replaceAll { arguments["replace_all"] = replaceAll }
        return await DesktopControlService.execute(tool: .editFile, arguments: arguments)
    }

    func testScratchPathPassesModificationGuard() throws {
        let directory = try makeScratchDirectory()
        XCTAssertTrue(
            DesktopControlService.isModifiablePath(
                DesktopControlService.normalizedPath(directory.path)
            )
        )
    }

    func testSingleMatchIsApplied() async throws {
        let file = try makeFile("alpha beta gamma")
        let result = await edit(file, search: "beta", replace: "delta")

        XCTAssertFalse(result.isError, result.text)
        XCTAssertTrue(result.text.contains("replaced 1 occurrence"))
        XCTAssertEqual(try String(contentsOf: file), "alpha delta gamma")
    }

    func testMultipleMatchesAreRefusedWithoutReplaceAll() async throws {
        let original = "old old old"
        let file = try makeFile(original)
        let result = await edit(file, search: "old", replace: "new")

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.text.contains("appears 3 times"), result.text)
        XCTAssertTrue(result.text.contains("replace_all: true"), result.text)
        XCTAssertEqual(try String(contentsOf: file), original)
    }

    func testReplaceAllChangesEveryMatchAndReportsCount() async throws {
        let file = try makeFile("old old old")
        let result = await edit(
            file,
            search: "old",
            replace: "new",
            replaceAll: true
        )

        XCTAssertFalse(result.isError, result.text)
        XCTAssertTrue(result.text.contains("replaced 3 occurrences"), result.text)
        XCTAssertEqual(try String(contentsOf: file), "new new new")
    }

    func testNotFoundErrorsInSingleMatchMode() async throws {
        let file = try makeFile("alpha")
        let result = await edit(file, search: "missing", replace: "new")

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.text.lowercased().contains("found"), result.text)
        XCTAssertEqual(try String(contentsOf: file), "alpha")
    }

    func testNotFoundErrorsInReplaceAllMode() async throws {
        let file = try makeFile("alpha")
        let result = await edit(
            file,
            search: "missing",
            replace: "new",
            replaceAll: true
        )

        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.text.lowercased().contains("found"), result.text)
        XCTAssertEqual(try String(contentsOf: file), "alpha")
    }

    func testEmptyReplacementDeletesMatchedText() async throws {
        let file = try makeFile("keep REMOVE keep")
        let result = await edit(file, search: "REMOVE ", replace: "")

        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(try String(contentsOf: file), "keep keep")
    }
}
