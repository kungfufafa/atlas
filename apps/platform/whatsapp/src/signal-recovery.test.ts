import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Curve, generateSignalPubKey } from "@whiskeysockets/baileys";
import { makeLibSignalRepository } from "@whiskeysockets/baileys/lib/Signal/libsignal.js";
import { usePrivateMultiFileAuthState } from "./auth-state";

test("real Signal state survives a restart and a failed MAC without losing the next valid message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-signal-recovery-"));
  const originalUmask = process.umask();
  const writeError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const alice = await usePrivateMultiFileAuthState(join(directory, "alice"));
    const bob = await usePrivateMultiFileAuthState(join(directory, "bob"));
    const aliceJid = "620000000001@s.whatsapp.net";
    const bobJid = "620000000002@s.whatsapp.net";
    await alice.saveCreds();
    await bob.saveCreds();
    const aliceSignal = makeLibSignalRepository(alice.state);
    let bobSignal = makeLibSignalRepository(bob.state);
    const preKey = Curve.generateKeyPair();
    await bob.state.keys.set({ "pre-key": { "1": preKey } });
    await aliceSignal.injectE2ESession({
      jid: bobJid,
      session: {
        identityKey: generateSignalPubKey(
          bob.state.creds.signedIdentityKey.public
        ),
        preKey: { keyId: 1, publicKey: generateSignalPubKey(preKey.public) },
        registrationId: bob.state.creds.registrationId,
        signedPreKey: {
          keyId: bob.state.creds.signedPreKey.keyId,
          publicKey: generateSignalPubKey(
            bob.state.creds.signedPreKey.keyPair.public
          ),
          signature: bob.state.creds.signedPreKey.signature,
        },
      },
    });
    const first = await aliceSignal.encryptMessage({
      data: Buffer.from("first message"),
      jid: bobJid,
    });
    expect(
      Buffer.from(
        await bobSignal.decryptMessage({ ...first, jid: aliceJid })
      ).toString()
    ).toBe("first message");
    const reply = await bobSignal.encryptMessage({
      data: Buffer.from("acknowledged"),
      jid: aliceJid,
    });
    await aliceSignal.decryptMessage({ ...reply, jid: bobJid });

    const reloaded = await usePrivateMultiFileAuthState(join(directory, "bob"));
    expect(reloaded.state.creds.signedIdentityKey).toEqual(
      bob.state.creds.signedIdentityKey
    );
    bobSignal = makeLibSignalRepository(reloaded.state);
    const next = await aliceSignal.encryptMessage({
      data: Buffer.from("after restart"),
      jid: bobJid,
    });
    const damaged = Buffer.from(next.ciphertext);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] + 1) % 256;
    await expect(
      bobSignal.decryptMessage({ ...next, ciphertext: damaged, jid: aliceJid })
    ).rejects.toThrow();
    expect(
      Buffer.from(
        await bobSignal.decryptMessage({ ...next, jid: aliceJid })
      ).toString()
    ).toBe("after restart");
  } finally {
    writeError.mockRestore();
    process.umask(originalUmask);
    await rm(directory, { force: true, recursive: true });
  }
});
