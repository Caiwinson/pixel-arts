import {
    ActionRowBuilder,
    AttachmentBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    MessageFlags,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    StringSelectMenuOptionBuilder,
} from "discord.js";
import { getCanvasHistory, type CanvasHistoryRow } from "../../../database.js";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { DOMAIN_URL, PREVIEW_PATH } from "../../../constants.js";
import { get } from "http";
import { getCanvasKey } from "../../utils.js";

const TIMELAPSE_RENDER_BIN =
    process.env.TIMELAPSE_RENDER_BIN ?? "/usr/local/bin/timelapse-render";

export function createClosedCanvasView(): ActionRowBuilder<ButtonBuilder>[] {
    const download = new ButtonBuilder()
        .setCustomId("download")
        .setLabel("Download")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("📥");

    const timelapse = new ButtonBuilder()
        .setCustomId("timelapse")
        .setLabel("Timelapse")
        .setStyle(ButtonStyle.Success)
        .setEmoji("📼");

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        download,
        timelapse,
    );

    return [row];
}

// Download button

export async function downloadButtonExecute(
    interaction: ButtonInteraction,
): Promise<void> {
    const url = interaction.message.embeds?.[0]?.image?.url;

    if (!url) {
        await interaction.reply({
            content: "No image found.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const lastSegment = url.split("/").pop() ?? "";

    // Remove query string if present; default to empty string if undefined
    const noQuery = lastSegment.split("?")[0] ?? "";

    // Split on period and take the first part; safe because noQuery is always string
    const key = noQuery.split(".")[0]!;
    // Fetch the image
    const isLarge = url.includes("/image_large/");
    const imgRoute = isLarge ? "/image_large/" : "/image/";

    const response = await fetch(`${DOMAIN_URL}${imgRoute}${key}`);

    if (!response.ok) {
        await interaction.reply({
            content: "Failed to download image.",
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    // Convert to buffer
    const buffer = Buffer.from(await response.arrayBuffer());

    // Create attachment
    const attachment = new AttachmentBuilder(buffer, {
        name: "canvas.png",
    });

    // Send attachment
    await interaction.reply({
        files: [attachment],
        flags: MessageFlags.Ephemeral,
    });
}

// Timelapse button
export async function timelapseButtonExecute(
    interaction: ButtonInteraction,
): Promise<void> {
    try {
        // Fetch canvas history for this message / user
        const history = await getCanvasHistory(interaction.message.id);

        if (!history || history.length === 0) {
            await interaction.reply({
                content: "No canvas history found for timelapse.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const previewPath = path.join(
            PREVIEW_PATH,
            `${interaction.message.id}.mp4`,
        );

        // if file didnt exist
        if (!fs.existsSync(previewPath)) {
            // Generate video
            await generateTimelapseVideo(history, previewPath);
        }

        // Send video
        await interaction.reply({
            content: `Here’s your [timelapse](${DOMAIN_URL}/download/${interaction.message.id}-1) video!`,
            components: createTimelapseView(
                interaction.message.id,
                history.length,
            ),
            flags: MessageFlags.Ephemeral,
        });
    } catch (err) {
        console.error(err);
        await interaction.editReply({
            content: "Failed to generate timelapse video.",
        });
    }
}

export async function generateTimelapseVideo(
    history: CanvasHistoryRow[],
    previewPath: string,
): Promise<void> {
    if (!history.length) throw new Error("No history");

    await new Promise<void>((resolve, reject) => {
        const proc = spawn(TIMELAPSE_RENDER_BIN, [previewPath], {
            // Pipe stdin so we can write JSON history to it.
            // stdout/stderr inherit so errors show in your logs.
            stdio: ["pipe", "inherit", "inherit"],
        });

        proc.on("error", (err) => {
            reject(
                new Error(`timelapse-render failed to start: ${err.message}`),
            );
        });

        proc.on("close", (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`timelapse-render exited with code ${code}`));
            }
        });

        // Write the history JSON and close stdin so the binary sees EOF
        // and starts processing. This is equivalent to piping:
        //   echo '[...]' | timelapse-render output.mp4
        proc.stdin!.write(JSON.stringify(history), (err) => {
            if (err) reject(err);
        });
        proc.stdin!.end();
    });
}

function timeframe(duration: number): string {
    const hour = Math.floor(duration / 3600);
    const minute = Math.floor((duration - hour * 3600) / 60);
    const second = Math.floor(duration - hour * 3600 - minute * 60);

    let time = "";
    if (hour > 0) time += `${hour}:`;
    time += minute < 10 ? `0${minute}:` : `${minute}:`;
    time += second < 10 ? `0${second}` : `${second}`;
    return time;
}
// Create the speed select menu
function createTimelapseSpeedSelect(
    messageId: string,
    duration: number,
    defaultSpeed = 1,
) {
    const options: StringSelectMenuOptionBuilder[] = [];

    if (duration <= 4) {
        for (let i = 1; i <= duration; i++) {
            options.push(
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i}x (00:0${Math.floor(duration / i)})`)
                    .setValue(i.toString())
                    .setDefault(i === defaultSpeed),
            );
        }
    } else {
        const speeds = [
            1,
            ...[1, 2, 3, 4].map((i) => Math.floor((i / 4) * duration)),
        ];
        const uniqueSpeeds = Array.from(new Set(speeds)).sort((a, b) => a - b);

        for (const i of uniqueSpeeds) {
            options.push(
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${i}x (${timeframe(duration / i)})`)
                    .setValue(i.toString())
                    .setDefault(i === defaultSpeed),
            );
        }
    }

    return new StringSelectMenuBuilder()
        .setCustomId(`ts:${messageId}`)
        .addOptions(options);
}

// Create the timelapse view (ActionRow) with default speed
function createTimelapseView(
    messageId: string,
    duration: number,
    defaultSpeed = 1,
) {
    const speedSelect = createTimelapseSpeedSelect(
        messageId,
        duration,
        defaultSpeed,
    );
    const optionsButton = new ButtonBuilder()
        .setLabel("Click me for more options")
        .setStyle(ButtonStyle.Link)
        .setURL(`${DOMAIN_URL}/timelapse/${messageId}`);

    const actionRows = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            speedSelect,
        ),
        new ActionRowBuilder<ButtonBuilder>().addComponents(optionsButton),
    ];

    return actionRows;
}

export async function timelapseSelectExecute(
    interaction: StringSelectMenuInteraction,
) {
    if (!interaction.isStringSelectMenu()) return;

    const messageId = interaction.customId.split(":")[1]; // extract messageId
    const selectedSpeed = parseInt(interaction.values[0]!);

    const options = interaction.component.options;
    const lastOption = parseInt(options[options.length - 1]!.value);

    // Recreate the view with the selected speed as default
    const updatedView = createTimelapseView(
        messageId!,
        lastOption,
        selectedSpeed,
    );

    // Build the download URL
    const downloadUrl = `Here’s your [timelapse](${DOMAIN_URL}/download/${messageId}-${selectedSpeed}) video!`;

    // Edit the original message
    await interaction.update({
        content: downloadUrl,
        components: updatedView,
    });
}
