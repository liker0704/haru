export interface SpawnResult {
	spawned: boolean;
	reason?: string;
}

export interface SpawnDeps {
	spawn?: typeof Bun.spawn;
}

export interface SpawnEphemeralAgentOptions {
	capability: string;
	agentName: string;
	projectRoot?: string;
	extraArgs?: string[];
}

export function spawnEphemeralAgent(
	opts: SpawnEphemeralAgentOptions,
	deps: SpawnDeps = {},
): SpawnResult {
	const spawn = deps.spawn ?? Bun.spawn;
	try {
		const proc = spawn(
			[
				"ha",
				"sling",
				opts.capability,
				"--capability",
				opts.capability,
				"--name",
				opts.agentName,
				"--depth",
				"0",
				"--skip-task-check",
				"--json",
				...(opts.extraArgs ?? []),
			],
			{
				cwd: opts.projectRoot ?? process.cwd(),
				stdout: "pipe",
				stderr: "pipe",
				detached: true,
			},
		);
		proc.unref();
		return { spawned: true };
	} catch (err) {
		return { spawned: false, reason: err instanceof Error ? err.message : String(err) };
	}
}
