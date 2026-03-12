import path from "path";
import fs from "fs";

/** Environment configuration object with proper typing */
interface EnvironmentConfig {
    discord_token: string | undefined;
    topggToken: string | undefined;
    domainUrl: string | undefined;
    topgg_webhook: string | undefined;
    webhook_url: string | undefined;
}

// Environment configuration
export const ENV: EnvironmentConfig = {
    discord_token: process.env.DISCORD_TOKEN,
    topggToken: process.env.TOPGG_TOKEN,
    domainUrl: process.env.DOMAIN_URL,
    topgg_webhook: process.env.TOPGG_WEBHOOK,
    webhook_url: process.env.WEBHOOK_URL,
};

// Individual constants for convenience
export const DISCORD_TOKEN = ENV.discord_token;
export const TOPGG_API_TOKEN = ENV.topggToken;
export const TOPGG_WEBHOOK = ENV.topgg_webhook;
export const WEBHOOK_URL = ENV.webhook_url;
export const DOMAIN_URL = ENV.domainUrl;
export const EMBED_COLOUR: number = 5793266;

// Paths
export const DATA_DIR: string = path.join(process.cwd(), "data");
export const DB_PATH: string = path.join(DATA_DIR, "data.db");
export const PREVIEW_PATH: string = path.join(DATA_DIR, "cache", "preview");
export const NO_PLOT_DIR: string = path.join(DATA_DIR, "cache", "no_plot");
export const PLOT_DIR: string = path.join(DATA_DIR, "cache", "plot");
export const PLOT_OVERLAY_PATH: string = path.join(
    process.cwd(),
    "static",
    "plot.png",
);

// Ensure directories exist
[DATA_DIR, PREVIEW_PATH].forEach((dir: string) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Type definition for color options
interface ColourOption {
    hex: string;
    emoji: string;
}

// Color options mapping
export const COLOUR_OPTION: Record<string, ColourOption> = {
    red: { hex: "ff0000", emoji: "<:red:1135073767861801041>" },
    "red-orange": { hex: "ff4500", emoji: "<:red_orange:1135073770369994853>" },
    orange: { hex: "ffa800", emoji: "<:orange:1135073772622331905>" },
    yellow: { hex: "ffd635", emoji: "<:yellow:1135073774832717904>" },
    green: { hex: "00a368", emoji: "<:green:1135073777093443695>" },
    lime: { hex: "7eed56", emoji: "<:lime:1135073778553065503>" },
    blue: { hex: "2450a4", emoji: "<:blue:1135073780721520640>" },
    sky: { hex: "3690ea", emoji: "<:sky:1135073782621556767>" },
    cyan: { hex: "51e9f4", emoji: "<:cyan:1135073784785801298>" },
    purple: { hex: "811e9f", emoji: "<:purple:1135073786438357124>" },
    violet: { hex: "b44ac0", emoji: "<:violet:1135073789051420712>" },
    pink: { hex: "ff99aa", emoji: "<:pink:1135073790460690544>" },
    brown: { hex: "9c6926", emoji: "<:brown:1135073792880820255>" },
    black: { hex: "000000", emoji: "<:black:1135073794956996699>" },
    gray: { hex: "898d90", emoji: "<:gray:1135073797163188346>" },
    silver: { hex: "d4d7d9", emoji: "<:silver:1135073798933184612>" },
    white: { hex: "ffffff", emoji: "<:white:1135073801114226768>" },
};
