import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import type { ButtonInteraction, StringSelectMenuBuilder } from "discord.js";
import { createCanvasEmbed, getCanvasKey } from "../../utils.js";
import { applyPixelUpdate, getUserColour } from "../../../database.js";
import { createColourMenu } from "../interactions/colour.js";

// Generate a row of buttons
function createCanvasRow(
    start: number,
    end: number,
): ActionRowBuilder<ButtonBuilder> {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let i = start; i < end; i++) {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`pb:${i}`)
                .setLabel("⠀") // invisible space
                .setStyle(ButtonStyle.Secondary), // gray button
        );
    }
    return row;
}

export function createBasicCanvasView(): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let id = 0;

    for (let y = 0; y < 5; y++) {
        // Each row has 5 buttons
        rows.push(createCanvasRow(id, id + 5));
        id += 5;
    }

    return rows;
}

export async function pixelExecute(interaction: ButtonInteraction) {
    const url = interaction.message.embeds?.[0]?.image?.url;
    const key = await getCanvasKey(url!);

    const num = Number(interaction.customId.split(":")[1]);
    const colour = await getUserColour(interaction.user.id);

    const newKey = await applyPixelUpdate(
        interaction.message.id,
        [`${num}:${colour}`],
        interaction.user.id,
        key,
    );
    const embed = await createCanvasEmbed(newKey);
    await interaction.update({ embeds: [embed] });
}

export async function createBasicColourView(
    defaultHex: string,
    extraColours: string[] = [],
): Promise<
    [ActionRowBuilder<StringSelectMenuBuilder>, ActionRowBuilder<ButtonBuilder>]
> {
    const menu = await createColourMenu(defaultHex, "basic", extraColours);

    const selectRow =
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("cl:basic")
            .setLabel("Close")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Danger),

        new ButtonBuilder()
            .setCustomId("ud:basic")
            .setLabel("Undo")
            .setEmoji("↩️")
            .setStyle(ButtonStyle.Secondary),
    );

    return [selectRow, buttonRow];
}
