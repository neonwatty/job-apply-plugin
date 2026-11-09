type Answer = { key?: unknown; valueRedacted?: unknown; hasValue?: unknown; deletedAt?: unknown; redirectedFrom?: unknown };

export function answerNeedsFreshConsent(state: unknown, sensitivity: unknown, hasValue: unknown): boolean {
  return Boolean(hasValue) && (state === "sensitive" || sensitivity !== "none");
}

export function answerSummary(record: unknown): string {
  const answer = record as Answer;
  if (answer.valueRedacted) return "Sensitive value hidden — reveal explicitly to view";
  if (answer.hasValue) return "Value retained";
  return "No retained value";
}

export function canRevealAnswer(record: unknown): boolean {
  const answer = record as Answer | null | undefined;
  return Boolean(answer?.valueRedacted) && answer?.deletedAt == null;
}

export function canRefreshAnswerDraft(selected: unknown, latest: unknown): boolean {
  return Boolean(selected && latest && (selected as Answer).key === (latest as Answer).key);
}

export function canApplyAnswerReveal(selected: unknown, requestedKey: unknown, revealed: unknown): boolean {
  return Boolean(
    selected
    && revealed
    && (selected as Answer).key === requestedKey
    && (revealed as Answer).key === requestedKey
    && !(revealed as Answer).redirectedFrom
  );
}

export function canApplyAnswerDialogResponse(
  selected: unknown, requestedKey: unknown, requestSequence: unknown,
  currentSequence: unknown, dialogOpen: unknown = true,
): boolean {
  return Boolean(
    dialogOpen
    && selected
    && (selected as Answer).key === requestedKey
    && requestSequence === currentSequence
  );
}

export function canApplyAnswerDialogMutation(
  selected: unknown, requestedKey: unknown, requestGeneration: unknown,
  currentGeneration: unknown, dialogOpen: unknown = true,
): unknown {
  return dialogOpen
    && requestGeneration === currentGeneration
    && ((selected as Answer | null | undefined)?.key ?? null) === requestedKey;
}

export function answerApiPath(key: unknown, action: unknown = ""): string {
  const bytes = new TextEncoder().encode(String(key));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `/api/answers/by-key/${encoded}${action ? `/${action}` : ""}`;
}

export function sameAnswerScope(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
    return value;
  };
  return JSON.stringify(canonical(left || {})) === JSON.stringify(canonical(right || {}));
}
