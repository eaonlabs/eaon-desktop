import SwiftUI

/// One block of a reply.
enum MarkdownBlock: Equatable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullets([String])
    case numbered([String])
    case quote(String)
    case code(language: String?, text: String)

    /// Splits Markdown into blocks. Made for text that's still arriving: a
    /// code fence that hasn't closed yet is code, not a paragraph full of backticks.
    static func parse(_ source: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbers: [String] = []
        var quote: [String] = []

        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
            if !numbers.isEmpty { blocks.append(.numbered(numbers)); numbers = [] }
            if !quote.isEmpty { blocks.append(.quote(quote.joined(separator: "\n"))); quote = [] }
        }

        var lines = source.components(separatedBy: "\n")[...]
        while let raw = lines.popFirst() {
            let line = raw.trimmingCharacters(in: .whitespaces)

            if line.hasPrefix("```") {
                flush()
                let language = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []
                while let next = lines.popFirst() {
                    if next.trimmingCharacters(in: .whitespaces).hasPrefix("```") { break }
                    code.append(next)
                }
                blocks.append(.code(language: language.isEmpty ? nil : language, text: code.joined(separator: "\n")))
                continue
            }

            if line.isEmpty { flush(); continue }

            if let heading = line.firstMatch(of: /^(#{1,4})\s+(.+)$/) {
                flush()
                blocks.append(.heading(level: heading.1.count, text: String(heading.2)))
            } else if let item = line.firstMatch(of: /^[-*•]\s+(.+)$/) {
                if bullets.isEmpty { flush() }
                bullets.append(String(item.1))
            } else if let item = line.firstMatch(of: /^\d+[.)]\s+(.+)$/) {
                if numbers.isEmpty { flush() }
                numbers.append(String(item.1))
            } else if line.hasPrefix(">") {
                if quote.isEmpty { flush() }
                quote.append(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))
            } else {
                if !bullets.isEmpty || !numbers.isEmpty || !quote.isEmpty { flush() }
                paragraph.append(line)
            }
        }
        flush()
        return blocks
    }
}

/// A reply, set in the page: paragraphs, headings, lists, quotes, and code
/// in a card that copies. While a reply is arriving, each new block fades up into place.
struct MarkdownText: View {
    let source: String
    var animatesNewBlocks = false

    var body: some View {
        let blocks = MarkdownBlock.parse(source)
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(for: block)
                    .entrance(rise: 4, animation: .easeOut(duration: 0.22), isEnabled: animatesNewBlocks)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let text):
            inline(text)
                .font(.body)
                .lineSpacing(5)
        case .heading(let level, let text):
            inline(text)
                .font(level == 1 ? .title2.weight(.semibold) : level == 2 ? .title3.weight(.semibold) : .headline)
                .padding(.top, 4)
        case .bullets(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Circle().fill(Palette.secondary)
                            .frame(width: 5, height: 5)
                            .offset(y: -2)
                            .frame(width: 22, alignment: .leading)
                        inline(item).font(.body).lineSpacing(3)
                    }
                }
            }
        case .numbered(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text("\(index + 1).")
                            .font(.body.monospacedDigit())
                            .foregroundStyle(Palette.secondary)
                            .frame(width: 22, alignment: .leading)
                        inline(item).font(.body).lineSpacing(3)
                    }
                }
            }
        case .quote(let text):
            HStack(alignment: .top, spacing: 12) {
                Capsule().fill(Palette.hairline).frame(width: 3)
                inline(text).font(.body).foregroundStyle(Palette.secondary).lineSpacing(3)
            }
        case .code(let language, let text):
            CodeBlock(language: language, text: text)
        }
    }

    private func inline(_ text: String) -> Text {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible
        )
        if let attributed = try? AttributedString(markdown: text, options: options) {
            return Text(attributed)
        }
        return Text(text)
    }
}

private struct CodeBlock: View {
    let language: String?
    let text: String

    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language ?? "Code")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Palette.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                    Haptic.tap()
                    withAnimation(Springs.snappy) { copied = true }
                    Task {
                        try? await Task.sleep(for: .seconds(1.6))
                        withAnimation(Springs.snappy) { copied = false }
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(Palette.secondary)
                        .contentTransition(.symbolEffect(.replace))
                        .frame(minHeight: 30)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableStyle(scale: 0.92))
            }
            .padding(.horizontal, 14)
            .padding(.top, 6)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(text)
                    .font(.system(size: 13.5, design: .monospaced))
                    .foregroundStyle(Palette.ink)
                    .textSelection(.enabled)
                    .padding(.horizontal, 14)
                    .padding(.top, 4)
                    .padding(.bottom, 14)
            }
        }
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}
