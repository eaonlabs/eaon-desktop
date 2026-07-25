import AppKit
import SwiftUI

/// What the agent is doing right now, shown as a small badge on the pet so a
/// glance across the desk tells you what it's up to without raising the
/// window. Deliberately a tiny closed vocabulary rather than free text: the
/// badge is 16pt, so it can carry an icon and nothing else.
enum EaonPetActivity: Equatable, Sendable {
    case shell      // running a command
    case searching  // web search
    case editing    // writing or editing a file
    case reading    // reading a file / listing a directory
    case thinking   // generating, no specific tool

    /// Maps a raw tool name from the agent loop onto a badge. Unknown tools
    /// fall back to `.thinking` rather than showing nothing, so a newly added
    /// tool never silently blanks the indicator.
    static func forTool(_ name: String) -> EaonPetActivity {
        switch name {
        case "run_shell", "run", "shell": return .shell
        case "web_search", "search": return .searching
        case "write_file", "edit_file", "edit", "write": return .editing
        case "read_file", "list_dir", "read", "ls", "grep", "find": return .reading
        default: return .thinking
        }
    }

    var systemImage: String {
        switch self {
        case .shell: return "wrench.and.screwdriver.fill"
        case .searching: return "magnifyingglass"
        case .editing: return "pencil"
        case .reading: return "doc.text.fill"
        case .thinking: return "ellipsis"
        }
    }

    /// Spoken in the right-click menu and the accessibility label.
    var label: String {
        switch self {
        case .shell: return "Running a command"
        case .searching: return "Searching the web"
        case .editing: return "Editing a file"
        case .reading: return "Reading files"
        case .thinking: return "Thinking"
        }
    }
}

/// A cosmetic colour scheme for the pet's body. Purely a palette swap — the
/// shape, faces and animations are identical — because the pet is drawn from
/// SwiftUI shapes rather than image assets, which makes recolouring free and
/// new "species" a much larger piece of art work.
struct EaonPetSkin: Identifiable, Equatable {
    let id: String
    let name: String
    let top: Color
    let mid: Color
    let bottom: Color
    /// The contact shadow under the body, tinted to match.
    let glow: Color

    static let coral = EaonPetSkin(
        id: "coral", name: "Coral",
        top: Color(hex: "#FFB088"), mid: Color(hex: "#F97A4D"), bottom: Color(hex: "#E85D2A"),
        glow: Color(red: 0.82, green: 0.33, blue: 0.17)
    )
    static let mint = EaonPetSkin(
        id: "mint", name: "Mint",
        top: Color(hex: "#8FF0D4"), mid: Color(hex: "#41D6AC"), bottom: Color(hex: "#1FB98E"),
        glow: Color(red: 0.12, green: 0.66, blue: 0.52)
    )
    static let blueberry = EaonPetSkin(
        id: "blueberry", name: "Blueberry",
        top: Color(hex: "#A5B8FF"), mid: Color(hex: "#6D82F0"), bottom: Color(hex: "#4A5FD4"),
        glow: Color(red: 0.29, green: 0.37, blue: 0.83)
    )
    static let grape = EaonPetSkin(
        id: "grape", name: "Grape",
        top: Color(hex: "#D6A8FF"), mid: Color(hex: "#A96DF0"), bottom: Color(hex: "#8544D4"),
        glow: Color(red: 0.52, green: 0.27, blue: 0.83)
    )
    static let lemon = EaonPetSkin(
        id: "lemon", name: "Lemon",
        top: Color(hex: "#FFE28A"), mid: Color(hex: "#F5C43D"), bottom: Color(hex: "#DDA412"),
        glow: Color(red: 0.78, green: 0.64, blue: 0.07)
    )
    static let slate = EaonPetSkin(
        id: "slate", name: "Slate",
        top: Color(hex: "#C2CBD6"), mid: Color(hex: "#8A97A8"), bottom: Color(hex: "#66707E"),
        glow: Color(red: 0.36, green: 0.40, blue: 0.45)
    )

    static let all: [EaonPetSkin] = [coral, mint, blueberry, grape, lemon, slate]
}

/// Persists the chosen skin and the pet's sound switch. Same UserDefaults
/// shape as every other lightweight store in the app.
@MainActor
@Observable
final class EaonPetAppearanceStore {
    static let shared = EaonPetAppearanceStore()

    private static let skinKey = "eaon_pet_skin"
    private static let soundKey = "eaon_pet_sounds_enabled"

    var skinId: String { didSet { UserDefaults.standard.set(skinId, forKey: Self.skinKey) } }
    /// Off by default: a companion that starts making noise without being
    /// asked is the fastest way to get itself turned off entirely.
    var soundsEnabled: Bool { didSet { UserDefaults.standard.set(soundsEnabled, forKey: Self.soundKey) } }

    var skin: EaonPetSkin {
        EaonPetSkin.all.first { $0.id == skinId } ?? .coral
    }

    private init() {
        skinId = UserDefaults.standard.string(forKey: Self.skinKey) ?? EaonPetSkin.coral.id
        soundsEnabled = UserDefaults.standard.object(forKey: Self.soundKey) as? Bool ?? false
    }
}

/// The pet's small sound palette, played from macOS's own system sounds so
/// nothing has to ship (or be licensed) with the app. Silent unless the user
/// has explicitly switched sounds on.
@MainActor
enum EaonPetSound {
    case happy
    case sad
    case alert
    case pop

    private var systemName: String {
        switch self {
        case .happy: return "Tink"
        case .sad: return "Basso"
        case .alert: return "Glass"
        case .pop: return "Pop"
        }
    }

    func play() {
        guard EaonPetAppearanceStore.shared.soundsEnabled else { return }
        NSSound(named: systemName)?.play()
    }
}
