// === Canopy CLI Results ===

/** A single section within a rendered canopy prompt. */
export interface CanopyPromptSection {
	name: string;
	body: string;
}

/** Summary of a canopy prompt as returned by list/show. */
export interface CanopyPromptSummary {
	id: string;
	name: string;
	version: number;
	sections: CanopyPromptSection[];
}

/** Result from ta render — resolved prompt with all inheritance applied. */
export interface CanopyRenderResult {
	success: boolean;
	name: string;
	version: number;
	sections: CanopyPromptSection[];
}

/** Result from ta validate — validation status and errors. */
export interface CanopyValidateResult {
	success: boolean;
	errors: string[];
}

/** Result from ta list — list of all prompts. */
export interface CanopyListResult {
	success: boolean;
	prompts: CanopyPromptSummary[];
}

/** Result from ta show — single prompt record. */
export interface CanopyShowResult {
	success: boolean;
	prompt: CanopyPromptSummary;
}
