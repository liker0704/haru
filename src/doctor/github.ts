import type { DoctorCheck, DoctorCheckFn } from "./types.ts";

/** Result of probing the `gh` CLI. Injectable to keep tests free of real subprocess calls. */
export type GhProbe = (
	args: string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Dependencies for {@link makeCheckGithub}. */
export interface CheckGithubDeps {
	runGhProbe?: GhProbe;
}

const defaultGhProbe: GhProbe = async (args) => {
	try {
		const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;
		return { stdout, stderr, exitCode };
	} catch (err) {
		return { exitCode: 127, stdout: "", stderr: String(err) };
	}
};

export function makeCheckGithub(deps?: CheckGithubDeps): DoctorCheckFn {
	const probe = deps?.runGhProbe ?? defaultGhProbe;

	return async (config, _overstoryDir) => {
		const checks: DoctorCheck[] = [];
		const pr = config.pr;

		const ghResult = await probe(["auth", "status"]);
		if (ghResult.exitCode !== 0) {
			checks.push({
				name: "GitHub auth",
				category: "config",
				status: "warn",
				message: "gh auth status failed — run 'gh auth login' to authenticate",
				details: ghResult.stderr ? [ghResult.stderr] : undefined,
			});
		} else {
			checks.push({
				name: "GitHub auth",
				category: "config",
				status: "pass",
				message: "gh authenticated",
			});
		}

		const prEnabled = pr?.enabled !== false;

		if (prEnabled) {
			if (!pr?.operatorGithubLogin) {
				checks.push({
					name: "PR operator login",
					category: "config",
					status: "fail",
					message:
						"pr.operatorGithubLogin is not set — silent comment-approval is disabled. Set pr.operatorGithubLogin to enable it.",
				});

				if (!pr?.commentTriageAuthors) {
					checks.push({
						name: "PR comment triage authors",
						category: "config",
						status: "warn",
						message:
							"pr.commentTriageAuthors is not set and pr.operatorGithubLogin is missing — comment triage will be limited",
					});
				}
			} else {
				checks.push({
					name: "PR operator login",
					category: "config",
					status: "pass",
					message: `PR operator login set to '${pr.operatorGithubLogin}'`,
				});
			}
		}

		if (pr?.directTierIncludesPr === true && !pr?.operatorGithubLogin) {
			checks.push({
				name: "PR direct-tier opt-in",
				category: "config",
				status: "fail",
				message:
					"pr.directTierIncludesPr is true but pr.operatorGithubLogin is not set — direct-tier PR opt-in requires an operator login",
			});
		}

		const rpm = pr?.ghBudget?.rpm;
		if (rpm !== undefined && rpm > 5000) {
			checks.push({
				name: "gh-budget rpm sanity",
				category: "config",
				status: "warn",
				message: `pr.ghBudget.rpm is ${rpm}, which exceeds GitHub's 5000/hr API cap`,
			});
		}

		return checks;
	};
}

/** Default {@link DoctorCheckFn} that runs the GitHub checks against the real `gh` CLI. */
export const checkGithub: DoctorCheckFn = makeCheckGithub();
