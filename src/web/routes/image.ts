import {
    Router,
    type Request,
    type Response,
    type RequestHandler,
} from "express";
import rateLimit from "express-rate-limit";
import { generateImageData } from "../services/image.js";
import { getImageHash } from "../../database.js";
import { getStringQueryParam, parseBoolString } from "../../type-guards.js";

const imageRouter = Router();

// ---- Helpers ----

function stripExtension(value: string): string {
    return value.split(".")[0]!;
}

// ---- Rate limiters ----

const imageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests, please try again later.",
});

// ---- Typed param interfaces ----

interface HexCodeParams {
    hexCode: string;
}
interface ImgHashParams {
    imgHash: string;
}

// ---- Routes ----

/**
 * GET /image/:hexCode
 * Generates a pixel-art PNG from a compact hex string (150 / 600 / 1350 chars).
 */
imageRouter.get("/image/:hexCode", imageLimiter, (async (
    req: Request<HexCodeParams>,
    res: Response,
): Promise<void> => {
    const raw = stripExtension(req.params.hexCode);
    const code = raw.toLowerCase();

    if (!/^(?:[0-9a-f]{150}|[0-9a-f]{600}|[0-9a-f]{1350})$/.test(code)) {
        res.status(400).send("Invalid Value");
        return;
    }

    try {
        const plotParam = getStringQueryParam(req.query["plot"]) ?? "";
        const png = await generateImageData({ code, plotArg: plotParam });

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.send(png);
    } catch (err) {
        console.error(`Image generation failed for code ${code}: ${err}`);
        res.status(500).send("Error generating image");
    }
}) as unknown as RequestHandler);

/**
 * GET /image_large/:imgHash
 * Generates a pixel-art PNG for large canvases (20x20, 25x25) looked up by SHA-256 hash.
 */
imageRouter.get("/image_large/:imgHash", imageLimiter, (async (
    req: Request<ImgHashParams>,
    res: Response,
): Promise<void> => {
    const raw = stripExtension(req.params.imgHash);

    if (!/^[0-9a-f]{64}$/.test(raw)) {
        res.status(400).send("Invalid image hash");
        return;
    }

    try {
        const result = await getImageHash(raw);
        if (!result) {
            res.status(404).send("Image not found");
            return;
        }

        const [size, key] = result;
        const code = key.toLowerCase();
        const plotParam = getStringQueryParam(req.query["plot"]) ?? "";

        const png = await generateImageData({ code, plotArg: plotParam, size });

        res.setHeader("Content-Type", "image/png");
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.send(png);
    } catch (err) {
        console.error(`Large image generation failed for hash ${raw}: ${err}`);
        res.status(500).send("Error generating image");
    }
}) as unknown as RequestHandler);

export default imageRouter;
