import XCTest
@testable import Eaon

@MainActor
final class ChatStoreTests: XCTestCase {
    private var url = FileManager.default.temporaryDirectory.appendingPathComponent("eaon-tests-\(UUID().uuidString).json")

    override func tearDown() {
        try? FileManager.default.removeItem(at: url)
    }

    private func conversation(_ title: String, messages: Int = 2) -> Conversation {
        Conversation(
            title: title,
            messages: (0..<messages).map { ChatMessage(role: $0 % 2 == 0 ? .user : .assistant, text: "\(title) \($0)") }
        )
    }

    func testNewestFirstAndEmptyOnesAreNotKept() {
        let store = ChatStore(url: url)
        store.upsert(conversation("old"))
        store.upsert(conversation("new"))
        store.upsert(conversation("nothing", messages: 0))
        XCTAssertEqual(store.conversations.map(\.title), ["new", "old"])
    }

    func testSavingAgainMovesItToTheTop() {
        let store = ChatStore(url: url)
        let first = conversation("first")
        store.upsert(first)
        store.upsert(conversation("second"))
        var again = first
        again.messages.append(ChatMessage(role: .user, text: "more"))
        store.upsert(again)
        XCTAssertEqual(store.conversations.map(\.title), ["first", "second"])
        XCTAssertEqual(store.conversations.count, 2)
        XCTAssertEqual(store.conversation(first.id)?.messages.count, 3)
    }

    func testFlushWritesAndANewStoreReadsItBack() {
        let store = ChatStore(url: url)
        store.upsert(conversation("kept"))
        store.flush()
        let again = ChatStore(url: url)
        XCTAssertEqual(again.conversations.map(\.title), ["kept"])
        XCTAssertEqual(again.conversations.first?.messages.count, 2)
    }

    func testRenameDeleteAndDeleteAll() {
        let store = ChatStore(url: url)
        let one = conversation("one")
        store.upsert(one)
        store.upsert(conversation("two"))
        store.rename(one.id, to: "  Renamed  ")
        XCTAssertEqual(store.conversation(one.id)?.title, "Renamed")
        store.rename(one.id, to: "   ")
        XCTAssertEqual(store.conversation(one.id)?.title, "Renamed")
        store.delete(one.id)
        XCTAssertEqual(store.conversations.map(\.title), ["two"])
        store.deleteAll()
        XCTAssertTrue(store.conversations.isEmpty)
    }

    func testACorruptFileIsIgnoredNotACrash() throws {
        try Data("{ not json".utf8).write(to: url)
        XCTAssertTrue(ChatStore(url: url).conversations.isEmpty)
    }
}
