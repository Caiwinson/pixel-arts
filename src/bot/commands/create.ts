import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    PermissionFlagsBits,
    MessageFlags,
    ModalSubmitInteraction,
} from "discord.js";
import {
    createBasicCanvasView,
    createBasicColourView,
} from "../ui/canvas/basic.js";
import { checkVote, createCanvasEmbed } from "../utils.js";
import { COLOUR_OPTION } from "../../constants.js";
import {
    incrementCanvasCount,
    recordPixelUpdate,
    getUserColour,
} from "../../database.js";
import { createColourModal } from "../ui/interactions/colour.js";
import { createAdvanceCanvasView } from "../ui/canvas/advance.js";

const colourChoices = [
    ...Object.entries(COLOUR_OPTION).map(([name, data]) => ({
        name: name, // display name in the slash command
        value: data.hex, // HEX value as the choice value
    })),
    {
        name: "Custom Colour",
        value: "custom", // special value to trigger the modal
    },
];

export const createCommandData = new SlashCommandBuilder()
    .setName("create")
    .setDescription("Create something")
    .addSubcommand((sub) =>
        sub
            .setName("canvas")
            .setDescription("Generate a new canvas")
            .addStringOption(
                (option) =>
                    option
                        .setName("colour")
                        .setDescription("Choose a colour")
                        .setRequired(false)
                        .addChoices(...colourChoices), // spread the array here
            )
            .addIntegerOption((option) =>
                option
                    .setName("size")
                    .setDescription("Canvas size")
                    .setRequired(false)
                    .addChoices(
                        { name: "5x5 (default)", value: 5 },
                        { name: "10x10", value: 10 },
                        { name: "15x15", value: 15 },
                        { name: "20x20 (vote only)", value: 20 },
                        { name: "25x25 (vote only)", value: 25 },
                    ),
            )
            .addBooleanOption((option) =>
                option
                    .setName("enable_tools")
                    .setDescription("Enable or disable tools")
                    .setRequired(false),
            ),
    );

export async function createCommandExecute(
    interaction: ChatInputCommandInteraction | ModalSubmitInteraction,
) {
    if (interaction.isModalSubmit()) {
        return;
    }
    if (interaction.inGuild()) {
        const channel = interaction.channel;
        if (!channel) return;

        const permissions = channel.permissionsFor(interaction.client.user!);
        if (
            !permissions?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
            ])
        ) {
            return interaction.reply({
                content: "I don't have permission to send messages here.",
                flags: MessageFlags.Ephemeral,
            });
        }
    }

    let baseColour = interaction.options.getString("colour") || "ffffff";
    const size = interaction.options.getInteger("size") || 5;
    const enableTools = interaction.options.getBoolean("enable_tools") ?? true;

    if (baseColour === "custom" || size > 15) {
        const hasVoted = await checkVote(interaction);
        if (!hasVoted) return;
    }

    if (baseColour === "custom") {
        const id = Math.floor(Math.random() * 1_000_000);
        await interaction.showModal(createColourModal(id));

        let submitted: ModalSubmitInteraction;
        try {
            submitted = await interaction.awaitModalSubmit({
                filter: (i) =>
                    i.user.id === interaction.user.id &&
                    i.customId === `cm:${id}`,
                time: 60_000,
            });
        } catch {
            await interaction
                .followUp({
                    content: "You did not submit a colour in time.",
                    flags: MessageFlags.Ephemeral,
                })
                .catch(() => {});
            return;
        }

        const hexInput = submitted.fields.getTextInputValue("hex_input");

        if (!/^([0-9A-Fa-f]{6})$/.test(hexInput)) {
            await submitted.reply({
                content:
                    "Invalid HEX code. Please enter 6 hexadecimal characters.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        baseColour = hexInput.toLowerCase();
        interaction = submitted;
    }

    const key = baseColour.repeat(size ** 2);
    const embed = await createCanvasEmbed(key, size > 5);
    const defaultHex = await getUserColour(interaction.user.id);

    if (size === 5) {
        await interaction.reply({
            content: `${interaction.user} has created a canvas.`,
            embeds: [embed],
            components: createBasicCanvasView(),
            withResponse: true,
        });

        const message = await interaction.fetchReply();

        await interaction.followUp({
            content: "Pick a colour!",
            components: await createBasicColourView(defaultHex),
        });

        await recordPixelUpdate(message.id, key, null, interaction.user.id);
        await incrementCanvasCount();
    } else {
        await interaction.reply({
            content: `${interaction.user} has created a canvas.`,
            embeds: [embed],
            components: await createAdvanceCanvasView(
                size,
                1,
                1,
                defaultHex,
                undefined,
                enableTools,
            ),
            withResponse: true,
        });

        const message = await interaction.fetchReply();

        await recordPixelUpdate(message.id, key, null, interaction.user.id);
        await incrementCanvasCount();
    }
}
