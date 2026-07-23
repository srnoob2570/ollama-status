/**
 * Normalize a value before passing it to a D1-like `stmt.bind(...)`.
 *
 * - `undefined` → `null` (D1 compat)
 * - `boolean` → `0`/`1` (SQLite compat; harmless for PostgreSQL)
 */
export function normalizeBindValue(value: unknown): unknown {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
}
