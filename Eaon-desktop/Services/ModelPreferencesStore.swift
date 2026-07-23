import Foundation

/// An actual model *provider* — an account/connection that can be switched
/// off — as distinct from a model *company* like "Anthropic", which is just
/// a label for browsing. Aqua serves many companies through one connection;
/// a BYOK config is its own separate connection, even when it happens to
/// serve a company Aqua also serves. There is no per-company toggle: turning
/// off Aqua turns off every company it serves, not just one of them, and a
/// BYOK connection's toggle only ever affects that connection's own models.
enum ModelProviderKey: Hashable {
    case aqua
    /// The Free Trial — a genuinely separate connection from `.aqua`, not a
    /// fallback nested inside it: it has its own toggle state, its own
    /// provider-group row in the picker, and keeps working even when
    /// `.aqua` has a saved key of its own.
    case trial
    case custom(UUID)

    fileprivate var storageKey: String {
        switch self {
        case .aqua: return "aqua"
        case .trial: return "trial"
        case .custom(let id): return "custom:\(id.uuidString)"
        }
    }
}

@Observable
final class ModelPreferencesStore {
    static let shared = ModelPreferencesStore()

    private let nicknamesKey = "model_custom_nicknames"
    private let hiddenKey    = "model_hidden_ids"
    private let favoritesKey = "model_favorites"
    private let disabledProvidersKey = "model_disabled_providers"
    private let collapsedProviderGroupsKey = "model_picker_collapsed_providers"

    private(set) var nicknames:      [String: String] = [:]
    private(set) var hiddenModelIDs: Set<String>       = []
    private(set) var favoriteIDs:    Set<String>        = []
    /// Whole providers (connections — Aqua, or a specific BYOK config) the
    /// user has switched off — coarser than per-model hiding: every model
    /// from a disabled provider is excluded from chat, regardless of its own
    /// hidden state. Keyed by `ModelProviderKey.storageKey`, never by model
    /// company/brand — a company isn't itself a switchable provider.
    private(set) var disabledProviderIDs: Set<String> = []
    /// Which providers' model lists are collapsed in the model picker —
    /// purely a browsing preference (nothing here affects what's actually
    /// selectable), persisted so a connection you've tidied away stays
    /// collapsed the next time you open the picker, not just for the
    /// current session.
    private(set) var collapsedProviderGroupIDs: Set<String> = []

    private init() {
        load()
    }

    // MARK: - Nicknames

    func nickname(for modelId: String) -> String? {
        nicknames[modelId]?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    func setNickname(_ nickname: String?, for modelId: String) {
        let trimmed = nickname?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            nicknames.removeValue(forKey: modelId)
        } else {
            nicknames[modelId] = trimmed
        }
        persistNicknames()
    }

    // MARK: - Hidden

    func hideModel(_ modelId: String) {
        hiddenModelIDs.insert(modelId)
        favoriteIDs.remove(modelId)
        persistHidden()
        persistFavorites()
    }

    func restoreModel(_ modelId: String) {
        hiddenModelIDs.remove(modelId)
        persistHidden()
    }

    func isHidden(_ modelId: String) -> Bool {
        hiddenModelIDs.contains(modelId)
    }

    var hiddenModelsSorted: [String] {
        hiddenModelIDs.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    // MARK: - Favorites

    func toggleFavorite(_ modelId: String) {
        if favoriteIDs.contains(modelId) {
            favoriteIDs.remove(modelId)
        } else {
            favoriteIDs.insert(modelId)
        }
        persistFavorites()
    }

    func isFavorite(_ modelId: String) -> Bool {
        favoriteIDs.contains(modelId)
    }

    var favoritesSorted: [String] {
        favoriteIDs.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    // MARK: - Providers

    func isProviderDisabled(_ key: ModelProviderKey) -> Bool {
        disabledProviderIDs.contains(key.storageKey)
    }

    func setProviderDisabled(_ key: ModelProviderKey, disabled: Bool) {
        if disabled {
            disabledProviderIDs.insert(key.storageKey)
        } else {
            disabledProviderIDs.remove(key.storageKey)
        }
        persistDisabledProviders()
    }

    // MARK: - Model picker collapse state

    func isProviderGroupCollapsed(_ key: ModelProviderKey) -> Bool {
        collapsedProviderGroupIDs.contains(key.storageKey)
    }

    func toggleProviderGroupCollapsed(_ key: ModelProviderKey) {
        if collapsedProviderGroupIDs.contains(key.storageKey) {
            collapsedProviderGroupIDs.remove(key.storageKey)
        } else {
            collapsedProviderGroupIDs.insert(key.storageKey)
        }
        persistCollapsedProviderGroups()
    }

    // MARK: - Persistence

    private func load() {
        if let data = UserDefaults.standard.data(forKey: nicknamesKey),
           let decoded = try? JSONDecoder().decode([String: String].self, from: data) {
            nicknames = decoded
        }
        if let ids = UserDefaults.standard.array(forKey: hiddenKey) as? [String] {
            hiddenModelIDs = Set(ids)
        }
        if let ids = UserDefaults.standard.array(forKey: favoritesKey) as? [String] {
            favoriteIDs = Set(ids)
        }
        if let ids = UserDefaults.standard.array(forKey: disabledProvidersKey) as? [String] {
            disabledProviderIDs = Set(ids)
        }
        if let ids = UserDefaults.standard.array(forKey: collapsedProviderGroupsKey) as? [String] {
            collapsedProviderGroupIDs = Set(ids)
        }
    }

    private func persistNicknames() {
        if let data = try? JSONEncoder().encode(nicknames) {
            UserDefaults.standard.set(data, forKey: nicknamesKey)
        } else {
            UserDefaults.standard.removeObject(forKey: nicknamesKey)
        }
    }

    private func persistHidden() {
        UserDefaults.standard.set(Array(hiddenModelIDs), forKey: hiddenKey)
    }

    private func persistFavorites() {
        UserDefaults.standard.set(Array(favoriteIDs), forKey: favoritesKey)
    }

    private func persistDisabledProviders() {
        UserDefaults.standard.set(Array(disabledProviderIDs), forKey: disabledProvidersKey)
    }

    private func persistCollapsedProviderGroups() {
        UserDefaults.standard.set(Array(collapsedProviderGroupIDs), forKey: collapsedProviderGroupsKey)
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
