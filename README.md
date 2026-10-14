<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="" width="80">
</p>

# pi-harness-whatsapp

Talk to the [Pi coding agent](https://pi.dev) from WhatsApp: text, voice notes, images and files. Pi answers automatically, and you can switch models, compact the context or stop a run from your phone.

> 🤖 **AI agent installing this for someone?** Read [AGENT_INSTALL.md](AGENT_INSTALL.md) first: what to ask the user, how to configure, and what never to touch.

- **Scan a QR code once and you're in.** Pi runs as a linked device of a WhatsApp number. The login is saved, and Pi reconnects on its own.
- **Replies are automatic.** Pi's final answer is always sent back. The model doesn't have to call a tool.
- **You choose what else you get:** a summary line (`✅ 4/6 tool calls ok · ⏱ 2m 14s`), in-between messages, the list of touched files, and a live tool-activity message.
- **Voice notes both ways, on your own CPU.** Whisper understands them and Piper speaks the replies, through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx). No GPU or cloud service needed, and many languages are supported.
- **Control Pi from WhatsApp** with commands and poll menus: `/model`, `/think`, `/compact`, `/stop`, `/new`, `/status`, …
- **A real off switch.** Off means disconnected: nothing is read or sent, and the WhatsApp tools disappear from the model.

> **Use a second number if you can.** This extension uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. WhatsApp can restrict numbers that use unofficial clients, so a spare number is the safe choice.

## Requirements

- Pi 1.2 or newer
- `ffmpeg` on the PATH (for voice notes): `sudo apt install ffmpeg`
- Linux x64/arm64, macOS or Windows (sherpa-onnx ships ready-made builds)

## Install

```bash
pi install npm:pi-harness-whatsapp
```

Start Pi and run `/whatsapp`. Set **WhatsApp** to **on**, and a QR code appears above the editor. On your phone, go to **WhatsApp → Settings → Linked devices → Link a device** and scan it. That's it.

Nobody is allowed to talk to Pi yet. Send a message to the paired number from your phone and Pi asks, in the terminal, whether to allow you and make you the **owner**. You can also pick people from **Allowed contacts → Recent chats** or add a number by hand.

You can also use your own number: the "Message yourself" chat works and counts as the owner.

## How it works

- Messages from allowed contacts (or allowed groups) go to Pi as prompts, starting with `[WhatsApp · Name]`.
- Only runs that started from WhatsApp send replies back. Prompts you type in the terminal stay in the terminal.
- If Pi is busy, new WhatsApp messages are queued and answered in order.
- Messages sent while WhatsApp was off (or Pi wasn't running) are not acted on later, since they may be out of date. Instead, Pi replies once in that chat: "⏸ 3 messages arrived while Pi's WhatsApp was off and were skipped. Send again if still needed."
- Only one Pi process at a time can hold the WhatsApp connection. Others show `WA: in use by Pi #<pid>`.

## Settings: `/whatsapp`

| Setting | What it does |
|---|---|
| **WhatsApp** | On / Off for this session. Continued sessions get their own value back; new sessions start with the last value you chose. |
| **Reply: final answer** | Always on. |
| **Reply: summary** | Adds `✅ 4/6 tool calls ok · ⏱ 2m 14s`. |
| **Reply: in-between messages** | Sends what Pi writes while it's still working. |
| **Reply: touched files** | Adds the list of files Pi wrote or edited. |
| **Reply: tool activity** | One message, edited in place, showing the latest tool steps. |
| **Voice replies** | Off · Voice · Voice + text · **Mirror me** (voice note in → voice reply). |
| **Reply language** | **Mirror me** (answer in your language) or a fixed language. |
| **Languages / Default language / Voices** | Which languages Pi listens to and speaks, and with which voice. |
| **Speech model** | **Fast (base)** · Balanced (small) · Accurate (turbo). See below. |
| **Voice speed** | Slower 0.9 · Normal 1.0 · Faster 1.2 · Custom (0.5–2.0). |
| **Forward images from tools** | Screenshots and other images made by tools are sent to you. |
| **Ask at session start** | Asks "WhatsApp for this session?" when a session opens (off by default). |
| **Command access** | Who may change Pi from WhatsApp: **only the owner** (default) or all allowed contacts. |
| **Allowed contacts** | Who can talk to Pi. ★ marks the owner. |
| **Connection** | Connect, show a new QR code, or log out. |

Settings are stored in `~/.pi/agent/pi-harness-whatsapp/config.json`.

## WhatsApp commands

Commands are handled by the extension and never reach the model. Menus are **WhatsApp polls**: tap an option and it's applied right away, or reply with its number. Normal accounts can't send list or button messages; polls work everywhere.

| Command | What it does |
|---|---|
| `/help` | Commands and current settings |
| `/status` | Connection, model, thinking level, context use, voice models |
| `/stop` | Stop what Pi is doing |
| `/compact [focus]` | Compact the context, then report e.g. `✅ Compacted in 18s · 142k → 23k tokens (−84%) · context 89% free` |
| `/autocompact [on\|off]` | Automatic compaction for this session (Pi still compacts if the context is completely full) |
| `/model [name]` | Switch the model for this session; lists only models with a login or API key |
| `/think [level]` | Reasoning level, limited to what the model supports |
| `/voice [off\|voice\|both\|mirror]` · `/lang` · `/speed [x]` | Voice settings |
| `/replies` | Switch the reply extras on and off (multi-choice poll) |
| `/new` | Start a fresh Pi session (the old one stays saved) |
| `/off` | Turn WhatsApp off. It can be turned back on only from the terminal, or by restarting Pi. |
| `/quit` | Shut Pi down |
| `/restart` | Restart Pi (when it runs as a systemd service, see below) |

`/off`, `/quit` and `/restart` ask for confirmation first. Everything except `/help`, `/status` and `/languages` follows **Command access**.

## Voice

Voice notes are transcribed on your machine and given to Pi tagged with their language, e.g. `[voice note · Turkish] …`. With **Mirror me**, Pi answers in the language you used, and the voice reply uses that language's voice.

Models download automatically the first time they're needed, or right away when you change languages or the speech model. One multilingual Whisper model covers every language. Each spoken language needs one Piper voice (~67 MB download).

Measured on an Intel i5-13500 (CPU only, 8 threads). For each language, a ~20-second voice note with the same short developer update was spoken by that language's Piper voice. Each model transcribed every note 5 times; the five runs always gave the same transcript. Times are medians. Wrong words are counted against the script, ignoring punctuation and capitals. Real voices and background noise will cause more errors.

| Speech model | Download | RAM (peak) |
|---|---|---|
| **Fast (base)**, default | 208 MB | ~1.0 GB |
| Balanced (small) | 639 MB | ~1.6 GB |
| Accurate (turbo) | 564 MB | ~2.9 GB |

How long each model took, and the share of words it got wrong:

| Language | Note length | Base: time · wrong words | Small: time · wrong words | Turbo: time · wrong words |
|---|---|---|---|---|
| Turkish | 21 s | 2.9 s · 16 % | 8.7 s · 14 % | 7.7 s · 7 % |
| English | 22 s | 2.0 s · 0 % | 5.2 s · 0 % | 5.3 s · 0 % |
| Spanish | 19 s | 2.3 s · 3 % | 10.2 s · 0 % | 6.7 s · 0 % |
| Polish | 22 s | 3.0 s · 4 % | 10.1 s · 0 % | 8.4 s · 0 % |
| Portuguese | 18 s | 2.2 s · 7 % | 6.2 s · 9 % | 7.6 s · 2 % |
| German | 20 s | 3.0 s · 16 % | 9.7 s · 6 % | 7.6 s · 3 % |
| French | 21 s | 3.0 s · 10 % | 9.0 s · 10 % | 7.9 s · 3 % |
| Dutch | 25 s | 3.0 s · 10 % | 8.6 s · 3 % | 7.6 s · 3 % |
| Russian | 21 s | 2.5 s · 6 % | 7.7 s · 4 % | 7.8 s · 4 % |
| Swedish | 23 s | 2.6 s · 11 % | 7.8 s · 14 % | 7.1 s · 5 % |
| Italian | 17 s | 2.2 s · 22 % | 7.6 s · 16 % | 7.2 s · 7 % |
| Finnish | 22 s | 3.2 s · 32 % | 11.5 s · 22 % | 8.4 s · 8 % |
| Ukrainian¹ | 19 s | 2.7 s · 40 % | 12.2 s · 26 % | 7.7 s · 13 % |
| Arabic² | 28 s | 3.4 s · 64 % | 12.3 s · 51 % | 9.3 s · 47 % |
| Persian³ | 19 s | 3.1 s · 92 % | 8.5 s · 78 % | 8.7 s · 66 % |
| Hindi⁴ | 20 s | 2.9 s · 100 % | 13.0 s · 94 % | 7.9 s · 94 % |

1. Tested with the only Ukrainian Piper voice that works, which is the lowest quality grade; part of the errors come from the voice.
2. The note was longer than 28 s, so it was transcribed in two parts.
3. Much of this is spelling: turbo wrote what was said in everyday spoken Persian (e.g. میتونن for می‌توانند), so the meaning was mostly right.
4. Not usable yet: base writes Hindi in Urdu script, and small and turbo drop letters from Devanagari words.

Base was about 2.5–4.5× faster than the others. Small and turbo made fewer mistakes in most languages, and turbo had the fewest errors (or tied for fewest) in every language. Piper makes a ~7-second reply in under a second. Models are unloaded after 10 minutes without voice work, so idle RAM use is zero.

Received files are saved in `~/.pi/agent/pi-harness-whatsapp/inbox/` (kept for 7 days), and Pi is told where they are.

## Tools for the model

These are optional; normal replies never need them. They are visible to the model only while WhatsApp is on, and they only send to allowed contacts.

- `whatsapp_send_image(path, caption?, to?)`
- `whatsapp_send_file(path, caption?, to?)`
- `whatsapp_send_voice(text, to?)`

## Run in the background

Pi can keep running without an open terminal by starting it (`pi --continue --whatsapp`) inside a tmux session from a systemd service with `Restart=always`. You can then attach to that tmux session to scan the QR code or watch Pi work, and systemd starts Pi again after a crash. If the service sets `PI_HARNESS_WHATSAPP_SERVICE` to its own unit name, `/restart` and `/quit` from WhatsApp restart or stop the service. Without it, `/restart` isn't available, and `/quit` just exits Pi. Only one Pi can hold the WhatsApp connection at a time, so other Pi sessions show `WA: in use` while the service is connected.

## Files

Everything lives in `~/.pi/agent/pi-harness-whatsapp/`:

| Path | What |
|---|---|
| `config.json` | Settings |
| `auth/` | The WhatsApp login. Keep it private; deleting it means scanning a new QR code. |
| `models/` | Speech models |
| `inbox/` | Files people sent (kept 7 days) |
| `recents.json` | Recent chat ids and names, for picking contacts (no message text) |
| `log/pi-harness-whatsapp.log` | Log: connection events and errors, never message text |

## Troubleshooting

- **QR code expired:** `/whatsapp` → Connection → Connect now.
- **"needs a new QR scan":** WhatsApp logged the device out (for example, it was removed from Linked devices). Connection → Show a new QR code.
- **"in use by Pi #…":** another Pi holds the connection; turn WhatsApp off there.
- **Messages are ignored:** the sender isn't in Allowed contacts. Pi shows a notice in the terminal the first time.
- **Voice notes fail:** check that `ffmpeg -version` works. The first voice note waits for the speech model to download.
- **More detail:** set `PI_HARNESS_WHATSAPP_DEBUG=1` before starting Pi, and check the log.

## Development

```bash
git clone https://github.com/mkemalemdar/pi-harness-whatsapp
cd pi-harness-whatsapp
npm install
npm run check          # typecheck + tests
pi -ne -e .            # run Pi with only this extension
```

`PI_HARNESS_WHATSAPP_DIR=/some/dir` keeps test data away from your real login and settings.

## License

[MIT](LICENSE) © mkemalemdar
