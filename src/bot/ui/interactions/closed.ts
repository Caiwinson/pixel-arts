import crypto from "crypto";
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
import {
    DOMAIN_URL,
    INTERNAL_API_SECRET,
    INTERNAL_URL,
} from "../../../constants.js";

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

/** Asks the web service to render the timelapse. Returns the frame count. */
async function requestTimelapse(messageId: string): Promise<number> {
    if (!INTERNAL_API_SECRET) {
        throw new Error("INTERNAL_API_SECRET is not configured");
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
        .createHmac("sha256", INTERNAL_API_SECRET)
        .update(`${timestamp}.${messageId}`)
        .digest("hex");

    const res = await fetch(`${INTERNAL_URL}/internal/timelapse/${messageId}`, {
        method: "POST",
        headers: {
            "x-timestamp": timestamp,
            "x-signature": signature,
        },
        signal: AbortSignal.timeout(150_000),
    });

    if (res.status === 404) throw new Error("NO_HISTORY");
    if (!res.ok) throw new Error(`Web service responded ${res.status}`);

    const data = (await res.json()) as { frames: number };
    return data.frames;
}

export async function timelapseButtonExecute(interaction: ButtonInteraction) {
    // Rendering can exceed Discord's 3s window, so acknowledge first
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const frames = await requestTimelapse(interaction.message.id);

        await interaction.editReply({
            content: `Here’s your [timelapse](${DOMAIN_URL}/download/${interaction.message.id}-1) video!`,
            components: createTimelapseView(interaction.message.id, frames),
        });
    } catch (err: any) {
        if (err?.message === "NO_HISTORY") {
            await interaction.editReply({
                content: "No canvas history found for timelapse.",
            });
            return;
        }
        console.error(err);
        await interaction.editReply({
            content: "Failed to generate timelapse video.",
        });
    }
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
