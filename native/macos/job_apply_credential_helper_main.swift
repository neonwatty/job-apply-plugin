import Foundation

@main
enum IsolatedCredentialIntegrationMain {
    static func main() throws {
        let arguments = CommandLine.arguments
        let helper = MacOSProtectedCredentialHelper()
        if arguments.count == 1 { return }
        switch arguments[1] {
        case "reference":
            guard arguments.count == 5 else { throw ProtectedCredentialError.invalidBinding }
            let actual = try MacOSProtectedCredentialHelper.credentialReference(strategy: arguments[2], realmRef: arguments[3])
            guard actual == arguments[4] else { throw ProtectedCredentialError.invalidBinding }
        case "count":
            guard arguments.count == 4, let expected = Int(arguments[3]),
                  try helper.isolatedTestItemCount(isolatedNamespace: arguments[2]) == expected
            else { throw ProtectedCredentialError.invalidBinding }
        case "cleanup":
            guard arguments.count == 5 else { throw ProtectedCredentialError.invalidBinding }
            try helper.removeIsolatedTestItem(realmRef: arguments[3], strategy: arguments[2], isolatedNamespace: arguments[4])
        case "isolated-compound":
            guard arguments.count == 7 else { throw ProtectedCredentialError.invalidBinding }
            let strategy = arguments[2], realm = arguments[3], expectedReference = arguments[4], namespace = arguments[5]
            let expectedReused = arguments[6] == "reused"
            guard arguments[6] == "new" || expectedReused,
                  expectedReference == (try MacOSProtectedCredentialHelper.credentialReference(strategy: strategy, realmRef: realm))
            else { throw ProtectedCredentialError.invalidBinding }
            let sink = ClearingSyntheticSecureInput()
            let receipt = try helper.provisionOrReuseAndFill(strategy: strategy, realmRef: realm, isolatedNamespace: namespace, secureInput: sink)
            guard receipt.reused == expectedReused, receipt.filled, sink.invocationCount == 1 else {
                throw ProtectedCredentialError.invalidBinding
            }
        case "isolated-compound-fail":
            guard arguments.count == 6 else { throw ProtectedCredentialError.invalidBinding }
            let strategy = arguments[2], realm = arguments[3], expectedReference = arguments[4], namespace = arguments[5]
            guard expectedReference == (try MacOSProtectedCredentialHelper.credentialReference(strategy: strategy, realmRef: realm)) else {
                throw ProtectedCredentialError.invalidBinding
            }
            do {
                _ = try helper.provisionOrReuseAndFill(strategy: strategy, realmRef: realm, isolatedNamespace: namespace, secureInput: FailingSyntheticSecureInput())
                throw ProtectedCredentialError.invalidBinding
            } catch ProtectedCredentialError.secureInput {
                guard try helper.isolatedTestItemCount(isolatedNamespace: namespace) == 0 else {
                    throw ProtectedCredentialError.invalidBinding
                }
            }
        case "compound":
            guard arguments.count == 12, let browserPID = Int32(arguments[6]) else {
                throw ProtectedCredentialError.invalidBinding
            }
            let strategy = arguments[2]
            let realm = arguments[3]
            let expectedReference = arguments[4]
            let namespace = arguments[5]
            let target = arguments[7]
            let control = arguments[8]
            let operation = arguments[9]
            let expectedReused = arguments[10] == "reused"
            guard arguments[10] == "new" || expectedReused,
                  expectedReference == (try MacOSProtectedCredentialHelper.credentialReference(strategy: strategy, realmRef: realm))
            else { throw ProtectedCredentialError.invalidBinding }
            do {
                let bridge = try MacOSBrowserSecureInputBridge(expected: NativeBrowserBinding(
                    browserProcessIdentifier: browserPID, targetURL: target,
                    realmReference: realm, controlFingerprint: control,
                    operationFingerprint: operation,
                    nativeAttestationSocketPath: arguments[11]
                ))
                let receipt = try helper.provisionOrReuseAndFill(
                    strategy: strategy, realmRef: realm, isolatedNamespace: namespace,
                    secureInput: bridge
                )
                guard receipt.credentialReference == expectedReference,
                      receipt.reused == expectedReused, receipt.filled,
                      bridge.completedEffect
                else { throw ProtectedCredentialError.invalidBinding }
            } catch BrowserBridgeDiagnostic.failedClosed(let stage) {
                let status = [
                    "browser_process": 43, "browser_identity": 44,
                    "accessibility_trust": 45, "browser_activation": 46,
                    "focused_control": 47,
                ][stage] ?? 48
                Darwin.exit(Int32(status))
            } catch ProtectedCredentialError.invalidBinding {
                Darwin.exit(40)
            } catch ProtectedCredentialError.keychain {
                Darwin.exit(41)
            } catch ProtectedCredentialError.secureInput {
                Darwin.exit(42)
            }
        case "oracle-email-only":
            guard arguments.count == 18,
                  let browserPID = Int32(arguments[2]),
                  let jobRevision = Int(arguments[12]),
                  let accountRevision = Int(arguments[13]),
                  let settingsRevision = Int(arguments[14]),
                  let privateDescriptor = Int32(arguments[17]),
                  privateDescriptor > STDERR_FILENO
            else { throw ProtectedCredentialError.invalidBinding }
            let binding = NativeEmailOnlyBinding(
                browserProcessIdentifier: browserPID,
                portalURL: arguments[3], realmReference: arguments[4], realmDescriptor: arguments[5],
                accountFormFingerprint: arguments[6], emailControlFingerprint: arguments[7],
                termsControlFingerprint: arguments[8], termsDocumentFingerprint: arguments[9],
                nextControlFingerprint: arguments[10], accountCreationControlsFingerprint: arguments[11],
                passwordControlFingerprint: nil, createAccountControlFingerprint: nil,
                jobRevision: jobRevision, accountRevision: accountRevision,
                settingsRevision: settingsRevision, operationFingerprint: arguments[15],
                nativeAttestationSocketPath: arguments[16]
            )
            do {
                try MacOSAccessibilityAccountFlowHelper().execute(
                    binding, privateEmailDescriptor: privateDescriptor
                )
            } catch AccountFlowHelperError.invalidBinding {
                Darwin.exit(21)
            } catch AccountFlowHelperError.privateChannel {
                Darwin.exit(22)
            } catch AccountFlowHelperError.effectFailed {
                Darwin.exit(23)
            } catch AccountFlowHelperError.emailEffect {
                Darwin.exit(24)
            } catch AccountFlowHelperError.termsEffect {
                Darwin.exit(25)
            } catch AccountFlowHelperError.nextEffect {
                Darwin.exit(26)
            } catch AccountFlowHelperError.clearingEffect {
                Darwin.exit(27)
            } catch AccountFlowHelperError.requestBinding {
                Darwin.exit(28)
            } catch AccountFlowHelperError.browserBinding {
                Darwin.exit(29)
            } catch AccountFlowHelperError.pageBinding {
                Darwin.exit(30)
            } catch AccountFlowHelperError.controlBinding {
                Darwin.exit(31)
            } catch AccountFlowHelperError.stateBinding {
                Darwin.exit(32)
            } catch AccountFlowHelperError.causalBinding {
                Darwin.exit(33)
            } catch AccountFlowHelperError.browserProcessBinding {
                Darwin.exit(34)
            } catch AccountFlowHelperError.browserIdentityBinding {
                Darwin.exit(35)
            } catch AccountFlowHelperError.accessibilityBinding {
                Darwin.exit(36)
            } catch AccountFlowHelperError.activationBinding {
                Darwin.exit(37)
            }
        case "oracle-email-only-prepare":
            guard arguments.count == 6, let browserPID = Int32(arguments[2])
            else { throw ProtectedCredentialError.invalidBinding }
            let result = try MacOSAccessibilityAccountFlowHelper().prepare(
                browserProcessIdentifier: browserPID, portalURL: arguments[3],
                realmReference: arguments[4], realmDescriptor: arguments[5]
            )
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        case "oracle-email-only-adversarial-fixtures":
            guard arguments.count == 2, oracleAccountFlowAdversarialFixturesPass()
            else { throw ProtectedCredentialError.invalidBinding }
        case "workday-prepare":
            guard arguments.count == 6, let browserPID = Int32(arguments[2])
            else { throw ProtectedCredentialError.invalidBinding }
            let result = try MacOSWorkdayAccountFlowHelper().prepare(
                browserProcessIdentifier: browserPID, portalURL: arguments[3],
                realmReference: arguments[4], realmDescriptor: arguments[5]
            )
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        case "workday-account":
            guard arguments.count == 13, let browserPID = Int32(arguments[2]),
                  let privateDescriptor = Int32(arguments[12]), privateDescriptor > STDERR_FILENO
            else { throw ProtectedCredentialError.invalidBinding }
            let binding = NativeWorkdayBinding(
                browserProcessIdentifier: browserPID, portalURL: arguments[3],
                realmReference: arguments[4], realmDescriptor: arguments[5],
                accountFormFingerprint: arguments[6], emailControlFingerprint: arguments[7],
                passwordControlFingerprint: arguments[8], createAccountControlFingerprint: arguments[9],
                accountCreationControlsFingerprint: arguments[10], nativeAttestationSocketPath: arguments[11]
            )
            do {
                try MacOSWorkdayAccountFlowHelper().execute(
                    binding, privateEmailDescriptor: privateDescriptor
                )
            } catch {
                Darwin.exit(50)
            }
        case "workday-account-adversarial-fixtures":
            guard arguments.count == 2, workdayAccountAdversarialFixturesPass()
            else { throw ProtectedCredentialError.invalidBinding }
        default:
            throw ProtectedCredentialError.invalidBinding
        }
    }
}
