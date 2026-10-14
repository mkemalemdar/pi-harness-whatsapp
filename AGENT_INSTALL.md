# Installing pi-harness-whatsapp: notes for AI agents

This file is for an AI agent (Pi, Claude Code, Codex, …) asked to install this extension for a user. Read it fully before changing anything.

## What you can and can't do

- **You can:**
  - install the package
  - check the prerequisites
  - write the settings file before the first start
  - optionally set up the background service (only if asked)
- **You can't:**
  - **scan the QR code** — only the user can, with their phone
  - use the `/whatsapp` panel — it's an interactive terminal UI meant for the user
- So the install ends with the **user** starting Pi and scanning the QR. Tell them exactly how (see step 6).

## Ask the user first

Ask these together, in one message, and wait for the answers:

1. **Which WhatsApp number will Pi use?** Recommend a **second number**. The extension uses an unofficial WhatsApp Web client (Baileys), and WhatsApp may restrict numbers that use one. Using their own number also works: they then talk to Pi in the "Message yourself" chat.
2. **Command conflicts:** this extension registers the `/whatsapp` and `/whatsapp-new` commands. Before installing, list the commands that are already registered:
   ```bash
   echo '{"type":"get_commands"}' | pi --mode rpc | grep '"get_commands"'
   ```
   If another package already registers `/whatsapp` or `/whatsapp-new` (each entry shows its `source`), ask the user to remove that package first. Other WhatsApp extensions that use different command names can stay.
3. **Languages:** which languages they will speak and want spoken replies in. The default is English only. Each spoken language downloads one voice (~67 MB); speech recognition covers all languages with one model.
4. **Speech model:** this depends on free RAM (check with `free -m`):
   - **base** (default): ~1.3 GB, fastest (about 3× faster than the others in our tests)
   - **small**: ~1.6 GB, made fewer mistakes than base on the Turkish test
   - **turbo**: ~2.6 GB, the largest model
5. **ffmpeg:** if `ffmpeg -version` fails, ask before installing it (it usually needs sudo: `sudo apt install ffmpeg`, `brew install ffmpeg`, …). Without it, text still works, but voice notes don't.
6. **Owner:** who may change Pi's settings from WhatsApp (their own phone number, with country code). If they don't know yet, skip it: the first person who messages the bot is offered as owner in the terminal.
7. **Background service:** whether Pi should keep running without a terminal (see "Run in the background" in the README). Don't set it up unless they say yes. If they do, ask which project folder Pi should work in.

## Install

```bash
pi install npm:pi-harness-whatsapp
pi list    # should show npm:pi-harness-whatsapp
```

## Write the settings (optional, before the first start)

Settings live in `~/.pi/agent/pi-harness-whatsapp/config.json`. Unknown or invalid values are replaced with defaults, so writing only the fields you need is safe. Create the folder if needed, and keep the file private (`chmod 600`).

```json
{
  "version": 1,
  "languages": ["en", "tr"],
  "speechModel": "base",
  "voiceMode": "mirror",
  "replyLanguage": "mirror",
  "contacts": [{ "id": "905551234567", "name": "Alex", "owner": true }]
}
```

| Field | Values |
|---|---|
| `languages` | Language codes; the first one is the default: `en tr de fr es it pt nl pl ru uk ar fa hi sv zh` |
| `speechModel` | `base` (default) · `small` · `turbo` |
| `voiceMode` | `off` · `voice` · `voice+text` · `mirror` (default: voice note in → voice reply) |
| `replyLanguage` | `mirror` (default) or one of `languages` |
| `voiceSpeed` | 0.5–2.0 (default 1.0) |
| `replies` | `{ "summary", "interim", "touchedFiles", "toolActivity" }` booleans, all `false` by default |
| `commandAccess` | `owner` (default) · `allowed` |
| `contacts` | `id` is digits with country code and no `+` (e.g. `905551234567`), or a group JID like `120363…@g.us`. `owner: true` on exactly one person. |
| `askAtSessionStart`, `forwardToolImages` | booleans (defaults `false`, `true`) |

Speech models download by themselves when first needed. You don't have to fetch them.

## Hand over to the user

Tell the user:

1. Start Pi: `pi`
2. Run `/whatsapp`, then set **WhatsApp** to **on** (Enter).
3. A QR code appears above the editor. On the phone that has the chosen number: **WhatsApp → Settings → Linked devices → Link a device**, then scan it.
4. From your own phone, send the bot number a message. If nobody is allowed yet, Pi asks in the terminal whether to allow you as owner.
5. Send `/help` in WhatsApp to see the commands.

## Check it worked

- The footer of Pi shows `WA: connected as +<number> · <n> chats`.
- `~/.pi/agent/pi-harness-whatsapp/log/pi-harness-whatsapp.log` shows `state: open`.
- A WhatsApp message to the bot gets an answer.

## Never do this

- Don't read, copy, print, upload or commit `~/.pi/agent/pi-harness-whatsapp/auth/`. It is the WhatsApp login; anyone with it can use the account.
- Don't add contacts the user didn't name. Allowed contacts can send prompts to Pi, which can run commands on this machine.
- Don't set `commandAccess` to `allowed` unless the user asks.
- Don't install the systemd service, or enable it at boot, without the user's yes.
- Don't publish, fork or re-upload this package on the user's behalf.

## Troubleshooting

See the README's **Troubleshooting** section. The most common issues:
- the QR code expired: `/whatsapp → Connection → Connect now`
- `WA: in use by Pi #…`: another Pi holds the connection
- `ffmpeg` missing: voice notes fail with a clear error
