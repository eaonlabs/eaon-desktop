import SwiftUI

/// A read-only reference of the app's keyboard shortcuts, split out into its
/// own settings page rather than bundled into General.
struct ShortcutsSettingsView: View {
    @Environment(\.themeColors) private var colors

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Keyboard Shortcuts")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    shortcutsCard(title: "Application", rows: [
                        ("New chat", "⌘N"),
                        ("Search chats", "⌘K"),
                        ("Toggle sidebar", "⌘\\"),
                    ])
                    shortcutsCard(title: "Chat", rows: [
                        ("Send message", "⏎"),
                        ("New line", "⇧⏎"),
                    ])
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
    }

    private func shortcutsCard(title: String, rows: [(String, String)]) -> some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(AppFont.mono(14, weight: .semibold))
                    .foregroundColor(colors.textPrimary)
                    .padding(.horizontal, 18)
                    .padding(.top, 16)
                    .padding(.bottom, 10)

                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    if index > 0 {
                        Divider().overlay(colors.borderSubtle).padding(.horizontal, 18)
                    }
                    shortcutRow(row.0, keys: row.1, isLast: index == rows.count - 1)
                }
            }
        }
    }

    private func shortcutRow(_ title: String, keys: String, isLast: Bool) -> some View {
        HStack {
            Text(title)
                .font(AppFont.mono(14))
                .foregroundColor(colors.textPrimary)
            Spacer()
            Text(keys)
                .font(AppFont.mono(12, weight: .medium))
                .foregroundColor(colors.textSecondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(colors.backgroundSubtle)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .padding(.bottom, isLast ? 6 : 0)
    }
}
