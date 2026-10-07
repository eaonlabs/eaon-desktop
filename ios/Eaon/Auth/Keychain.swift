import Foundation
import Security

/// A small generic-password store. Items are readable after the first unlock
/// and never leave this iPhone (no iCloud Keychain, no backups to a new one).
struct Keychain: Sendable {
    var service = "dev.eaon.ios"

    func read(_ key: String) -> Data? {
        var query = base(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    @discardableResult
    func write(_ data: Data, for key: String) -> Bool {
        let update = [kSecValueData as String: data] as CFDictionary
        let status = SecItemUpdate(base(key) as CFDictionary, update)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var add = base(key)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }

    func delete(_ key: String) {
        SecItemDelete(base(key) as CFDictionary)
    }

    /// Removes everything this app has put here.
    func deleteAll() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        SecItemDelete(query as CFDictionary)
    }

    func string(_ key: String) -> String? {
        read(key).flatMap { String(data: $0, encoding: .utf8) }
    }

    @discardableResult
    func setString(_ value: String?, for key: String) -> Bool {
        guard let value, !value.isEmpty else {
            delete(key)
            return true
        }
        return write(Data(value.utf8), for: key)
    }

    func value<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        read(key).flatMap { try? JSONDecoder().decode(type, from: $0) }
    }

    @discardableResult
    func setValue<T: Encodable>(_ value: T, for key: String) -> Bool {
        guard let data = try? JSONEncoder().encode(value) else { return false }
        return write(data, for: key)
    }

    private func base(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }
}
