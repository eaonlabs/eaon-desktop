import SafariServices
import SwiftUI

/// The sheet GitHub's device flow needs: a code to type in at github.com,
/// while the app waits to be told it was approved.
struct GitHubCodeSheet: View {
    let code: GitHubDeviceCode
    var onCancel: () -> Void

    @State private var copied = false
    @State private var showsGitHub = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 0) {
            Image("GitHubMark")
                .resizable()
                .scaledToFit()
                .frame(width: 26, height: 26)
                .foregroundStyle(Palette.ink)
                .frame(width: 56, height: 56)
                .background(Palette.fill, in: Circle())
                .padding(.top, 30)
                .accessibilityHidden(true)

            Text("Enter this code on GitHub")
                .font(.title3.weight(.semibold))
                .foregroundStyle(Palette.ink)
                .padding(.top, 16)

            Text("Open GitHub, paste the code, then choose Authorize. Eaon only reads your name and picture.")
                .font(.subheadline)
                .foregroundStyle(Palette.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)
                .padding(.horizontal, 12)

            codeCells
                .padding(.top, 24)

            VStack(spacing: 10) {
                Button {
                    UIPasteboard.general.string = code.userCode
                    Haptic.success()
                    copied = true
                    showsGitHub = true
                } label: {
                    Label(copied ? "Code copied. Open GitHub" : "Copy code and open GitHub", systemImage: "arrow.up.forward.app")
                }
                .buttonStyle(PillButtonStyle(kind: .primary))

                Button("Cancel", action: onCancel)
                    .buttonStyle(PillButtonStyle(kind: .secondary))
            }
            .padding(.top, 26)

            status
                .padding(.top, 18)
                .padding(.bottom, 8)
        }
        .padding(.horizontal, Metrics.gutter)
        .frame(maxWidth: .infinity)
        .presentationBackground(Palette.background)
        .presentationDetents([.height(500)])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .sheet(isPresented: $showsGitHub) {
            SafariView(url: code.verificationURL)
                .ignoresSafeArea()
        }
    }

    /// "WDJB-MJHT" as eight cells and a dash.
    private var codeCells: some View {
        let parts = code.userCode.split(separator: "-", maxSplits: 1).map(String.init)
        return Button {
            UIPasteboard.general.string = code.userCode
            Haptic.tap()
            copied = true
        } label: {
            HStack(spacing: 10) {
                ForEach(Array(parts.enumerated()), id: \.offset) { index, part in
                    if index > 0 {
                        Capsule().fill(Palette.secondary.opacity(0.5)).frame(width: 10, height: 3)
                    }
                    HStack(spacing: 5) {
                        ForEach(Array(part.enumerated()), id: \.offset) { offset, character in
                            Text(String(character))
                                .font(.system(size: 26, weight: .semibold, design: .monospaced))
                                .foregroundStyle(Palette.ink)
                                .frame(width: 32, height: 52)
                                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .entrance(delay: 0.15 + Double(index * 4 + offset) * 0.04, rise: 12, animation: Springs.bouncy)
                        }
                    }
                }
            }
        }
        .buttonStyle(PressableStyle(scale: 0.98))
        .accessibilityLabel("Code \(code.userCode.map(String.init).joined(separator: " "))")
        .accessibilityHint("Copies the code")
    }

    private var status: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, Int(code.expiresAt.timeIntervalSince(context.date)))
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Waiting for GitHub · expires in \(left / 60):\(String(format: "%02d", left % 60))")
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(Palette.secondary)
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// GitHub's page, in the app.
struct SafariView: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        let controller = SFSafariViewController(url: url)
        controller.preferredControlTintColor = UIColor(Palette.ink)
        return controller
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
