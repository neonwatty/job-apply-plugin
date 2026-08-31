import Foundation
import CryptoKit
import Darwin
import AppKit
import ApplicationServices
import Security

enum AccountFlowHelperError: Error {
    case invalidBinding, privateChannel, effectFailed
    case emailEffect, termsEffect, nextEffect, clearingEffect
    case requestBinding, browserBinding, pageBinding, controlBinding, stateBinding, causalBinding
}

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

struct OracleReviewedControlShape {
    let secureCount: Int
    let emailCount: Int
    let termsCount: Int
    let documentCount: Int
    let nextCount: Int
    let textCount: Int
    let checkboxCount: Int
    let enabledButtonCount: Int
    let hasUnknownRequiredOrActionable: Bool

    var isExact: Bool {
        secureCount == 0 && emailCount == 1 && termsCount == 1
            && documentCount == 1 && nextCount == 1 && textCount == 1
            && checkboxCount == 1 && enabledButtonCount == 1
            && !hasUnknownRequiredOrActionable
    }
}

/// Executable, value-free regressions for the live fail-closed predicates.
func oracleAccountFlowAdversarialFixturesPass() -> Bool {
    let exact = OracleReviewedControlShape(
        secureCount: 0, emailCount: 1, termsCount: 1, documentCount: 1,
        nextCount: 1, textCount: 1, checkboxCount: 1, enabledButtonCount: 1,
        hasUnknownRequiredOrActionable: false
    )
    let unintendedEmail = OracleReviewedControlShape(
        secureCount: 0, emailCount: 2, termsCount: 1, documentCount: 1,
        nextCount: 1, textCount: 2, checkboxCount: 1, enabledButtonCount: 1,
        hasUnknownRequiredOrActionable: true
    )
    let extraRequired = OracleReviewedControlShape(
        secureCount: 0, emailCount: 1, termsCount: 1, documentCount: 1,
        nextCount: 1, textCount: 1, checkboxCount: 1, enabledButtonCount: 1,
        hasUnknownRequiredOrActionable: true
    )
    let extraAction = OracleReviewedControlShape(
        secureCount: 0, emailCount: 1, termsCount: 1, documentCount: 1,
        nextCount: 1, textCount: 1, checkboxCount: 1, enabledButtonCount: 2,
        hasUnknownRequiredOrActionable: true
    )
    let termsBefore = NativeEmailOnlyBinding.fingerprint("AXLink|terms|https://terms.invalid/v1")
    let termsAfter = NativeEmailOnlyBinding.fingerprint("AXLink|terms|https://terms.invalid/v2")
    return exact.isExact && !unintendedEmail.isExact && !extraRequired.isExact && !extraAction.isExact
        && termsBefore != termsAfter
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a", "other": "z"],
            after: ["bound": "b", "other": "z"]
        ) == .selected("bound")
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a", "other": "z"],
            after: ["replacement": "b", "other": "z"]
        ) == .selected("replacement")
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a", "other": "z"],
            after: ["bound": "a", "other": "changed"]
        ) == .ambiguous
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a"], after: ["bound": "a"]
        ) == .pending
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a"], after: [:]
        ) == .pending
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a"],
            after: ["first": "b", "second": "c"]
        ) == .ambiguous
        && oracleExactEmailControlIdentityRemoved(
            matchCount: 0, observedValue: nil, inheritedIdentity: "private@example.invalid"
        )
        && oracleExactEmailControlIdentityRemoved(
            matchCount: 1, observedValue: "", inheritedIdentity: "private@example.invalid"
        )
        && !oracleExactEmailControlIdentityRemoved(
            matchCount: 1, observedValue: "private@example.invalid",
            inheritedIdentity: "private@example.invalid"
        )
        && !oracleExactEmailControlIdentityRemoved(
            matchCount: 1, observedValue: nil, inheritedIdentity: "private@example.invalid"
        )
        && !oracleExactEmailControlIdentityRemoved(
            matchCount: 2, observedValue: "", inheritedIdentity: "private@example.invalid"
        )
}

struct NativeEmailOnlyBinding {
    let browserProcessIdentifier: pid_t
    let portalURL: String
    let realmReference: String
    let realmDescriptor: String
    let accountFormFingerprint: String
    let emailControlFingerprint: String
    let termsControlFingerprint: String
    let termsDocumentFingerprint: String
    let nextControlFingerprint: String
    let accountCreationControlsFingerprint: String
    let passwordControlFingerprint: String?
    let createAccountControlFingerprint: String?
    let jobRevision: Int
    let accountRevision: Int
    let settingsRevision: Int
    let operationFingerprint: String
    let nativeAttestationSocketPath: String

    static func fingerprint(_ value: String) -> String {
        "sha256:" + SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    var isSynthetic: Bool { URLComponents(string: portalURL)?.scheme == "http" }

    func validate() throws {
        guard browserProcessIdentifier > 1,
              realmReference.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              realmDescriptor.range(of: "^oracle-recruiting:v1:[a-z0-9-]+\\.fa\\.[a-z0-9-]+\\.oraclecloud\\.com:[a-z0-9][a-z0-9_-]*$", options: .regularExpression) != nil,
              Self.fingerprint(realmDescriptor).replacingOccurrences(of: "sha256:", with: "") == realmReference,
              operationFingerprint.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression) != nil,
              nativeAttestationSocketPath.hasPrefix("/"), nativeAttestationSocketPath.utf8.count <= 103,
              jobRevision > 0, accountRevision > 0, settingsRevision > 0,
              passwordControlFingerprint == nil, createAccountControlFingerprint == nil,
              let components = URLComponents(string: portalURL), let host = components.host,
              components.user == nil, components.password == nil, components.fragment == nil
        else { throw AccountFlowHelperError.invalidBinding }
        let loopback = components.scheme == "http" && host == "127.0.0.1" && components.port != nil
            && components.path == "/synthetic-oracle"
            && components.queryItems?.map(\.name) == ["operation"]
            && components.queryItems?.first?.value == operationFingerprint.replacingOccurrences(of: "sha256:", with: "")
        let live = components.scheme == "https"
            && (components.port == nil || components.port == 443)
            && components.query == nil
        guard loopback || live else { throw AccountFlowHelperError.invalidBinding }
        if live {
            let descriptorParts = realmDescriptor.split(separator: ":", omittingEmptySubsequences: false)
            let pathExpression = "^/hcmUI/CandidateExperience/[a-z]{2}(?:-[A-Z]{2})?/sites/([a-z0-9][a-z0-9_-]*)/job/[1-9][0-9]*(?:/apply/email)?/?$"
            guard descriptorParts.count == 4, String(descriptorParts[2]) == host,
                  let expression = try? NSRegularExpression(pattern: pathExpression),
                  let match = expression.firstMatch(in: components.path, range: NSRange(components.path.startIndex..., in: components.path)),
                  let siteRange = Range(match.range(at: 1), in: components.path),
                  String(descriptorParts[3]) == String(components.path[siteRange])
            else { throw AccountFlowHelperError.invalidBinding }
        }
        let values = [accountFormFingerprint, emailControlFingerprint,
                      termsControlFingerprint, termsDocumentFingerprint,
                      nextControlFingerprint]
        guard values.allSatisfy({ $0.range(of: "^sha256:[0-9a-f]{64}$", options: .regularExpression) != nil }),
              accountCreationControlsFingerprint == Self.fingerprint(values.joined(separator: ":"))
        else { throw AccountFlowHelperError.invalidBinding }
        if loopback {
            let expected = ["oracle-form:v1", "oracle-email:v1", "oracle-terms-control:v1",
                            "oracle-terms-document:v1", "oracle-next-non-final:v1"].map(Self.fingerprint)
            guard values == expected else { throw AccountFlowHelperError.invalidBinding }
        }
    }
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

private final class OracleEmailOnlyEffect {
    let binding: NativeEmailOnlyBinding
    init(binding: NativeEmailOnlyBinding) { self.binding = binding }

    private func string(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        if let text = value as? String { return text }
        if let url = value as? URL { return url.absoluteString }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    private func elements(_ root: AXUIElement) -> [AXUIElement] {
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

    private func exact(_ all: [AXUIElement], id: String) throws -> AXUIElement {
        let matches = all.filter { string($0, "AXDOMIdentifier" as CFString) == id }
        guard matches.count == 1 else { throw AccountFlowHelperError.invalidBinding }
        return matches[0]
    }

    private func digest(_ element: AXUIElement) -> String {
        let value = [kAXRoleAttribute as String, "AXDOMIdentifier", kAXTitleAttribute as String,
                     kAXDescriptionAttribute as String, kAXHelpAttribute as String,
                     kAXValueAttribute as String, kAXURLAttribute as String]
            .map { string(element, $0 as CFString) ?? "" }.joined(separator: "|")
        return NativeEmailOnlyBinding.fingerprint(value)
    }

    private func reviewedFingerprint(_ element: AXUIElement) -> String {
        let role = string(element, kAXRoleAttribute as CFString) ?? ""
        var attributes = [kAXRoleAttribute as String, "AXDOMIdentifier",
                          kAXTitleAttribute as String, kAXDescriptionAttribute as String,
                          kAXHelpAttribute as String, kAXURLAttribute as String]
        if role != (kAXTextFieldRole as String) && role != (kAXCheckBoxRole as String) {
            attributes.append(kAXValueAttribute as String)
        }
        return NativeEmailOnlyBinding.fingerprint(
            attributes.map { string(element, $0 as CFString) ?? "" }.joined(separator: "|")
        )
    }

    private func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success,
              let values = names as? [String]
        else { return [] }
        return values
    }

    private func required(_ element: AXUIElement) -> Bool {
        string(element, "AXRequired" as CFString) == "1"
    }

    private func searchable(_ element: AXUIElement) -> String {
        [kAXTitleAttribute as String, kAXDescriptionAttribute as String,
         kAXHelpAttribute as String, "AXDOMIdentifier"]
            .compactMap { string(element, $0 as CFString) }
            .joined(separator: " ").lowercased()
    }

    private func exact(_ all: [AXUIElement], fingerprint: String) throws -> AXUIElement {
        let matches = all.filter { reviewedFingerprint($0) == fingerprint }
        guard matches.count == 1 else { throw AccountFlowHelperError.invalidBinding }
        return matches[0]
    }

    private func exactPage(_ all: [AXUIElement]) throws -> AXUIElement {
        let matches = all.filter {
            string($0, kAXRoleAttribute as CFString) == "AXWebArea"
                && string($0, kAXURLAttribute as CFString) == binding.portalURL
        }
        guard matches.count == 1 else { throw AccountFlowHelperError.invalidBinding }
        return matches[0]
    }

    private func boundPage() throws -> AXUIElement {
        let application = AXUIElementCreateApplication(binding.browserProcessIdentifier)
        for _ in 0..<20 {
            if let page = try? exactPage(elements(application)) { return page }
            usleep(50_000)
        }
        throw AccountFlowHelperError.invalidBinding
    }

    private func exactAccountForm(_ page: AXUIElement) throws -> AXUIElement {
        let pageElements = elements(page)
        if binding.isSynthetic {
            let form = try exact(pageElements, id: "oracle-form:v1")
            guard let observedIdentifier = string(form, "AXDOMIdentifier" as CFString),
                  NativeEmailOnlyBinding.fingerprint(observedIdentifier) == binding.accountFormFingerprint
            else { throw AccountFlowHelperError.invalidBinding }
            return form
        }
        return try exact(pageElements, fingerprint: binding.accountFormFingerprint)
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
        guard path == executable, let text = trusted[path.path] else { return false }
        var requirement: SecRequirement?, staticCode: SecStaticCode?, dynamicCode: SecCode?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement,
              SecStaticCodeCreateWithPath(path as CFURL, [], &staticCode) == errSecSuccess, let staticCode,
              SecStaticCodeCheckValidity(staticCode, SecCSFlags(rawValue: (1 << 0) | (1 << 4)), requirement) == errSecSuccess,
              SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributePid as String: binding.browserProcessIdentifier] as CFDictionary, [], &dynamicCode) == errSecSuccess, let dynamicCode,
              SecCodeCheckValidity(dynamicCode, SecCSFlags(rawValue: 1 << 4), requirement) == errSecSuccess
        else { return false }
        return true
    }

    private func reviewedControls(_ form: AXUIElement) throws ->
        (email: AXUIElement, terms: AXUIElement, document: AXUIElement, next: AXUIElement) {
        let all = elements(form)
        let secure = all.filter { string($0, kAXSubroleAttribute as CFString) == (kAXSecureTextFieldSubrole as String) }
        let emails = all.filter {
            string($0, kAXRoleAttribute as CFString) == (kAXTextFieldRole as String)
                && searchable($0).contains("email")
        }
        let terms = all.filter {
            string($0, kAXRoleAttribute as CFString) == (kAXCheckBoxRole as String)
                && (searchable($0).contains("term") || searchable($0).contains("privacy"))
        }
        let next = all.filter {
            let label = searchable($0)
            return string($0, kAXRoleAttribute as CFString) == (kAXButtonRole as String)
                && (label.contains("next") || label.contains("continue"))
                && !label.contains("submit") && !label.contains("apply") && !label.contains("send")
        }
        let termDocuments = all.filter {
            let role = string($0, kAXRoleAttribute as CFString)
            return (role == "AXLink" || role == (kAXStaticTextRole as String))
                && (searchable($0).contains("term") || searchable($0).contains("privacy"))
        }
        let links = termDocuments.filter { string($0, kAXRoleAttribute as CFString) == "AXLink" }
        let documents = links.isEmpty ? termDocuments : links
        let allText = all.filter { string($0, kAXRoleAttribute as CFString) == (kAXTextFieldRole as String) }
        let allChecks = all.filter { string($0, kAXRoleAttribute as CFString) == (kAXCheckBoxRole as String) }
        let allEnabledButtons = all.filter {
            string($0, kAXRoleAttribute as CFString) == (kAXButtonRole as String)
                && string($0, kAXEnabledAttribute as CFString) != "0"
        }
        let reviewedIdentities = Set([emails.first, terms.first, documents.first, next.first]
            .compactMap { $0 }.map(CFHash))
        let unknownRequiredOrActionable = all.contains { element in
            guard !reviewedIdentities.contains(CFHash(element)) else { return false }
            let enabled = string(element, kAXEnabledAttribute as CFString) != "0"
            return required(element) || (enabled && !actionNames(element).isEmpty)
        }
        let shape = OracleReviewedControlShape(
            secureCount: secure.count, emailCount: emails.count, termsCount: terms.count,
            documentCount: documents.count, nextCount: next.count, textCount: allText.count,
            checkboxCount: allChecks.count, enabledButtonCount: allEnabledButtons.count,
            hasUnknownRequiredOrActionable: unknownRequiredOrActionable
        )
        guard shape.isExact
        else { throw AccountFlowHelperError.invalidBinding }
        return (emails[0], terms[0], documents[0], next[0])
    }

    func prepare() throws -> [String: Any] {
        guard !binding.isSynthetic, kill(binding.browserProcessIdentifier, 0) == 0,
              signedBrowser(), AXIsProcessTrusted(),
              let running = NSRunningApplication(processIdentifier: binding.browserProcessIdentifier),
              running.activate(options: [.activateAllWindows])
        else { throw AccountFlowHelperError.invalidBinding }
        usleep(150_000)
        let page = try boundPage()
        let candidates = elements(page).filter {
            let role = string($0, kAXRoleAttribute as CFString)
            guard role == "AXGroup" || role == "AXForm" else { return false }
            return (try? reviewedControls($0)) != nil
        }
        let measured = candidates.map { ($0, elements($0).count) }
        guard let minimum = measured.map(\.1).min() else { throw AccountFlowHelperError.invalidBinding }
        let narrowest = measured.filter { $0.1 == minimum }
        guard narrowest.count == 1 else { throw AccountFlowHelperError.invalidBinding }
        let form = narrowest[0].0, controls = try reviewedControls(form)
        let values = [reviewedFingerprint(form), reviewedFingerprint(controls.email),
                      reviewedFingerprint(controls.terms), reviewedFingerprint(controls.document),
                      reviewedFingerprint(controls.next)]
        return [
            "accountFormFingerprint": values[0], "emailControlFingerprint": values[1],
            "termsControlFingerprint": values[2], "termsDocumentFingerprint": values[3],
            "nextControlFingerprint": values[4],
            "accountCreationControlsFingerprint": NativeEmailOnlyBinding.fingerprint(values.joined(separator: ":")),
            "unknownRequiredControlsPresent": false, "credentialControlsPresent": false,
        ]
    }

    private func connectedChannel() throws -> Int32 {
        let bytes = Array(binding.nativeAttestationSocketPath.utf8CString)
        guard bytes.count <= 104 else { throw AccountFlowHelperError.invalidBinding }
        let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw AccountFlowHelperError.effectFailed }
        var address = sockaddr_un(); address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size); address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.initializeMemory(as: UInt8.self, repeating: 0)
            _ = bytes.withUnsafeBytes { memcpy(destination.baseAddress!, $0.baseAddress!, bytes.count) }
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else { Darwin.close(descriptor); throw AccountFlowHelperError.effectFailed }
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
        var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); data.append(0x0a)
        let descriptor = try connectedChannel(); defer { Darwin.close(descriptor) }
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
        let reattestedForm = try exactAccountForm(page)
        let reattestedEmail = binding.isSynthetic
            ? try exact(elements(reattestedForm), id: "job-apply-email-control")
            : try reviewedControls(reattestedForm).email
        guard CFEqual(reattestedEmail, exactControl),
              binding.isSynthetic || reviewedFingerprint(reattestedEmail) == binding.emailControlFingerprint,
              string(reattestedEmail, kAXValueAttribute as CFString) == email
        else { throw AccountFlowHelperError.emailEffect }
    }

    func perform(email: String) throws {
        guard kill(binding.browserProcessIdentifier, 0) == 0, signedBrowser(), AXIsProcessTrusted(),
              let running = NSRunningApplication(processIdentifier: binding.browserProcessIdentifier),
              running.activate(options: [.activateAllWindows])
        else { throw AccountFlowHelperError.browserBinding }
        usleep(150_000)
        let page: AXUIElement
        do {
            page = try boundPage()
        } catch {
            throw AccountFlowHelperError.pageBinding
        }
        let pageElements = elements(page)
        guard pageElements.filter({ string($0, kAXSubroleAttribute as CFString) == (kAXSecureTextFieldSubrole as String) }).isEmpty
        else { throw AccountFlowHelperError.controlBinding }
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
        guard string(emailControl, kAXValueAttribute as CFString) == "" else { throw AccountFlowHelperError.emailEffect }
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
            guard preActionRealmPages[boundPageIdentity] != nil else { throw AccountFlowHelperError.causalBinding }
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
        )
        else { throw AccountFlowHelperError.clearingEffect }
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
