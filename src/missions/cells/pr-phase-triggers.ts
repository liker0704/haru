/**
 * PR-phase trigger string-literal union.
 *
 * TODO(w3-builder): replace with the canonical list per spec §6.
 * Tester stub: empty list keeps test compile clean while RED-phase assertions
 * fail at runtime.
 */
export const PR_PHASE_TRIGGERS = [] as const;

export type PrPhaseTrigger = (typeof PR_PHASE_TRIGGERS)[number];
