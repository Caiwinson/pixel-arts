import crypto from "crypto";
import {
    Router,
    type NextFunction,
    type Request,
    type RequestHandler,
    type Response,
} from "express";
import { INTERNAL_API_SECRET } from "../../constants.js";
import { ensureTimelapse, TimelapseError } from "../services/video.js";

const internalRouter = Router();

const MAX_SKEW_SECONDS = 30;

interface TimelapseParams {
    messageId: string;
}

/** Signature = HMAC_SHA256(secret, `${timestamp}.${messageId}`) as hex */
function requireInternalAuth(
    req: Request<TimelapseParams>,
    res: Response,
    next: NextFunction,
): void {
    const secret = INTERNAL_API_SECRET;
    if (!secret) {
        // Fail closed if the secret isn't configured
        res.status(503).send("Internal API disabled");
        return;
    }

    const timestamp = req.header("x-timestamp");
    const signature = req.header("x-signature");
    if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) {
        res.status(401).send("Unauthorized");
        return;
    }

    const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (skew > MAX_SKEW_SECONDS) {
        res.status(401).send("Unauthorized");
        return;
    }

    const expected = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.${req.params.messageId}`)
        .digest();

    const received = /^[0-9a-f]{64}$/i.test(signature)
        ? Buffer.from(signature, "hex")
        : null;

    if (
        !received ||
        received.length !== expected.length ||
        !crypto.timingSafeEqual(expected, received)
    ) {
        res.status(401).send("Unauthorized");
        return;
    }

    next();
}

/**
 * POST /internal/timelapse/:messageId
 * Bot-only: renders the base timelapse (if missing) and returns the frame count.
 */
internalRouter.post(
    "/internal/timelapse/:messageId",
    requireInternalAuth as unknown as RequestHandler,
    (async (req: Request<TimelapseParams>, res: Response) => {
        try {
            const frames = await ensureTimelapse(req.params.messageId);
            res.json({ frames });
        } catch (err) {
            if (err instanceof TimelapseError) {
                res.status(err.status).send(err.message);
                return;
            }
            console.error("Internal timelapse error:", err);
            res.status(500).send("Internal error");
        }
    }) as unknown as RequestHandler,
);

export default internalRouter;