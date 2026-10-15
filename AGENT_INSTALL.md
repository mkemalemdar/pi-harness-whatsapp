# Installing pi-harness-whatsapp: notes for AI agents

This file is for an AI agent (Pi, Claude Code, Codex, …) asked to install this extension for a user. Read it fully before changing anything.

## What you can and can't do

- **You can:**
  - check the machine and install the package
  - ask the user how they want it set up, and write the settings file for them
  - optionally set up the background service (only if asked)
- **You can't:**
  - **scan the QR code** — only the user can, with their phone
  - use the `/whatsapp` panel — it's an interactive terminal UI meant for the user
- So the install ends with the **user** starting Pi and scanning the QR. Tell them exactly how (see "Hand over to the user").

## 1. Check the machine

Do these yourself before asking anything, so your questions can include the results.

- **Command conflicts:** this extension registers the `/whatsapp` command. List the commands that are already registered:
  ```bash
  echo '{"type":"get_commands"}' | pi --mode rpc | grep '"get_commands"'
  ```
  If another package already registers `/whatsapp` (each entry shows its `source`), tell the user it has to be removed first, and ask before removing it. Other WhatsApp extensions that use different command names can stay.
- **ffmpeg:** run `ffmpeg -version`. Without it, text still works, but voice notes don't. If it's missing, ask before installing it (it usually needs sudo: `sudo apt install ffmpeg`, `brew install ffmpeg`, …).
- **Free RAM:** run `free -m` (Linux). The speech-to-text model needs ~1.0 GB (base), ~1.6 GB (small) or ~2.9 GB (turbo) while a voice note is transcribed.

## 2. Ask the basics

Ask these together, in one message, and wait for the answers:

1. **Which WhatsApp number will Pi use?** Recommend a **second number**. The extension uses an unofficial WhatsApp Web client (Baileys), and WhatsApp may restrict numbers that use one. Using their own number also works: they then talk to Pi in the "Message yourself" chat.
2. **Owner:** their own phone number, with country code. The owner is the only one who can change Pi from WhatsApp (`/model`, `/compact`, `/quit`, …). If they don't know it yet, skip it: the first person who messages the bot is offered as owner in the terminal.
3. **Languages:** which languages they'll write and speak in. The default is English only. Each spoken language downloads one voice (~67 MB). Speech recognition covers all languages with one model. Supported: English, Turkish, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Ukrainian, Arabic, Persian, Hindi, Swedish, Finnish and Chinese. Hindi voice notes aren't reliable yet with any model.
4. **Speech-to-text model** (recommend one that fits the free RAM you found):
   - **base** (default): ~1.0 GB, fastest (about 2.5–4.5× faster than the others in our tests)
   - **small**: ~1.6 GB, fewer mistakes than base in most tested languages
   - **turbo**: ~2.9 GB, the fewest mistakes in our tests
   - The README has a per-language table.
5. **Background service:** should Pi keep running without a terminal (see "Run in the background" in the README)? Don't set it up unless they say yes. If they do, ask which project folder Pi should work in.

## 3. Offer the other settings

Then show the remaining settings in **one** message, with the default for each, and ask which ones they want changed. Make it clear they can answer "defaults are fine", and that everything can be changed later in `/whatsapp`. Don't ask about each setting one by one.

| Setting (name in `/whatsapp`) | What it does | Default | Other choices |
|---|---|---|---|
| Reply type | How Pi answers | **mirror me**: a voice note gets a voice reply, text gets text | text only · voice note · voice note + text |
| Reply language | Which language Pi answers in | **mirror me**: the language they used | always one of their languages |
| Fallback language | Used only when Pi can't tell the language (e.g. very short replies) | **the first language** they named | any of their languages |
| Voice per language | Which voice speaks each language | the first voice in the table below | the other voices in the table |
| Voice reply speed | How fast voice replies are spoken | **1.0** | 0.5–2.0 (0.9 slower, 1.2 faster) |
| Terminal answers | Also sends the owner Pi's answers to prompts typed in the terminal, as text | **off** | on |
| Progress messages | Sends what Pi writes while it's still working | **off** | on |
| Live tool log | One message, updated live, with the latest tool steps | **off** | on |
| Changed files | Adds the list of files Pi wrote or edited | **off** | on |
| Stats (tools · time) | Adds a line like `✅ 4/6 tool calls ok · ⏱ 2m 14s` | **off** | on |
| Auto-send tool images | Sends every image a tool makes while answering (e.g. browser screenshots) | **off** | on |
| Who can use commands | Who may change Pi from WhatsApp | **only the owner** | everyone in Allowed chats (warn them: they could then switch models, compact, or quit Pi) |
| Ask on/off at session start | Asks whether WhatsApp should be on each time a Pi session opens | **off** (new sessions use the last choice) | on |
| Other allowed chats | People or groups besides the owner who may talk to Pi | **nobody** | numbers or groups they name (warn them: allowed chats can make Pi run commands on this machine) |

The final answer is always sent and can't be turned off.

## 4. Install

```bash
pi install npm:pi-harness-whatsapp
pi list    # should show npm:pi-harness-whatsapp
```

## 5. Write the settings

Settings live in `~/.pi/agent/pi-harness-whatsapp/config.json`. Unknown or invalid values are replaced with defaults, so writing only the fields that differ from the defaults is safe. Create the folder if needed, and keep the file private (`chmod 600`).

Pi reads this file when a session starts, and saves it when a setting changes. If a Pi with this extension is already running, ask the user to quit it before you write the file, so it doesn't keep the old settings or save over yours.

Example: English and Turkish, the owner set, stats on, a slightly faster voice:

```json
{
  "version": 1,
  "languages": ["en", "tr"],
  "voices": { "en": "en_GB-cori-medium" },
  "speechModel": "base",
  "voiceMode": "mirror",
  "replyLanguage": "mirror",
  "voiceSpeed": 1.1,
  "replies": { "summary": true },
  "contacts": [{ "id": "905551234567", "name": "Alex", "owner": true }]
}
```

| Field | Setting | Values |
|---|---|---|
| `languages` | My languages, Fallback language | Language codes from the table below. The **first** one is the fallback language. |
| `voices` | Voice per language | `{ "<code>": "<voice id>" }` for the languages whose voice should differ from the default |
| `speechModel` | Speech-to-text model | `base` (default) · `small` · `turbo` |
| `voiceMode` | Reply type | `mirror` (default) · `off` (text only) · `voice` · `voice+text` |
| `replyLanguage` | Reply language | `mirror` (default) or one of `languages` |
| `voiceSpeed` | Voice reply speed | 0.5–2.0 (default 1.0) |
| `replies` | Terminal answers, Progress messages, Live tool log, Changed files, Stats | `{ "terminal", "interim", "toolActivity", "touchedFiles", "summary" }`, booleans, all `false` by default |
| `forwardToolImages` | Auto-send tool images | boolean, default `false` |
| `commandAccess` | Who can use commands | `owner` (default) · `allowed` |
| `askAtSessionStart` | Ask on/off at session start | boolean, default `false` |
| `contacts` | Allowed chats | `id` is digits with country code and no `+` (e.g. `905551234567`), or a group JID like `120363…@g.us`. `owner: true` on exactly one person. `name` is optional. |

Leave out `lastEnabled` and the `lid` of contacts: the extension fills them in itself.

Languages and voices (the first voice is the default):

| Code | Voices |
|---|---|
| `en` English | `en_US-amy-medium` Amy (US, female) · `en_US-ryan-medium` Ryan (US, male) · `en_US-lessac-medium` Lessac (US, female) · `en_GB-alan-medium` Alan (UK, male) · `en_GB-cori-medium` Cori (UK, female) |
| `tr` Turkish | `tr_TR-dfki-medium` DFKI (male) · `tr_TR-fahrettin-medium` Fahrettin (male) · `tr_TR-fettah-medium` Fettah (male) |
| `de` German | `de_DE-thorsten-medium` Thorsten (male) · `de_DE-kerstin-low` Kerstin (female) |
| `fr` French | `fr_FR-siwis-medium` Siwis (female) · `fr_FR-tom-medium` Tom (male) |
| `es` Spanish | `es_ES-davefx-medium` Davefx (Spain, male) · `es_MX-ald-medium` Ald (Mexico, male) |
| `it` Italian | `it_IT-paola-medium` Paola (female) · `it_IT-riccardo-x_low` Riccardo (male) |
| `pt` Portuguese | `pt_BR-faber-medium` Faber (Brazil, male) · `pt_PT-tugao-medium` Tugão (Portugal, male) |
| `nl` Dutch | `nl_NL-pim-medium` Pim (male) |
| `pl` Polish | `pl_PL-gosia-medium` Gosia (female) · `pl_PL-darkman-medium` Darkman (male) |
| `ru` Russian | `ru_RU-irina-medium` Irina (female) · `ru_RU-dmitri-medium` Dmitri (male) |
| `uk` Ukrainian | `uk_UA-lada-x_low` Lada (female) |
| `ar` Arabic | `ar_JO-kareem-medium` Kareem (male) |
| `fa` Persian | `fa_IR-amir-medium` Amir (male) |
| `hi` Hindi | `hi_IN-pratham-medium` Pratham (male) |
| `sv` Swedish | `sv_SE-nst-medium` NST |
| `fi` Finnish | `fi_FI-harri-medium` Harri (male) |
| `zh` Chinese | `zh_CN-huayan-medium` Huayan (female) |

If the user can't decide on a voice, keep the default and tell them they can hear each one later: `/whatsapp` → Voice per language → a voice → "Send me a sample on WhatsApp".

Speech files download by themselves when first needed. You don't have to fetch them.

## 6. Hand over to the user

Tell the user:

1. Start Pi: `pi`
2. Run `/whatsapp`, then set **WhatsApp** to **on** (Enter).
3. A QR code appears above the editor. On the phone that has the chosen number: **WhatsApp → Settings → Linked devices → Link a device**, then scan it.
4. From your own phone, send the bot number a message. If nobody is allowed yet, Pi asks in the terminal whether to allow you as owner.
5. **Send `/help` on WhatsApp.** It lists every command and shows the current settings (model, reply type, languages, which extras are on). Be sure to tell them this step: it's how they learn what they can do from the phone.

Then tell them, briefly:

- Anything that isn't a command goes to Pi as a prompt. Voice notes, images and files work too.
- From WhatsApp they can switch the model (`/model`), the reasoning level (`/think`), compact (`/compact`), stop a run (`/stop`), start a new session (`/new`) and change the reply type, language, speed and extras (`/voice`, `/lang`, `/speed`, `/replies`). Menus come as polls: tap an option.
- Everything else, including on/off, allowed chats and voices, is in `/whatsapp` in the terminal.

## Check it worked

- The footer of Pi shows `WA: connected as +<number> · <n> chats`.
- `~/.pi/agent/pi-harness-whatsapp/log/pi-harness-whatsapp.log` shows `state: open`.
- A WhatsApp message to the bot gets an answer, and `/help` gets the command list.

## Never do this

- Don't read, copy, print, upload or commit `~/.pi/agent/pi-harness-whatsapp/auth/`. It is the WhatsApp login; anyone with it can use the account.
- Don't add contacts the user didn't name. Allowed chats can send prompts to Pi, which can run commands on this machine.
- Don't set `commandAccess` to `allowed` unless the user asks.
- Don't install the systemd service, or enable it at boot, without the user's yes.
- Don't publish, fork or re-upload this package on the user's behalf.

## Troubleshooting

See the README's **Troubleshooting** section. The most common issues:
- the QR code expired: `/whatsapp → Connection → Connect now`
- `WA: in use by Pi #…`: another Pi holds the connection
- `ffmpeg` missing: voice notes fail with a clear error
