import Foundation
import Darwin

@main
enum WorkdayAccountFlowMain {
    static func main() throws {
        let arguments = CommandLine.arguments
        guard arguments.count > 1 else { return }
        switch arguments[1] {
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
                try MacOSWorkdayAccountFlowHelper().execute(binding, privateEmailDescriptor: privateDescriptor)
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
