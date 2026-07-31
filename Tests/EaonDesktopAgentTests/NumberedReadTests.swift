import XCTest
@testable import Eaon_desktop

final class NumberedReadTests: XCTestCase {
    private func read(
        _ content: String,
        path: String = "/tmp/example.txt",
        offset: Int? = nil,
        limit: Int? = nil
    ) -> String {
        DesktopControlService.numberedRead(
            content: content,
            path: path,
            offset: offset,
            limit: limit
        )
    }

    func testLineNumbersAreRightAlignedToLargestNumberInSlice() {
        let content = (1...12).map { "line \($0)" }.joined(separator: "\n")
        let result = read(content, offset: 8, limit: 5)

        XCTAssertTrue(result.contains("\n 8\tline 8"))
        XCTAssertTrue(result.contains("\n 9\tline 9"))
        XCTAssertTrue(result.contains("\n10\tline 10"))
        XCTAssertTrue(result.contains("\n12\tline 12"))
    }

    func testDefaultReadIsCappedAtFourHundredLines() {
        let content = (1...401).map { "line \($0)" }.joined(separator: "\n")
        let result = read(content)

        XCTAssertTrue(result.contains("lines 1-400 of 401"))
        XCTAssertTrue(result.contains("\n400\tline 400"))
        XCTAssertFalse(result.contains("\n401\tline 401"))
    }

    func testHeaderReportsSliceAndReadOnHint() {
        let result = read("one\ntwo\nthree\nfour", offset: 2, limit: 2)

        XCTAssertTrue(result.hasPrefix("/tmp/example.txt — lines 2-3 of 4"))
        XCTAssertTrue(result.contains("read on with offset: 4"))
    }

    func testReadOnHintIsAbsentAtEOF() {
        let result = read("one\ntwo\nthree", offset: 2, limit: 2)

        XCTAssertTrue(result.contains("lines 2-3 of 3"))
        XCTAssertFalse(result.contains("read on with offset"))
    }

    func testOffsetAndLimitSelectExactSlice() {
        let result = read("one\ntwo\nthree\nfour\nfive", offset: 3, limit: 2)

        XCTAssertTrue(result.contains("\n3\tthree"))
        XCTAssertTrue(result.contains("\n4\tfour"))
        XCTAssertFalse(result.contains("\n2\ttwo"))
        XCTAssertFalse(result.contains("\n5\tfive"))
    }

    func testOffsetPastEOFClampsToFinalLine() {
        let result = read("one\ntwo\nthree", offset: 999, limit: 10)

        XCTAssertTrue(result.contains("lines 3-3 of 3"))
        XCTAssertTrue(result.hasSuffix("3\tthree"))
    }

    func testZeroOffsetIsTreatedAsOne() {
        let result = read("one\ntwo", offset: 0, limit: 1)
        XCTAssertTrue(result.contains("lines 1-1 of 2"))
        XCTAssertTrue(result.hasSuffix("1\tone"))
    }

    func testNegativeOffsetIsTreatedAsOne() {
        let result = read("one\ntwo", offset: -20, limit: 1)
        XCTAssertTrue(result.contains("lines 1-1 of 2"))
        XCTAssertTrue(result.hasSuffix("1\tone"))
    }

    func testZeroOrNegativeLimitStillReadsOneLine() {
        let zero = read("one\ntwo", offset: 1, limit: 0)
        let negative = read("one\ntwo", offset: 1, limit: -5)

        XCTAssertTrue(zero.contains("lines 1-1 of 2"))
        XCTAssertTrue(negative.contains("lines 1-1 of 2"))
        XCTAssertFalse(zero.contains("\n2\ttwo"))
        XCTAssertFalse(negative.contains("\n2\ttwo"))
    }

    func testEmptyFileHasExplicitZeroLineMessage() {
        XCTAssertEqual(read("", path: "/tmp/empty.txt"), "/tmp/empty.txt is empty (0 lines).")
    }

    func testLongLineIsTruncatedWithoutHidingLaterLines() {
        let result = read(String(repeating: "x", count: 2_100) + "\nlater")

        XCTAssertTrue(result.contains("… (line truncated)"))
        XCTAssertTrue(result.contains("\n2\tlater"))
        XCTAssertFalse(result.contains(String(repeating: "x", count: 2_100)))
    }
}
