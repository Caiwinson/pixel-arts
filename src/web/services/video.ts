import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { PREVIEW_PATH } from "../../constants.js";
import type { ImageGenerationResult } from "../../types.js";
import { getCanvasHistory } from "../../database.js";

const TIMELAPSE_RENDER_BIN =
    process.env.TIMELAPSE_RENDER_BIN ?? "/usr/local/bin/timelapse-render";

export type VideoResult = ImageGenerationResult;

/**
 * Validates that value is a pure numeric ID (5–20 digits) and returns the
 * sanitized match string, breaking the taint chain for CodeQL.
 */
function validateNumericId(value: string): string | null {
    const m = /^([0-9]{5,20})$/.exec(value);
    return m ? m[1]! : null;
}

/**
 * Builds a path guaranteed to stay inside baseDir, throws otherwise.
 */
function safePathInDir(baseDir: string, filename: string): string {
    const resolved = path.resolve(baseDir, filename);
    const base = path.resolve(baseDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        throw new Error("Path traversal detected");
    }
    return resolved;
}

// ---- Timelapse (base video) generation ----

const MAX_CONCURRENT_RENDERS = 2;
const RENDER_TIMEOUT_MS = 120_000;

let activeRenders = 0;
const renderWaiters: Array<() => void> = [];

async function acquireRenderSlot(): Promise<void> {
    if (activeRenders < MAX_CONCURRENT_RENDERS) {
        activeRenders++;
        return;
    }
    await new Promise<void>((resolve) => renderWaiters.push(resolve));
}

function releaseRenderSlot(): void {
    const next = renderWaiters.shift();
    if (next) next(); // slot handed straight to the next waiter
    else activeRenders--;
}

// De-dupe concurrent requests for the same canvas
const inflight = new Map<string, Promise<void>>();

export class TimelapseError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
    }
}

function runTimelapseRender(
    history: unknown[],
    outputPath: string,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const proc = spawn(TIMELAPSE_RENDER_BIN, [outputPath], {
            stdio: ["pipe", "ignore", "inherit"],
        });

        const timer = setTimeout(() => {
            proc.kill("SIGKILL");
            reject(new Error("timeout"));
        }, RENDER_TIMEOUT_MS);

        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        proc.on("close", (code) => {
            clearTimeout(timer);
            code === 0
                ? resolve()
                : reject(new Error(`timelapse-render exited with ${code}`));
        });

        proc.stdin!.on("error", () => {}); // ignore EPIPE if the process dies early
        proc.stdin!.end(JSON.stringify(history));
    });
}

async function renderBaseVideo(
    cleanId: string,
    history: unknown[],
    finalPath: string,
): Promise<void> {
    // ffmpeg infers the container from the extension, so keep ".mp4" at the end
    const tmpPath = safePathInDir(
        PREVIEW_PATH,
        `${cleanId}.tmp-${process.pid}-${Date.now()}.mp4`,
    );

    await acquireRenderSlot();
    try {
        await runTimelapseRender(history, tmpPath);
        fs.renameSync(tmpPath, finalPath); // atomic: never expose partial files
    } finally {
        releaseRenderSlot();
        fs.rmSync(tmpPath, { force: true });
    }
}

/**
 * Ensures the base (1x) timelapse exists. ONLY call from authorized code paths.
 * Returns the number of frames in the canvas history.
 */
export async function ensureTimelapse(messageId: string): Promise<number> {
    const cleanId = validateNumericId(messageId);
    if (!cleanId) throw new TimelapseError("Invalid message ID", 400);

    const history = await getCanvasHistory(cleanId);
    if (history.length === 0) {
        throw new TimelapseError("No canvas history found", 404);
    }

    const finalPath = safePathInDir(PREVIEW_PATH, `${cleanId}.mp4`);
    if (fs.existsSync(finalPath)) return history.length;

    let job = inflight.get(cleanId);
    if (!job) {
        job = renderBaseVideo(cleanId, history, finalPath).finally(() =>
            inflight.delete(cleanId),
        );
        inflight.set(cleanId, job);
    }

    try {
        await job;
    } catch (err: any) {
        console.error(`Timelapse render failed for ${cleanId}: ${err}`);
        throw new TimelapseError(
            err?.message === "timeout"
                ? "Timelapse render timed out"
                : "Timelapse render failed",
            500,
        );
    }

    return history.length;
}

/**
 * Returns the path to the video at the requested speed.
 * If speed === 1, returns the original file without running ffmpeg.
 */
export async function generateDownloadVideo(
    videoId: string,
    speed: number,
): Promise<VideoResult> {
    // Re-validate and extract a clean ID from the match result itself
    const cleanId = validateNumericId(videoId);
    if (!cleanId) {
        return { outputPath: null, error: "Invalid video ID" };
    }

    let inputPath: string;
    try {
        inputPath = safePathInDir(PREVIEW_PATH, `${cleanId}.mp4`);
    } catch {
        return { outputPath: null, error: "Invalid video ID" };
    }

    if (!fs.existsSync(inputPath)) {
        return { outputPath: null, error: "Preview not found" };
    }

    // Speed 1 → return original
    if (speed === 1) {
        return { outputPath: inputPath, error: null };
    }

    const fps = Math.min(speed, 60); // Cap FPS to 60

    let outputPath: string;
    try {
        outputPath = safePathInDir(PREVIEW_PATH, `${cleanId}-${speed}.mp4`);
    } catch {
        return { outputPath: null, error: "Invalid video ID" };
    }

    if (fs.existsSync(outputPath)) {
        return { outputPath, error: null };
    }

    try {
        await runFfmpeg(inputPath, outputPath, fps, speed);
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        if (errorMessage === "timeout") {
            console.error(
                `Video processing timeout for ${cleanId} at speed ${speed}`,
            );
            return { outputPath: null, error: "Video processing timeout" };
        }
        console.error(
            `Error generating video for ${cleanId} at speed ${speed}: ${errorMessage}`,
        );
        return { outputPath: null, error: "Error generating video" };
    }

    if (!fs.existsSync(outputPath)) {
        console.error(
            `FFmpeg failed to create output file for ${cleanId} at speed ${speed}`,
        );
        return { outputPath: null, error: "Error generating video" };
    }

    return { outputPath, error: null };
}

function runFfmpeg(
    inputPath: string,
    outputPath: string,
    fps: number,
    speed: number,
    timeoutMs = 30_000,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const vf = `tpad=stop_mode=clone:stop_duration=${speed},fps=${fps},setpts=PTS/${speed}`;

        const ffmpeg = spawn("ffmpeg", [
            "-i",
            inputPath,
            "-vf",
            vf,
            "-y",
            outputPath,
        ]);

        const timer = setTimeout(() => {
            ffmpeg.kill();
            reject(new Error("timeout"));
        }, timeoutMs);

        ffmpeg.on("close", (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${code}`));
        });

        ffmpeg.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
