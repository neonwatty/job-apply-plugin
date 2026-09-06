export function answerNeedsFreshConsent(state, sensitivity, hasValue) {
    return Boolean(hasValue) && (state === "sensitive" || sensitivity !== "none");
}
export function answerSummary(record) {
    const answer = record;
    if (answer.valueRedacted)
        return "Sensitive value hidden — reveal explicitly to view";
    if (answer.hasValue)
        return "Value retained";
    return "No retained value";
}
export function canRevealAnswer(record) {
    const answer = record;
    return Boolean(answer?.valueRedacted) && answer?.deletedAt == null;
}
export function canRefreshAnswerDraft(selected, latest) {
    return Boolean(selected && latest && selected.key === latest.key);
}
export function canApplyAnswerReveal(selected, requestedKey, revealed) {
    return Boolean(selected
        && revealed
        && selected.key === requestedKey
        && revealed.key === requestedKey
        && !revealed.redirectedFrom);
}
export function canApplyAnswerDialogResponse(selected, requestedKey, requestSequence, currentSequence, dialogOpen = true) {
    return Boolean(dialogOpen
        && selected
        && selected.key === requestedKey
        && requestSequence === currentSequence);
}
export function canApplyAnswerDialogMutation(selected, requestedKey, requestGeneration, currentGeneration, dialogOpen = true) {
    return dialogOpen
        && requestGeneration === currentGeneration
        && (selected?.key ?? null) === requestedKey;
}
export function answerApiPath(key, action = "") {
    const bytes = new TextEncoder().encode(String(key));
    let binary = "";
    for (const byte of bytes)
        binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    return `/api/answers/by-key/${encoded}${action ? `/${action}` : ""}`;
}
export function sameAnswerScope(left, right) {
    const canonical = (value) => {
        if (Array.isArray(value))
            return value.map(canonical);
        if (value && typeof value === "object")
            return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
        return value;
    };
    return JSON.stringify(canonical(left || {})) === JSON.stringify(canonical(right || {}));
}
