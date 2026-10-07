import XCTest
@testable import Eaon

final class MarkdownTests: XCTestCase {
    func testBlocks() {
        let blocks = MarkdownBlock.parse("""
        # Title

        Some **bold** text
        on two lines.

        - one
        - two

        1. first
        2. second

        > quoted
        """)
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: "Title"),
            .paragraph("Some **bold** text\non two lines."),
            .bullets(["one", "two"]),
            .numbered(["first", "second"]),
            .quote("quoted")
        ])
    }

    func testCodeFenceWithLanguage() {
        XCTAssertEqual(
            MarkdownBlock.parse("Before\n```swift\nlet a = 1\n\nlet b = 2\n```\nAfter"),
            [.paragraph("Before"), .code(language: "swift", text: "let a = 1\n\nlet b = 2"), .paragraph("After")]
        )
    }

    func testAFenceStillBeingWrittenIsCode() {
        XCTAssertEqual(
            MarkdownBlock.parse("Try this:\n```python\nprint('hi'"),
            [.paragraph("Try this:"), .code(language: "python", text: "print('hi'")]
        )
    }

    func testAListRightAfterAParagraphStartsItsOwnBlock() {
        XCTAssertEqual(
            MarkdownBlock.parse("Steps:\n- a\n- b"),
            [.paragraph("Steps:"), .bullets(["a", "b"])]
        )
    }

    func testPreviewsAreOneLineOfPlainText() {
        XCTAssertEqual("Tides come from the **Moon's gravity**.\n\n- The side facing the Moon\n- bulges".markdownPreview,
                       "Tides come from the Moon's gravity. The side facing the Moon bulges")
        XCTAssertEqual("# Heading\n```swift\nlet x = 1\n```".markdownPreview, "Heading let x = 1")
        XCTAssertEqual("".markdownPreview, "")
    }

    func testTitlesComeFromTheFirstLine() {
        XCTAssertEqual(Conversation.title(from: "Explain how tides work"), "Explain how tides work")
        XCTAssertEqual(Conversation.title(from: "   \n"), Conversation.untitled)
        let long = Conversation.title(from: "Please write me a very long and detailed essay about the history of the printing press")
        XCTAssertTrue(long.hasSuffix("…"))
        XCTAssertLessThanOrEqual(long.count, 46)
        XCTAssertEqual(Conversation.title(from: "First line\nSecond line"), "First line")
    }

    func testGreetings() {
        func at(_ hour: Int) -> Date {
            Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: Date())!
        }
        XCTAssertEqual(DayPart.greeting(at(8)), "Good morning")
        XCTAssertEqual(DayPart.greeting(at(14)), "Good afternoon")
        XCTAssertEqual(DayPart.greeting(at(19)), "Good evening")
        XCTAssertEqual(DayPart.greeting(at(2)), "Hello")
    }
}
