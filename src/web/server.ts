import express from "express";
import path from "path";
import imageRouter from "./routes/image.js";
import videoRouter from "./routes/video.js";
import voteRouter from "./routes/vote.js";
import internalRouter from "./routes/internal.js";

// Rate limiting for expensive routes
import rateLimit from "express-rate-limit";

const app = express();
const __dirname = process.cwd();

// Limit requests to the timelapse endpoint to reduce DoS risk from disk access
const timelapseLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
});

app.use("/static", express.static(path.join(__dirname, "static")));
app.use(express.static(path.join(__dirname, "public")));

app.use("/", imageRouter);
app.use("/", videoRouter);
app.use("/", voteRouter)
app.use("/", internalRouter);

app.get("/timelapse/:code", timelapseLimiter, (req, res) => {
    // Serve timelapse.html from ./public
    res.sendFile(path.join(__dirname, "public", "timelapse.html"));
});

// Catch-all to debug unmatched routes
app.use((req, res) => {
    console.log("Unmatched route:", req.method, req.path);
    res.status(404).send("Not found");
});

export default app;