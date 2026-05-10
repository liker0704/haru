/**
 * Mission slug generation from raw intent.
 *
 * Used by `ha mission start "<intent>"` when --slug is omitted. Produces a
 * short kebab-case identifier from the first 4-6 significant words of the
 * intent. Falls back to a hash-derived suffix on heavy collision.
 */

const STOPWORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"of",
	"in",
	"on",
	"at",
	"to",
	"from",
	"by",
	"for",
	"with",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"can",
	"may",
	"might",
	"that",
	"this",
	"these",
	"those",
	"i",
	"we",
	"you",
	"our",
	"your",
	"my",
	"its",
]);

const MIN_WORDS = 2;
const MAX_WORDS = 6;
const MAX_COLLISION_ATTEMPTS = 99;

/**
 * Generate a slug from the given intent text. If the slug collides with an
 * existing one, appends `-2`, `-3`, etc. After MAX_COLLISION_ATTEMPTS, falls
 * back to a hash-suffixed slug.
 */
export function generateSlugFromIntent(intent: string, existingSlugs: Set<string>): string {
	const base = slugifyIntent(intent);
	if (!existingSlugs.has(base)) {
		return base;
	}
	for (let i = 2; i <= MAX_COLLISION_ATTEMPTS; i++) {
		const candidate = `${base}-${i}`;
		if (!existingSlugs.has(candidate)) {
			return candidate;
		}
	}
	const hash = shortHash(intent);
	return `${base}-${hash}`;
}

function slugifyIntent(intent: string): string {
	const cleaned = intent
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, " ")
		.split(/\s+/)
		.map((w) => w.trim())
		.filter((w) => w.length > 0);

	const significant = cleaned.filter((w) => !STOPWORDS.has(w));
	const words = significant.length >= MIN_WORDS ? significant : cleaned;

	const selected = words.slice(0, MAX_WORDS);
	if (selected.length === 0) {
		return `mission-${shortHash(intent)}`;
	}
	return selected.join("-").replace(/-+/g, "-");
}

function shortHash(input: string): string {
	let hash = 5381;
	for (let i = 0; i < input.length; i++) {
		hash = ((hash << 5) + hash + input.charCodeAt(i)) & 0xffffffff;
	}
	return Math.abs(hash).toString(36).slice(0, 6);
}
