# ADR 0003 — Atlas Mobile stack

Atlas Mobile is a first-party client of the same self-hosted server as web
and CLI. It lives at `apps/mobile` and talks to Atlas through `@atlas/client`.

## Decision

- **Expo SDK 57 + React Native + TypeScript** — one app for Android and iOS,
  local or EAS builds, signed by us.
- **Expo Router** — auth, tabs, agent detail, and `atlas://` deep links.
- **React Native Reusables + NativeWind + `@rn-primitives/*`** — the mobile
  equivalent of web's shadcn + Tailwind. Unistyles is not used.
- **`@expo/ui`** — native controls only where the platform control is clearly
  better (switch, picker, menu).
- **Hugeicons React Native** and **Instrument Sans + JetBrains Mono** — same
  icon and type family as web.
- **TanStack Query** for server state; React Context for the active server,
  org, and session; local state for composers and sheets. Zustand is not
  introduced until UI state crosses several screens.
- **SecureStore** for session tokens; **AsyncStorage** for server URL and
  theme. Each saved server has its own session.
- **FlashList**, **Reanimated**, **Gesture Handler**, and
  **react-native-keyboard-controller** for chat-scale lists and input.

## Auth

Web login is cookie + CSRF. React Native cannot use that path.

Mobile sends `X-Atlas-Auth-Mode: token` on login/setup. The server still
creates a browser session, and **also** returns `sessionToken` in the JSON
body. The app stores that token in SecureStore and sends
`Authorization: Bearer <sessionToken>`. CSRF is skipped for this bearer
session mode. Local-auth CLI tokens (`tc_local_…`) stay a separate Bearer
path.

The session token is never returned unless the client asked for token auth,
so the web dashboard is unchanged.

## Server selection and isolation

Mobile treats every self-hosted Atlas URL as a separate trust boundary:

- A server must pass `GET /health` with the current API version before it can
  be saved.
- Remote servers require HTTPS. HTTP is accepted only for loopback or private
  network endpoints after an explicit user confirmation. iOS allows only local
  network cleartext traffic; Android cleartext is enabled for user-selected
  private endpoints while the URL validator rejects public HTTP.
- The mobile token-auth client rejects redirects. A checked URL cannot silently
  forward bearer traffic to another origin.
- The saved-server identifier derives from the complete canonical URL, so
  HTTP/HTTPS and path-prefixed deployments cannot collide in SecureStore.
- Every React Query key is scoped by server and organization. A backend switch
  aborts/removes the old server's work, remounts the authenticated navigation,
  and never exposes credentials or cached data from the previous backend.
- SecureStore uses device-only accessibility. Removing a server deletes its
  token; a migration from the legacy identifier scheme is conservative and
  never assigns an ambiguous token to a different server.

Chat streaming, composer, artifacts, and first-time setup are supported by the
mobile client. The initial release still relies on the Atlas server for all
authorization and data retention policies.

## Monorepo linking

Keep the current Bun workspace linker and Metro config
(`watchFolders` + `nodeModulesPaths` in `apps/mobile/metro.config.js`).
Expo Autolinking is on for both platforms:

- Metro prints `Expo Autolinking module resolution enabled` on
  `expo export --platform ios` and `expo export --platform android`.
- iOS uses `use_expo_modules!` and `expo-modules-autolinking`.
- `expo-modules-autolinking react-native-config` resolves native modules
  from the workspace root for iOS and Android.

`expo-modules-autolinking verify` still warns about nested
`expo-constants` copies (hoisted `57.0.16` vs `57.0.15` under
`expo-asset` and `expo-linking`). That is a Bun workspace install, not a
failed autolink. Do not hide it with LogBox, Metro `blockList` /
`disableHierarchicalLookup`, a one-off `overrides` entry, or deleting
`bun.lock`. Clearing it needs a workspace-wide linker migration and
TypeScript alignment (`apps/mobile` declares `typescript ~6.0.3`; the
repo typechecks on `5.9.3` and excludes mobile from
`tsconfig.typecheck.json`).
