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

func oracleExecutableIdentityAdversarialFixturesPass() -> Bool {
    let reviewed = OracleExecutableFileIdentity(device: 7, inode: 11)
    let other = OracleExecutableFileIdentity(device: 7, inode: 12)
    let changed = OracleExecutableFileIdentity(device: 8, inode: 11)
    let trusted = [
        "/literal/reviewed": "reviewed requirement",
        "/literal/other": "other requirement",
    ]
    let exact = oracleUniqueTrustedExecutableProof(
        processIdentity: reviewed, runningIdentity: reviewed,
        literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
        trusted: trusted
    )
    return exact == OracleTrustedExecutableProof(
        literalPath: "/literal/reviewed", requirement: "reviewed requirement", identity: reviewed
    )
        && oracleUniqueTrustedExecutableProof(
            processIdentity: reviewed, runningIdentity: other,
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
            trusted: trusted
        ) == nil
        && oracleUniqueTrustedExecutableProof(
            processIdentity: reviewed, runningIdentity: reviewed,
            literalAnchorIdentities: ["/literal/reviewed": nil, "/literal/other": other],
            trusted: trusted
        ) == nil
        && oracleUniqueTrustedExecutableProof(
            processIdentity: reviewed, runningIdentity: reviewed,
            literalAnchorIdentities: ["/literal/reviewed": other, "/literal/other": other],
            trusted: trusted
        ) == nil
        && oracleUniqueTrustedExecutableProof(
            processIdentity: reviewed, runningIdentity: reviewed,
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": reviewed],
            trusted: trusted
        ) == nil
        && exact != oracleUniqueTrustedExecutableProof(
            processIdentity: changed, runningIdentity: changed,
            literalAnchorIdentities: ["/literal/reviewed": changed, "/literal/other": other],
            trusted: trusted
        )
}
