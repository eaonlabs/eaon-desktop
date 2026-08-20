import SwiftUI

/// A searchable, scrollable font list — one choice applies everywhere
/// (`AppFont.sans` and `AppFont.mono` both render it), so there's a single
/// picker rather than separate UI/code controls. Each row renders the
/// font's own name in itself, so picking one shows exactly what it looks
/// like before committing, not a plain-text label. Split into two sections:
/// fonts this app bundles itself (always available, exactly as previewed)
/// and every other font already installed on this Mac (however many that
/// happens to be — Font Book's own count).
struct FontOptionPicker: View {
    @Environment(\.themeColors) private var colors
    @Binding var selectedId: String
    let accentColor: Color

    @State private var query = ""

    private var filteredCurated: [FontOption] {
        filter(FontOption.curated)
    }

    private var filteredInstalled: [FontOption] {
        filter(FontOption.installed)
    }

    private func filter(_ catalog: [FontOption]) -> [FontOption] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return catalog }
        return catalog.filter { $0.displayName.localizedCaseInsensitiveContains(trimmed) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            searchField

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    if filteredCurated.isEmpty, filteredInstalled.isEmpty {
                        Text("No fonts match \"\(query)\".")
                            .font(AppFont.sans(12))
                            .foregroundColor(colors.textTertiary)
                            .padding(.vertical, 12)
                            .frame(maxWidth: .infinity)
                    } else {
                        if !filteredCurated.isEmpty {
                            sectionHeader("Featured")
                            ForEach(filteredCurated) { option in
                                row(option)
                            }
                        }
                        if !filteredInstalled.isEmpty {
                            sectionHeader("On this Mac (\(FontOption.installed.count))")
                            ForEach(filteredInstalled) { option in
                                row(option)
                            }
                        }
                    }
                }
                .padding(4)
            }
            .frame(height: 360)
            .background(colors.backgroundInput)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(colors.borderSubtle, lineWidth: 1)
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(colors.textTertiary)
            TextField("Search \(FontOption.all.count) fonts…", text: $query)
                .textFieldStyle(.plain)
                .font(AppFont.sans(12))
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(colors.textTertiary)
                        .iconHoverEffect(for: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(colors.backgroundInputSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(colors.borderSubtle, lineWidth: 1)
        )
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(AppFont.mono(12, weight: .semibold))
            .tracking(0.6)
            .foregroundColor(colors.textTertiary)
            .padding(.horizontal, 8)
            .padding(.top, 8)
            .padding(.bottom, 2)
    }

    private func row(_ option: FontOption) -> some View {
        let isSelected = selectedId == option.id
        return Button {
            selectedId = option.id
        } label: {
            HStack(spacing: 8) {
                // The name, in its OWN font — the whole point: you see
                // exactly what picking this option looks like before you
                // commit to it, not just a plain-text label.
                Text(option.displayName)
                    .font(AppFont.previewFont(for: option, size: 14, weight: .medium))
                    .foregroundColor(colors.textPrimary)
                    .lineLimit(1)

                Spacer(minLength: 4)

                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(accentColor)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(isSelected ? accentColor.opacity(0.12) : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
