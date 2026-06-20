import * as crypto from "crypto";
import { NO_PLOT_DIR, PLOT_DIR } from "../../constants.js";
import { getCachedImage, storeImageInCache } from "./cache.js";
import { sendWebhookMessage } from "./webhook.js";
import { execFile } from "child_process";

const PIXEL_RENDER_BIN =
    process.env.PIXEL_RENDER_BIN ?? "/usr/local/bin/pixel-render";

/**
 * Calls the Rust pixel-render binary. When `plot` is true, the overlay
 * grid is composited in Rust (it's baked into the binary at compile time)
 * before the single PNG encode — no separate canvas compositing pass on
 * the Node side anymore.
 */
function hexStringToCanvas(
    code: string,
    size: number,
    plot: boolean,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const args = [code, String(size)];
        if (plot) args.push("plot");

        execFile(
            PIXEL_RENDER_BIN,
            args,
            // `encoding: "buffer"` means stdout comes back as a raw Buffer,
            // not a UTF-8 string — important for binary PNG data.
            { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 }, // 10 MB max
            (err, stdout, stderr) => {
                if (err) {
                    reject(
                        new Error(
                            `pixel-render failed: ${stderr?.toString() ?? err.message}`,
                        ),
                    );
                    return;
                }
                resolve(stdout);
            },
        );
    });
}

export interface GenerateImageOptions {
    code: string;
    plotArg?: string;
    size?: number;
}

/**
 * Generate (or retrieve from cache) a PNG buffer for the given pixel art code.
 * Mirrors generate_image_data() in image_service.py.
 *
 * Base and plotted images are still cached separately (NO_PLOT_DIR / PLOT_DIR)
 * since they're requested independently and a plot toggle shouldn't evict
 * the base image's cache entry. Both are now rendered fully in Rust —
 * there's no Node-side compositing step.
 */
export async function generateImageData(
    opts: GenerateImageOptions,
): Promise<Buffer> {
    const { code, plotArg = "", size: sizeOpt } = opts;

    const size = sizeOpt ?? Math.round(Math.sqrt(code.length / 6));
    const imgKey = `${size}-${code}`;
    const imgHash = crypto.createHash("sha256").update(imgKey).digest("hex");
    const plot = plotArg.toLowerCase() === "true" && size > 5;

    // ---- Step 1: Ensure base (no-plot) image ----
    let basePng = getCachedImage(NO_PLOT_DIR, imgHash);

    if (!basePng) {
        console.info(`Generating base image for hash: ${imgHash}`);
        basePng = await hexStringToCanvas(code, size, false);
        storeImageInCache(NO_PLOT_DIR, imgHash, basePng);
        sendWebhookMessage(size <= 15 ? code : imgHash);
    }

    // ---- Step 2: Return base if plot not requested ----
    if (!plot) {
        return basePng;
    }

    // ---- Step 3: Plotted version ----
    let plottedPng = getCachedImage(PLOT_DIR, imgHash);

    if (!plottedPng) {
        console.info(`Generating plotted image for hash: ${imgHash}`);
        plottedPng = await hexStringToCanvas(code, size, true);
        storeImageInCache(PLOT_DIR, imgHash, plottedPng);
    }

    return plottedPng;
}
