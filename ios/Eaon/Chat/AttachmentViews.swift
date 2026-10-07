import SwiftUI

/// The pictures and files sent with one of your messages, above its bubble.
struct AttachmentGallery: View {
    let attachments: [MessageAttachment]

    private var pictures: [MessageAttachment] { attachments.filter { $0.kind == .image } }
    private var files: [MessageAttachment] { attachments.filter { $0.kind == .text } }

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if !pictures.isEmpty {
                let side: CGFloat = pictures.count == 1 ? 210 : 128
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(side), spacing: 8), count: pictures.count == 1 ? 1 : 2), alignment: .trailing, spacing: 8) {
                    ForEach(pictures) { picture in
                        StoredPicture(attachment: picture)
                            .frame(width: side, height: side)
                            .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(Palette.hairline, lineWidth: 0.5))
                    }
                }
                .fixedSize()
            }
            ForEach(files) { file in
                HStack(spacing: 9) {
                    Image(systemName: "doc.text")
                        .foregroundStyle(Palette.secondary)
                    Text(file.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                }
                .padding(.horizontal, 14)
                .frame(height: 44)
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .frame(maxWidth: 260, alignment: .trailing)
            }
        }
    }
}

/// A picture that was sent, read from its file when it comes on screen.
private struct StoredPicture: View {
    let attachment: MessageAttachment
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Palette.fill
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Image(systemName: "photo")
                    .foregroundStyle(Palette.secondary)
            }
        }
        .task(id: attachment.id) {
            guard let file = attachment.file, let data = AttachmentStore.data(for: file) else { return }
            image = await UIImage(data: data)?.byPreparingThumbnail(ofSize: CGSize(width: 480, height: 480))
        }
        .accessibilityLabel("Picture")
    }
}
