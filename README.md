<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/atlas-logo-dither-dark.png" />
    <img alt="Atlas logo" src="assets/atlas-logo-dither-light.png" width="188" />
  </picture>
</p>

# Atlas

> **Fork & Attribution Notice**: **Atlas** is a rebranded fork of [Nakama](https://github.com/ahmadrosid/nakama), originally created by [ahmadrosid](https://github.com/ahmadrosid).

Your next hire will still be human.
With Atlas, that person works on important tasks.
The AI agents do the trivial tasks.

Atlas is a small, self-hosted service for AI agents. You can imagine that Atlas is like [OpenClaw](https://github.com/openclaw/openclaw) and [Hermes Agent](https://github.com/nousresearch/hermes-agent) but designed to work with your teams.

- Atlas is multi-tenant by design.
- Those projects serve one operator on one machine.
- Atlas is one server for many orgs.
- Each org has isolated profiles, sessions, member invites, and roles.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/atlas_demo_dark.png" />
  <img alt="Atlas dashboard demo" src="assets/atlas_demo_light.png" />
</picture>

Open [ARCHITECTURE.md](./ARCHITECTURE.md) for the system design.

## Quick start

### Run locally

You need [Bun](https://bun.sh). For PowerPoint, Word, and Excel previews and thumbnails, also install [LibreOffice](https://www.libreoffice.org/) (`soffice`). Docker images include it.

```bash
# Install dependencies
bun install

# Start the web (starts the server automatically if needed)
bun run dev:web
```

Open the web dashboard: http://localhost:3000

Or start the server alone:

```bash
bun run dev:server
```

### Docker

You can also run Atlas with Docker.

**Prebuilt image (fastest):**

```bash
# Pull and run the latest image
docker pull ghcr.io/kungfufafa/atlas:latest
docker run -d -p 4310:4310 -v atlas-data:/atlas/data --name atlas ghcr.io/kungfufafa/atlas:latest
```

**Build from source:**

```bash
./scripts/docker-build-run.sh
```

**Fresh start:**

```bash
./scripts/docker-destroy.sh
./scripts/docker-build-run.sh
```

Open the dashboard at http://localhost:4310.

### Integrations

Atlas connects to **Telegram**, **WhatsApp**, and **Composio**.
With Composio, you can connect to more than 1,000 external apps.
Enable them in the web app under **Integrations**.

On the first run, open the dashboard and complete the setup wizard (admin account, workspace, and LLM provider).
Provider settings are saved in `~/.atlas/config.ini`.

The server listens on `http://127.0.0.1:4310` by default.
Interactive API docs are at `http://127.0.0.1:4310/docs`.

## License & Attribution

MIT License. Atlas is a rebranded fork of [Nakama](https://github.com/ahmadrosid/nakama) by [ahmadrosid](https://github.com/ahmadrosid). All original copyright and licensing terms apply.

