import Foundation
import Darwin
import ApplicationServices

/// Internal, binding-scoped AX collaborator. Traversal is bounded and
/// cycle-safe, and exact lookups reject missing or ambiguous identities.
class OracleAccessibilityTree {
    let binding: NativeEmailOnlyBinding

    init(binding: NativeEmailOnlyBinding) {
        self.binding = binding
    }

    func string(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        if let text = value as? String { return text }
        if let url = value as? URL { return url.absoluteString }
        if let number = value as? NSNumber { return number.stringValue }
        return nil
    }

    func elements(_ root: AXUIElement) -> [AXUIElement] {
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

    func exact(_ all: [AXUIElement], id: String) throws -> AXUIElement {
        let matches = all.filter { string($0, "AXDOMIdentifier" as CFString) == id }
        guard matches.count == 1 else { throw AccountFlowHelperError.invalidBinding }
        return matches[0]
    }

    func digest(_ element: AXUIElement) -> String {
        let value = [kAXRoleAttribute as String, "AXDOMIdentifier", kAXTitleAttribute as String,
                     kAXDescriptionAttribute as String, kAXHelpAttribute as String,
                     kAXValueAttribute as String, kAXURLAttribute as String]
            .map { string(element, $0 as CFString) ?? "" }.joined(separator: "|")
        return NativeEmailOnlyBinding.fingerprint(value)
    }

    func reviewedFingerprint(_ element: AXUIElement) -> String {
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

    func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success,
              let values = names as? [String]
        else { return [] }
        return values
    }

    func required(_ element: AXUIElement) -> Bool {
        string(element, "AXRequired" as CFString) == "1"
    }

    func searchable(_ element: AXUIElement) -> String {
        [kAXTitleAttribute as String, kAXDescriptionAttribute as String,
         kAXHelpAttribute as String, "AXDOMIdentifier"]
            .compactMap { string(element, $0 as CFString) }
            .joined(separator: " ").lowercased()
    }

    func exact(_ all: [AXUIElement], fingerprint: String) throws -> AXUIElement {
        let matches = all.filter { reviewedFingerprint($0) == fingerprint }
        guard matches.count == 1 else { throw AccountFlowHelperError.invalidBinding }
        return matches[0]
    }

    func exactPage(_ all: [AXUIElement]) throws -> AXUIElement {
        let matches = all.filter {
            string($0, kAXRoleAttribute as CFString) == "AXWebArea"
                && string($0, kAXURLAttribute as CFString) == binding.portalURL
        }
        guard matches.count == 1 else { throw AccountFlowHelperError.invalidBinding }
        return matches[0]
    }

    func boundPage() throws -> AXUIElement {
        let application = AXUIElementCreateApplication(binding.browserProcessIdentifier)
        for _ in 0..<20 {
            if let page = try? exactPage(elements(application)) { return page }
            usleep(50_000)
        }
        throw AccountFlowHelperError.invalidBinding
    }
}
