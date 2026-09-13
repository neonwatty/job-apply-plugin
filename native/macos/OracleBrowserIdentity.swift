import Foundation
import Darwin
import AppKit
import ApplicationServices
import Security

/// Closed, value-free substages for the signed-browser identity proof. These
/// cases identify only which predicate failed; they never carry an observed
/// path, signing value, process metadata, or other mutable/private state.
enum OracleBrowserIdentitySubstage: Int, Error {
    case processExecutable = 38
    case runningApplication = 39
    case runningExecutable = 40
    case processRunningMismatch = 41
    case trustedBrowser = 42
    case requirement = 43
    case staticCode = 44
    case staticValidity = 45
    case dynamicCode = 46
    case dynamicValidity = 47
    case literalAnchorUnproven = 48
    case secondProofChanged = 49
    case processIdentityUnavailable = 50
    case runningIdentityUnavailable = 51
    case processLiteralAnchorOnly = 52
    case runningLiteralAnchorOnly = 53
    case noLiteralAnchorMatch = 54
    case literalAnchorMatchAmbiguous = 55
}

extension OracleAccessibilityTree {
    func signedBrowserIdentityFailure() -> OracleBrowserIdentitySubstage? {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN * 4))
        guard proc_pidpath(binding.browserProcessIdentifier, &buffer, UInt32(buffer.count)) > 0
        else { return .processExecutable }
        guard let running = NSRunningApplication(processIdentifier: binding.browserProcessIdentifier)
        else { return .runningApplication }
        guard let executable = running.executableURL
        else { return .runningExecutable }
        let processPath = String(cString: buffer)
        let trusted = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome": "identifier \"com.google.Chrome\" and anchor apple generic and certificate leaf[subject.OU] = \"EQHXZ8M8AV\"",
            "/Applications/Safari.app/Contents/MacOS/Safari": "identifier \"com.apple.Safari\" and anchor apple",
        ]
        let initialProof = oracleTrustedExecutableProofDecision(
            processPath: processPath, runningPath: executable.path, trusted: trusted
        )
        let proof: OracleTrustedExecutableProof
        switch initialProof {
        case .processIdentityUnavailable:
            return .processIdentityUnavailable
        case .runningIdentityUnavailable:
            return .runningIdentityUnavailable
        case .processRunningMismatch:
            return .processRunningMismatch
        case .processLiteralAnchorOnly:
            return .processLiteralAnchorOnly
        case .runningLiteralAnchorOnly:
            return .runningLiteralAnchorOnly
        case .noLiteralAnchorMatch:
            return .noLiteralAnchorMatch
        case .literalAnchorMatchAmbiguous:
            return .literalAnchorMatchAmbiguous
        case .literalAnchorUnproven:
            return .literalAnchorUnproven
        case .proven(let establishedProof):
            proof = establishedProof
        }
        guard let text = trusted[proof.literalPath], text == proof.requirement
        else { return .trustedBrowser }
        let path = URL(fileURLWithPath: proof.literalPath)
        var requirement: SecRequirement?, staticCode: SecStaticCode?, dynamicCode: SecCode?
        guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess,
              let requirement else { return .requirement }
        guard SecStaticCodeCreateWithPath(path as CFURL, [], &staticCode) == errSecSuccess,
              let staticCode else { return .staticCode }
        guard SecStaticCodeCheckValidity(
            staticCode, SecCSFlags(rawValue: (1 << 0) | (1 << 4)), requirement
        ) == errSecSuccess else { return .staticValidity }
        guard SecCodeCopyGuestWithAttributes(
            nil, [kSecGuestAttributePid as String: binding.browserProcessIdentifier] as CFDictionary,
            [], &dynamicCode
        ) == errSecSuccess, let dynamicCode else { return .dynamicCode }
        guard SecCodeCheckValidity(
            dynamicCode, SecCSFlags(rawValue: 1 << 4), requirement
        ) == errSecSuccess else { return .dynamicValidity }
        var confirmedBuffer = [CChar](repeating: 0, count: Int(MAXPATHLEN * 4))
        guard proc_pidpath(
            binding.browserProcessIdentifier, &confirmedBuffer, UInt32(confirmedBuffer.count)
        ) > 0 else { return .processExecutable }
        guard let confirmedRunning = NSRunningApplication(
            processIdentifier: binding.browserProcessIdentifier
        ) else { return .runningApplication }
        guard let confirmedExecutable = confirmedRunning.executableURL
        else { return .runningExecutable }
        guard oracleSecondExecutableProofMatches(
            proof,
            oracleTrustedExecutableProofDecision(
                processPath: String(cString: confirmedBuffer),
                runningPath: confirmedExecutable.path,
                trusted: trusted
            )
        ) else { return .secondProofChanged }
        return nil
    }

    func activateReviewedBrowser() throws {
        // A freshly launched signed browser can briefly exist before AppKit and
        // Security.framework expose a consistent running/active view. Poll only
        // this pre-effect proof; no form control is read or mutated here.
        for _ in 0..<100 {
            if kill(binding.browserProcessIdentifier, 0) == 0,
               AXIsProcessTrusted(), signedBrowserIdentityFailure() == nil,
               let running = NSRunningApplication(
                    processIdentifier: binding.browserProcessIdentifier
               ), running.activate(options: [.activateAllWindows]) {
                return
            }
            usleep(50_000)
        }
        guard kill(binding.browserProcessIdentifier, 0) == 0,
              NSRunningApplication(processIdentifier: binding.browserProcessIdentifier) != nil
        else { throw AccountFlowHelperError.browserProcessBinding }
        guard AXIsProcessTrusted() else { throw AccountFlowHelperError.accessibilityBinding }
        if let substage = signedBrowserIdentityFailure() {
            throw AccountFlowHelperError.browserIdentityBinding(substage)
        }
        throw AccountFlowHelperError.activationBinding
    }
}
