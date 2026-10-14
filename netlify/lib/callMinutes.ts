// Retell's valid minimum and Recepta's existing three-minute per-call policy.
// PostgreSQL enforces the same bounds; admission tests verify exact agreement.
export const CALL_MIN_SECONDS = 60
export const CALL_MAX_SECONDS = 180
