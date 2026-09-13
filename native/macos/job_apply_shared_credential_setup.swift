import AppKit
import Foundation

enum SharedCredentialSource: String {
    case generate
    case enter
}

enum SharedCredentialSetupError: Error {
    case cancelled
    case invalidSecret
}

final class NoTransferSecureTextField: NSSecureTextField {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command),
           let characters = event.charactersIgnoringModifiers?.lowercased(),
           ["c", "v", "x"].contains(characters) {
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?,
                                 returnType: NSPasteboard.PasteboardType?) -> Any? {
        nil
    }
}

@MainActor
final class NativeSharedCredentialSetup {
    private let helper = MacOSProtectedCredentialHelper()
    private let productionNamespace = "production-v1"

    private func enteredSecret() throws -> Data {
        let field = NoTransferSecureTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.placeholderString = "Shared password"
        field.menu = NSMenu()
        field.unregisterDraggedTypes()
        let alert = NSAlert()
        alert.messageText = "Save shared employer-account password"
        alert.informativeText = "Type the password here. It is written directly to this Mac's Keychain."
        alert.accessoryView = field
        alert.addButton(withTitle: "Save to Keychain")
        alert.addButton(withTitle: "Cancel")
        NSApplication.shared.setActivationPolicy(.accessory)
        NSApplication.shared.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else {
            field.stringValue = ""
            throw SharedCredentialSetupError.cancelled
        }
        let value = field.stringValue
        field.stringValue = ""
        guard !value.isEmpty, let secret = value.data(using: .utf8), !secret.isEmpty else {
            throw SharedCredentialSetupError.invalidSecret
        }
        return secret
    }

    func create(source: SharedCredentialSource, credentialVersion: Int) throws
        -> SharedCredentialSetupReceipt {
        var secret: Data
        switch source {
        case .generate:
            secret = try helper.generatedSecret()
        case .enter:
            secret = try enteredSecret()
        }
        defer { secret.resetBytes(in: 0..<secret.count) }
        return try helper.createSharedCredential(
            credentialVersion: credentialVersion,
            isolatedNamespace: productionNamespace,
            secret: &secret
        )
    }
}
