import { WebhookClient, type APIEmbed } from "discord.js";
import { DOMAIN_URL, WEBHOOK_URL } from "../../constants.js";

/**
 * Check if a string is a valid SHA256 hash
 */
function isSha256(value: string): boolean {
    return /^[A-Fa-f0-9]{64}$/.test(value);
}

/**
 * Sends a message to the configured webhook URL asynchronously using discord.js
 */
export async function sendWebhookMessage(content: string): Promise<void> {
    if (!WEBHOOK_URL) {
        console.warn("Webhook URL not configured. Skipping webhook send.");
        return;
    }

    // Discord.js WebhookClient can take a full URL
    const webhook = new WebhookClient({ url: WEBHOOK_URL });

    const domainUrl = DOMAIN_URL;

    const embed: APIEmbed = {
        description: "",
        color: 5793266,
    };

    if (isSha256(content)) {
        embed.description = `[Too Long](${domainUrl}/image_large/${content})`;
        embed.image = { url: `${domainUrl}/image_large/${content}` };
    } else if (content.length === 150) {
        embed.description = `[${content.toUpperCase()}](${domainUrl}/image/${content})`;
        embed.image = { url: `${domainUrl}/image/${content}` };
    } else if (content.length > 150 && content.length <= 1350) {
        embed.description = `[Too Long](${domainUrl}/image/${content})`;
        embed.image = { url: `${domainUrl}/image/${content}` };
    } else {
        embed.description = content;
    }

    try {
        await webhook.send({ embeds: [embed] });
    } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.warn(`Webhook request failed: ${errorMessage}`);
    }
}
