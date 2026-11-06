# Pixel Arts

<img src="static/icon.png" alt="Pixel Arts icon" width="80" align="right" />

A Discord bot for creating collaborative pixel art canvases with your friends.

This repository is a complete migration from Python to TypeScript, rebuilt from scratch to improve performance, maintainability, and long-term scalability.

## Features

- **Create Canvases** — Use `/create canvas` to start a new canvas from 5×5 up to 15×15. Unlock 20×20 and 25×25 by voting.
- **Collaborate** — Invite friends to draw on the same canvas in real-time.
- **Recreate Images** — Transform any image into an editable pixel art canvas using `/recreate` _(vote required)_.
- **Timelapse** — Generate a speed-adjustable timelapse video of your canvas's evolution.
- **Advanced Tools** — Line drawing, rectangle, fill, and color replacement tools for complex designs.
- **Custom Colors** — Unlock any hex color by voting on Top.gg.

## Commands

| Command          | Description                                                |
| ---------------- | ---------------------------------------------------------- |
| `/create canvas` | Start a new pixel art canvas                               |
| `/recreate`      | Convert an image into an editable canvas _(vote required)_ |
| `/help`          | Show all commands and features                             |
| `/vote`          | Vote on Top.gg to unlock premium features                  |
| `/invite`        | Get the invite link for Pixel Arts                         |

## Getting Started

### Prerequisites

- Docker
- Docker Compose

### Installation

1. Copy the example environment file and fill in your values:

    ```bash
    cp .env.example .env
    ```

    The `.env` file requires the following variables:

    | Variable              | Description                                                                          |
    | --------------------- | ------------------------------------------------------------------------------------ |
    | `DISCORD_TOKEN`       | Bot token from the Discord Developer Portal                                          |
    | `TOPGG_TOKEN`         | Top.gg API token for posting server stats                                            |
    | `TOPGG_WEBHOOK`       | Webhook secret for verifying vote payloads                                           |
    | `WEBHOOK_URL`         | _(Optional)_ Discord webhook for logging new canvases                                |
    | `DOMAIN_URL`          | Public-facing base URL of the web service (no trailing slash)                        |
    | `INTERNAL_API_SECRET` | Shared secret the bot uses to sign requests to the web service (must match on both)  |
    | `INTERNAL_URL`        | _(Optional)_ URL the bot uses to reach the web service. Default: `http://web:8080`   |
    | `POSTGRES_USER`       | PostgreSQL username                                                                  |
    | `POSTGRES_PASSWORD`   | PostgreSQL password                                                                  |
    | `POSTGRES_DB`         | PostgreSQL database name                                                             |

    Generate the internal secret with:

    ```bash
    openssl rand -hex 32
    ```

2. Create a `docker-compose.yml` file:

    ```yaml
    services:
        db:
            image: postgres:16-alpine
            restart: unless-stopped
            environment:
                POSTGRES_USER: ${POSTGRES_USER}
                POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
                POSTGRES_DB: ${POSTGRES_DB}
            volumes:
                - ./data/postgres:/var/lib/postgresql/data
            healthcheck:
                test:
                    [
                        "CMD-SHELL",
                        "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}",
                    ]
                interval: 10s
                timeout: 5s
                retries: 5

        web:
            image: ghcr.io/caiwinson/pixel-arts:latest
            restart: unless-stopped
            env_file: .env
            environment:
                APP_MODE: web
            ports:
                - "8080:8080"
            volumes:
                - ./data:/app/data
            depends_on:
                db:
                    condition: service_healthy

        bot:
            image: ghcr.io/caiwinson/pixel-arts:latest
            restart: unless-stopped
            env_file: .env
            environment:
                APP_MODE: bot
            depends_on:
                db:
                    condition: service_healthy
    ```

3. Start all services:

    ```bash
    docker-compose up -d
    ```

### Development

```bash
npm install
npm run dev
```

To build for production:

```bash
npm run build
npm start
```

## Usage

1. **Create a Canvas** — Run `/create canvas` and choose a size.
2. **Draw** — Click the grid buttons to fill pixels with your selected color.
3. **Advanced Canvases** — On larger canvases, use the X/Y selectors then hit **Place Pixel**.
4. **Tools** — Open the Tool menu for line, fill, rectangle, outline, and color replacement.
5. **Undo** — Undo your last placement (up to 3 times per minute).
6. **Close & Timelapse** — Close the canvas and press **Timelapse** to generate a replay video.
7. **Recreate** — Use `/recreate` to turn any image into an editable canvas _(vote required)_.

## Architecture

Pixel Arts runs as two services from the same image, selected by `APP_MODE`:

| Service | `APP_MODE` | Responsibility                                                          |
| ------- | ---------- | ----------------------------------------------------------------------- |
| `bot`   | `bot`      | Discord interactions, canvas state, votes                               |
| `web`   | `web`      | Image rendering, timelapse rendering, downloads, Top.gg vote webhook    |

### Timelapse generation

Timelapse videos are rendered by the web service only. When a user presses
**Timelapse**, the bot sends a signed request to the web service's internal
endpoint, which renders the video (if it doesn't exist yet) and returns the
frame count.

- Requests are authenticated with an HMAC-SHA256 signature over
  `timestamp.messageId` using `INTERNAL_API_SECRET`, with a 30 second validity
  window.
- If `INTERNAL_API_SECRET` is not set on the web service, the endpoint is
  disabled.
- The public routes (`/download`, `/preview`, `/canvas-history`) only serve
  videos that already exist and can never start a new render.
- Renders are limited to 2 at a time, de-duplicated per canvas, and written
  atomically so partial files are never served.

### Running the services on separate machines

The bot and web services can run on different machines. Connect them over a
private network (e.g. Tailscale or WireGuard) and:

1. Set `INTERNAL_API_SECRET` to the same value on both machines.
2. On the bot machine, set `INTERNAL_URL=http://<web-private-ip>:8080`.
3. On the web machine, set `POSTGRES_HOST=<db-private-ip>`.
4. Set `DOMAIN_URL` to the public URL on both machines.
5. Bind PostgreSQL to the private interface only, and don't expose `/internal`
   through your public reverse proxy.
6. Only the web machine needs the `./data` volume.

Run a single web instance, or share the `data` volume between instances.
Rendered videos and caches are stored on local disk.

## Links

- [Website](https://pixel-arts.caiwinson.space)
- [Invite the Bot](https://top.gg/bot/1008692736720908318/invite)
- [Support Server](https://discord.gg/ErBJ7JTUYe)
- [Vote on Top.gg](https://top.gg/bot/1008692736720908318/vote)
