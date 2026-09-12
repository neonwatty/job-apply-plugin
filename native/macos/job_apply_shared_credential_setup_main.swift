import Darwin
import Foundation

@main
enum SharedCredentialSetupMain {
    @MainActor
    static func main() {
        do {
            let arguments = CommandLine.arguments
            guard arguments.count == 3 || arguments.count == 4,
                  let source = SharedCredentialSource(rawValue: arguments[2])
            else { throw ProtectedCredentialError.invalidBinding }
            let version: Int
            switch arguments[1] {
            case "setup":
                guard arguments.count == 3 else { throw ProtectedCredentialError.invalidBinding }
                version = 1
            case "rotate":
                guard arguments.count == 4, let parsed = Int(arguments[3]), parsed >= 2
                else { throw ProtectedCredentialError.invalidBinding }
                version = parsed
            default:
                throw ProtectedCredentialError.invalidBinding
            }
            let receipt = try NativeSharedCredentialSetup().create(
                source: source, credentialVersion: version
            )
            let output: [String: Any] = [
                "credentialRef": receipt.credentialReference,
                "credentialVersion": receipt.credentialVersion,
                "status": "created",
            ]
            let data = try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        } catch SharedCredentialSetupError.cancelled {
            Darwin.exit(64)
        } catch ProtectedCredentialError.slotAlreadyExists {
            Darwin.exit(65)
        } catch {
            Darwin.exit(66)
        }
    }
}
