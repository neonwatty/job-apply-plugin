import Foundation

final class ClearingSyntheticSecureInput: NativeSecureInputBoundary {
    private(set) var invocationCount = 0
    func fillAndClear(_ generatedBytes: UnsafeRawBufferPointer) throws {
        guard generatedBytes.count == 32 else { throw ProtectedCredentialError.secureInput }
        invocationCount += 1
    }
}

final class FailingSyntheticSecureInput: NativeSecureInputBoundary {
    func fillAndClear(_ generatedBytes: UnsafeRawBufferPointer) throws {
        throw ProtectedCredentialError.secureInput
    }
}

// Runtime integration is intentionally opt-in and must use a fresh isolated
// namespace. Python tests enforce that this source has no output or process
// intermediary and that cleanup is present; ordinary validation only typechecks.
func isolatedHelperShape() -> Bool {
    let sink = ClearingSyntheticSecureInput()
    return sink.invocationCount == 0
}
