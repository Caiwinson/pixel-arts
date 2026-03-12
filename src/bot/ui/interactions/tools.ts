import {
    LabelBuilder,
    MessageFlags,
    ModalBuilder,
    ModalSubmitInteraction,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import {
    createCanvasEmbed,
    ensureOwner,
    getCanvasKey,
    getStringSelectById,
} from "../../utils.js";
import { createColourMenu, getColourList } from "./colour.js";
import { recordPixelUpdate, getUserColour } from "../../../database.js";
import { parseCanvasState } from "../canvas/advance.js";
import type { Coordinate, ToolModalResult } from "../../../types.js";

export function createToolMenu(
    showsTool: boolean = false,
): StringSelectMenuBuilder {
    const options: StringSelectMenuOptionBuilder[] = [
        new StringSelectMenuOptionBuilder()
            .setLabel("Line")
            .setValue("line")
            .setEmoji("✏️"),
        new StringSelectMenuOptionBuilder()
            .setLabel("Rectangle")
            .setValue("rectangle")
            .setEmoji("⬛"),
        new StringSelectMenuOptionBuilder()
            .setLabel("Outline")
            .setValue("outline")
            .setEmoji("🔲"),
        new StringSelectMenuOptionBuilder()
            .setLabel("Bucket Fill")
            .setValue("bucket")
            .setEmoji("🪣"),
        new StringSelectMenuOptionBuilder()
            .setLabel("Replace Colour")
            .setValue("replace")
            .setEmoji("🔄"),
        new StringSelectMenuOptionBuilder()
            .setLabel("Toggle Plot")
            .setValue("plot")
            .setEmoji("🔢"),
    ];

    const menu = new StringSelectMenuBuilder()
        .setCustomId("tool")
        .setPlaceholder("Select a tool")
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(!showsTool)
        .addOptions(options);

    return menu;
}

/** Type for tool handler functions */
type ToolHandler = (interaction: StringSelectMenuInteraction) => Promise<void>;

const toolMap: Record<string, ToolHandler> = {
    line: handleLine,
    rectangle: handleRectangle,
    outline: handleRectangleOutline,
    bucket: handleBucketFill,
    replace: handleReplaceColour,
    plot: handlePlot,
};

export async function toolExecute(
    interaction: StringSelectMenuInteraction,
): Promise<void> {
    const tool = interaction.values[0]!;
    const handler = toolMap[tool];
    if (handler) await handler(interaction);
}

async function createToolModal(
    id: number,
    title: string,
    interaction: StringSelectMenuInteraction,
    size: number,
): Promise<ModalBuilder> {
    const colourList = getColourList(
        getStringSelectById(interaction.message, "cc:advanced")!,
    );

    const colour = await getUserColour(interaction.user.id);

    const modal = new ModalBuilder().setCustomId(`tm:${id}`).setTitle(title);

    const startInput = new TextInputBuilder()
        .setCustomId("start")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("1,1")
        .setMinLength(3)
        .setMaxLength(5);

    const startLabel = new LabelBuilder()
        .setLabel("Start from:")
        .setTextInputComponent(startInput);

    const endInput = new TextInputBuilder()
        .setCustomId("end")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(`${size},${size}`)
        .setMinLength(3)
        .setMaxLength(5);

    const endLabel = new LabelBuilder()
        .setLabel("To:")
        .setTextInputComponent(endInput);

    const colourLabel = new LabelBuilder()
        .setLabel("Pick a colour")
        .setStringSelectMenuComponent(
            await createColourMenu(colour, "modal", colourList),
        );

    modal.addLabelComponents(startLabel, endLabel, colourLabel);

    return modal;
}

export function parseCoords(coordStr: string, size: number): Coordinate | null {
    const parts = coordStr.split(",");
    if (parts.length !== 2) return null;

    const x = Number(parts[0]!.trim()) - 1;
    const y = Number(parts[1]!.trim()) - 1;

    if (
        Number.isNaN(x) ||
        Number.isNaN(y) ||
        x < 0 ||
        x >= size ||
        y < 0 ||
        y >= size
    ) {
        return null;
    }

    return [x, y];
}

async function executeToolModal(
    title: string,
    interaction: StringSelectMenuInteraction,
    size: number,
): Promise<
    (ToolModalResult & { submitted: ModalSubmitInteraction }) | undefined
> {
    const id = Math.floor(Math.random() * 1_000_000);
    const modal = await createToolModal(id, title, interaction, size);
    await interaction.showModal(modal);
    let submitted;

    try {
        submitted = await interaction.awaitModalSubmit({
            filter: (i) =>
                i.user.id === interaction.user.id && i.customId === `tm:${id}`,
            time: 60_000,
        });
    } catch {
        return;
    }

    const start = submitted.fields.getTextInputValue("start");
    const end = submitted.fields.getTextInputValue("end");
    const colour = submitted.fields.getStringSelectValues("cc:modal")[0]!;

    const startCoords = parseCoords(start, size);
    const endCoords = parseCoords(end, size);

    if (!startCoords || !endCoords) {
        await submitted.reply({
            content: "Invalid coordinates.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await submitted.deferUpdate();

    return { start: startCoords, end: endCoords, colour, submitted };
}

async function updateCanvas(
    submitted: ModalSubmitInteraction,
    key: string,
    deltas: string[],
    showsPlot: boolean,
): Promise<void> {
    const embeds = await createCanvasEmbed(key, showsPlot);

    await submitted.editReply({
        embeds: [embeds],
    });

    await recordPixelUpdate(
        submitted.message!.id,
        key,
        deltas.join(","),
        submitted.user.id,
    );
}

function setPixel(
    pixels: string[],
    size: number,
    x: number,
    y: number,
    colour: string,
    deltas: string[],
): void {
    if (x < 0 || y < 0 || x >= size || y >= size) return;

    const idx = y * size + x;
    pixels[idx] = colour;
    deltas.push(`${idx}:${colour}`);
}

async function handleLine(
    interaction: StringSelectMenuInteraction,
): Promise<void> {
    const canvasState = await parseCanvasState(interaction.message);
    if (!canvasState) return; // exit if null

    const { key, size, showsPlot } = canvasState; // now safe
    if (!key) return;

    const result = await executeToolModal("Line Tool", interaction, size);
    if (!result) return;

    const { start, end, colour, submitted } = result;

    let pixels = key.match(/.{6}/g)!;

    const deltas: string[] = [];

    // Bresenham's Line Algorithm
    let [x0, y0] = start;
    const [x1, y1] = end;

    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    while (true) {
        setPixel(pixels, size, x0, y0, colour, deltas);

        if (x0 === x1 && y0 === y1) break;

        const e2 = 2 * err;

        if (e2 > -dy) {
            err -= dy;
            x0 += sx;
        }

        if (e2 < dx) {
            err += dx;
            y0 += sy;
        }
    }

    const newKey = pixels.join("");

    await updateCanvas(submitted, newKey, deltas, showsPlot);
}

async function handleRectangle(
    interaction: StringSelectMenuInteraction,
): Promise<void> {
    const canvasState = await parseCanvasState(interaction.message);
    if (!canvasState) return;

    const { key, size, showsPlot } = canvasState;
    if (!key) return;

    const result = await executeToolModal("Rectangle Tool", interaction, size);
    if (!result) return;

    const { start, end, colour, submitted } = result;

    let pixels = key.match(/.{6}/g)!;
    const deltas: string[] = [];

    let [x0, y0] = start;
    let [x1, y1] = end;

    // normalize corners
    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);

    // fill area
    for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
            setPixel(pixels, size, x, y, colour, deltas);
        }
    }

    const newKey = pixels.join("");
    await updateCanvas(submitted, newKey, deltas, showsPlot);
}

async function handleRectangleOutline(
    interaction: StringSelectMenuInteraction,
): Promise<void> {
    const canvasState = await parseCanvasState(interaction.message);
    if (!canvasState) return;

    const { key, size, showsPlot } = canvasState;
    if (!key) return;

    const result = await executeToolModal("Outline Tool", interaction, size);
    if (!result) return;

    const { start, end, colour, submitted } = result;

    let pixels = key.match(/.{6}/g)!;
    const deltas: string[] = [];

    let [x0, y0] = start;
    let [x1, y1] = end;

    const minX = Math.min(x0, x1);
    const maxX = Math.max(x0, x1);
    const minY = Math.min(y0, y1);
    const maxY = Math.max(y0, y1);

    // top & bottom edges
    for (let x = minX; x <= maxX; x++) {
        setPixel(pixels, size, x, minY, colour, deltas);
        setPixel(pixels, size, x, maxY, colour, deltas);
    }

    // left & right edges
    for (let y = minY; y <= maxY; y++) {
        setPixel(pixels, size, minX, y, colour, deltas);
        setPixel(pixels, size, maxX, y, colour, deltas);
    }

    const newKey = pixels.join("");
    await updateCanvas(submitted, newKey, deltas, showsPlot);
}

async function BucketFillModal(
    id: number,
    interaction: StringSelectMenuInteraction,
) {
    const modal = new ModalBuilder()
        .setCustomId(`bm:${id}`)
        .setTitle("Bucket Fill Tool");

    const fillInput = new TextInputBuilder()
        .setCustomId("fill")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("1,1")
        .setMinLength(3)
        .setMaxLength(5);

    const fillLabel = new LabelBuilder()
        .setLabel("Fill from:")
        .setTextInputComponent(fillInput);

    const colourList = getColourList(
        getStringSelectById(interaction.message, "cc:advanced")!,
    );

    const colour = await getUserColour(interaction.user.id);

    const colourLabel = new LabelBuilder()
        .setLabel("Pick a colour")
        .setStringSelectMenuComponent(
            await createColourMenu(colour, "modal", colourList),
        );

    modal.addLabelComponents(fillLabel, colourLabel);

    return modal;
}

async function handleBucketFill(interaction: StringSelectMenuInteraction) {
    const canvasState = await parseCanvasState(interaction.message);
    if (!canvasState) return;

    const { key, size, showsPlot } = canvasState;
    if (!key) return;

    const id = Math.floor(Math.random() * 1_000_000);
    const modal = await BucketFillModal(id, interaction);

    await interaction.showModal(modal);

    let submitted;

    try {
        submitted = await interaction.awaitModalSubmit({
            filter: (i) =>
                i.user.id === interaction.user.id && i.customId === `bm:${id}`,
            time: 60_000,
        });
    } catch {
        return;
    }

    const fill = submitted.fields.getTextInputValue("fill");
    const colour = submitted.fields.getStringSelectValues("cc:modal")[0]!;

    const startCoords = parseCoords(fill, size);

    if (!startCoords) {
        await submitted.reply({
            content: "Invalid coordinates.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await submitted.deferUpdate();

    const [startX, startY] = startCoords;
    const pixels = key.match(/.{6}/g)!;
    const targetColour = pixels[startY * size + startX]!;

    if (targetColour === colour) return;

    const deltas: string[] = [];
    const queue: [number, number][] = [[startX, startY]];
    const seen = new Set<number>();

    while (queue.length > 0) {
        const [x, y] = queue.shift()!;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;

        const idx = y * size + x;
        if (seen.has(idx)) continue;
        if (pixels[idx] !== targetColour) continue;

        seen.add(idx);
        setPixel(pixels, size, x, y, colour, deltas);

        queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }

    const newKey = pixels.join("");
    await updateCanvas(submitted, newKey, deltas, showsPlot);
}

async function ReplaceColourModal(
    id: number,
    interaction: StringSelectMenuInteraction,
) {
    const modal = new ModalBuilder()
        .setCustomId(`rm:${id}`)
        .setTitle("Replace Colour Tool");

    const colourList = getColourList(
        getStringSelectById(interaction.message, "cc:advanced")!,
    );
    const colour = await getUserColour(interaction.user.id);

    const oldLabel = new LabelBuilder()
        .setLabel("Pick a colour to replace")
        .setStringSelectMenuComponent(
            (await createColourMenu("000000", "modal", colourList)).setCustomId(
                "old",
            ),
        );

    const newLabel = new LabelBuilder()
        .setLabel("Pick a new colour")
        .setStringSelectMenuComponent(
            (await createColourMenu(colour, "modal", colourList)).setCustomId(
                "new",
            ),
        );

    modal.addLabelComponents(oldLabel, newLabel);

    return modal;
}

async function handleReplaceColour(interaction: StringSelectMenuInteraction) {
    const canvasState = await parseCanvasState(interaction.message);
    if (!canvasState) return;

    const { key, showsPlot } = canvasState;
    if (!key) return;

    const id = Math.floor(Math.random() * 1_000_000);
    const modal = await ReplaceColourModal(id, interaction);

    await interaction.showModal(modal);

    let submitted;

    try {
        submitted = await interaction.awaitModalSubmit({
            filter: (i) =>
                i.user.id === interaction.user.id && i.customId === `rm:${id}`,
            time: 60_000,
        });
    } catch {
        return;
    }

    const oldColour = submitted.fields.getStringSelectValues("old")[0]!;
    const newColour = submitted.fields.getStringSelectValues("new")[0]!;

    if (oldColour === newColour) {
        await submitted.reply({
            content: "Colours are the same.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await submitted.deferUpdate();

    const pixels = key.match(/.{6}/g)!;
    const deltas: string[] = [];

    for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] === oldColour) {
            pixels[i] = newColour;
            deltas.push(`${i}:${newColour}`);
        }
    }

    if (deltas.length === 0) return;

    const newKey = pixels.join("");
    await updateCanvas(submitted, newKey, deltas, showsPlot);
}

async function handlePlot(interaction: StringSelectMenuInteraction) {
    const allowed = ensureOwner(
        interaction,
        interaction.message,
        "You cannot toggle plots on this canvas.",
    );
    if (!allowed) return;

    const url = interaction.message.embeds?.[0]?.image?.url;

    const showsPlot = url?.includes("?plot=True") ?? false;

    const key = await getCanvasKey(url!);

    await interaction.update({
        embeds: [await createCanvasEmbed(key, !showsPlot)],
    });
}
