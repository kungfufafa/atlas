# Channel documentation browser QA

Completed against local Next.js preview on `http://127.0.0.1:3000`, using isolated headless Playwright Chromium at 1440×1000.

## Verified

- `/atlas/discord`, `/atlas/whatsapp`, `/atlas/telegram`: HTTP 200; expected page titles; new role/denylist paragraphs visible.
- Discord command table includes paired workspace/platform admin restriction for `/allow`.
- WhatsApp group session description identifies separate sessions for each sender.
- Original states captured from a temporary copy with only the three MDX files restored from HEAD. Original workspace source files were never reverted for comparison.
- Eight before/after screenshots cover the three permission sections and Discord command table; the Discord table, WhatsApp section, and search-result screenshots were visually inspected for clipping/overlap.
- Sidebar navigation Discord → WhatsApp → Telegram → Discord passed.
- Search opens, accepts `discord`, fetches its static index with HTTP 200, shows relevant results, dismisses with Escape, reopens, and selecting a visible result closes the dialog. Search result destination transition was not separately proved because the initial route already matched the checked Discord URL.
- No browser page errors observed on page rendering or the completed interaction checks.

## Runtime notes and cleanup

The sandbox blocked listening; the approved preview bound only to 127.0.0.1. The temporary copy's dependency symlink was incompatible with Turbopack, so both snapshots used Next's Webpack dev mode. An initial test click before hydration and an incorrect assumption that static search sends a query URL were corrected in the QA harness; the hydrated UI and static index completed the checks above.

Both preview servers and the temporary inspection process were stopped. Next-generated docs/website/AGENTS.md and CLAUDE.md were removed, and Next's generated next-env.d.ts change was restored; the user's MDX changes remain intact.

## Pre-fix evidence

- `baseline-discord-auth-failures.log`: original Discord matrix151 pass/2 fail, demonstrating blocked paired /allow mutation and unknown-owner artifact emission.
- `baseline-channel-pairing-failures.log`: original2 failures demonstrating blocked Telegram/Discord callers reaching principal binding with a valid code.
