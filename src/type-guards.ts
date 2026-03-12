/**
 * Type guards and validation utilities for third-party and uncertain data
 */

/** Type guard to check if value is a non-empty string */
export function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
}

/** Type guard to check if value is a valid hex color string (6 characters) */
export function isHexColor(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-fA-F]{6}$/.test(value);
}

/** Type guard to check if value is a boolean string ("true" or "false") */
export function isBoolString(value: unknown): value is string {
    return typeof value === "string" && (value === "true" || value === "false");
}

/** Convert a boolean string to boolean */
export function parseBoolString(value: string): boolean {
    return value.toLowerCase() === "true";
}

/** Type guard to check if value is a positive integer */
export function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Type guard for query string values - Express req.query can be string or array */
export function getStringQueryParam(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (
        Array.isArray(value) &&
        value.length > 0 &&
        typeof value[0] === "string"
    ) {
        return value[0];
    }
    return undefined;
}

/** Type guard to validate a simple object has expected string key */
export function hasStringKey(
    obj: unknown,
    key: string,
): obj is Record<string, unknown> {
    return (
        typeof obj === "object" &&
        obj !== null &&
        typeof (obj as Record<string, unknown>)[key] === "string"
    );
}
