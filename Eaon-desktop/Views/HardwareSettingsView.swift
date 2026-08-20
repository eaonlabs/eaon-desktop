import SwiftUI

/// Settings → Hardware — read-only live facts about this Mac (the same
/// numbers `ModelFitEstimator` already judges local models against), so
/// "why did it say this model might be tight?" has a page to check against.
struct HardwareSettingsView: View {
    @Environment(\.themeColors) private var colors

    @State private var cpuUsage: Double?
    @State private var availableMemory = SystemSpecs.availableMemory
    @State private var cpuSampler = CPULoadSampler()

    private let totalMemory = SystemSpecs.totalMemory

    private var memoryUsedFraction: Double {
        guard totalMemory > 0 else { return 0 }
        return Double(totalMemory - availableMemory) / Double(totalMemory)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Hardware")
                .font(AppFont.mono(20, weight: .bold))
                .foregroundColor(colors.textPrimary)
                .padding(.horizontal, 32)
                .padding(.top, 28)
                .padding(.bottom, 8)

            Text("Live facts about this Mac. These are the same numbers Eaon checks before saying whether a local model will actually fit.")
                .font(AppFont.sans(12))
                .foregroundColor(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .lineSpacing(3)
                .padding(.horizontal, 32)
                .padding(.bottom, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    operatingSystemCard
                    cpuCard
                    memoryCard
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 32)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(colors.backgroundPrimary)
        .task { await runLiveUpdates() }
    }

    private var operatingSystemCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader("Operating System")
                row("Name", "macOS")
                divider
                row("Version", SystemSpecs.osVersionString.replacingOccurrences(of: "macOS ", with: ""))
            }
        }
    }

    private var cpuCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader("CPU")
                row("Model", SystemSpecs.cpuModel)
                divider
                row("Architecture", SystemSpecs.architecture)
                divider
                row("Cores", "\(SystemSpecs.cpuCoreCount)")
                divider
                usageRow("Usage", fraction: cpuUsage.map { $0 / 100 }, percentText: cpuUsage.map(percentString))
            }
        }
    }

    private var memoryCard: some View {
        SettingsCard {
            VStack(alignment: .leading, spacing: 0) {
                sectionHeader("Memory")
                row("Total RAM", formatGB(totalMemory))
                divider
                row("Available RAM", formatGB(availableMemory))
                divider
                usageRow("Usage", fraction: memoryUsedFraction, percentText: percentString(memoryUsedFraction * 100))
            }
        }
    }

    // MARK: - Rows

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(AppFont.mono(12, weight: .semibold))
            .foregroundColor(colors.textTertiary)
            .tracking(0.5)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)
    }

    private var divider: some View {
        Divider().overlay(colors.borderSubtle)
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(AppFont.mono(14, weight: .medium))
                .foregroundColor(colors.textPrimary)
            Spacer()
            Text(value)
                .font(AppFont.mono(14))
                .foregroundColor(colors.textSecondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    /// `fraction`/`percentText` are optional together — CPU usage has no
    /// value yet on the very first tick (nothing to diff the sample
    /// against), so this shows a measuring state rather than a misleading 0%.
    private func usageRow(_ label: String, fraction: Double?, percentText: String?) -> some View {
        HStack {
            Text(label)
                .font(AppFont.mono(14, weight: .medium))
                .foregroundColor(colors.textPrimary)
            Spacer()
            if let fraction, let percentText {
                UsageBar(fraction: fraction)
                Text(percentText)
                    .font(AppFont.mono(14))
                    .foregroundColor(colors.textSecondary)
                    .frame(width: 56, alignment: .trailing)
            } else {
                Text("Measuring…")
                    .font(AppFont.mono(12))
                    .foregroundColor(colors.textTertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    // MARK: - Formatting

    private func formatGB(_ bytes: Int64) -> String {
        String(format: "%.2f GB", Double(bytes) / 1_000_000_000)
    }

    private func percentString(_ value: Double) -> String {
        String(format: "%.2f%%", value)
    }

    // MARK: - Live updates

    /// Cancelled automatically when the view disappears — `.task` ties the
    /// loop's lifetime to the view's, so there's nothing to invalidate by
    /// hand. CPU usage is a delta between two kernel tick counts, so the
    /// first sample always comes back nil; everything after that is real.
    private func runLiveUpdates() async {
        while !Task.isCancelled {
            let sample = cpuSampler.sample()
            let freshAvailable = SystemSpecs.availableMemory
            withAnimation(.uiEaseOut(duration: 0.25)) {
                if let sample { cpuUsage = sample }
                availableMemory = freshAvailable
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }
}

private struct UsageBar: View {
    @Environment(\.themeColors) private var colors
    let fraction: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(colors.borderMedium)
                Capsule()
                    .fill(AppearanceSettings.shared.accentColor)
                    .frame(width: geo.size.width * min(max(fraction, 0), 1))
            }
        }
        .frame(width: 90, height: 6)
    }
}
