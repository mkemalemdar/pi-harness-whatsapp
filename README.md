<p align="center">
  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="" width="80">
</p>

# pi-harness-whatsapp

Talk to the [Pi coding agent](https://pi.dev) from WhatsApp: text, voice notes, images and files. Pi answers automatically, and you can switch models, compact the context or stop a run from your phone.

> 🤖 **AI agent installing or removing this for someone?** Read [AGENT_INSTALL.md](AGENT_INSTALL.md) first: what to ask the user, how to configure, how to uninstall without leaving anything behind, and what never to touch.

- **Scan a QR code once and you're in.** Pi runs as a linked device of a WhatsApp number. The login is saved, and Pi reconnects on its own.
- **Replies are automatic.** Pi's final answer is always sent back. The model doesn't have to call a tool.
- **You choose what else you get:** a summary line (`✅ 4/6 tool calls ok · ⏱ 2m 14s`), in-between messages, the list of touched files, and a live tool-activity message.
- **Optional voice notes, both ways, on your own CPU.** [Whisper](https://github.com/openai/whisper) turbo understands them and [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) speaks the replies, both through Intel's [OpenVINO](https://github.com/openvinotoolkit/openvino). No GPU or cloud service needed, in 15 languages. Off by default; see below for what it costs.
- **Images and files both ways.** Send Pi a photo or screenshot and it sees it; send a file (PDF, log, zip, …) and it's saved for Pi to open. Ask Pi for an image or a file and it sends it to your chat, and screenshots its tools take can come automatically.
- **Control Pi from WhatsApp** with commands and poll menus: `/model`, `/think`, `/compact`, `/stop`, `/new`, `/status`, …
- **A real off switch.** Off means disconnected: nothing is read or sent, and the WhatsApp tools disappear from the model.

> **Voice is optional and off by default.** Turn it on in `/whatsapp` → **Voice notes**, one part or both:
>
> | Part | Disk | RAM while a voice note is handled |
> |---|---|---|
> | Understand voice notes (speech-to-text) | 1.0 GB | about 2 GB |
> | Reply with voice notes (text-to-speech) | 0.6 GB | about 1.2 GB |
> | Both | 1.4 GB (they share a 202 MB engine) | about 3.4 GB |
>
> The files download only once you switch a part on, and switching it off deletes them again. The models are unloaded after 10 minutes without voice work, so idle RAM use is zero. Everything runs on the CPU; nothing goes to the cloud.

> **Use a second number if you can.** This extension uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. WhatsApp can restrict numbers that use unofficial clients, so a spare number is the safe choice.

## Requirements

- Pi 1.2 or newer

Only if you turn voice on:
- `ffmpeg` on the PATH: `sudo apt install ffmpeg`
- Linux (x64 or ARM64), Windows (x64) or macOS on Apple Silicon. OpenVINO has no build for Intel Macs or Windows on ARM; text, images and files work there, voice notes don't.
- The disk and free RAM from the table above.

## Install

```bash
pi install npm:pi-harness-whatsapp
```

Or straight from GitHub: `pi install git:github.com/mkemalemdar/pi-harness-whatsapp`.

Start Pi and run `/whatsapp`. Set **WhatsApp** to **on**, and a QR code appears above the editor. On your phone, go to **WhatsApp → Settings → Linked devices → Link a device** and scan it. That's it.

Nobody is allowed to talk to Pi yet. Send a message to the paired number from your phone and Pi asks, in the terminal, whether to allow you and make you the **owner**. You can also pick people from **Allowed chats → Pick from recent chats** or add a number by hand.

You can also use your own number: the "Message yourself" chat works and counts as the owner.

Then send `/help` on WhatsApp: it lists every command and shows your current settings.

## How it works

- Messages from allowed contacts (or allowed groups) go to Pi as prompts, starting with a label like `[WhatsApp · Name · your reply goes to Name]`. The label and Pi's instructions tell the model that Name is talking to it directly and that its answer is sent back automatically, so even small local models answer you instead of describing your message.
- Only runs that started from WhatsApp send replies back. Prompts you type in the terminal stay in the terminal, unless you turn on **Terminal answers**: then their answers are also sent to the owner as text, after the prompt.
- If Pi is busy, new WhatsApp messages are queued and answered in order. Each answer goes to the chat whose message it answers. If Pi is busy with a prompt you typed in the terminal, that answer stays in the terminal.
- If Pi can't start on a message (for example, no model is selected or a login expired), the chat is told to check the terminal.
- Messages sent while WhatsApp was off (or Pi wasn't running) are not acted on later, since they may be out of date. Instead, Pi replies once in that chat: "⏸ 3 messages arrived while Pi's WhatsApp was off and were skipped. Send again if still needed."
- Only one Pi process at a time can hold the WhatsApp connection. Others show `WA: in use by Pi #<pid>`.

## Groups

Pi can take part in a WhatsApp group:

1. Add the bot's number to the group, like any other member.
2. Allow the group: once someone has written in it, `/whatsapp` → **Allowed chats** → **Pick from recent chats** lists it with 👥.
3. In the group, **@mention Pi** (type `@` and pick the bot's number) or **reply to one of Pi's messages**. Pi answers in the group, and it knows who asked.

What Pi reacts to is set by **In groups, answer**: **replies and @mentions** (default), only replies, only @mentions, or every message.

- **Context:** when Pi is addressed, it also gets the last 20 messages written since it was last addressed, so "@Pi what do you think?" makes sense. Only text goes into that context; images, files and voice notes show up only as a note like `[sent an image]`. These messages are kept in memory only.
- **Images:** send an image with a caption that @mentions Pi, or reply to someone's image and @mention Pi; Pi sees that image.
- **Commands** (`/status`, `/model`, …) work in groups without a mention, with the same rules as in private chats: only the owner can change Pi by default. A number as a poll answer only counts in a group if it replies to the poll.
- **Pi needs its own number for groups.** If Pi runs on your own number, your messages in a group are your own messages, and Pi ignores them there; the "Message yourself" chat still works.
- **Be careful:** everyone in an allowed group can ask Pi things, and Pi can run commands on this machine. Only allow groups where you trust every member.

## Settings: `/whatsapp`

Every row opens a small menu with the choices and a short explanation. Nothing changes until you pick something. Defaults are in **bold**.

| Section | Setting | Choices and what it does |
|---|---|---|
| Connection | WhatsApp (this session) | On · **Off**. Continued sessions get their own value back; new sessions start with the last value you chose. |
| | Connection | Connect now, show a new QR code (pair again), or log out. |
| | Allowed chats | People and groups that can talk to Pi. ★ marks the owner. Pick from recent chats, add a number by hand, rename, remove, or make someone the owner. |
| | In groups, answer | **Replies and @mentions** · replies to Pi · @mentions only · every message. See [Groups](#groups). |
| | Who can use commands | **Only me** (the owner) · all allowed chats. |
| | Ask on/off at session start | On · **Off**. Asks whether WhatsApp should be on when a session opens. |
| Replies | Final answer | Always on. |
| | Terminal answers | On · **Off**. Also sends the owner Pi's answers to prompts typed in the terminal, as text. |
| | Progress messages | On · **Off**. What Pi writes while it's still working. |
| | Live tool log | On · **Off**. One message, updated live, with the latest tool steps. |
| | Changed files | On · **Off**. The files Pi wrote or edited. |
| | Stats (tools · time) | On · **Off**. A line like `✅ 4/6 tool calls ok · ⏱ 2m 14s`. |
| | Auto-send tool images | On · **Off**. Every image a tool makes while answering you (e.g. browser screenshots). You can always ask Pi to send a specific image instead. |
| Voice | Voice notes | Two ticks, both **off**: **Understand voice notes** (1.0 GB) and **Reply with voice notes** (0.6 GB), plus **Delete all speech files**. See [Voice](#voice). |
| | Reply type | **Mirror me** (voice note in → voice reply, text in → text reply) · text · voice · voice + text. Greyed out until "Reply with voice notes" is on. Without "Understand voice notes", mirror me answers everything with text (Pi gets no voice notes to mirror), so pick voice if you want spoken replies. |
| | Voice per language | Which voice speaks each language: one of 10 voices, **F1**–F5 (female) and M1–M5 (male), the same list for every language. "Send me a sample" sends a short voice note to your WhatsApp first. Greyed out until "Reply with voice notes" is on. |
| | Voice reply speed | 0.9 · **1.0** · 1.2 · custom (0.5–2.0). Greyed out until "Reply with voice notes" is on. |
| Languages | Reply language | **Mirror me** (the language you used) or one of your languages. |
| | My languages | Tick the languages you use (**English**). See [Voice](#voice) for the 15 languages. |
| | Fallback language | Used only when Pi can't tell which language to use (**the first of your languages**). |
| Danger | Remove everything (before uninstalling) | Unlinks Pi from your phone and deletes everything it made. Asks first. See [Uninstall](#uninstall). |
| | Log file | Where the log is (shown, not a setting). |

Greyed-out rows can still be selected: they say which tick in **Voice notes** turns them on.

Settings are stored in `~/.pi/agent/pi-harness-whatsapp/config.json`.

## WhatsApp commands

Commands are handled by the extension and never reach the model. Send `/help` to see them all. Menus are **WhatsApp polls**: tap an option and it's applied right away, or reply with its number. A number counts as a menu answer only until the menu is answered or you send Pi a normal message; after that it goes to Pi. Normal accounts can't send list or button messages; polls work everywhere.

| Command | What it does |
|---|---|
| `/help` | Commands and current settings |
| `/status` | Connection, model, thinking level, context use, voice |
| `/stop` | Stop what Pi is doing |
| `/compact [focus]` | Compact the context, then report e.g. `✅ Compacted in 18s · 142k → 23k tokens (−84%) · context 89% free` |
| `/autocompact [on\|off]` | Automatic compaction for this session (Pi still compacts if the context is completely full) |
| `/model [name]` | Switch the model for this session; lists only models with a login or API key |
| `/think [level]` | Reasoning level, limited to what the model supports |
| `/voice [text\|voice\|both\|mirror]` · `/lang` · `/speed [x]` | Reply type, reply language, voice reply speed. `/voice` and `/speed` work once voice replies are on; voice itself is switched on only in the terminal, since it downloads files. |
| `/replies` | Switch the reply extras on and off (multi-choice poll) |
| `/languages` | Show your languages (change them in the terminal) |
| `/new` | Start a fresh Pi session (the old one stays saved) |
| `/off` | Turn WhatsApp off. It can be turned back on only from the terminal, or by restarting Pi. |
| `/quit` | Shut Pi down |
| `/restart` | Restart Pi (when it runs as a systemd service, see below) |

`/off`, `/quit` and `/restart` ask for confirmation first. Everything except `/help`, `/status` and `/languages` follows **Command access**.

## Voice

Voice is optional and **off by default**. In `/whatsapp` → **Voice notes**, tick what you want:

- **Understand voice notes** (speech-to-text, 1.0 GB): Pi transcribes the voice notes you send. While it's off, a voice note gets "🎤 Voice notes are off. Please type your message." and never reaches the model; in a group, only a voice note that replies to Pi gets that answer.
- **Reply with voice notes** (text-to-speech, 0.6 GB): Pi can answer with voice notes; **Reply type**, the voices and the speed then become available. While it's off, Pi always answers with text.

Downloads and deletions happen when you leave that menu:
- **A part you ticked** whose files aren't there yet: Pi asks "Download now (recommended)" or "When first needed". "When first needed" downloads with the first voice note (the chat is told while it waits).
- **A part you unticked:** Pi asks, e.g. "You set speech-to-text for removal. 828 MB will be freed." Yes deletes the files; No puts the tick back. The shared engine stays as long as the other part needs it.
- **"Delete all speech files"** unticks both, and asks the same way.

You don't have to untick anything to stop voice replies for a while: set **Reply type** to text.

Voice notes are transcribed on your machine and given to Pi with a label, e.g. `[WhatsApp · Name · voice note · your reply is spoken to Name] …`. When the reply will be spoken, the model is told so, and writes plain speech. Long answers are read in full as several voice notes (up to ~10 minutes; anything longer also comes as text). Answers that are mostly code come as text too, since code can't be read aloud. With **Mirror me**, Pi answers in the language you used, and the voice reply uses that language's voice.

Supported languages: **English, Turkish, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Ukrainian, Arabic, Hindi, Swedish and Finnish**. Pi understands and speaks all of them with the same two models, so adding a language downloads nothing.

| What | Model | Size on disk |
|---|---|---|
| Understanding voice notes | Whisper large-v3-turbo, int8, [exported for OpenVINO by Intel](https://huggingface.co/OpenVINO/whisper-large-v3-turbo-int8-ov) | 828 MB |
| Speaking replies | [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) by Supertone (10 voices) | 401 MB |
| Running both | Intel's OpenVINO for Node | 202 MB |

Models are unloaded after 10 minutes without voice work, so idle RAM use is zero. While a voice note is handled, Pi needed about 2 GB of RAM to understand it, about 1.2 GB to speak a reply, and about 3.4 GB with both, measured on the machine below.

Measured on an Intel i5-13500, CPU only, on real recordings from Google's [FLEURS](https://huggingface.co/datasets/google/fleurs) dataset: 10 sentences per language, read by real people. Wrong words are counted against the dataset's transcript, ignoring punctuation and capitals; a number written as digits ("18") where the transcript spells it out counts as wrong. For the voice, Supertonic read a short sentence in each language and Whisper listened to it again.

| Language | Wrong words | Time for an ~11 s voice note | Voice read back correctly |
|---|---|---|---|
| Turkish | 10 % | 2.7 s | ✓ |
| English | 5 % | 2.3 s | ✓ |
| Spanish | 2 % | 2.8 s | ✓ |
| Portuguese | 3 % | 2.8 s | ✓ |
| Italian | 4 % | 2.9 s | ✓ |
| German | 4 % | 2.8 s | ✓ |
| Dutch | 5 % | 2.8 s | ✓ |
| Russian | 7 % | 2.8 s | ✓ |
| Polish | 7 % | 2.8 s | 1 word off |
| French | 8 % | 2.8 s | ✓ |
| Ukrainian | 9 % | 2.9 s | ✓ |
| Arabic | 9 % | 2.9 s | ✓ |
| Finnish | 11 % | 2.8 s | ✓ |
| Swedish | 12 % | 2.9 s | ✓ |
| Hindi | 31 % | 3.2 s | 1 word off |

Supertonic makes speech about 10× faster than real time, so a 20-second reply is ready in about 2 seconds. Symbols and units are hard for any voice to read ("13°C" is not "13 degrees"), so when a reply will be spoken, Pi is told to write everything out as it should be said.

## Images and files

**To Pi:**
- **Images** (photos, screenshots) go to the model with their caption, so you can ask "what's wrong in this screenshot?". In a group, an image counts when its caption @mentions Pi, or when you reply to an image and @mention Pi.
- **Files** (PDFs, documents, logs, archives, videos; up to 50 MB) are saved in `~/.pi/agent/pi-harness-whatsapp/inbox/`, and Pi is told the name, type, size and where it is, so it can open it with its own tools. Received files are deleted after 7 days.
- **Voice notes** are transcribed when **Understand voice notes** is on; see [Voice](#voice).

**From Pi:** ask for it ("send me the screenshot", "send me report.pdf") and Pi sends images and files from this computer to your chat, up to 60 MB. With **Auto-send tool images** on, every image a tool makes while answering you (e.g. a browser screenshot) is sent without asking.

Pi does this with two tools that the model sees only while WhatsApp is on, and that send only to allowed chats:

- `whatsapp_send_image(path, caption?, to?)`: a PNG, JPEG, WebP or GIF, shown as a photo
- `whatsapp_send_file(path, caption?, to?)`: any file, sent as a document

`to` is an allowed contact's name or number; without it, Pi sends to the chat it's answering (or the owner). Normal replies never need these tools. There's no voice tool on purpose: when your reply is spoken, Pi's answer itself becomes the voice note, so the model can't send the same thing twice.

## Run in the background

Pi can keep running without an open terminal by starting it (`pi --continue --whatsapp`) inside a tmux session from a systemd service with `Restart=always`. You can then attach to that tmux session to scan the QR code or watch Pi work, and systemd starts Pi again after a crash. If the service sets `PI_HARNESS_WHATSAPP_SERVICE` to its own unit name, `/restart` and `/quit` from WhatsApp restart or stop the service. Without it, `/restart` isn't available, and `/quit` just exits Pi. Only one Pi can hold the WhatsApp connection at a time, so other Pi sessions show `WA: in use` while the service is connected.

## Files

Everything lives in `~/.pi/agent/pi-harness-whatsapp/`:

| Path | What |
|---|---|
| `config.json` | Settings |
| `auth/` | The WhatsApp login. Keep it private; deleting it means scanning a new QR code. |
| `models/` | Speech models and the OpenVINO engine that runs them (only while voice is on) |
| `inbox/` | Files people sent (kept 7 days) |
| `recents.json` | Recent chat ids and names, for picking contacts (no message text) |
| `connection.lock` | Which Pi process holds the connection right now |
| `announce.json` | For a moment around `/new` and `/restart`: which chat to tell that Pi is back |
| `setup.json` | Only if the installer recorded it: programs installed just for the extension (see [Uninstall](#what-was-installed-for-it)) |
| `log/pi-harness-whatsapp.log` | Log: connection events and errors, no message text (unless debug logging is on). Rotated at 5 MB into `.log.1`. |

If you set `PI_HARNESS_WHATSAPP_DIR`, everything is in that folder instead. The extension writes nothing anywhere else, apart from Pi's own files (your sessions and its package list).

## Uninstall

Do it in this order, so nothing is left behind.

1. **Clean up from inside Pi.** Close every other Pi window first. Then run `/whatsapp` → **Danger** → **Remove everything (before uninstalling)…** (or type `/whatsapp remove`) and confirm. Pi:
   - unlinks itself from your phone (WhatsApp → Settings → Linked devices),
   - stops any speech-file download that's still running,
   - deletes `~/.pi/agent/pi-harness-whatsapp/` with everything in it: the WhatsApp login, speech files, settings, allowed chats, recent chats, log and received files,
   - deletes this extension's copies (and those of the packages it brought along) from npm's download cache, and nothing else there,
   - asks about each program that was installed just for it, if the installer recorded one (see [What was installed for it](#what-was-installed-for-it)), and removes exactly the packages you say yes to,
   - and writes nothing more until you quit, even if you keep using Pi.
2. **If Pi runs as a background service, stop and remove it now** (see [Removing the background service](#removing-the-background-service)); otherwise systemd starts Pi again.
3. **Quit Pi and remove the code:**
   ```bash
   pi uninstall npm:pi-harness-whatsapp
   ```
   If you installed it from GitHub, use the source that `pi list` shows (e.g. `pi uninstall git:github.com/mkemalemdar/pi-harness-whatsapp`).
4. **Tidy up after npm.** npm removes every file, but leaves a few empty folders (like `@types`) in Pi's package folder. This deletes only folders that are empty:
   ```bash
   find ~/.pi/agent/npm/node_modules ~/.pi/agent/git -mindepth 1 -type d -empty -delete 2>/dev/null
   ```

**Check that it's gone:** `pi list` no longer shows it, and `ls ~/.pi/agent/pi-harness-whatsapp` says "No such file or directory".

### Already uninstalled without step 1?

The easiest clean way: install it again (`pi install npm:pi-harness-whatsapp`), start Pi, and do the steps above. "Remove everything" then also cleans up what the first uninstall left.

By hand instead: make sure no Pi is running, and look at `~/.pi/agent/pi-harness-whatsapp/setup.json` first, if it's there, for programs installed for the extension. Then delete the folder: `rm -rf ~/.pi/agent/pi-harness-whatsapp` (if you set `PI_HARNESS_WHATSAPP_DIR` to a folder that holds other things too, delete only the entries listed under [Files](#files)). On your phone, remove Pi under WhatsApp → Settings → Linked devices.

### Removing the background service

Use your unit's name. For a system service, run the same with `sudo` and without `--user`; its file is in `/etc/systemd/system/`.
```bash
systemctl --user disable --now pi-whatsapp.service
rm ~/.config/systemd/user/pi-whatsapp.service
systemctl --user daemon-reload
```
If you turned on lingering only for this service, turn it off again with `loginctl disable-linger`. Remove the tmux session it used with `tmux kill-session -t <name>` if it's still running.

### What was installed for it

The extension itself never installs programs; you or an AI agent install `ffmpeg` (and `tmux` for the background service) when they're missing. Whoever does that can record it in `setup.json` in the data folder, and "Remove everything" then offers to remove it again. [AGENT_INSTALL.md](AGENT_INSTALL.md) has the format, and AI agents installing the extension write it for you.

Removal is careful: with apt, it first does a dry run and keeps everything if removing those packages would also remove anything not on the list (like a program you installed later that needs them). It runs as root or with `sudo` that needs no password; otherwise it shows you the command. With Homebrew it runs `brew uninstall`; with other package managers it shows the command.

### What isn't removed, on purpose

- **Your Pi sessions** (`~/.pi/agent/sessions/`). Chats you had with Pi from WhatsApp are ordinary Pi sessions, and they contain small `pi-harness-whatsapp/session` entries (whether WhatsApp was on). Pi ignores those once the extension is gone; cutting them out would break the sessions. Delete whole sessions in Pi if you don't want them.
- **Programs nobody recorded** in `setup.json`: if you installed `ffmpeg` or `tmux` yourself just for this, remove them with your package manager (e.g. `sudo apt remove --purge ffmpeg tmux`, then `sudo apt autoremove` for what came with them, after checking its list).
- **npm's own logs** (`~/.npm/_logs`): npm keeps a log of its last few runs, which can mention the install. They're replaced as npm runs again.
- **Your package manager's history** (e.g. `/var/log/apt/history.log`, `/var/log/dpkg.log`) notes every install and removal, like it does for every program.

## Troubleshooting

- **QR code expired:** `/whatsapp` → Connection → Connect now.
- **"needs a new QR scan":** WhatsApp logged the device out (for example, it was removed from Linked devices). Connection → Show a new QR code.
- **"in use by Pi #…":** another Pi holds the connection; turn WhatsApp off there.
- **Messages are ignored:** the sender isn't in Allowed chats. Pi shows a notice in the terminal the first time.
- **"Voice notes are off":** tick **Understand voice notes** in `/whatsapp` → Voice notes.
- **Voice notes fail:** check that `ffmpeg -version` works. With "When first needed", the first voice note waits for the download (up to 1.4 GB); a download that drops continues where it stopped, and one that stalls for a minute is given up and tried again with the next voice note. On Intel Macs and Windows on ARM, voice notes aren't available.
- **More detail:** set `PI_HARNESS_WHATSAPP_DEBUG=1` before starting Pi, and check the log. Debug logging also writes WhatsApp's own internal messages, which can contain message content, so turn it off again afterwards.

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

The speech models are downloaded from their makers and keep their own licenses: Whisper (MIT, OpenAI), Supertonic 3 ([OpenRAIL-M](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE), Supertone; free to use, with use restrictions such as not impersonating others without their consent), and OpenVINO (Apache-2.0, Intel).
