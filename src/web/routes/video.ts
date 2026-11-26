import {
    Router,
    type Request,
    type Response,
    type RequestHandler,
} from "express";
import path from "path";
import fs from "fs";
import rateLimit from "express-rate-limit";
import { PREVIEW_PATH } from "../../constants.js";
import { generateDownloadVideo } from "../services/video.js";
import { getCanvasHistory, getCanvasHistoryCount } from "../../database.js";

const videoRouter = Router();

interface DownloadParams {
    code: string;
}

interface PreviewParams {
    code: string;
}

interface HistoryParams {
    messageId: string;
}

function stripExtension(value: string): string {
    return value.split(".")[0]!;
}

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
 * The containment check gives CodeQL a definitive proof the path is safe.
 */
function safePathInDir(baseDir: string, filename: string): string {
    const resolved = path.resolve(baseDir, filename);
    const base = path.resolve(baseDir);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
        throw new Error("Path traversal detected");
    }
    return resolved;
}

const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests, please try again later.",
});

const previewLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests, please try again later.",
});

/**
 * GET /download/:code
 * Generates and serves an MP4 at the requested speed.
 * Format: <videoId> or <videoId>-<speed>
 */
videoRouter.get("/download/:code", downloadLimiter, (async (
    req: Request<DownloadParams>,
    res: Response,
) => {
    const code = stripExtension(req.params.code);

    // Accept either "<videoId>" or "<videoId>-<speed>" where videoId is numeric
    const m = /^([0-9]{5,20})(?:-([1-9][0-9]*))?$/.exec(code);
    if (!m) {
        res.status(400).send("Invalid video ID");
        return;
    }

    // Use only the captured groups — taint is broken here
    const vid = m[1]!;
    const speed = m[2] ? parseInt(m[2], 10) : 1;

    // Max speed is the frame count of the original video (1 frame per history row)
    if (speed > 1) {
        const frames = await getCanvasHistoryCount(vid);
        if (speed > frames) {
            res.status(400).send("Invalid speed");
            return;
        }
    }

    const { outputPath, error } = await generateDownloadVideo(vid, speed);

    if (error || !outputPath) {
        const isServerError =
            error?.toLowerCase().includes("timeout") ||
            error?.toLowerCase().includes("error");
        res.status(isServerError ? 500 : 404).send(error ?? "Unknown error");
        return;
    }

    let safePath: string;
    try {
        safePath = safePathInDir(PREVIEW_PATH, path.basename(outputPath));
    } catch {
        res.status(400).send("Invalid path");
        return;
    }

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("ETag", String(fs.statSync(safePath).mtimeMs));
    res.sendFile(safePath);
}) as unknown as RequestHandler);

/**
 * GET /preview/:code
 * Serves a cached MP4 timelapse file from PREVIEW_DIR.
 */
videoRouter.get("/preview/:code", previewLimiter, ((
    req: Request<PreviewParams>,
    res: Response,
) => {
    const raw = stripExtension(req.params.code);

    const cleanId = validateNumericId(raw);
    if (!cleanId) {
        res.status(400).send("Invalid preview ID");
        return;
    }

    let filePath: string;
    try {
        filePath = safePathInDir(PREVIEW_PATH, `${cleanId}.mp4`);
    } catch {
        res.status(400).send("Invalid path");
        return;
    }

    if (!fs.existsSync(filePath)) {
        res.status(404).send("Preview not found");
        return;
    }

    res.setHeader("Content-Type", "video/mp4");
    res.sendFile(filePath);
}) as unknown as RequestHandler);

/**
 * GET /canvas-history/:messageId
 * Returns stripped canvas history JSON for a given message ID.
 * Only responds if the timelapse video already exists (auth gate).
 * Sensitive fields (user_id, timestamp, readable_time) are omitted.
 */
videoRouter.get("/canvas-history/:messageId", previewLimiter, (async (
    req: Request<HistoryParams>,
    res: Response,
) => {
    const cleanId = validateNumericId(req.params.messageId);
    if (!cleanId) {
        res.status(400).send("Invalid message ID");
        return;
    }

    // Auth: only serve history if the timelapse video already exists
    let videoPath: string;
    try {
        videoPath = safePathInDir(PREVIEW_PATH, `${cleanId}.mp4`);
    } catch {
        res.status(400).send("Invalid path");
        return;
    }

    if (!fs.existsSync(videoPath)) {
        res.status(404).send("Timelapse not found");
        return;
    }

    try {
        const history = await getCanvasHistory(cleanId);

        if (!history || history.length === 0) {
            res.status(404).send("No history found");
            return;
        }

        // Strip sensitive fields — only expose what the renderer needs
        const safe = history.map(({ row_id, key, is_delta }) => ({
            row_id,
            key,
            is_delta,
        }));

        res.json(safe);
    } catch (err) {
        console.error(`Canvas history fetch failed for ${cleanId}: ${err}`);
        res.status(500).send("Error fetching history");
    }
}) as unknown as RequestHandler);

export default videoRouter;