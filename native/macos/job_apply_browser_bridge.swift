import Foundation
import ApplicationServices
import Darwin
import CryptoKit
import AppKit
import Security

struct NativeBrowserBinding: Equatable {
    let browserProcessIdentifier: pid_t
    let targetURL: String
    let realmReference: String
    let controlFingerprint: String
    let operationFingerprint: String
    let nativeAttestationSocketPath: String
}

private struct ObservedSecureControl {
    let element: AXUIElement
}

enum BrowserBridgeDiagnostic: Error { case failedClosed(String) }

/// The complete native live vocabulary reserved for the later, exact T007
/// account-creation canary. There is intentionally no general navigation,
/// script, selector, application, or final-action representation.
enum ReviewedNativeAccountCreationEffect: String, CaseIterable {
    case focusEmailControl = "focus_email_control"
    case fillEmailFromSettings = "fill_email_from_settings"
    case focusPasswordControl = "focus_password_control"
    case fillPasswordFromKeychain = "fill_password_from_keychain"
    case activateCreateAccountControl = "activate_create_account_control"
    case observeAccountCreationOutcome = "observe_account_creation_outcome"
}

/// Closed vocabulary for Oracle Recruiting's email-only candidate-profile
/// step. It cannot represent navigation, selectors, scripts, passwords, or an
/// application submission.
enum ReviewedNativeEmailOnlyEffect: String, CaseIterable {
    case focusEmailControl = "focus_email_control"
    case fillEmailFromCanonicalSettings = "fill_email_from_canonical_settings"
    case activateExactRecruitingTermsConsent = "activate_exact_recruiting_terms_consent"
    case activateExactCandidateProfileNext = "activate_exact_candidate_profile_next"
    case observeCandidateProfileOutcome = "observe_candidate_profile_outcome"
}

struct DisabledMacOSAccountCreationBoundary {
    static let enabled = false

    func execute(_ effect: ReviewedNativeAccountCreationEffect) throws -> Never {
        _ = effect
        throw ProtectedCredentialError.invalidBinding
    }
}

/// Native, write-only browser bridge. Browser identity, page origin, focused
/// secure control, and operation identity are all read from the OS accessibility
/// tree; none is accepted merely because the caller supplied it.
final class MacOSBrowserSecureInputBridge: NativeSecureInputBoundary {
    private let expected: NativeBrowserBinding
    private(set) var completedEffect = false

    init(expected: NativeBrowserBinding) throws {
        let control = "sha256:" + SHA256.hash(data: Data("native-secure-control:v1".utf8)).map { String(format: "%02x", $0) }.joined()
        let target = URL(string: expected.targetURL)
        var canonical = URLComponents(url: target ?? URL(fileURLWithPath: "/"), resolvingAgainstBaseURL: false)
        canonical?.query = nil; canonical?.fragment = nil
        let binding = "protected-account:v1:\(canonical?.url?.absoluteString ?? ""):\(expected.realmReference):\(expected.controlFingerprint)"
        let operation = "sha256:" + SHA256.hash(data: Data(binding.utf8)).map { String(format: "%02x", $0) }.joined()
        guard expected.browserProcessIdentifier > 1,
              expected.realmReference.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              expected.controlFingerprint.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression) != nil,
              expected.controlFingerprint == control, expected.operationFingerprint == operation,
              expected.nativeAttestationSocketPath.hasPrefix("/"),
              expected.nativeAttestationSocketPath.utf8.count <= 103,
              let target, target.scheme == "http",
              target.host == "127.0.0.1", target.port != nil,
              target.path == "/synthetic-account"
        else { throw ProtectedCredentialError.invalidBinding }
        self.expected = expected
    }

    private func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        if let string = value as? String { return string }
        if let url = value as? URL { return url.absoluteString }
        return nil
    }

    private func executableIsExactlyTrustedBrowser() -> Bool {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN * 4))
        let count = proc_pidpath(expected.browserProcessIdentifier, &buffer, UInt32(buffer.count))
        guard count > 0 else { return false }
        guard let running = NSRunningApplication(processIdentifier: expected.browserProcessIdentifier),
              let executableURL = running.executableURL
        else { return false }
        let trusted: [String: String] = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome":
                "identifier \"com.google.Chrome\" and anchor apple generic and certificate leaf[subject.OU] = \"EQHXZ8M8AV\"",
            "/Applications/Safari.app/Contents/MacOS/Safari":
                "identifier \"com.apple.Safari\" and anchor apple",
        ]
        let observedPath = URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().standardizedFileURL
        let applicationPath = executableURL.resolvingSymlinksInPath().standardizedFileURL
        guard observedPath == applicationPath,
              let requirementText = trusted[observedPath.path]
        else { return false }
        var requirement: SecRequirement?
        guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return false }
        var staticCode: SecStaticCode?
        let strictAllArchitectures = SecCSFlags(rawValue: (1 << 0) | (1 << 4))
        let strictValidation = SecCSFlags(rawValue: 1 << 4)
        guard SecStaticCodeCreateWithPath(observedPath as CFURL, [], &staticCode) == errSecSuccess,
              let staticCode,
              SecStaticCodeCheckValidity(staticCode, strictAllArchitectures, requirement) == errSecSuccess
        else { return false }
        var dynamicCode: SecCode?
        let attributes = [kSecGuestAttributePid as String: expected.browserProcessIdentifier] as CFDictionary
        guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &dynamicCode) == errSecSuccess,
              let dynamicCode,
              SecCodeCheckValidity(dynamicCode, strictValidation, requirement) == errSecSuccess
        else { return false }
        return true
    }

    private func observedPageURL(from element: AXUIElement) -> String? {
        var current: AXUIElement? = element
        for _ in 0..<20 {
            guard let item = current else { break }
            if let value = stringAttribute(item, kAXURLAttribute as CFString) { return value }
            var parent: CFTypeRef?
            guard AXUIElementCopyAttributeValue(item, kAXParentAttribute as CFString, &parent) == .success,
                  let next = parent else { break }
            current = unsafeBitCast(next, to: AXUIElement.self)
        }
        return nil
    }

    private func independentlyObserve() throws -> ObservedSecureControl {
        guard kill(expected.browserProcessIdentifier, 0) == 0 else { throw BrowserBridgeDiagnostic.failedClosed("browser_process") }
        guard executableIsExactlyTrustedBrowser() else { throw BrowserBridgeDiagnostic.failedClosed("browser_identity") }
        guard AXIsProcessTrusted() else { throw BrowserBridgeDiagnostic.failedClosed("accessibility_trust") }
        guard let running = NSRunningApplication(processIdentifier: expected.browserProcessIdentifier),
              running.activate(options: [.activateAllWindows]) else {
            throw BrowserBridgeDiagnostic.failedClosed("browser_activation")
        }
        usleep(150_000)
        let application = AXUIElementCreateApplication(expected.browserProcessIdentifier)
        var focusedValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &focusedValue) == .success,
              let focusedValue else { throw BrowserBridgeDiagnostic.failedClosed("focused_control") }
        let focused = unsafeBitCast(focusedValue, to: AXUIElement.self)
        let role = stringAttribute(focused, kAXRoleAttribute as CFString)
        let subrole = stringAttribute(focused, kAXSubroleAttribute as CFString)
        guard role == (kAXTextFieldRole as String), subrole == (kAXSecureTextFieldSubrole as String) else {
            throw BrowserBridgeDiagnostic.failedClosed("secure_control_role")
        }
        guard stringAttribute(focused, "AXDOMIdentifier" as CFString) == "job-apply-secure-control" else {
            throw BrowserBridgeDiagnostic.failedClosed("secure_control_identity")
        }
        guard observedPageURL(from: focused) == expected.targetURL else { throw BrowserBridgeDiagnostic.failedClosed("browser_origin") }
        let exactIdentity = "job-apply-operation:\(expected.operationFingerprint)"
        let candidates = [
            stringAttribute(focused, kAXTitleAttribute as CFString),
            stringAttribute(focused, kAXHelpAttribute as CFString),
            stringAttribute(focused, kAXDescriptionAttribute as CFString),
        ].compactMap { $0 }
        guard candidates.contains(exactIdentity) else {
            let observedDigest = SHA256.hash(data: Data(candidates.joined(separator: "|").utf8)).map { String(format: "%02x", $0) }.joined()
            let expectedDigest = SHA256.hash(data: Data(exactIdentity.utf8)).map { String(format: "%02x", $0) }.joined()
            throw BrowserBridgeDiagnostic.failedClosed("operation_identity_\(observedDigest)_\(expectedDigest)")
        }
        return ObservedSecureControl(element: focused)
    }

    private func secureValueIsEmpty(_ element: AXUIElement) throws -> Bool {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == CFStringGetTypeID()
        else { throw ProtectedCredentialError.secureInput }
        return CFStringGetLength(unsafeBitCast(value, to: CFString.self)) == 0
    }

    private func connectedNativeChannel() throws -> Int32 {
        let pathBytes = Array(expected.nativeAttestationSocketPath.utf8CString)
        guard pathBytes.count > 1, pathBytes.count <= 104 else { throw ProtectedCredentialError.invalidBinding }
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ProtectedCredentialError.secureInput }
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.initializeMemory(as: UInt8.self, repeating: 0)
            _ = pathBytes.withUnsafeBytes { source in
                memcpy(destination.baseAddress!, source.baseAddress!, pathBytes.count)
            }
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { Darwin.close(descriptor); throw ProtectedCredentialError.secureInput }
        return descriptor
    }

    private func publishVerifiedObservation() throws {
        let attestation: [String: Any] = [
            "operationFingerprint": expected.operationFingerprint,
            "nativeOriginAttested": true,
            "signedBrowserIdentityAttested": true,
            "beforeFillAttested": true,
            "duringFillAttested": true,
            "afterClearAttested": true,
            "secureControlCleared": true,
        ]
        var data = try JSONSerialization.data(withJSONObject: attestation, options: [.sortedKeys])
        data.append(0x0a)
        let descriptor = try connectedNativeChannel()
        defer { Darwin.close(descriptor) }
        try data.withUnsafeBytes { raw in
            guard var base = raw.baseAddress else { throw ProtectedCredentialError.secureInput }
            var remaining = raw.count
            while remaining > 0 {
                let written = Darwin.write(descriptor, base, remaining)
                guard written > 0 else { throw ProtectedCredentialError.secureInput }
                remaining -= written
                base = base.advanced(by: written)
            }
        }
        var acknowledgement: UInt8 = 0
        guard Darwin.read(descriptor, &acknowledgement, 1) == 1, acknowledgement == 1 else {
            throw ProtectedCredentialError.secureInput
        }
    }

    func fillAndClear(_ generatedBytes: UnsafeRawBufferPointer) throws {
        guard generatedBytes.count == 32 else { throw ProtectedCredentialError.secureInput }
        let before = try independentlyObserve()
        let transient = String(decoding: generatedBytes.bindMemory(to: UInt8.self), as: UTF8.self)
        guard AXUIElementSetAttributeValue(before.element, kAXValueAttribute as CFString, transient as CFString) == .success else {
            throw ProtectedCredentialError.secureInput
        }
        usleep(100_000)
        let during = try independentlyObserve()
        guard try !secureValueIsEmpty(during.element),
              AXUIElementSetAttributeValue(during.element, kAXValueAttribute as CFString, "" as CFString) == .success
        else { throw ProtectedCredentialError.secureInput }
        let after = try independentlyObserve()
        guard try secureValueIsEmpty(after.element)
        else { throw ProtectedCredentialError.secureInput }
        try publishVerifiedObservation()
        completedEffect = true
    }
}
