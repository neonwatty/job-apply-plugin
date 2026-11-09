import Foundation
import CryptoKit
import Darwin

enum AccountFlowHelperError: Error {
    case invalidBinding, privateChannel, effectFailed
    case emailEffect, termsEffect, nextEffect, clearingEffect
    case requestBinding, browserBinding, pageBinding, controlBinding, stateBinding, causalBinding
    case browserProcessBinding, browserIdentityBinding(OracleBrowserIdentitySubstage)
    case accessibilityBinding, activationBinding
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
