# Atlas Mobile

Expo client for a self-hosted Atlas server. Same API as the web dashboard:
server URL → `@atlas/client` → session token → `X-Org-Id`.

## Stack

Expo SDK 57, Expo Router, React Native Reusables, NativeWind, TanStack Query,
`@atlas/client`. See `docs/adr/0003-mobile-stack.md`.

## Run

The Atlas API must already be running (`bun run dev:server` or Docker on
port 4310). A fresh server can be set up on-device: admin account, workspace,
then an API-key provider. After that, chats stream through `@atlas/client`.

```bash
bun run dev:mobile
```

Then press `a` for Android or `i` for iOS. The app does not ship a hosted
API — like Bitwarden, you point it at your own Atlas URL from Sign in
(Logging in on → Self-hosted server). Examples:

- Production: `https://atlas.example.com` or `atlas.example.com`
- Android emulator: `http://10.0.2.2:4310`
- iOS simulator: `http://127.0.0.1:4310`
- Phone on LAN: `http://192.168.x.x:4310`

### Expo Web

Browser builds need the Atlas server to allow the exact origin serving Expo.
For the default local Expo Web URL, start or redeploy the server with:

```bash
ATLAS_CORS_ORIGINS=http://localhost:8081 bun run dev:server
```

For Docker, pass the same setting with `-e`. Multiple browser origins can be
separated by commas. Do not use a wildcard; native Android and iOS builds do
not need CORS.

## Servers and security

You can save and switch among Atlas installations from **Account → Server**.
Each saved URL has an independent session token, so switching a backend does
not reuse credentials or cached workspace data from another backend.

- Remote servers must use HTTPS. Public `http://` URLs are rejected.
- HTTP is available only for loopback or private-network addresses and needs
  an explicit confirmation. Use it only on a network you trust.
- A URL must return a compatible Atlas health response before it can be saved.
  Redirects are rejected so a token-auth client cannot silently move to a
  different origin.
- Session tokens are stored with device-only SecureStore accessibility and are
  deleted when you remove a server or sign out.

## Offline behavior

Atlas detects the device's network connection, including a phone connected only
to the LAN that hosts Atlas. When the connection drops, the app shows an
offline banner, keeps the last saved chats, files, and work lists available for
up to seven days, and stops requests rather than reporting a misleading server
error. Active screens refresh automatically after reconnection. Sending chat
messages and changing workspace data remain disabled while offline; they are
never silently queued or replayed.

The offline cache never stores a session token and is cleared when signing out.

If a server uses a reverse proxy or a path prefix, enter its external base URL
(for example `https://atlas.example.com/atlas`), not a dashboard subpage.

Keyboard controller and FlashList need a development build, not Expo Go:

```bash
cd apps/mobile
bunx expo prebuild
bunx expo run:android
```

Run a production bundle check before release:

```bash
cd apps/mobile
bunx tsc --noEmit
bunx expo export --platform ios --platform android --output-dir /tmp/atlas-mobile-export
```

`expo export` should print `Expo Autolinking module resolution enabled` for
both platforms. `expo-modules-autolinking verify` may still warn about
nested `expo-constants` copies. Leave that warning until the workspace
linker and TypeScript versions are aligned; do not suppress it in Metro
or LogBox. See `docs/adr/0003-mobile-stack.md`.

## Layout

```text
src/
  app/           Expo Router (auth, chat, files, work, agents, system)
  components/    Reusables + chat/file/work primitives
  features/      Server, auth, setup, chat streaming, and theme
  hooks/
  lib/           Client, storage, URL helpers
  shims/         Node APIs that Metro cannot load from @atlas/client
```
