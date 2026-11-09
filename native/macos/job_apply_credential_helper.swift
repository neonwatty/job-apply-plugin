import Foundation
import Security
import CryptoKit

enum ProtectedCredentialError: Error {
    case invalidBinding
    case keychain(OSStatus)
    case secureInput
}

struct ProtectedCredentialReceipt: Equatable {
    let credentialReference: String
    let credentialVersion: Int
    let reused: Bool
    let filled: Bool
}

protocol NativeSecureInputBoundary {
    // Implementations write directly into the native secure control and clear it.
    // They must not serialize, log, inspect, or return these bytes.
    func fillAndClear(_ generatedBytes: UnsafeRawBufferPointer) throws
}

final class MacOSProtectedCredentialHelper {
    private let servicePrefix = "com.openai.job-apply.accounts.v1."

    private func accountName(strategy: String, realmRef: String) throws -> String {
        guard realmRef.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw ProtectedCredentialError.invalidBinding
        }
        switch strategy {
        case "unique_per_realm": return realmRef
        case "shared": return "explicit-shared-v1"
        default: throw ProtectedCredentialError.invalidBinding
        }
    }

    static func credentialReference(strategy: String, realmRef: String) throws -> String {
        let binding: String
        guard realmRef.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw ProtectedCredentialError.invalidBinding
        }
        switch strategy {
        case "unique_per_realm": binding = realmRef
        case "shared": binding = "explicit-shared-v1"
        default: throw ProtectedCredentialError.invalidBinding
        }
        let digest = SHA256.hash(data: Data(binding.utf8)).map { String(format: "%02x", $0) }.joined()
        return "credential_" + digest
    }

    private func generatedSecret() throws -> Data {
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-._~".utf8)
        var random = Data(count: 32)
        let status = random.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw ProtectedCredentialError.keychain(status) }
        var secret = Data(count: 32)
        secret.withUnsafeMutableBytes { output in
            random.withUnsafeBytes { input in
                let outputBytes = output.bindMemory(to: UInt8.self)
                let inputBytes = input.bindMemory(to: UInt8.self)
                for index in 0..<32 {
                    outputBytes[index] = alphabet[Int(inputBytes[index]) % alphabet.count]
                }
            }
        }
        random.resetBytes(in: 0..<random.count)
        return secret
    }

    func provisionOrReuseAndFill(
        strategy: String,
        realmRef: String,
        isolatedNamespace: String,
        secureInput: NativeSecureInputBoundary
    ) throws -> ProtectedCredentialReceipt {
        guard isolatedNamespace.range(of: "^[A-Za-z0-9_-]{8,80}$", options: .regularExpression) != nil else {
            throw ProtectedCredentialError.invalidBinding
        }
        let account = try accountName(strategy: strategy, realmRef: realmRef)
        let service = servicePrefix + isolatedNamespace
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var secret = try generatedSecret()
        defer { secret.resetBytes(in: 0..<secret.count) }
        var add = query
        add[kSecValueData as String] = secret
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        let reused: Bool
        if addStatus == errSecSuccess {
            reused = false
        } else if addStatus == errSecDuplicateItem {
            reused = true
            var lookup = query
            lookup[kSecReturnData as String] = true
            lookup[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: CFTypeRef?
            let lookupStatus = SecItemCopyMatching(lookup as CFDictionary, &result)
            guard lookupStatus == errSecSuccess, let existing = result as? Data else {
                throw ProtectedCredentialError.keychain(lookupStatus)
            }
            secret.resetBytes(in: 0..<secret.count)
            secret = existing
        } else {
            throw ProtectedCredentialError.keychain(addStatus)
        }
        do {
            try secret.withUnsafeBytes { buffer in try secureInput.fillAndClear(buffer) }
        } catch {
            if !reused {
                _ = SecItemDelete(query as CFDictionary)
            }
            throw error
        }
        // The opaque reference identifies the provider slot, never secret bytes.
        return ProtectedCredentialReceipt(
            credentialReference: try Self.credentialReference(strategy: strategy, realmRef: realmRef),
            credentialVersion: 1,
            reused: reused,
            filled: true
        )
    }


    func isolatedTestItemCount(isolatedNamespace: String) throws -> Int {
        guard isolatedNamespace.range(of: "^[A-Za-z0-9_-]{8,80}$", options: .regularExpression) != nil else {
            throw ProtectedCredentialError.invalidBinding
        }
        var result: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servicePrefix + isolatedNamespace,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
        ] as CFDictionary, &result)
        if status == errSecItemNotFound { return 0 }
        guard status == errSecSuccess else { throw ProtectedCredentialError.keychain(status) }
        return (result as? [[String: Any]])?.count ?? ((result as? [String: Any]) == nil ? 0 : 1)
    }

    func removeIsolatedTestItem(realmRef: String, strategy: String, isolatedNamespace: String) throws {
        let account = try accountName(strategy: strategy, realmRef: realmRef)
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: servicePrefix + isolatedNamespace,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw ProtectedCredentialError.keychain(status)
        }
    }

}
