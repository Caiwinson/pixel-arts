import crypto from "crypto";
import { recordVote } from "../../database.js";
import { TOPGG_WEBHOOK } from "../../constants.js";
import { Router, type Request, type Response, raw } from "express";
import { sendWebhookMessage } from "../services/webhook.js";
import rateLimit from "express-rate-limit";

const voteRouter = Router();

const topggLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 60, // limit each IP to 60 requests per window
    standardHeaders: true,
    legacyHeaders: false,
});

/** Top.gg webhook payload structure */
interface TopGgWebhookPayload {
    type: string;
    data?: {
        user?: {
            platform_id?: string;
            id?: string;
        };
    };
}

/**
 * Verifies Top.gg webhook signature (V2)
 * HMAC_SHA256(secret, timestamp + '.' + raw_body)
 */
function verifySignature(
    secret: string,
    rawBody: Buffer,
    signatureHeader: string,
): boolean {
    try {
        const items = Object.fromEntries(
            signatureHeader.split(",").map((item) => {
                const [k, v] = item.trim().split("=");
                return [k, v];
            }),
        );

        const timestamp = items["t"];
        const receivedSig = items["v1"];

        if (!timestamp || !receivedSig) return false;

        const message = Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]);

        const expectedSig = crypto
            .createHmac("sha256", secret)
            .update(message)
            .digest("hex");

        const expected = Buffer.from(expectedSig, "hex");
        const received = Buffer.from(receivedSig, "hex");

        if (expected.length !== received.length) return false;

        return crypto.timingSafeEqual(expected, received);
    } catch {
        return false;
    }
}

// Top.gg webhook endpoint
voteRouter.post(
    "/topgg-webhook",
    topggLimiter,
    // Use raw parser only for this route
    raw({ type: "application/json" }),
    async (req: Request, res: Response): Promise<void> => {
        const secret = TOPGG_WEBHOOK;
        const signature = req.header("x-topgg-signature");

        if (!secret || !signature) {
            res.status(401).send("Unauthorized");
            return;
        }

        const rawBody = req.body as Buffer;

        if (!verifySignature(secret, rawBody, signature)) {
            res.status(401).send("Unauthorized");
            return;
        }

        let payload: unknown;
        try {
            payload = JSON.parse(rawBody.toString("utf8"));
        } catch {
            res.status(400).send("Bad Request");
            return;
        }

        // Type guard for the payload
        if (!isTopGgWebhookPayload(payload)) {
            res.status(400).send("Bad Request");
            return;
        }

        const eventType = payload.type;
        const data = payload.data ?? {};

        if (eventType === "vote.create") {
            const userId = data?.user?.platform_id;

            if (!userId) {
                res.status(400).send("Bad Request");
                return;
            }

            console.info(`Top.gg Vote: ${userId}`);

            await recordVote(userId);

            // fire-and-forget async webhook send
            sendWebhookMessage(`Voted ${userId}`).catch(console.error);
        } else if (eventType === "webhook.test") {
            const userId = data?.user?.id;
            console.info(`Top.gg Webhook Test: ${userId}`);
        }

        res.sendStatus(200);
    },
);

/** Type guard to validate Top.gg webhook payload structure */
function isTopGgWebhookPayload(value: unknown): value is TopGgWebhookPayload {
    if (typeof value !== "object" || value === null) return false;
    const obj = value as Record<string, unknown>;
    return typeof obj.type === "string";
}

export default voteRouter;
