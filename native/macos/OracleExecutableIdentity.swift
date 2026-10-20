import Foundation
import Darwin

struct OracleExecutableFileIdentity: Equatable {
    let device: dev_t
    let inode: ino_t
}

struct OracleTrustedExecutableProof: Equatable {
    let literalPath: String
    let requirement: String
    let identity: OracleExecutableFileIdentity
}

enum OracleTrustedExecutableProofDecision: Equatable {
    case processIdentityUnavailable
    case runningIdentityUnavailable
    case processRunningMismatch
    case processLiteralAnchorOnly
    case runningLiteralAnchorOnly
    case noLiteralAnchorMatch
    case literalAnchorMatchAmbiguous
    case literalAnchorUnproven
    case proven(OracleTrustedExecutableProof)
}

func oracleRegularExecutableIdentity(atPath path: String) -> OracleExecutableFileIdentity? {
    var metadata = stat()
    guard path.withCString({ fstatat(AT_FDCWD, $0, &metadata, 0) }) == 0,
          metadata.st_mode & S_IFMT == S_IFREG
    else { return nil }
    return OracleExecutableFileIdentity(device: metadata.st_dev, inode: metadata.st_ino)
}

func oracleTrustedExecutableProofDecision(
    processIdentity: OracleExecutableFileIdentity?,
    runningIdentity: OracleExecutableFileIdentity?,
    literalAnchorIdentities: [String: OracleExecutableFileIdentity?],
    trusted: [String: String]
) -> OracleTrustedExecutableProofDecision {
    guard let processIdentity else { return .processIdentityUnavailable }
    guard let runningIdentity else { return .runningIdentityUnavailable }
    guard processIdentity == runningIdentity else {
        let processMatches = trusted.keys.filter { literalPath in
            guard let anchorIdentity = literalAnchorIdentities[literalPath] ?? nil
            else { return false }
            return anchorIdentity == processIdentity
        }.count
        let runningMatches = trusted.keys.filter { literalPath in
            guard let anchorIdentity = literalAnchorIdentities[literalPath] ?? nil
            else { return false }
            return anchorIdentity == runningIdentity
        }.count
        switch (processMatches, runningMatches) {
        case (1, 0):
            return .processLiteralAnchorOnly
        case (0, 1):
            return .runningLiteralAnchorOnly
        case (0, 0):
            return .noLiteralAnchorMatch
        default:
            return .literalAnchorMatchAmbiguous
        }
    }
    let matches = trusted.compactMap { literalPath, requirement -> OracleTrustedExecutableProof? in
        guard let anchorIdentity = literalAnchorIdentities[literalPath] ?? nil,
              anchorIdentity == processIdentity
        else { return nil }
        return OracleTrustedExecutableProof(
            literalPath: literalPath, requirement: requirement, identity: anchorIdentity
        )
    }
    guard matches.count == 1 else { return .literalAnchorUnproven }
    return .proven(matches[0])
}

func oracleUniqueTrustedExecutableProof(
    processIdentity: OracleExecutableFileIdentity?,
    runningIdentity: OracleExecutableFileIdentity?,
    literalAnchorIdentities: [String: OracleExecutableFileIdentity?],
    trusted: [String: String]
) -> OracleTrustedExecutableProof? {
    guard case .proven(let proof) = oracleTrustedExecutableProofDecision(
        processIdentity: processIdentity,
        runningIdentity: runningIdentity,
        literalAnchorIdentities: literalAnchorIdentities,
        trusted: trusted
    ) else { return nil }
    return proof
}

func oracleTrustedExecutableProofDecision(
    processPath: String, runningPath: String, trusted: [String: String]
) -> OracleTrustedExecutableProofDecision {
    oracleTrustedExecutableProofDecision(
        processIdentity: oracleRegularExecutableIdentity(atPath: processPath),
        runningIdentity: oracleRegularExecutableIdentity(atPath: runningPath),
        literalAnchorIdentities: Dictionary(
            uniqueKeysWithValues: trusted.keys.map {
                ($0, oracleRegularExecutableIdentity(atPath: $0))
            }
        ),
        trusted: trusted
    )
}

func oracleSecondExecutableProofMatches(
    _ first: OracleTrustedExecutableProof,
    _ second: OracleTrustedExecutableProofDecision
) -> Bool {
    guard case .proven(let proof) = second else { return false }
    return proof == first
}
