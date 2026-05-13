import type { DoctorCheckFn } from "./types.ts";

/** Result of probing the `gh` CLI. Injectable to keep tests free of real subprocess calls. */
export type GhProbe = (
	args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Dependencies for {@link makeCheckGithub}. */
export interface CheckGithubDeps {
	runGhProbe?: GhProbe;
}

/**
 * Factory for the GitHub doctor check. Builders fill in real check logic in W9 GREEN.
 *
 * RED-phase stub: returns an empty list so the suite compiles. All assertions
 * about specific checks will fail until the builder populates this function.
 */
export function makeCheckGithub(_deps?: CheckGithubDeps): DoctorCheckFn {
	return async () => [];
}

/** Default {@link DoctorCheckFn} that runs the GitHub checks against the real `gh` CLI. */
export const checkGithub: DoctorCheckFn = makeCheckGithub();
