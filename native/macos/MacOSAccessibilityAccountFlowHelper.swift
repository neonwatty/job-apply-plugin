import Foundation
import Darwin
import ApplicationServices

enum OracleCausalSuccessorDecision: Equatable {
    case pending
    case ambiguous
    case selected(String)
}

/// Value-free decision for the post-action identity-removal attestation. The
/// private identity is compared in memory only and is never returned, logged,
/// or included in a fingerprint. An unreadable or ambiguous exact control
/// fails closed.
func oracleExactEmailControlIdentityRemoved(
    matchCount: Int, observedValue: String?, inheritedIdentity: String
) -> Bool {
    if matchCount == 0 { return observedValue == nil }
    guard matchCount == 1, let observedValue else { return false }
    return observedValue != inheritedIdentity
}

/// Value-free causal selection shared by the live AX boundary and the native
/// adversarial fixture. A pre-existing page other than the reviewed page must
/// remain byte-for-byte stable. The reviewed page may itself change, or it may
/// disappear and be replaced by exactly one new realm page.
func oracleCausalSuccessorDecision(
    boundPage: String, before: [String: String], after: [String: String]
) -> OracleCausalSuccessorDecision {
    guard let boundDigest = before[boundPage] else { return .ambiguous }
    for (identity, digest) in before where identity != boundPage {
        guard after[identity] == digest else { return .ambiguous }
    }
    let newPages = after.keys.filter { before[$0] == nil }
    if let currentBoundDigest = after[boundPage] {
        guard newPages.isEmpty else { return .ambiguous }
        return currentBoundDigest == boundDigest ? .pending : .selected(boundPage)
    }
    guard newPages.count <= 1 else { return .ambiguous }
    return newPages.count == 1 ? .selected(newPages[0]) : .pending
}

/// Closed Oracle candidate-profile boundary. Identity arrives only through an
/// inherited descriptor and is erased after one AXValue write. No navigation,
/// general selector/script API, password operation, or final action exists.
struct MacOSAccessibilityAccountFlowHelper {
    static let providerIdentifier = "macos-accessibility"

    func execute(_ binding: NativeEmailOnlyBinding, privateEmailDescriptor: Int32) throws {
        do {
            try binding.validate()
        } catch {
            throw AccountFlowHelperError.requestBinding
        }
        var emailBytes = Data()
        var chunk = [UInt8](repeating: 0, count: 256)
        while emailBytes.count <= 254 {
            let count = Darwin.read(privateEmailDescriptor, &chunk, chunk.count)
            if count < 0 { throw AccountFlowHelperError.privateChannel }
            if count == 0 { break }
            emailBytes.append(chunk, count: count)
        }
        defer {
            emailBytes.resetBytes(in: 0..<emailBytes.count)
            Darwin.close(privateEmailDescriptor)
        }
        guard emailBytes.count > 2, emailBytes.count <= 254,
              let email = String(data: emailBytes, encoding: .utf8),
              email.contains("@"), !email.contains("\n"), !email.contains("\r")
        else { throw AccountFlowHelperError.privateChannel }
        try OracleEmailOnlyEffect(binding: binding).perform(email: email)
    }

    func prepare(browserProcessIdentifier: pid_t, portalURL: String,
                 realmReference: String, realmDescriptor: String) throws -> [String: Any] {
        let placeholder = NativeEmailOnlyBinding.fingerprint("preparation-placeholder")
        let aggregate = NativeEmailOnlyBinding.fingerprint(
            [placeholder, placeholder, placeholder, placeholder, placeholder].joined(separator: ":")
        )
        let binding = NativeEmailOnlyBinding(
            browserProcessIdentifier: browserProcessIdentifier, portalURL: portalURL,
            realmReference: realmReference, realmDescriptor: realmDescriptor,
            accountFormFingerprint: placeholder, emailControlFingerprint: placeholder,
            termsControlFingerprint: placeholder, termsDocumentFingerprint: placeholder,
            nextControlFingerprint: placeholder, accountCreationControlsFingerprint: aggregate,
            passwordControlFingerprint: nil, createAccountControlFingerprint: nil,
            jobRevision: 1, accountRevision: 1, settingsRevision: 1,
            operationFingerprint: placeholder, nativeAttestationSocketPath: "/tmp/job-apply-prepare"
        )
        try binding.validate()
        return try OracleEmailOnlyEffect(binding: binding).prepare()
    }
}

private final class OracleEmailOnlyEffect: OracleAccessibilityTree {
    private func connectedChannel() throws -> Int32 {
        let bytes = Array(binding.nativeAttestationSocketPath.utf8CString)
        guard bytes.count <= 104 else { throw AccountFlowHelperError.invalidBinding }
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw AccountFlowHelperError.effectFailed }
        var address = sockaddr_un()
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
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
        guard connected == 0 else {
            Darwin.close(descriptor)
            throw AccountFlowHelperError.effectFailed
        }
        return descriptor
    }

    private func publish(outcome: String, emailRemovedAttested: Bool) throws {
        guard emailRemovedAttested else { throw AccountFlowHelperError.clearingEffect }
        var value: [String: Any] = [
            "operationFingerprint": binding.operationFingerprint,
            "nativeOriginAttested": true, "signedBrowserIdentityAttested": true,
            "emailFilledAttested": true, "termsAcceptedAttested": true,
            "nextActivatedExactlyOnce": true,
            "emailRemovedAttested": emailRemovedAttested,
            "finalActionActivated": false, "credentialProviderInvocations": 0,
        ]
        if !binding.isSynthetic { value["outcome"] = outcome }
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        data.append(0x0a)
        let descriptor = try connectedChannel()
        defer { Darwin.close(descriptor) }
        let sent = data.withUnsafeBytes { Darwin.send(descriptor, $0.baseAddress, data.count, 0) }
        guard sent == data.count else { throw AccountFlowHelperError.effectFailed }
        Darwin.shutdown(descriptor, SHUT_WR)
        var acknowledgment: UInt8 = 0
        guard Darwin.recv(descriptor, &acknowledgment, 1, 0) == 1, acknowledgment == 1 else {
            throw AccountFlowHelperError.effectFailed
        }
    }

    private func isExactRealmPage(_ element: AXUIElement) -> Bool {
        guard string(element, kAXRoleAttribute as CFString) == "AXWebArea",
              let raw = string(element, kAXURLAttribute as CFString),
              let components = URLComponents(string: raw), components.scheme == "https",
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              let host = components.host
        else { return false }
        let descriptor = binding.realmDescriptor.split(separator: ":", omittingEmptySubsequences: false)
        guard descriptor.count == 4, host == String(descriptor[2]) else { return false }
        let escapedSite = NSRegularExpression.escapedPattern(for: String(descriptor[3]))
        let expression = "^/hcmUI/CandidateExperience/[a-z]{2}(?:-[A-Z]{2})?/sites/" + escapedSite + "/(?:.*)$"
        return components.path.range(of: expression, options: .regularExpression) != nil
    }

    private func pageStateDigest(_ page: AXUIElement) -> String {
        NativeEmailOnlyBinding.fingerprint(elements(page).map(digest).joined(separator: ":"))
    }

    private struct RealmPageState {
        let element: AXUIElement
        let digest: String
    }

    private func realmPageSnapshot() -> [String: RealmPageState]? {
        let application = AXUIElementCreateApplication(binding.browserProcessIdentifier)
        var snapshot: [String: RealmPageState] = [:]
        for page in elements(application).filter(isExactRealmPage) {
            let identity = String(CFHash(page))
            guard snapshot[identity] == nil else { return nil }
            snapshot[identity] = RealmPageState(element: page, digest: pageStateDigest(page))
        }
        return snapshot
    }

    private func exactCausalSuccessor(boundPageIdentity: String,
                                      before: [String: RealmPageState]) throws -> AXUIElement? {
        let beforeDigests = before.mapValues(\.digest)
        for _ in 0..<40 {
            guard let current = realmPageSnapshot() else {
                throw AccountFlowHelperError.clearingEffect
            }
            switch oracleCausalSuccessorDecision(
                boundPage: boundPageIdentity, before: beforeDigests,
                after: current.mapValues(\.digest)
            ) {
            case .selected(let identity):
                return current[identity]?.element
            case .ambiguous:
                throw AccountFlowHelperError.clearingEffect
            case .pending:
                usleep(50_000)
            }
        }
        return nil
    }

    private func classifyPostOutcome(_ successor: AXUIElement) -> String {
        let all = elements(successor)
        let text = all.map(searchable).joined(separator: " ")
        let secure = all.contains {
            string($0, kAXSubroleAttribute as CFString) == (kAXSecureTextFieldSubrole as String)
        }
        let verification = ["verification code", "verify your email", "check your email", "sign in", "password"]
        let failures = ["unable to continue", "account already exists", "unexpected error", "cannot create"]
        let active = ["personal information", "contact information", "upload resume", "work experience"]
        if secure || verification.contains(where: text.contains) { return "verification_required" }
        if failures.contains(where: text.contains) { return "failed_definitive" }
        if active.filter(text.contains).count >= 2 { return "active" }
        return "ambiguous"
    }

    private func exactEmailControlIdentityRemoved(
        on successor: AXUIElement, inheritedIdentity: String
    ) -> Bool {
        let matches = elements(successor).filter {
            reviewedFingerprint($0) == binding.emailControlFingerprint
        }
        let observedValue = matches.count == 1
            ? string(matches[0], kAXValueAttribute as CFString)
            : nil
        return oracleExactEmailControlIdentityRemoved(
            matchCount: matches.count, observedValue: observedValue,
            inheritedIdentity: inheritedIdentity
        )
    }

    private func writePrivateIdentity(_ email: String, to exactControl: AXUIElement,
                                      on page: AXUIElement) throws {
        guard AXUIElementSetAttributeValue(
            exactControl, kAXValueAttribute as CFString, email as CFString
        ) == .success else { throw AccountFlowHelperError.emailEffect }
        // Chromium can acknowledge the single native write before its AX tree
        // publishes the new value. Reobserve only; never repeat the effect.
        for _ in 0..<20 {
            if let reattestedForm = try? exactAccountForm(page),
               let reattestedEmail = try? (binding.isSynthetic
                    ? exact(elements(reattestedForm), id: "job-apply-email-control")
                    : reviewedControls(reattestedForm).email),
               CFEqual(reattestedEmail, exactControl),
               (binding.isSynthetic
                    || reviewedFingerprint(reattestedEmail) == binding.emailControlFingerprint),
               string(reattestedEmail, kAXValueAttribute as CFString) == email {
                return
            }
            usleep(50_000)
        }
        throw AccountFlowHelperError.emailEffect
    }

    func perform(email: String) throws {
        try activateReviewedBrowser()
        usleep(150_000)
        let page: AXUIElement
        do {
            page = try boundPage()
        } catch {
            throw AccountFlowHelperError.pageBinding
        }
        let pageElements = elements(page)
        guard pageElements.filter({
            string($0, kAXSubroleAttribute as CFString) == (kAXSecureTextFieldSubrole as String)
        }).isEmpty else { throw AccountFlowHelperError.controlBinding }
        let accountForm: AXUIElement
        let emailControl: AXUIElement
        let termsControl: AXUIElement
        let nextControl: AXUIElement
        let finalControl: AXUIElement?
        do {
            accountForm = try exactAccountForm(page)
            let formElements = elements(accountForm)
            emailControl = try (binding.isSynthetic
                ? exact(formElements, id: "job-apply-email-control")
                : exact(formElements, fingerprint: binding.emailControlFingerprint))
            termsControl = try (binding.isSynthetic
                ? exact(formElements, id: "job-apply-terms-control")
                : exact(formElements, fingerprint: binding.termsControlFingerprint))
            _ = try (binding.isSynthetic
                ? exact(formElements, id: "job-apply-terms-document")
                : exact(formElements, fingerprint: binding.termsDocumentFingerprint))
            nextControl = try (binding.isSynthetic
                ? exact(formElements, id: "job-apply-next-control")
                : exact(formElements, fingerprint: binding.nextControlFingerprint))
            finalControl = binding.isSynthetic ? try exact(formElements, id: "job-apply-final-tripwire") : nil
            if !binding.isSynthetic {
                let reviewed = try reviewedControls(accountForm)
                guard reviewedFingerprint(reviewed.email) == binding.emailControlFingerprint,
                      reviewedFingerprint(reviewed.terms) == binding.termsControlFingerprint,
                      reviewedFingerprint(reviewed.document) == binding.termsDocumentFingerprint,
                      reviewedFingerprint(reviewed.next) == binding.nextControlFingerprint
                else { throw AccountFlowHelperError.controlBinding }
            }
        } catch AccountFlowHelperError.controlBinding {
            throw AccountFlowHelperError.controlBinding
        } catch {
            throw AccountFlowHelperError.controlBinding
        }
        guard string(emailControl, kAXRoleAttribute as CFString) == (kAXTextFieldRole as String),
              string(termsControl, kAXRoleAttribute as CFString) == (kAXCheckBoxRole as String),
              string(termsControl, kAXValueAttribute as CFString) == "0",
              string(nextControl, kAXRoleAttribute as CFString) == (kAXButtonRole as String),
              finalControl == nil || string(finalControl!, kAXEnabledAttribute as CFString) != "1"
        else { throw AccountFlowHelperError.stateBinding }
        guard string(emailControl, kAXValueAttribute as CFString) == ""
        else { throw AccountFlowHelperError.emailEffect }
        var effectCompleted = false
        defer {
            if !effectCompleted {
                _ = AXUIElementSetAttributeValue(
                    emailControl, kAXValueAttribute as CFString, "" as CFString
                )
                if string(termsControl, kAXValueAttribute as CFString) == "1" {
                    _ = AXUIElementPerformAction(termsControl, kAXPressAction as CFString)
                }
            }
        }
        try writePrivateIdentity(email, to: emailControl, on: page)
        guard AXUIElementPerformAction(termsControl, kAXPressAction as CFString) == .success
        else { throw AccountFlowHelperError.termsEffect }
        usleep(50_000)
        guard string(termsControl, kAXValueAttribute as CFString) == "1"
        else { throw AccountFlowHelperError.termsEffect }
        let preActionRealmPages = binding.isSynthetic ? [:] : (realmPageSnapshot() ?? [:])
        let boundPageIdentity = String(CFHash(page))
        if !binding.isSynthetic {
            guard preActionRealmPages[boundPageIdentity] != nil
            else { throw AccountFlowHelperError.causalBinding }
        }
        guard AXUIElementPerformAction(nextControl, kAXPressAction as CFString) == .success
        else { throw AccountFlowHelperError.nextEffect }
        if binding.isSynthetic {
            usleep(150_000)
            let emailRemovedAttested = oracleExactEmailControlIdentityRemoved(
                matchCount: 1,
                observedValue: string(emailControl, kAXValueAttribute as CFString),
                inheritedIdentity: email
            )
            try publish(outcome: "active", emailRemovedAttested: emailRemovedAttested)
            effectCompleted = true
            return
        }
        guard let successor = try exactCausalSuccessor(
            boundPageIdentity: boundPageIdentity, before: preActionRealmPages
        ) else { throw AccountFlowHelperError.clearingEffect }
        let emailRemovedAttested = exactEmailControlIdentityRemoved(
            on: successor, inheritedIdentity: email
        )
        try publish(
            outcome: classifyPostOutcome(successor),
            emailRemovedAttested: emailRemovedAttested
        )
        effectCompleted = true
    }
}
