import { Pool } from "pg";
import crypto from "crypto";
import type {
    ImageHashResult,
    UserColourRecord,
    VoteRecord,
    EmojiRecord,
} from "./types.js";

const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? "db",
    port: parseInt(process.env.POSTGRES_PORT ?? "5432"),
    user: process.env.POSTGRES_USER ?? "myuser",
    password: process.env.POSTGRES_PASSWORD ?? "mypassword",
    database: process.env.POSTGRES_DB ?? "mydb",
});

async function initDb(): Promise<void> {
    const schema = `
        CREATE TABLE IF NOT EXISTS timelapse (
            message_id TEXT NOT NULL,
            row_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            is_delta BOOLEAN NOT NULL,
            user_id TEXT NOT NULL,
            timestamp BIGINT NOT NULL,
            readable_time TEXT NOT NULL,
            PRIMARY KEY (message_id, row_id)
        );

        CREATE INDEX IF NOT EXISTS idx_timelapse_message_id ON timelapse(message_id);

        CREATE TABLE IF NOT EXISTS colour (
            user_id TEXT PRIMARY KEY,
            hex_code INTEGER
        );

        CREATE TABLE IF NOT EXISTS vote (
            user_id TEXT PRIMARY KEY,
            timestamp BIGINT
        );

        CREATE TABLE IF NOT EXISTS image_hash (
            hash TEXT PRIMARY KEY,
            key TEXT
        );

        CREATE TABLE IF NOT EXISTS canvas_count (
            id INTEGER PRIMARY KEY CHECK (id = 0),
            count INTEGER NOT NULL
        );

        INSERT INTO canvas_count (id, count) VALUES (0, 0) ON CONFLICT DO NOTHING;

        CREATE TABLE IF NOT EXISTS emoji (
            hex TEXT PRIMARY KEY,
            emoji_string TEXT NOT NULL
        );
    `;
    await pool.query(schema);
}

export { initDb };

export async function closeDb(): Promise<void> {
    await pool.end();
}

export interface CanvasHistoryRow {
    row_id: number;
    key: string;
    is_delta: boolean;
    user_id: string;
    timestamp: number;
    readable_time: string;
}

export async function recordPixelUpdate(
    messageId: string,
    fkey: string,
    dkey: string | null | undefined,
    userId: string,
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const ts = Math.floor(Date.now() / 1000);
        const readable = new Date(ts * 1000)
            .toISOString()
            .replace("T", " ")
            .substring(0, 19);

        const maxRowResult = await client.query<{ max_row_id: number | null }>(
            `SELECT MAX(row_id) AS max_row_id FROM timelapse WHERE message_id = $1`,
            [messageId],
        );
        const rowId = (maxRowResult.rows[0]?.max_row_id ?? -1) + 1;

        let keyToStore: string;
        let isDelta: boolean;

        // Store a full snapshot on row 0 (canvas creation), when there's no delta,
        // or every 10th row (rowId % 10 === 0) — no extra DB query needed.
        if (rowId === 0 || !dkey || rowId % 10 === 0) {
            keyToStore = fkey;
            isDelta = false;
        } else {
            keyToStore = dkey;
            isDelta = true;
        }

        await client.query(
            `INSERT INTO timelapse (message_id, row_id, key, is_delta, user_id, timestamp, readable_time)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [messageId, rowId, keyToStore, isDelta, userId, ts, readable],
        );

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

export async function getCanvasHistory(
    messageId: string,
): Promise<CanvasHistoryRow[]> {
    const result = await pool.query<CanvasHistoryRow>(
        `SELECT row_id, key, is_delta, user_id, timestamp, readable_time
         FROM timelapse
         WHERE message_id = $1
         ORDER BY row_id`,
        [messageId],
    );
    return result.rows;
}

export async function revertLastPixel(
    messageId: string,
): Promise<string | null> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const histResult = await client.query<CanvasHistoryRow>(
            `SELECT row_id, key, is_delta, user_id, timestamp, readable_time
             FROM timelapse WHERE message_id = $1 ORDER BY row_id`,
            [messageId],
        );
        const rows = histResult.rows;

        if (rows.length === 0) {
            await client.query("COMMIT");
            return null;
        }

        if (rows.length === 1) {
            await client.query("COMMIT");
            return rows[0]!.key;
        }

        await client.query(
            `DELETE FROM timelapse
             WHERE message_id = $1 AND row_id = (
                 SELECT MAX(row_id) FROM timelapse WHERE message_id = $1
             )`,
            [messageId],
        );

        rows.pop();

        await client.query("COMMIT");

        const snapshotIndex = rows.findLastIndex(
            (row) => row.is_delta === false,
        );
        if (snapshotIndex === -1) return null;

        let key = rows[snapshotIndex]!.key;
        for (let i = snapshotIndex + 1; i < rows.length; i++) {
            const delta = rows[i]?.key.split(",");
            for (const pixel of delta!) {
                const [numStr, colour] = pixel.split(":");
                const num = Number(numStr);
                key = key.slice(0, num * 6) + colour + key.slice(num * 6 + 6);
            }
        }

        return key;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

export async function getUserColour(userId: string): Promise<string> {
    const result = await pool.query<{ hex_code: number }>(
        `INSERT INTO colour (user_id, hex_code) VALUES ($1, 0)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING hex_code`,
        [userId],
    );

    if (result.rows.length > 0) {
        return result.rows[0]!.hex_code.toString(16).padStart(6, "0");
    }

    const existing = await pool.query<{ hex_code: number }>(
        `SELECT hex_code FROM colour WHERE user_id = $1`,
        [userId],
    );
    return existing.rows[0]!.hex_code.toString(16).padStart(6, "0");
}

export async function setUserColour(
    userId: string,
    hexCode: string,
): Promise<void> {
    const intValue = parseInt(hexCode, 16);
    await pool.query(
        `INSERT INTO colour (user_id, hex_code) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET hex_code = EXCLUDED.hex_code`,
        [userId, intValue],
    );
}

export async function getCanvasCount(): Promise<number> {
    const result = await pool.query<{ count: number }>(
        `SELECT count FROM canvas_count WHERE id = 0`,
    );
    return result.rows[0]?.count ?? 0;
}

export async function incrementCanvasCount(): Promise<void> {
    await pool.query(
        `INSERT INTO canvas_count (id, count) VALUES (0, 1)
         ON CONFLICT (id) DO UPDATE SET count = canvas_count.count + 1`,
    );
}

export async function saveImageHash(
    key: string,
    size: number,
): Promise<string> {
    const combinedKey = `${size}-${key}`;
    const hash = crypto.createHash("sha256").update(combinedKey).digest("hex");

    await pool.query(
        `INSERT INTO image_hash (hash, key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [hash, combinedKey],
    );

    return hash;
}

export async function getImageHash(hash: string): Promise<ImageHashResult> {
    const result = await pool.query<{ key: string }>(
        `SELECT key FROM image_hash WHERE hash = $1`,
        [hash],
    );

    const row = result.rows[0];
    if (!row?.key) return null;

    const firstHyphenIndex = row.key.indexOf("-");
    if (firstHyphenIndex === -1) return null;

    const sizeStr = row.key.substring(0, firstHyphenIndex);
    const keyStr = row.key.substring(firstHyphenIndex + 1);
    const size = parseInt(sizeStr, 10);

    return isNaN(size) ? null : [size, keyStr];
}

export async function hasUserVoted(userId: string): Promise<boolean> {
    const result = await pool.query<{ timestamp: number }>(
        `SELECT timestamp FROM vote WHERE user_id = $1`,
        [userId],
    );

    const row = result.rows[0];
    if (!row) return false;

    const currentTs = Math.floor(Date.now() / 1000);
    return currentTs - row.timestamp < 43200;
}

export async function recordVote(userId: string): Promise<void> {
    const timestamp = Math.floor(Date.now() / 1000);

    await pool.query(
        `INSERT INTO vote (user_id, timestamp)
         VALUES ($1, $2)
         ON CONFLICT (user_id)
         DO UPDATE SET timestamp = EXCLUDED.timestamp`,
        [userId, timestamp],
    );
}

// ---- Emoji Table ----

export async function syncEmojiTable(
    emojis: Array<{ name: string | null; toString(): string }>,
): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM emoji");

        for (const emoji of emojis) {
            if (!emoji.name) continue;
            await client.query(
                `INSERT INTO emoji (hex, emoji_string) VALUES ($1, $2)
                 ON CONFLICT (hex) DO UPDATE SET emoji_string = EXCLUDED.emoji_string`,
                [emoji.name.toLowerCase(), emoji.toString()],
            );
        }

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

export async function getEmojiByHex(hex: string): Promise<string | null> {
    const result = await pool.query<{ emoji_string: string }>(
        `SELECT emoji_string FROM emoji WHERE hex = $1`,
        [hex.toLowerCase()],
    );
    return result.rows[0]?.emoji_string ?? null;
}

export async function upsertEmojiRecord(
    hex: string,
    emojiString: string,
): Promise<void> {
    await pool.query(
        `INSERT INTO emoji (hex, emoji_string) VALUES ($1, $2)
         ON CONFLICT (hex) DO UPDATE SET emoji_string = EXCLUDED.emoji_string`,
        [hex.toLowerCase(), emojiString],
    );
}

export async function deleteEmojiRecord(hex: string): Promise<void> {
    await pool.query(`DELETE FROM emoji WHERE hex = $1`, [hex.toLowerCase()]);
}

export async function getEmojiCount(): Promise<number> {
    const result = await pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM emoji`,
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
}

export async function getOldestNonPresetEmoji(
    presetHexes: string[],
): Promise<{ hex: string; emoji_string: string } | null> {
    const result = await pool.query<{ hex: string; emoji_string: string }>(
        `SELECT hex, emoji_string FROM emoji
         WHERE hex <> ALL($1::text[])
         LIMIT 1`,
        [presetHexes],
    );
    return result.rows[0] ?? null;
}
