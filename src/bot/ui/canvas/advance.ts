import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    Message,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    StringSelectMenuOptionBuilder,
} from "discord.js";
import { createColourMenu, getColourList } from "../interactions/colour.js";
import {
    createCanvasEmbed,
    ensureOwner,
    getCanvasKey,
    getStringSelectById,
} from "../../utils.js";
import { recordPixelUpdate, getUserColour } from "../../../database.js";
import { createToolMenu } from "../interactions/tools.js";

type PixelSelection = {
    x: number;
    y: number;
};

type MessageCanvasState = {
    users: { [userId: string]: PixelSelection };
    lastAccessed: number; // unix ms timestamp
};

type AdvanceCanvasState = {
    [messageId: string]: MessageCanvasState;
};

// ---- Config ----
const STATE_TTL_MS = 60 * 60 * 1000; // evict entries not touched in 1 hour
const MAX_STATE_ENTRIES = 500; // hard cap on number of tracked messages
const EVICTION_INTERVAL_MS = 10 * 60 * 1000; // run TTL sweep every 10 minutes

const advanceCanvasState: AdvanceCanvasState = {};

// ---- Eviction ----

function evictExpiredEntries(): void {
    const now = Date.now();
    for (const messageId in advanceCanvasState) {
        if (now - advanceCanvasState[messageId]!.lastAccessed > STATE_TTL_MS) {
            delete advanceCanvasState[messageId];
        }
    }
}

function evictOldestEntry(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const messageId in advanceCanvasState) {
        const t = advanceCanvasState[messageId]!.lastAccessed;
        if (t < oldestTime) {
            oldestTime = t;
            oldestId = messageId;
        }
    }
    if (oldestId) delete advanceCanvasState[oldestId];
}

// Periodic TTL sweep — keeps memory bounded without per-access overhead
setInterval(evictExpiredEntries, EVICTION_INTERVAL_MS).unref();

// ---- State access ----

function getOrCreateEntry(messageId: string): MessageCanvasState {
    const now = Date.now();

    if (!advanceCanvasState[messageId]) {
        // Enforce hard cap before inserting
        if (Object.keys(advanceCanvasState).length >= MAX_STATE_ENTRIES) {
            evictOldestEntry();
        }
        advanceCanvasState[messageId] = { users: {}, lastAccessed: now };
    } else {
        advanceCanvasState[messageId]!.lastAccessed = now;
    }

    return advanceCanvasState[messageId]!;
}

export function getUserSelection(
    messageId: string,
    userId: string,
): PixelSelection {
    const entry = getOrCreateEntry(messageId);

    if (!entry.users[userId]) {
        entry.users[userId] = { x: 1, y: 1 };
    }

    return entry.users[userId]!;
}

function createRowOptions(
    type: "x" | "y",
    size: number,
    default_num: number = 1,
): StringSelectMenuOptionBuilder[] {
    const options: StringSelectMenuOptionBuilder[] = [];
    const emoji = type === "x" ? "🇽" : "🇾";
    for (let i = 1; i <= size; i++) {
        options.push(
            new StringSelectMenuOptionBuilder()
                .setLabel(i.toString())
                .setValue(i.toString())
                .setEmoji(emoji)
                .setDefault(default_num === i),
        );
    }
    return options;
}

export async function createAdvanceCanvasView(
    size: number,
    defaultX: number = 1,
    defaultY: number = 1,
    defaultHex: string,
    extraColours: string[] = [],
    showsTool: boolean = true,
): Promise<ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[]> {
    // X SELECT MENU
    const xMenu = new StringSelectMenuBuilder()
        .setCustomId("sel:x")
        .addOptions(createRowOptions("x", size, defaultX));

    const xRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        xMenu,
    );

    // Y SELECT MENU
    const yMenu = new StringSelectMenuBuilder()
        .setCustomId("sel:y")
        .addOptions(createRowOptions("y", size, defaultY));

    const yRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        yMenu,
    );

    const cMenu = await createColourMenu(defaultHex, "advanced", extraColours);

    const cRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        cMenu,
    );

    const bRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("place")
            .setLabel("Place Pixel")
            .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
            .setCustomId("cl:advanced")
            .setLabel("Close")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Danger),

        new ButtonBuilder()
            .setCustomId("ud:advanced")
            .setLabel("Undo")
            .setEmoji("↩️")
            .setStyle(ButtonStyle.Secondary),

        new ButtonBuilder()
            .setCustomId("tt")
            .setLabel("Toggle Tool")
            .setEmoji("🔧")
            .setStyle(ButtonStyle.Secondary),
    );

    const tMenu = createToolMenu(showsTool);

    const tRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        tMenu,
    );

    return [xRow, yRow, cRow, bRow, tRow];
}

export async function rowOptionsExecute(
    interaction: StringSelectMenuInteraction,
): Promise<void> {
    const type = interaction.customId.split(":")[1];
    const msgId = interaction.message.id;
    const userId = interaction.user.id;

    const entry = getOrCreateEntry(msgId);

    if (!entry.users[userId]) {
        entry.users[userId] = { x: 1, y: 1 };
    }

    const state = entry.users[userId]!;

    const numericValue = parseInt(interaction.values[0]!);

    if (type === "x") state.x = numericValue;
    else state.y = numericValue;

    await interaction.deferUpdate();
}

/** Canvas state extracted from message embed */
interface CanvasState {
    key: string;
    size: number;
    showsPlot: boolean;
}

export async function parseCanvasState(
    messageId: Message,
): Promise<CanvasState | null> {
    // Safely get URL from embed
    const url = messageId.embeds?.[0]?.image?.url;
    if (!url) return null; // no image, abort

    // Extract key from URL
    const key = await getCanvasKey(url);
    const size = Math.sqrt(key.length / 6);

    // Determine if ?plot=True is in the URL
    const showsPlot = url.includes("?plot=True");

    // Return structured state
    return { key, size, showsPlot };
}

export async function placePixelExecute(
    interaction: ButtonInteraction,
): Promise<void> {
    const canvasState = await parseCanvasState(interaction.message);
    if (!canvasState) return;

    const { key: keyStr, size, showsPlot } = canvasState;
    if (!size) return;

    const selection = getUserSelection(
        interaction.message.id,
        interaction.user.id,
    );

    const x = selection.x - 1;
    const y = selection.y - 1;

    const colour = await getUserColour(interaction.user.id);
    const num = y * size + x;

    const colourMenu = getStringSelectById(interaction.message, "cc:advanced");

    if (!colourMenu) return;

    const colourList = getColourList(colourMenu);

    const toolsEnabled = !getStringSelectById(interaction.message, "tool")
        ?.disabled;

    const newKey =
        keyStr.slice(0, num * 6) + colour + keyStr.slice(num * 6 + 6);

    const embeds = await createCanvasEmbed(newKey, showsPlot);

    await interaction.update({
        embeds: [embeds],
        components: await createAdvanceCanvasView(
            size,
            selection.x,
            selection.y,
            colour,
            colourList,
            toolsEnabled,
        ),
    });

    await recordPixelUpdate(
        interaction.message.id,
        newKey,
        `${num}:${colour}`,
        interaction.user.id,
    );
}

export async function toggleToolExecute(
    interaction: ButtonInteraction,
): Promise<void> {
    const allowed = await ensureOwner(
        interaction,
        interaction.message,
        "You cannot toggle tools on this canvas.",
    );
    if (!allowed) return;

    const toolMenu = getStringSelectById(interaction.message, "tool");
    const toolsEnabled = toolMenu?.disabled;

    const selection = getUserSelection(
        interaction.message.id,
        interaction.user.id,
    );

    const size = getStringSelectById(interaction.message, "sel:x")?.options
        .length!;

    const colourList = getColourList(
        getStringSelectById(interaction.message, "cc:advanced")!,
    );

    const colour = await getUserColour(interaction.user.id);

    await interaction.update({
        components: await createAdvanceCanvasView(
            size,
            selection.x,
            selection.y,
            colour,
            colourList,
            toolsEnabled,
        ),
    });
}
