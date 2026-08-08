import AppKit
import CoreText
import SwiftUI

/// One font family's weight → PostScript-name mapping. Kept per-family
/// rather than a shared suffix scheme (`-Medium`/`-SemiBold`/...) because
/// real font files disagree on this in practice — some abbreviate
/// (`-Medm`/`-SmBld`), Adobe capitalizes `SourceCodePro-Semibold` with a
/// lowercase "b", several ship only two static weights. Every name below
/// was confirmed empirically against the actual bundled file via fontTools
/// (`name.getDebugName(6)`), never guessed — a wrong guess here silently
/// falls back to the system font for that one call, so it's worth getting
/// right up front.
struct FontFace: Equatable {
    let regular: String
    let medium: String
    let semibold: String
    let bold: String

    func postScriptName(weight: Font.Weight) -> String {
        switch weight {
        case .bold, .heavy, .black: return bold
        case .semibold: return semibold
        case .medium: return medium
        default: return regular
        }
    }
}

enum FontFaces {
    // MARK: Sans / UI faces
    static let spaceGrotesk = FontFace(regular: "SpaceGrotesk-Regular", medium: "SpaceGrotesk-Medium", semibold: "SpaceGrotesk-Bold", bold: "SpaceGrotesk-Bold")
    static let ibmPlexSans = FontFace(regular: "IBMPlexSans", medium: "IBMPlexSans-Medm", semibold: "IBMPlexSans-SmBld", bold: "IBMPlexSans-Bold")
    static let inter = FontFace(regular: "Inter-Regular", medium: "Inter-Medium", semibold: "Inter-SemiBold", bold: "Inter-Bold")
    static let geistSans = FontFace(regular: "Geist-Regular", medium: "Geist-Medium", semibold: "Geist-SemiBold", bold: "Geist-Bold")
    static let poppins = FontFace(regular: "Poppins-Regular", medium: "Poppins-Medium", semibold: "Poppins-SemiBold", bold: "Poppins-Bold")
    static let montserrat = FontFace(regular: "Montserrat-Regular", medium: "Montserrat-Medium", semibold: "Montserrat-SemiBold", bold: "Montserrat-Bold")
    static let raleway = FontFace(regular: "Raleway-Regular", medium: "Raleway-Medium", semibold: "Raleway-SemiBold", bold: "Raleway-Bold")
    static let archivo = FontFace(regular: "Archivo-Regular", medium: "Archivo-Medium", semibold: "Archivo-SemiBold", bold: "Archivo-Bold")
    static let barlow = FontFace(regular: "Barlow-Regular", medium: "Barlow-Medium", semibold: "Barlow-SemiBold", bold: "Barlow-Bold")

    // MARK: Mono / code faces
    static let jetBrainsMono = FontFace(regular: "JetBrainsMono-Regular", medium: "JetBrainsMono-Medium", semibold: "JetBrainsMono-SemiBold", bold: "JetBrainsMono-Bold")
    static let ibmPlexMono = FontFace(regular: "IBMPlexMono-Regular", medium: "IBMPlexMono-Medium", semibold: "IBMPlexMono-SemiBold", bold: "IBMPlexMono-Bold")
    static let firaCode = FontFace(regular: "FiraCode-Regular", medium: "FiraCode-Medium", semibold: "FiraCode-SemiBold", bold: "FiraCode-Bold")
    static let geistMono = FontFace(regular: "GeistMono-Regular", medium: "GeistMono-Medium", semibold: "GeistMono-SemiBold", bold: "GeistMono-Bold")
    static let sourceCodePro = FontFace(regular: "SourceCodePro-Regular", medium: "SourceCodePro-Medium", semibold: "SourceCodePro-Semibold", bold: "SourceCodePro-Bold")
    static let inconsolata = FontFace(regular: "Inconsolata-Regular", medium: "Inconsolata-Medium", semibold: "Inconsolata-SemiBold", bold: "Inconsolata-Bold")
    // Ships only two static weights upstream — Medium/SemiBold reuse the
    // nearest real instance rather than a fabricated PostScript name.
    static let spaceMono = FontFace(regular: "SpaceMono-Regular", medium: "SpaceMono-Regular", semibold: "SpaceMono-Bold", bold: "SpaceMono-Bold")
}

/// Where a `FontOption`'s actual glyph data comes from.
enum FontSource: Equatable {
    /// The OS default (SF Pro for UI text, SF Mono-ish for code) — no
    /// custom lookup at all.
    case system
    /// One of the 15 fonts this app embeds and registers itself
    /// (`Resources/Fonts/*.ttf`) — guaranteed present on every install,
    /// regardless of what the user has on their Mac.
    case bundled(FontFace)
    /// Any font family already installed on this Mac — resolved live via
    /// Core Text rather than a hand-written table (see
    /// `SystemFontCatalog.postScriptName`), since there's no way to
    /// pre-verify PostScript names for fonts this app doesn't ship.
    case installed(family: String)
}

/// One selectable font — used for both prose UI text and code, a single
/// choice applies everywhere (see `FontPreferenceStore`). Not split into
/// separate sans/mono axes: picking a font is picking it for the whole app.
struct FontOption: Identifiable, Equatable {
    let id: String
    let displayName: String
    let source: FontSource

    static let system = FontOption(id: "system", displayName: "System", source: .system)

    /// Bundled with the app itself — always available, on every Mac, right
    /// after install. Kept first in the picker since these are guaranteed
    /// to render exactly as previewed; system fonts below depend on what's
    /// actually installed on this particular Mac.
    static let curated: [FontOption] = [
        .system,
        FontOption(id: "spaceGrotesk", displayName: "Space Grotesk", source: .bundled(FontFaces.spaceGrotesk)),
        FontOption(id: "ibmPlexSans", displayName: "IBM Plex Sans", source: .bundled(FontFaces.ibmPlexSans)),
        FontOption(id: "inter", displayName: "Inter", source: .bundled(FontFaces.inter)),
        FontOption(id: "geistSans", displayName: "Geist", source: .bundled(FontFaces.geistSans)),
        FontOption(id: "poppins", displayName: "Poppins", source: .bundled(FontFaces.poppins)),
        FontOption(id: "montserrat", displayName: "Montserrat", source: .bundled(FontFaces.montserrat)),
        FontOption(id: "raleway", displayName: "Raleway", source: .bundled(FontFaces.raleway)),
        FontOption(id: "archivo", displayName: "Archivo", source: .bundled(FontFaces.archivo)),
        FontOption(id: "barlow", displayName: "Barlow", source: .bundled(FontFaces.barlow)),
        FontOption(id: "jetBrainsMono", displayName: "JetBrains Mono", source: .bundled(FontFaces.jetBrainsMono)),
        FontOption(id: "ibmPlexMono", displayName: "IBM Plex Mono", source: .bundled(FontFaces.ibmPlexMono)),
        FontOption(id: "firaCode", displayName: "Fira Code", source: .bundled(FontFaces.firaCode)),
        FontOption(id: "geistMono", displayName: "Geist Mono", source: .bundled(FontFaces.geistMono)),
        FontOption(id: "sourceCodePro", displayName: "Source Code Pro", source: .bundled(FontFaces.sourceCodePro)),
        FontOption(id: "inconsolata", displayName: "Inconsolata", source: .bundled(FontFaces.inconsolata)),
        FontOption(id: "spaceMono", displayName: "Space Mono", source: .bundled(FontFaces.spaceMono)),
    ]

    /// Every other font family installed on this Mac — hundreds of options
    /// (Helvetica, Arial, Times New Roman, Futura, Menlo, Papyrus, and
    /// whatever else Font Book knows about) with zero bundling, so the
    /// list is exactly as "massive" as the Mac it's running on. Computed
    /// once — enumerating and sorting hundreds of families isn't free, and
    /// the set can't change while the app is already running.
    static let installed: [FontOption] = SystemFontCatalog.availableFamilies().map {
        FontOption(id: $0, displayName: $0, source: .installed(family: $0))
    }

    static let all: [FontOption] = curated + installed

    /// The real PostScript name to hand `Font.custom`/`NSFont(name:)` for a
    /// given weight — `nil` means "fall back to the system font." For
    /// `.bundled` this is a pre-verified table lookup; for `.installed`
    /// there's no such table, so it asks Core Text's own font-matching to
    /// resolve whichever real weight variant the family actually ships,
    /// the same way the OS itself would pick one.
    func postScriptName(weight: Font.Weight) -> String? {
        switch source {
        case .system:
            return nil
        case .bundled(let face):
            return face.postScriptName(weight: weight)
        case .installed(let family):
            return SystemFontCatalog.postScriptName(family: family, weight: weight)
        }
    }
}

/// Enumerates fonts already installed on this Mac (outside the 15 this app
/// bundles itself) via Core Text / AppKit's own font-matching — never a
/// hand-maintained list, since there's no way to know in advance what any
/// given Mac has installed.
enum SystemFontCatalog {
    /// Family names that render as symbols, emoji, or braille dots rather
    /// than legible text — excluded so a 150+-entry searchable list doesn't
    /// surface an option that makes the whole app unreadable if picked.
    /// World-script fonts (Arabic, Devanagari, CJK, etc.) are real,
    /// readable text and deliberately NOT filtered here.
    private static let excludedSubstrings = [
        "emoji", "braille", "webdings", "wingdings", "dingbats", "ornaments", "symbol",
    ]

    static func availableFamilies() -> [String] {
        NSFontManager.shared.availableFontFamilies
            .filter { !$0.hasPrefix(".") } // private system-UI faces Font Book itself hides
            .filter { family in
                let lower = family.lowercased()
                return !excludedSubstrings.contains { lower.contains($0) }
            }
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    /// Resolves the closest real weight variant a family actually ships —
    /// e.g. asking Arial for `.medium` correctly lands on `ArialMT`
    /// (Arial has no true medium), while Avenir Next's real `.medium`
    /// resolves distinctly. Uses Core Text's own weight-trait matching
    /// (`NSFontDescriptor.TraitKey.weight`) rather than assuming every
    /// family follows the `-Medium`/`-SemiBold` naming convention the
    /// bundled `FontFace` table hand-verifies for its own 15 fonts.
    static func postScriptName(family: String, weight: Font.Weight) -> String? {
        let ctWeight: CGFloat
        switch weight {
        case .black: ctWeight = 0.62
        case .heavy: ctWeight = 0.56
        case .bold: ctWeight = 0.4
        case .semibold: ctWeight = 0.3
        case .medium: ctWeight = 0.23
        case .light: ctWeight = -0.4
        case .thin: ctWeight = -0.6
        case .ultraLight: ctWeight = -0.8
        default: ctWeight = 0.0
        }
        let descriptor = NSFontDescriptor(fontAttributes: [
            .family: family,
            .traits: [NSFontDescriptor.TraitKey.weight: ctWeight],
        ])
        guard let font = NSFont(descriptor: descriptor, size: 12) else { return nil }
        return font.fontName
    }
}

/// Registers every bundled font file with Core Text so `Font.custom` can
/// find it by PostScript name — call once, at launch, before any UI
/// renders. Missing/malformed files are skipped individually rather than
/// failing the whole app; `AppFont` falls back to the system font per-style
/// if its specific PostScript name never registered.
enum AppFonts {
    private static let fileNames: [String] = [
        "SpaceGrotesk-Regular", "SpaceGrotesk-Medium", "SpaceGrotesk-Bold",
        "IBMPlexSans-Regular", "IBMPlexSans-Medium", "IBMPlexSans-SemiBold", "IBMPlexSans-Bold",
        "Inter-Regular", "Inter-Medium", "Inter-SemiBold", "Inter-Bold",
        "GeistSans-Regular", "GeistSans-Medium", "GeistSans-SemiBold", "GeistSans-Bold",
        "Poppins-Regular", "Poppins-Medium", "Poppins-SemiBold", "Poppins-Bold",
        "Montserrat-Regular", "Montserrat-Medium", "Montserrat-SemiBold", "Montserrat-Bold",
        "Raleway-Regular", "Raleway-Medium", "Raleway-SemiBold", "Raleway-Bold",
        "Archivo-Regular", "Archivo-Medium", "Archivo-SemiBold", "Archivo-Bold",
        "Barlow-Regular", "Barlow-Medium", "Barlow-SemiBold", "Barlow-Bold",
        "JetBrainsMono-Regular", "JetBrainsMono-Medium", "JetBrainsMono-SemiBold", "JetBrainsMono-Bold",
        "IBMPlexMono-Regular", "IBMPlexMono-Medium", "IBMPlexMono-SemiBold", "IBMPlexMono-Bold",
        "FiraCode-Regular", "FiraCode-Medium", "FiraCode-SemiBold", "FiraCode-Bold",
        "GeistMono-Regular", "GeistMono-Medium", "GeistMono-SemiBold", "GeistMono-Bold",
        "SourceCodePro-Regular", "SourceCodePro-Medium", "SourceCodePro-SemiBold", "SourceCodePro-Bold",
        "Inconsolata-Regular", "Inconsolata-Medium", "Inconsolata-SemiBold", "Inconsolata-Bold",
        "SpaceMono-Regular", "SpaceMono-Bold",
    ]

    private static let bundle: Bundle = {
        if let url = Bundle.main.url(forResource: "Eaon-desktop_Eaon-desktop", withExtension: "bundle"),
           let resourceBundle = Bundle(url: url) {
            return resourceBundle
        }
        return Bundle.module
    }()

    private(set) static var isRegistered = false

    static func registerIfNeeded() {
        guard !isRegistered else { return }
        isRegistered = true
        for fileName in fileNames {
            guard let url = bundle.url(forResource: fileName, withExtension: "ttf") else { continue }
            var error: Unmanaged<CFError>?
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error)
            // Already-registered is expected on a second launch path in the
            // same process (e.g. SwiftUI previews) — anything else is worth
            // knowing about during development.
            if let error, (error.takeUnretainedValue() as Error as NSError).code != CTFontManagerError.alreadyRegistered.rawValue {
                print("AppFonts: failed to register \(fileName): \(error.takeUnretainedValue())")
            }
        }
    }
}

/// Persists the user's chosen font (Settings → Appearance → Font) and
/// exposes it live — every `AppFont.mono`/`.sans` call reads straight from
/// here, so a change updates every screen already routed through `AppFont`
/// immediately, no restart. `@Observable` makes that automatic, exactly
/// like `AppearanceSettings.theme` does for light/dark. One
/// font, one axis — it's used for both prose and code (`AppFont.sans` and
/// `AppFont.mono` render the identical family); there's no separate
/// "code font" choice.
@MainActor
@Observable
final class FontPreferenceStore {
    static let shared = FontPreferenceStore()

    private static let fontKey = "app_font_id"
    /// Pre-unification builds stored independent sans/mono choices.
    private static let legacySansKey = "app_font_sans"
    private static let legacyMonoKey = "app_font_mono"
    /// Builds before that stored one combined "pairing" id.
    private static let legacyPairingKey = "app_font_pairing"

    var fontId: String {
        didSet { UserDefaults.standard.set(fontId, forKey: Self.fontKey) }
    }

    var font: FontOption {
        FontOption.all.first { $0.id == fontId } ?? FontOption.curated[1]
    }

    private init() {
        if let existing = UserDefaults.standard.string(forKey: Self.fontKey) {
            fontId = existing
            return
        }
        // Migrate from the independent-sans/mono era: the UI font was
        // always the visually-dominant one (chat text, headings, every
        // label), so it becomes the single unified choice — a user's
        // existing look carries over instead of silently reverting to a
        // default the first time they open the app post-update.
        if let legacySans = UserDefaults.standard.string(forKey: Self.legacySansKey) {
            fontId = legacySans
            UserDefaults.standard.removeObject(forKey: Self.legacySansKey)
            UserDefaults.standard.removeObject(forKey: Self.legacyMonoKey)
            UserDefaults.standard.set(fontId, forKey: Self.fontKey)
            return
        }
        // Migrate from the even-older single-pairing era.
        if let legacyPairing = UserDefaults.standard.string(forKey: Self.legacyPairingKey) {
            switch legacyPairing {
            case "system": fontId = "system"
            case "ibmPlex": fontId = "ibmPlexSans"
            case "inter": fontId = "inter"
            case "geist": fontId = "geistSans"
            default: fontId = "spaceGrotesk" // "grotesk" or anything unrecognized
            }
            UserDefaults.standard.removeObject(forKey: Self.legacyPairingKey)
            UserDefaults.standard.set(fontId, forKey: Self.fontKey)
            return
        }
        fontId = "spaceGrotesk"
    }
}

/// The font used across the app, resolved from whichever font is currently
/// selected in Settings. Falls back to the matching system style if a given
/// weight's file somehow isn't registered (or the option is System) — this
/// never renders a missing-font placeholder, worst case it silently reverts
/// to SF for that one call site. `.mono` and `.sans` render the identical
/// chosen family; they stay as two entry points only so every existing call
/// site keeps its point size and system-fallback design (monospaced vs
/// proportional) — not because they can diverge in which font they use.
@MainActor
enum AppFont {
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let option = FontPreferenceStore.shared.font
        guard let name = option.postScriptName(weight: weight) else {
            return .system(size: size, weight: weight, design: .monospaced)
        }
        if case .bundled = option.source { AppFonts.registerIfNeeded() }
        return .custom(name, size: size)
    }

    static func sans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        let option = FontPreferenceStore.shared.font
        guard let name = option.postScriptName(weight: weight) else {
            return .system(size: size, weight: weight)
        }
        if case .bundled = option.source { AppFonts.registerIfNeeded() }
        return .custom(name, size: size)
    }

    /// The same face, as a raw `NSFont` — for the one spot that isn't
    /// SwiftUI `Text` at all: the composer's `NSTextView`-based editor,
    /// which needs an actual `NSFont` for its `.font` property (and for
    /// measuring wrapped-text height with the same metrics it renders
    /// with). Falls back to the system font exactly like `sans(_:weight:)`.
    static func sansNSFont(_ size: CGFloat, weight: NSFont.Weight = .regular) -> NSFont {
        let fontWeight: Font.Weight = weight == .bold ? .bold : weight == .semibold ? .semibold : weight == .medium ? .medium : .regular
        let option = FontPreferenceStore.shared.font
        guard let name = option.postScriptName(weight: fontWeight) else {
            return NSFont.systemFont(ofSize: size, weight: weight)
        }
        if case .bundled = option.source { AppFonts.registerIfNeeded() }
        guard let font = NSFont(name: name, size: size) else {
            return NSFont.systemFont(ofSize: size, weight: weight)
        }
        return font
    }

    /// A font option's own name, rendered in itself — what the Settings
    /// picker uses so each option visibly demonstrates itself instead of
    /// listing plain, uniform text. `.system` still goes through the real
    /// system font rather than a hardcoded design, so it demonstrates
    /// itself too.
    static func previewFont(for option: FontOption, size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        guard let name = option.postScriptName(weight: weight) else {
            return .system(size: size, weight: weight)
        }
        if case .bundled = option.source { AppFonts.registerIfNeeded() }
        return .custom(name, size: size)
    }
}
