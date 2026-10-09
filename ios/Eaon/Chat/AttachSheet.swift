import SwiftUI
import UIKit

/// What the "+" can do. The sheet only says which; the chat screen does it once the sheet is gone,
/// so a picker never has to be presented from on top of a sheet.
enum ComposerAction: Equatable {
    case camera
    case photos
    case files
    case model
    case temporary
    case agents
}

/// The sheet that rises from the "+": bring something in, or change what this chat is.
struct AttachSheet: View {
    var activeModelName: String?
    var isTemporary: Bool
    var photosLeft: Int
    var choose: (ComposerAction) -> Void

    private let cameraAvailable = UIImagePickerController.isSourceTypeAvailable(.camera)

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                tile("Camera", symbol: "camera", action: .camera, enabled: cameraAvailable && photosLeft > 0)
                    .entrance(delay: 0.04, rise: 16)
                tile("Photos", symbol: "photo.on.rectangle", action: .photos, enabled: photosLeft > 0)
                    .entrance(delay: 0.08, rise: 16)
                tile("Files", symbol: "paperclip", action: .files, enabled: true)
                    .entrance(delay: 0.12, rise: 16)
            }
            .padding(.top, 28)

            Rectangle().fill(Palette.hairline).frame(height: 0.5)
                .padding(.vertical, 16)

            VStack(spacing: 2) {
                row("Model", subtitle: activeModelName ?? "Choose where answers come from", symbol: "sparkles", action: .model)
                    .entrance(delay: 0.16, rise: 10)
                row(isTemporary ? "Leave temporary chat" : "Temporary chat",
                    subtitle: isTemporary ? "Back to chats that are kept" : "Not saved to your history",
                    symbol: nil, action: .temporary)
                    .entrance(delay: 0.2, rise: 10)
                row("Agents", subtitle: "Spin one up here, or run the ones on your Mac", symbol: IconTile.agentFace, action: .agents)
                    .entrance(delay: 0.24, rise: 10)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .presentationDetents([.height(436)])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(34)
        .presentationBackground(Palette.background)
        .accessibilityIdentifier("attach.sheet")
    }

    private func tile(_ title: String, symbol: String, action: ComposerAction, enabled: Bool) -> some View {
        Button {
            Haptic.select()
            choose(action)
        } label: {
            VStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 24, weight: .regular))
                Text(title)
                    .font(.subheadline.weight(.medium))
            }
            .foregroundStyle(Palette.ink)
            .frame(maxWidth: .infinity)
            .frame(height: 88)
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .opacity(enabled ? 1 : 0.35)
            .contentShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(PressableStyle(scale: 0.94))
        .disabled(!enabled)
        .accessibilityIdentifier("attach.\(title.lowercased())")
        .accessibilityHint(enabled ? "" : (action == .camera && !cameraAvailable ? "This device has no camera" : "Up to \(AttachmentLoader.maxImagesPerMessage) pictures in one message"))
    }

    private func row(_ title: String, subtitle: String, symbol: String?, action: ComposerAction) -> some View {
        Button {
            Haptic.select()
            choose(action)
        } label: {
            HStack(spacing: 16) {
                Group {
                    if let symbol {
                        IconTile(systemImage: symbol, size: 30)
                    } else {
                        TemporaryChatIcon(size: 21)
                    }
                }
                .frame(width: 30)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(Palette.ink)
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(Palette.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Palette.ink)
            .padding(.vertical, 10)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle(scale: 0.98))
        .accessibilityIdentifier("attach.\(title.lowercased().replacingOccurrences(of: " ", with: "-"))")
    }
}

/// A chat bubble drawn with a dashed line: a chat that isn't kept.
struct TemporaryChatIcon: View {
    var size: CGFloat = 22
    var filled = false

    var body: some View {
        RoundedRectangle(cornerRadius: size * 0.38, style: .continuous)
            .stroke(style: StrokeStyle(lineWidth: size * 0.09, lineCap: .round, dash: [size * 0.15, size * 0.2]))
            .background {
                if filled { RoundedRectangle(cornerRadius: size * 0.38, style: .continuous).fill(Palette.background.opacity(0.18)) }
            }
            .frame(width: size * 0.92, height: size * 0.92)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// The camera, for taking a picture to send.
struct CameraPicker: UIViewControllerRepresentable {
    var picked: (Data) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
                parent.picked(data)
            }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
