/**
 * Shared type definitions used across the application
 */

/** 2D coordinate tuple [x, y] - used for pixel coordinates and tool interactions */
export type Coordinate = [number, number];

/** Image generation options for creating pixel art PNG buffers */
export interface ImageGenerationResult {
    outputPath: string | null;
    error: string | null;
}

/** User interaction result from modal submission with coordinates and colour */
export interface ToolModalResult {
    start: Coordinate;
    end: Coordinate;
    colour: string;
}

/** Database result from image hash lookup - returns [size, key] tuple or null */
export type ImageHashResult = [number, string] | null;

/** Database query result for user colour preference */
export interface UserColourRecord {
    hex_code: number;
}

/** Database query result for vote verification */
export interface VoteRecord {
    timestamp: number;
}

/** Database query result for emoji mapping */
export interface EmojiRecord {
    emoji_string: string;
}
