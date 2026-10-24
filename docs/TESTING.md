# Testing

## Unit tests

```bash
npm run check     # typecheck + unit tests
```

Node's own test runner. `test/setup.ts` (loaded before every test file) points `PI_HARNESS_WHATSAPP_DIR` at a
temporary folder, so the tests never touch the real login or settings, and removes it afterwards. GitHub runs them
on Linux and macOS for every push.

- Pure logic (`src/core/`, ids, access, reconnect decisions) is tested directly.
- The bridge is tested with a harness of fake pi events and a fake send queue (`test/bridge.test.ts`). The bridge
  waits for pi with unref'd timers, so each of those tests holds the event loop open with a timer of its own.
- The panel is driven with key presses and its rendered text checked.
- Downloads run against a local fake server; the speech engine test runs only where the real models are installed
  (it skips itself and says why otherwise).

## Integration test: a real pi, a fake WhatsApp

```bash
node test/integration/whatsapp.mjs
```

No phone, account, model or GPU needed. It starts:

- **a fake model**: a small OpenAI-style server that answers `echo: <the message>`, set up as a provider in a
  temporary `models.json`;
- **a real pi** in RPC mode, in a temporary agent folder, with `test/integration/fake-whatsapp.ts` instead of the
  extension. That file runs the real extension (`createExtension`) with a fake Baileys: it's logged in as a test
  number (and keeps `creds.json` like Baileys does), `/fakewa {…}` makes a message arrive, and everything sent to
  WhatsApp is written to a log the test reads.

| Check | |
|---|---|
| connects without a QR code | |
| the "Message yourself" chat reaches pi, and the answer comes back there | one number |
| an allowed contact gets the answer in their chat | |
| a stranger never reaches the model, and gets nothing | |
| your own message in a group is ignored | one number |
| a contact @mentioning pi in an allowed group gets the answer there | |
| `/help` is answered without the model | |
| a prompt typed in the terminal stays there | |
| `/whatsapp remove` unlinks and deletes the extension's folder | |

It removes everything it made. To see what a real phone does, pair a real (spare) number with `/whatsapp` instead.
