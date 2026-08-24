# WhatsApp Bridge

Run the WhatsApp bridge with:

```sh
bun run dev:whatsapp
```

Setup flow:

1. Start the server with `bun run dev:server`
2. Open the web dashboard and go to `Integrations -> WhatsApp`
3. Choose a reply profile and enter your WhatsApp number with country code
4. Click Enable WhatsApp, then start the bridge if it is not already running
5. Copy the Linked Devices code, or scan the QR code
6. In WhatsApp, open `Settings -> Linked Devices`
7. Choose `Link with phone number` and enter the code, or scan the QR code

Access mode controls who may chat after the account is linked. Open does not use a chat access code.

Notes:

- Auth state is stored in `~/.atlas/whatsapp/auth/`
- Chat session mappings are stored in `~/.atlas/whatsapp/chat-sessions.json`
- Restart the bridge after changing the saved phone number
