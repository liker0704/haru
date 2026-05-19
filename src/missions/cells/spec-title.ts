/**
 * Extracts a display title from a product-spec.md body.
 * Priority: (1) first non-empty body line under ## Intent, (2) first # heading, (3) undefined.
 * Naive line scan — fenced ## Intent headings produce a documented false positive (per brief §7).
 */
export function extractSpecTitle(specBody: string): string | undefined {
	const lines = specBody.split("\n");

	let intentTitle: string | undefined;
	let slugTitle: string | undefined;
	let inIntent = false;

	for (const line of lines) {
		if (line.trim() === "## Intent") {
			inIntent = true;
			continue;
		}

		if (inIntent) {
			if (line.startsWith("#")) {
				inIntent = false;
			} else {
				const trimmed = line.trim();
				if (trimmed.length > 0) {
					intentTitle = trimmed;
					inIntent = false;
				}
			}
		}

		if (line.startsWith("# ") && slugTitle === undefined) {
			const title = line.slice(2).trim();
			if (title.length > 0) {
				slugTitle = title;
			}
		}
	}

	const raw = intentTitle ?? slugTitle;
	if (raw === undefined) return undefined;
	if (raw.length > 120) return `${raw.slice(0, 119)}…`;
	return raw;
}
