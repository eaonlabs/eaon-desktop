import AppKit
import SwiftUI

struct CodeBlockView: View {
    @Environment(\.themeColors) private var colors
    let language: String?
    let code: String
    var showTypingCursor: Bool = false

    @State private var copied = false

    private var displayLanguage: String {
        guard let language, !language.isEmpty else { return "code" }
        return language
    }

    private var detectedLanguage: SyntaxLanguage {
        SyntaxLanguage.detect(tag: language)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header

            ScrollView(.vertical, showsIndicators: true) {
                ScrollView(.horizontal, showsIndicators: false) {
                    codeText
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(maxHeight: 420)
            .background(colors.backgroundCode)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(displayLanguage)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundStyle(colors.textSecondary)

            Spacer()

            Button(action: copyCode) {
                HStack(spacing: 4) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .iconHoverEffect(for: copied ? "checkmark" : "doc.on.doc")
                    Text(copied ? "Copied" : "Copy")
                }
                .font(AppFont.mono(12, weight: .medium))
                .foregroundStyle(copied ? Color.green : colors.textPrimary.opacity(0.75))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(colors.backgroundCodeHeader)
    }

    @ViewBuilder
    private var codeText: some View {
        // Memoized: highlighting re-ran on every body evaluation (every
        // hover elsewhere in the row, every typewriter tick, every
        // LazyVStack scroll-in) — a finished block's re-render is now a
        // cache lookup. Still-streaming code (cursor showing) computes
        // fresh each tick and skips storing, since its key changes every
        // time anyway.
        let highlighted = RenderCache.shared.value("hl|\(displayLanguage)|\(colors == .dark)|\(code)", store: !showTypingCursor) {
            SyntaxHighlighter.highlight(code, language: detectedLanguage, colors: colors)
        }
        if showTypingCursor {
            TimelineView(.periodic(from: .now, by: 0.5)) { context in
                let cursorVisible = Int(context.date.timeIntervalSince1970 * 2) % 2 == 0
                (Text(highlighted)
                    + Text("▎").foregroundColor(colors.textPrimary.opacity(cursorVisible ? 0.95 : 0.2)))
                    .font(AppFont.mono(14))
                    .textSelection(.enabled)
            }
        } else {
            Text(highlighted)
                .font(AppFont.mono(14))
                .textSelection(.enabled)
        }
    }

    private func copyCode() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(code, forType: .string)

        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            copied = false
        }
    }
}
