import Foundation
import CryptoKit
import Darwin
import AppKit
import ApplicationServices
import Security

enum WorkdayAccountFlowError: Error {
    case invalidBinding, privateChannel, browserBinding, pageBinding, controlBinding
    case emailEffect, passwordEffect, createEffect, clearingEffect, attestation
}

struct NativeWorkdayBinding {
    let browserProcessIdentifier: pid_t
    let portalURL: String
    let realmReference: String
    let realmDescriptor: String
    let accountFormFingerprint: String
    let emailControlFingerprint: String
    let passwordControlFingerprint: String
    let createAccountControlFingerprint: String
    let accountCreationControlsFingerprint: String
    let nativeAttestationSocketPath: String

    static func fingerprint(_ value: String) -> String {
        "sha256:" + SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func validate() throws {
        let parts = realmDescriptor.split(separator: ":", omittingEmptySubsequences: false)
        guard browserProcessIdentifier > 1, parts.count == 4,
              parts[0] == "workday", parts[1] == "v1",
              String(parts[2]).range(of: "^wd[1-9][0-9]*$", options: .regularExpression) != nil,
              String(parts[3]).range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil,
              realmReference == Self.fingerprint(realmDescriptor).replacingOccurrences(of: "sha256:", with: ""),
              let components = URLComponents(string: portalURL), components.scheme == "https",
              components.user == nil, components.password == nil, components.port == nil || components.port == 443,
              components.query == nil, components.fragment == nil,
              components.host == "\(parts[3]).\(parts[2]).myworkdayjobs.com",
              nativeAttestationSocketPath.hasPrefix("/"), nativeAttestationSocketPath.utf8.count <= 103
        else { throw WorkdayAccountFlowError.invalidBinding }
        let fingerprints = [accountFormFingerprint, emailControlFingerprint,
                            passwordControlFingerprint, createAccountControlFingerprint]
        guard fingerprints.allSatisfy({ $0.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression) != nil }),
              accountCreationControlsFingerprint == Self.fingerprint(fingerprints.joined(separator: ":"))
        else { throw WorkdayAccountFlowError.invalidBinding }
    }
}

struct WorkdayReviewedControlShape {
    let emailCount: Int, secureCount: Int, createCount: Int
    let textCount: Int, enabledButtonCount: Int
    let unknownRequiredOrActionable: Bool
    var isExact: Bool {
        emailCount == 1 && secureCount == 1 && createCount == 1 && textCount == 1
            && enabledButtonCount == 1 && !unknownRequiredOrActionable
    }
}

func workdayClassifyOutcome(_ normalizedText: String, secureControls: Int) -> String {
    let text = normalizedText.lowercased()
    if text.contains("captcha") || text.contains("not a robot") { return "captcha_required" }
    if text.contains("multi-factor") || text.contains("authentication code") { return "mfa_required" }
    if text.contains("reset your password") || text.contains("password reset") { return "password_reset_required" }
    if text.contains("verify your email") || text.contains("verification code") || text.contains("check your email") {
        return "email_verification_required"
    }
    if text.contains("unable to create") || text.contains("account already exists") { return "failed_definitive" }
    if secureControls == 0 && (text.contains("my applications") || text.contains("candidate home")) { return "active" }
    return "ambiguous"
}

/// Silent, in-memory proof of the closed predicates. It performs no AX or
/// Security.framework operation and deliberately has no effect representation.
func workdayAccountAdversarialFixturesPass() -> Bool {
    let exact = WorkdayReviewedControlShape(emailCount: 1, secureCount: 1, createCount: 1,
        textCount: 1, enabledButtonCount: 1, unknownRequiredOrActionable: false)
    let wrongSecure = WorkdayReviewedControlShape(emailCount: 1, secureCount: 0, createCount: 1,
        textCount: 2, enabledButtonCount: 1, unknownRequiredOrActionable: false)
    let extraAction = WorkdayReviewedControlShape(emailCount: 1, secureCount: 1, createCount: 1,
        textCount: 1, enabledButtonCount: 2, unknownRequiredOrActionable: true)
    let labels = [
        ("candidate home my applications", 0, "active"),
        ("verify your email", 0, "email_verification_required"),
        ("complete captcha", 0, "captcha_required"),
        ("multi-factor authentication code", 0, "mfa_required"),
        ("reset your password", 1, "password_reset_required"),
        ("unable to create account", 0, "failed_definitive"),
        ("welcome", 0, "ambiguous"),
    ]
    let descriptor = "workday:v1:wd5:acme"
    let realm = NativeWorkdayBinding.fingerprint(descriptor).replacingOccurrences(of: "sha256:", with: "")
    let placeholder = NativeWorkdayBinding.fingerprint("placeholder")
    let binding = NativeWorkdayBinding(browserProcessIdentifier: 2,
        portalURL: "https://acme.wd5.myworkdayjobs.com/jobs/1", realmReference: realm,
        realmDescriptor: descriptor, accountFormFingerprint: placeholder,
        emailControlFingerprint: placeholder, passwordControlFingerprint: placeholder,
        createAccountControlFingerprint: placeholder,
        accountCreationControlsFingerprint: NativeWorkdayBinding.fingerprint(
            [placeholder, placeholder, placeholder, placeholder].joined(separator: ":")),
        nativeAttestationSocketPath: "/tmp/job-apply-workday-fixture")
    let queryRejected: Bool
    do {
        let invalid = NativeWorkdayBinding(browserProcessIdentifier: binding.browserProcessIdentifier,
            portalURL: binding.portalURL + "?secret=x", realmReference: binding.realmReference,
            realmDescriptor: binding.realmDescriptor, accountFormFingerprint: binding.accountFormFingerprint,
            emailControlFingerprint: binding.emailControlFingerprint, passwordControlFingerprint: binding.passwordControlFingerprint,
            createAccountControlFingerprint: binding.createAccountControlFingerprint,
            accountCreationControlsFingerprint: binding.accountCreationControlsFingerprint,
            nativeAttestationSocketPath: binding.nativeAttestationSocketPath)
        try invalid.validate(); queryRejected = false
    } catch { queryRejected = true }
    return (try? binding.validate()) != nil && queryRejected && exact.isExact
        && !wrongSecure.isExact && !extraAction.isExact
        && labels.allSatisfy { workdayClassifyOutcome($0.0, secureControls: $0.1) == $0.2 }
        && (try? MacOSProtectedCredentialHelper.credentialReference(
            strategy: "unique_per_realm", realmRef: realm
        )) == (try? MacOSProtectedCredentialHelper.credentialReference(
            strategy: "unique_per_realm", realmRef: realm
        ))
}

final class WorkdayAccessibilityInspector {
    private let binding: NativeWorkdayBinding
    init(_ binding: NativeWorkdayBinding) { self.binding = binding }

    fileprivate func string(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        if let text = value as? String { return text }
        if let url = value as? URL { return url.absoluteString }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    fileprivate func elements(_ root: AXUIElement) -> [AXUIElement] {
        var pending = [root], seen = Set<CFHashCode>(), result: [AXUIElement] = []
        while !pending.isEmpty && result.count < 10_000 {
            let element = pending.removeFirst(), identity = CFHash(element)
            guard seen.insert(identity).inserted else { continue }
            result.append(element)
            var value: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
               let children = value as? [AXUIElement] { pending.append(contentsOf: children) }
        }
        return result
    }

    fileprivate func searchable(_ element: AXUIElement) -> String {
        [kAXTitleAttribute as String, kAXDescriptionAttribute as String, kAXHelpAttribute as String, "AXDOMIdentifier"]
            .compactMap { string(element, $0 as CFString) }.joined(separator: " ").lowercased()
    }

    private func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return names as? [String] ?? []
    }

    fileprivate func fingerprint(_ element: AXUIElement) -> String {
        NativeWorkdayBinding.fingerprint([kAXRoleAttribute as String, kAXSubroleAttribute as String,
            "AXDOMIdentifier", kAXTitleAttribute as String, kAXDescriptionAttribute as String,
            kAXHelpAttribute as String, kAXURLAttribute as String]
            .map { string(element, $0 as CFString) ?? "" }.joined(separator: "|"))
    }

    private func signedBrowser() -> Bool {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN * 4))
        guard proc_pidpath(binding.browserProcessIdentifier, &buffer, UInt32(buffer.count)) > 0,
              let running = NSRunningApplication(processIdentifier: binding.browserProcessIdentifier),
              let executable = running.executableURL?.resolvingSymlinksInPath().standardizedFileURL
        else { return false }
        let path = URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath().standardizedFileURL
        let trusted = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome": "identifier \"com.google.Chrome\" and anchor apple generic and certificate leaf[subject.OU] = \"EQHXZ8M8AV\"",
            "/Applications/Safari.app/Contents/MacOS/Safari": "identifier \"com.apple.Safari\" and anchor apple",
        ]
        guard path == executable, let requirementText = trusted[path.path] else { return false }
        var requirement: SecRequirement?, staticCode: SecStaticCode?, dynamicCode: SecCode?
        guard SecRequirementCreateWithString(requirementText as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(path as CFURL, [], &staticCode) == errSecSuccess, let staticCode,
              SecStaticCodeCheckValidity(staticCode, SecCSFlags(rawValue: (1 << 0) | (1 << 4)), requirement) == errSecSuccess,
              SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: binding.browserProcessIdentifier] as CFDictionary, [], &dynamicCode) == errSecSuccess, let dynamicCode,
              SecCodeCheckValidity(dynamicCode, SecCSFlags(rawValue: 1 << 4), requirement) == errSecSuccess
        else { return false }
        return true
    }

    private func exactPage() throws -> AXUIElement {
        guard kill(binding.browserProcessIdentifier, 0) == 0, AXIsProcessTrusted(), signedBrowser()
        else { throw WorkdayAccountFlowError.browserBinding }
        let pages = elements(AXUIElementCreateApplication(binding.browserProcessIdentifier)).filter {
            string($0, kAXRoleAttribute as CFString) == "AXWebArea"
                && string($0, kAXURLAttribute as CFString) == binding.portalURL
        }
        guard pages.count == 1 else { throw WorkdayAccountFlowError.pageBinding }
        return pages[0]
    }

    struct Controls { let form: AXUIElement, email: AXUIElement, password: AXUIElement, create: AXUIElement }

    func exactControls() throws -> Controls {
        let page = try exactPage()
        let candidates = elements(page).filter {
            let role = string($0, kAXRoleAttribute as CFString)
            return role == "AXGroup" || role == "AXForm"
        }.compactMap { form -> (Controls, Int)? in
            let all = elements(form)
            let emails = all.filter { string($0, kAXRoleAttribute as CFString) == (kAXTextFieldRole as String) && searchable($0).contains("email") }
            let secure = all.filter { string($0, kAXSubroleAttribute as CFString) == (kAXSecureTextFieldSubrole as String) }
            let create = all.filter {
                let label = searchable($0)
                return string($0, kAXRoleAttribute as CFString) == (kAXButtonRole as String)
                    && (label.contains("create account") || label.contains("sign up") || label.contains("register"))
                    && !label.contains("apply") && !label.contains("submit application")
            }
            let text = all.filter { string($0, kAXRoleAttribute as CFString) == (kAXTextFieldRole as String) }
            let buttons = all.filter { string($0, kAXRoleAttribute as CFString) == (kAXButtonRole as String) && string($0, kAXEnabledAttribute as CFString) != "0" }
            let reviewed = Set([emails.first, secure.first, create.first].compactMap { $0 }.map(CFHash))
            let unknown = all.contains { !reviewed.contains(CFHash($0)) &&
                (string($0, "AXRequired" as CFString) == "1" || (string($0, kAXEnabledAttribute as CFString) != "0" && !actions($0).isEmpty)) }
            let shape = WorkdayReviewedControlShape(emailCount: emails.count, secureCount: secure.count,
                createCount: create.count, textCount: text.count, enabledButtonCount: buttons.count,
                unknownRequiredOrActionable: unknown)
            guard shape.isExact else { return nil }
            return (Controls(form: form, email: emails[0], password: secure[0], create: create[0]), all.count)
        }
        guard let minimum = candidates.map(\.1).min() else { throw WorkdayAccountFlowError.controlBinding }
        let narrowest = candidates.filter { $0.1 == minimum }
        guard narrowest.count == 1 else { throw WorkdayAccountFlowError.controlBinding }
        return narrowest[0].0
    }

    func prepare() throws -> [String: Any] {
        let controls = try exactControls()
        let values = [fingerprint(controls.form), fingerprint(controls.email),
                      fingerprint(controls.password), fingerprint(controls.create)]
        return ["providerId": "macos-workday-account", "accountFormFingerprint": values[0],
            "emailControlFingerprint": values[1], "passwordControlFingerprint": values[2],
            "createAccountControlFingerprint": values[3],
            "accountCreationControlsFingerprint": NativeWorkdayBinding.fingerprint(values.joined(separator: ":")),
            "readOnly": true, "effectCount": 0]
    }
}

private final class WorkdayAccessibilityAccountBoundary: NativeSecureInputBoundary {
    private let binding: NativeWorkdayBinding
    private let email: String
    private(set) var outcome: String?

    init(binding: NativeWorkdayBinding, email: String) {
        self.binding = binding; self.email = email
    }

    func fillAndClear(_ generatedBytes: UnsafeRawBufferPointer) throws {
        guard generatedBytes.count == 32 else { throw WorkdayAccountFlowError.passwordEffect }
        let inspector = WorkdayAccessibilityInspector(binding)
        let controls = try inspector.exactControls()
        guard inspector.fingerprint(controls.form) == binding.accountFormFingerprint,
              inspector.fingerprint(controls.email) == binding.emailControlFingerprint,
              inspector.fingerprint(controls.password) == binding.passwordControlFingerprint,
              inspector.fingerprint(controls.create) == binding.createAccountControlFingerprint,
              inspector.string(controls.email, kAXValueAttribute as CFString) == "",
              inspector.string(controls.password, kAXValueAttribute as CFString) == "",
              inspector.string(controls.create, kAXEnabledAttribute as CFString) != "0"
        else { throw WorkdayAccountFlowError.controlBinding }
        var completed = false
        defer {
            if !completed {
                _ = AXUIElementSetAttributeValue(controls.email, kAXValueAttribute as CFString, "" as CFString)
                _ = AXUIElementSetAttributeValue(controls.password, kAXValueAttribute as CFString, "" as CFString)
            }
        }
        guard AXUIElementSetAttributeValue(controls.email, kAXValueAttribute as CFString, email as CFString) == .success,
              inspector.string(controls.email, kAXValueAttribute as CFString) == email
        else { throw WorkdayAccountFlowError.emailEffect }
        let password = String(decoding: generatedBytes.bindMemory(to: UInt8.self), as: UTF8.self)
        guard AXUIElementSetAttributeValue(controls.password, kAXValueAttribute as CFString, password as CFString) == .success,
              !(inspector.string(controls.password, kAXValueAttribute as CFString) ?? "").isEmpty
        else { throw WorkdayAccountFlowError.passwordEffect }
        guard AXUIElementPerformAction(controls.create, kAXPressAction as CFString) == .success
        else { throw WorkdayAccountFlowError.createEffect }

        // Observe only. The activation above is never retried. A successful
        // causal successor must remove both secret-bearing controls.
        for _ in 0..<60 {
            usleep(50_000)
            let all = inspector.elements(AXUIElementCreateApplication(binding.browserProcessIdentifier))
            let pages = all.filter {
                inspector.string($0, kAXRoleAttribute as CFString) == "AXWebArea"
                    && (inspector.string($0, kAXURLAttribute as CFString) ?? "").contains(".myworkdayjobs.com/")
            }
            guard pages.count == 1 else { continue }
            let pageElements = inspector.elements(pages[0])
            let emailPresent = pageElements.contains { inspector.fingerprint($0) == binding.emailControlFingerprint }
            let passwordPresent = pageElements.contains { inspector.fingerprint($0) == binding.passwordControlFingerprint }
            guard !emailPresent && !passwordPresent else { continue }
            let text = pageElements.map(inspector.searchable).joined(separator: " ")
            let secure = pageElements.filter {
                inspector.string($0, kAXSubroleAttribute as CFString) == (kAXSecureTextFieldSubrole as String)
            }.count
            outcome = workdayClassifyOutcome(text, secureControls: secure)
            completed = true
            return
        }
        throw WorkdayAccountFlowError.clearingEffect
    }
}

struct MacOSWorkdayAccountFlowHelper {
    func prepare(browserProcessIdentifier: pid_t, portalURL: String,
                 realmReference: String, realmDescriptor: String) throws -> [String: Any] {
        let placeholder = NativeWorkdayBinding.fingerprint("preparation-placeholder")
        let binding = NativeWorkdayBinding(browserProcessIdentifier: browserProcessIdentifier,
            portalURL: portalURL, realmReference: realmReference, realmDescriptor: realmDescriptor,
            accountFormFingerprint: placeholder, emailControlFingerprint: placeholder,
            passwordControlFingerprint: placeholder, createAccountControlFingerprint: placeholder,
            accountCreationControlsFingerprint: NativeWorkdayBinding.fingerprint(
                [placeholder, placeholder, placeholder, placeholder].joined(separator: ":")),
            nativeAttestationSocketPath: "/tmp/job-apply-workday-prepare")
        try binding.validate()
        return try WorkdayAccessibilityInspector(binding).prepare()
    }

    private func inheritedEmail(_ descriptor: Int32) throws -> String {
        guard descriptor > STDERR_FILENO else { throw WorkdayAccountFlowError.privateChannel }
        var bytes = Data(), chunk = [UInt8](repeating: 0, count: 256)
        while bytes.count <= 254 {
            let count = Darwin.read(descriptor, &chunk, chunk.count)
            if count < 0 { throw WorkdayAccountFlowError.privateChannel }
            if count == 0 { break }
            bytes.append(chunk, count: count)
        }
        defer { bytes.resetBytes(in: 0..<bytes.count); Darwin.close(descriptor) }
        guard bytes.count > 2, bytes.count <= 254,
              let value = String(data: bytes, encoding: .utf8), value.contains("@"),
              !value.contains("\n"), !value.contains("\r")
        else { throw WorkdayAccountFlowError.privateChannel }
        return value
    }

    private func publish(_ value: [String: Any], socketPath: String) throws {
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw WorkdayAccountFlowError.attestation }
        defer { Darwin.close(descriptor) }
        let bytes = Array(socketPath.utf8CString)
        var address = sockaddr_un(); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.initializeMemory(as: UInt8.self, repeating: 0)
            _ = bytes.withUnsafeBytes { memcpy(destination.baseAddress!, $0.baseAddress!, bytes.count) }
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { throw WorkdayAccountFlowError.attestation }
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); data.append(0x0a)
        guard data.withUnsafeBytes({ Darwin.send(descriptor, $0.baseAddress, data.count, 0) }) == data.count
        else { throw WorkdayAccountFlowError.attestation }
        Darwin.shutdown(descriptor, SHUT_WR)
        var acknowledgement: UInt8 = 0
        guard Darwin.recv(descriptor, &acknowledgement, 1, 0) == 1, acknowledgement == 1
        else { throw WorkdayAccountFlowError.attestation }
    }

    func execute(_ binding: NativeWorkdayBinding, privateEmailDescriptor: Int32) throws {
        try binding.validate()
        let email = try inheritedEmail(privateEmailDescriptor)
        let boundary = WorkdayAccessibilityAccountBoundary(binding: binding, email: email)
        let receipt = try MacOSProtectedCredentialHelper().provisionOrReuseAndFill(
            strategy: "unique_per_realm", realmRef: binding.realmReference,
            isolatedNamespace: "production-v1", secureInput: boundary
        )
        guard let outcome = boundary.outcome else { throw WorkdayAccountFlowError.attestation }
        try publish([
            "providerId": "macos-workday-account", "credentialProviderId": "macos-keychain",
            "credentialRef": receipt.credentialReference, "credentialVersion": receipt.credentialVersion,
            "reused": receipt.reused, "outcome": outcome, "retryAllowed": false,
            "finalActionAuthorized": false, "createAccountActivations": 1,
            "emailControlRemoved": true, "passwordControlRemoved": true,
        ], socketPath: binding.nativeAttestationSocketPath)
    }
}
