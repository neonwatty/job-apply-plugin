import Foundation

/// Quietly exercises the executable-identity proof using synthetic identities.
/// This lives with the reviewed production proof so every production entrypoint
/// can compile independently of test-support sources.
func oracleExecutableIdentityAdversarialFixturesPass() -> Bool {
    let reviewed = OracleExecutableFileIdentity(device: 7, inode: 11)
    let other = OracleExecutableFileIdentity(device: 7, inode: 12)
    let changed = OracleExecutableFileIdentity(device: 8, inode: 11)
    let trusted = [
        "/literal/reviewed": "reviewed requirement",
        "/literal/other": "other requirement",
    ]
    guard let exact = oracleUniqueTrustedExecutableProof(
        processIdentity: reviewed, runningIdentity: reviewed,
        literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
        trusted: trusted
    ) else { return false }
    return exact == OracleTrustedExecutableProof(
        literalPath: "/literal/reviewed", requirement: "reviewed requirement", identity: reviewed
    )
        && oracleTrustedExecutableProofDecision(
            processIdentity: nil, runningIdentity: reviewed,
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
            trusted: trusted
        ) == .processIdentityUnavailable
        && oracleTrustedExecutableProofDecision(
            processIdentity: reviewed, runningIdentity: nil,
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
            trusted: trusted
        ) == .runningIdentityUnavailable
        && oracleTrustedExecutableProofDecision(
            processIdentity: reviewed, runningIdentity: changed,
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
            trusted: trusted
        ) == .processLiteralAnchorOnly
        && oracleTrustedExecutableProofDecision(
            processIdentity: changed, runningIdentity: reviewed,
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
            trusted: trusted
        ) == .runningLiteralAnchorOnly
        && oracleTrustedExecutableProofDecision(
            processIdentity: changed,
            runningIdentity: OracleExecutableFileIdentity(device: 8, inode: 12),
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
            trusted: trusted
        ) == .noLiteralAnchorMatch
        && oracleTrustedExecutableProofDecision(
            processIdentity: reviewed, runningIdentity: other,
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": other],
            trusted: trusted
        ) == .literalAnchorMatchAmbiguous
        && oracleTrustedExecutableProofDecision(
            processIdentity: reviewed, runningIdentity: reviewed,
            literalAnchorIdentities: ["/literal/reviewed": nil, "/literal/other": other],
            trusted: trusted
        ) == .literalAnchorUnproven
        && oracleTrustedExecutableProofDecision(
            processIdentity: reviewed, runningIdentity: reviewed,
            literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": reviewed],
            trusted: trusted
        ) == .literalAnchorUnproven
        && !oracleSecondExecutableProofMatches(
            exact,
            oracleTrustedExecutableProofDecision(
                processIdentity: changed, runningIdentity: changed,
                literalAnchorIdentities: ["/literal/reviewed": changed, "/literal/other": other],
                trusted: trusted
            )
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

/// Quietly proves that both native entry paths reject a query-bearing live
/// Oracle URL before accessibility or private-channel work can begin.
func oracleQueryBearingLivePortalRejectionsPass() -> Bool {
    let descriptor = "oracle-recruiting:v1:tenant.fa.us2.oraclecloud.com:jobsearch"
    let realmReference = NativeEmailOnlyBinding.fingerprint(descriptor)
        .replacingOccurrences(of: "sha256:", with: "")
    let portalURL = "https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/7/apply/email?candidate=unexpected"
    let placeholder = NativeEmailOnlyBinding.fingerprint("query-rejection-placeholder")
    let aggregate = NativeEmailOnlyBinding.fingerprint(
        [placeholder, placeholder, placeholder, placeholder, placeholder]
            .joined(separator: ":")
    )
    let binding = NativeEmailOnlyBinding(
        browserProcessIdentifier: 2, portalURL: portalURL,
        realmReference: realmReference, realmDescriptor: descriptor,
        accountFormFingerprint: placeholder, emailControlFingerprint: placeholder,
        termsControlFingerprint: placeholder, termsDocumentFingerprint: placeholder,
        nextControlFingerprint: placeholder, accountCreationControlsFingerprint: aggregate,
        passwordControlFingerprint: nil, createAccountControlFingerprint: nil,
        jobRevision: 1, accountRevision: 1, settingsRevision: 1,
        operationFingerprint: placeholder,
        nativeAttestationSocketPath: "/tmp/job-apply-query-rejection"
    )

    do {
        _ = try MacOSAccessibilityAccountFlowHelper().prepare(
            browserProcessIdentifier: 2, portalURL: portalURL,
            realmReference: realmReference, realmDescriptor: descriptor
        )
        return false
    } catch AccountFlowHelperError.invalidBinding {
        // Expected before the preparation path can inspect a browser.
    } catch {
        return false
    }

    do {
        try MacOSAccessibilityAccountFlowHelper().execute(
            binding, privateEmailDescriptor: -1
        )
        return false
    } catch AccountFlowHelperError.requestBinding {
        // Expected before the execution path can read the private descriptor.
        return true
    } catch {
        return false
    }
}

/// Executable, value-free regressions for the live fail-closed predicates.
func oracleAccountFlowAdversarialFixturesPass() -> Bool {
    let exact = OracleReviewedControlShape(
        secureCount: 0, emailCount: 1, termsCount: 1, documentCount: 1,
        nextCount: 1, textCount: 1, checkboxCount: 1, enabledButtonCount: 1,
        hasUnknownRequiredOrActionable: false
    )
    let unintendedEmail = OracleReviewedControlShape(
        secureCount: 0, emailCount: 2, termsCount: 1, documentCount: 1,
        nextCount: 1, textCount: 2, checkboxCount: 1, enabledButtonCount: 1,
        hasUnknownRequiredOrActionable: true
    )
    let extraRequired = OracleReviewedControlShape(
        secureCount: 0, emailCount: 1, termsCount: 1, documentCount: 1,
        nextCount: 1, textCount: 1, checkboxCount: 1, enabledButtonCount: 1,
        hasUnknownRequiredOrActionable: true
    )
    let extraAction = OracleReviewedControlShape(
        secureCount: 0, emailCount: 1, termsCount: 1, documentCount: 1,
        nextCount: 1, textCount: 1, checkboxCount: 1, enabledButtonCount: 2,
        hasUnknownRequiredOrActionable: true
    )
    let termsBefore = NativeEmailOnlyBinding.fingerprint("AXLink|terms|https://terms.invalid/v1")
    let termsAfter = NativeEmailOnlyBinding.fingerprint("AXLink|terms|https://terms.invalid/v2")
    return oracleQueryBearingLivePortalRejectionsPass()
        && oracleExecutableIdentityAdversarialFixturesPass()
        && exact.isExact && !unintendedEmail.isExact && !extraRequired.isExact && !extraAction.isExact
        && termsBefore != termsAfter
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a", "other": "z"],
            after: ["bound": "b", "other": "z"]
        ) == .selected("bound")
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a", "other": "z"],
            after: ["replacement": "b", "other": "z"]
        ) == .selected("replacement")
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a", "other": "z"],
            after: ["bound": "a", "other": "changed"]
        ) == .ambiguous
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a"], after: ["bound": "a"]
        ) == .pending
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a"], after: [:]
        ) == .pending
        && oracleCausalSuccessorDecision(
            boundPage: "bound", before: ["bound": "a"],
            after: ["first": "b", "second": "c"]
        ) == .ambiguous
        && oracleExactEmailControlIdentityRemoved(
            matchCount: 0, observedValue: nil, inheritedIdentity: "private@example.invalid"
        )
        && oracleExactEmailControlIdentityRemoved(
            matchCount: 1, observedValue: "", inheritedIdentity: "private@example.invalid"
        )
        && !oracleExactEmailControlIdentityRemoved(
            matchCount: 1, observedValue: "private@example.invalid",
            inheritedIdentity: "private@example.invalid"
        )
        && !oracleExactEmailControlIdentityRemoved(
            matchCount: 1, observedValue: nil, inheritedIdentity: "private@example.invalid"
        )
        && !oracleExactEmailControlIdentityRemoved(
            matchCount: 2, observedValue: "", inheritedIdentity: "private@example.invalid"
        )
}
