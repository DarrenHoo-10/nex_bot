import Foundation
import Security

/// The persisted login record. The password is never stored.
public struct StoredCredential: Codable, Sendable, Equatable {
    public var origin: String
    public var name: String
    public var token: String
    public var coreId: String
    public var sessionId: String
    /// Epoch milliseconds.
    public var expiresAt: Double
    public init(origin: String, name: String, token: String, coreId: String, sessionId: String, expiresAt: Double) {
        self.origin = origin; self.name = name; self.token = token; self.coreId = coreId; self.sessionId = sessionId; self.expiresAt = expiresAt
    }
}

/// Storage for one login record (one profile).
public protocol CredentialStore: Sendable {
    func load() throws -> StoredCredential?
    func save(_ credential: StoredCredential) throws
    func delete() throws
}

public struct KeychainError: Error, LocalizedError, Sendable {
    public let status: OSStatus
    public var errorDescription: String? { "钥匙串错误 (\(status))" }
}

/// Keychain generic password: service `com.nexbot.client`, account = profile or `default`.
/// Uses the legacy login keychain on macOS, so unsigned builds work without entitlements.
public struct KeychainCredentialStore: CredentialStore {
    public static let service = "com.nexbot.client"
    public let account: String

    public init(profile: String? = nil) { account = (profile?.isEmpty ?? true) ? "default" : profile! }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: Self.service, kSecAttrAccount as String: account]
    }

    public func load() throws -> StoredCredential? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return try? JSONDecoder().decode(StoredCredential.self, from: data)
    }

    public func save(_ credential: StoredCredential) throws {
        let data = try JSONEncoder().encode(credential)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw KeychainError(status: update) }
        var add = query; add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

/// Volatile store for tests and previews.
public final class InMemoryCredentialStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: StoredCredential?
    public init(_ value: StoredCredential? = nil) { self.value = value }
    public func load() throws -> StoredCredential? { lock.withLock { value } }
    public func save(_ credential: StoredCredential) throws { lock.withLock { value = credential } }
    public func delete() throws { lock.withLock { value = nil } }
}
