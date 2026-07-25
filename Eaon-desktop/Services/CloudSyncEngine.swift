import CryptoKit
import Foundation
import Observation

/// Pushes local data to the cloud, tracks how far along that is, and erases
/// it again on request.
///
/// Everything here goes through `CloudSyncCrypto` on the way out, so what
/// leaves this Mac is ciphertext plus an opaque id and a timestamp. The
/// engine's other job is honesty about progress: "syncing" with no numbers
/// is indistinguishable from "hung", and for a feature whose whole premise
/// is that the user stays in control of their data, a silent spinner is the
/// wrong answer. `uploaded`/`total` are real counts of real items.
@MainActor
@Observable
final class CloudSyncEngine {
    static let shared = CloudSyncEngine()

    enum Phase: Equatable {
        case idle
        case syncing
        case deleting
        case failed(String)

        var isBusy: Bool { self == .syncing || self == .deleting }
    }

    private(set) var phase: Phase = .idle
    /// Items pushed so far in the current run, and how many that run set out
    /// to push. Both zero when idle.
    private(set) var uploaded = 0
    private(set) var total = 0
    private(set) var lastSyncedAt: Date?

    /// 0…1 for the progress bar. Guards the empty case rather than producing
    /// a NaN width, which SwiftUI renders as a blank bar that looks broken.
    var progress: Double {
        guard total > 0 else { return 0 }
        return min(1, Double(uploaded) / Double(total))
    }

    /// Per-conversation record of what's already up there, so a re-sync only
    /// uploads what actually changed. Keyed by conversation id, valued by
    /// the `updatedAt` that was uploaded — a conversation whose local
    /// `updatedAt` is newer is stale in the cloud and needs pushing again.
    private var syncedRevisions: [String: Date] = [:]
    private static let revisionsKey = "cloud_sync_revisions_v1"
    private static let lastSyncKey = "cloud_sync_last_synced_v1"

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.revisionsKey),
           let stored = try? JSONDecoder().decode([String: Date].self, from: data) {
            syncedRevisions = stored
        }
        lastSyncedAt = UserDefaults.standard.object(forKey: Self.lastSyncKey) as? Date
    }

    // MARK: - Status the UI reads

    /// How many conversations are not yet in the cloud, or are there in an
    /// older version than what's on disk. This is what the "N chats waiting
    /// to sync" line and the progress bar's denominator come from.
    func pendingCount(in conversations: [Conversation]) -> Int {
        conversations.filter { isPending($0) }.count
    }

    private func isPending(_ conversation: Conversation) -> Bool {
        guard let synced = syncedRevisions[conversation.id.uuidString] else { return true }
        // Second granularity: `updatedAt` survives a JSON round-trip as a
        // Double, and comparing for exact equality across that boundary
        // would mark everything permanently stale.
        return conversation.updatedAt.timeIntervalSince(synced) > 1
    }

    var hasCloudData: Bool { !syncedRevisions.isEmpty }

    // MARK: - Push

    /// Uploads every conversation that's new or changed, plus the memory
    /// store, encrypting each one first. Safe to call repeatedly — already
    /// current items are skipped, which is what keeps a re-sync cheap.
    func sync(conversations: [Conversation], masterKey: SymmetricKey) async {
        guard CloudSyncStore.shared.isEnabled, EaonCloudAccount.shared.isSignedIn else { return }
        guard !phase.isBusy else { return }

        let pending = conversations.filter { isPending($0) }
        uploaded = 0
        total = pending.count + 1  // +1 for the memory blob
        phase = .syncing

        do {
            for conversation in pending {
                try await push(conversation: conversation, masterKey: masterKey)
                syncedRevisions[conversation.id.uuidString] = conversation.updatedAt
                uploaded += 1
                persistRevisions()
            }
            try await pushMemories(masterKey: masterKey)
            uploaded += 1

            lastSyncedAt = Date()
            UserDefaults.standard.set(lastSyncedAt, forKey: Self.lastSyncKey)
            phase = .idle
        } catch {
            // The counter is left where it stopped on purpose — "7 of 20"
            // alongside the error says far more about what happened than a
            // bare failure message with the bar reset to zero.
            phase = .failed(error.localizedDescription)
        }
    }

    private func push(conversation: Conversation, masterKey: SymmetricKey) async throws {
        let payload = try JSONEncoder().encode(conversation)
        let blob = try CloudSyncCrypto.encrypt(payload, with: masterKey)
        try await upsert(itemId: conversation.id.uuidString, kind: "conversation", blob: blob, updatedAt: conversation.updatedAt)
    }

    private func pushMemories(masterKey: SymmetricKey) async throws {
        let memories = MemoryStore.shared.memories
        let payload = try JSONEncoder().encode(memories)
        let blob = try CloudSyncCrypto.encrypt(payload, with: masterKey)
        try await upsert(itemId: "memories", kind: "memories", blob: blob, updatedAt: Date())
    }

    /// Appwrite has no upsert, and a blind create on an existing row 409s.
    /// Update-then-create-on-404 costs one extra round trip only the first
    /// time an item is ever pushed, which is the rarer case in a re-sync.
    private func upsert(itemId: String, kind: String, blob: String, updatedAt: Date) async throws {
        guard let userId = EaonCloudAccount.shared.session?.userId else {
            throw EaonCloudAccount.AccountError.notSignedIn
        }
        let rowId = rowIdentifier(userId: userId, itemId: itemId)
        let fields: [String: Any] = [
            "userId": userId,
            "kind": kind,
            "itemId": itemId,
            "blob": blob,
            "deleted": false,
            "updatedAt": ISO8601DateFormatter().string(from: updatedAt),
        ]
        let account = EaonCloudAccount.shared
        let path = EaonCloudAccount.rowsPath(EaonCloudAccount.itemsTable, rowId: rowId)

        do {
            let body = try JSONSerialization.data(withJSONObject: ["data": fields])
            _ = try await account.send(try account.authorizedRequest(path: path, method: "PATCH", body: body))
        } catch EaonCloudAccount.AccountError.requestFailed(let status, _) where status == 404 {
            var payload = fields
            payload["$permissions"] = ["read(\"user:\(userId)\")", "update(\"user:\(userId)\")", "delete(\"user:\(userId)\")"]
            let body = try JSONSerialization.data(withJSONObject: ["rowId": rowId, "data": fields,
                                                                  "permissions": payload["$permissions"] as Any])
            _ = try await account.send(try account.authorizedRequest(
                path: EaonCloudAccount.rowsPath(EaonCloudAccount.itemsTable),
                method: "POST", body: body))
        }
    }

    /// Row ids must be stable (so the same chat maps to the same row every
    /// time) and unique per user. A hash of both keeps it inside Appwrite's
    /// 36-character id limit, which a raw "userId-uuid" concatenation would
    /// blow straight past.
    private func rowIdentifier(userId: String, itemId: String) -> String {
        let digest = SHA256.hash(data: Data("\(userId)|\(itemId)".utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(32))
    }

    // MARK: - Delete

    /// Removes one conversation from the cloud. Called when a chat is
    /// deleted locally, so "delete" means the same thing everywhere instead
    /// of leaving an orphan copy on the server that reappears on the next
    /// device — which would be the single most alarming way for this feature
    /// to be wrong.
    func deleteFromCloud(conversationId: UUID) async {
        guard EaonCloudAccount.shared.isSignedIn,
              let userId = EaonCloudAccount.shared.session?.userId else { return }
        let key = conversationId.uuidString
        // Never synced in the first place — nothing up there to remove.
        guard syncedRevisions[key] != nil else { return }

        let account = EaonCloudAccount.shared
        let rowId = rowIdentifier(userId: userId, itemId: key)
        do {
            _ = try await account.send(try account.authorizedRequest(
                path: EaonCloudAccount.rowsPath(EaonCloudAccount.itemsTable, rowId: rowId),
                method: "DELETE"))
            syncedRevisions.removeValue(forKey: key)
            persistRevisions()
        } catch EaonCloudAccount.AccountError.requestFailed(let status, _) where status == 404 {
            // Already gone — forget it locally too rather than retrying a
            // delete forever against a row that doesn't exist.
            syncedRevisions.removeValue(forKey: key)
            persistRevisions()
        } catch {
            phase = .failed("Couldn't remove that chat from the cloud: \(error.localizedDescription)")
        }
    }

    /// Erases everything this account has in the cloud. Local chats are
    /// untouched — this is "take my data off your servers", not "delete my
    /// chats", and conflating those two would be unforgivable.
    func deleteAllCloudData() async {
        guard EaonCloudAccount.shared.isSignedIn,
              let userId = EaonCloudAccount.shared.session?.userId else { return }
        guard !phase.isBusy else { return }
        phase = .deleting
        uploaded = 0
        total = 0

        let account = EaonCloudAccount.shared
        do {
            let listPath = EaonCloudAccount.rowsPath(EaonCloudAccount.itemsTable)
                + "?queries[]=" + EaonCloudAccount.encodedQuery(method: "limit", values: [100])
            var remaining = true
            while remaining {
                let data = try await account.send(try account.authorizedRequest(path: listPath))
                let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                let rows = (json?["rows"] as? [[String: Any]]) ?? []
                if rows.isEmpty { remaining = false; break }
                total = max(total, rows.count)
                for row in rows {
                    guard let rowId = row["$id"] as? String else { continue }
                    _ = try? await account.send(try account.authorizedRequest(
                        path: EaonCloudAccount.rowsPath(EaonCloudAccount.itemsTable, rowId: rowId),
                        method: "DELETE"))
                    uploaded += 1
                }
                // Fewer than a full page means that was the last page.
                remaining = rows.count == 100
            }
            _ = userId
            syncedRevisions.removeAll()
            persistRevisions()
            lastSyncedAt = nil
            UserDefaults.standard.removeObject(forKey: Self.lastSyncKey)
            phase = .idle
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// The synchronous entry point `deleteConversation` calls. Kept separate
    /// from the async `deleteFromCloud` so the local delete never waits on a
    /// network round trip — the chat vanishes from the UI immediately and
    /// the cloud copy is chased down behind it.
    nonisolated func forgetLocallyDeletedConversation(_ id: UUID) {
        Task { @MainActor in await deleteFromCloud(conversationId: id) }
    }

    /// Forgets what this device thinks it has uploaded, without touching the
    /// server — used when sync is switched off, so switching it back on does
    /// a full, honest re-upload rather than trusting a stale ledger.
    func resetLocalLedger() {
        syncedRevisions.removeAll()
        persistRevisions()
        lastSyncedAt = nil
        uploaded = 0
        total = 0
        phase = .idle
        UserDefaults.standard.removeObject(forKey: Self.lastSyncKey)
    }

    private func persistRevisions() {
        guard let data = try? JSONEncoder().encode(syncedRevisions) else { return }
        UserDefaults.standard.set(data, forKey: Self.revisionsKey)
    }
}
