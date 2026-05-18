export const PENDING_SENTINEL = "!pending-tracker-create";
// Note: leading "!" deliberately fails the tracker-id validation regex.

export function isRealTaskId(t: string | null | undefined): t is string {
	return typeof t === "string" && t.length > 0 && t !== PENDING_SENTINEL;
}
