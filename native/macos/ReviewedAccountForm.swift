import Foundation
import Darwin
import ApplicationServices

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

extension OracleAccessibilityTree {
    func exactAccountForm(_ page: AXUIElement) throws -> AXUIElement {
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

    func reviewedControls(_ form: AXUIElement) throws ->
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
        guard !binding.isSynthetic else { throw AccountFlowHelperError.invalidBinding }
        try activateReviewedBrowser()
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
}
