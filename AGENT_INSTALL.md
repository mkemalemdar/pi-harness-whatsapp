# Installing (and uninstalling) pi-harness-whatsapp: notes for AI agents

This file is for an AI agent (Pi, Claude Code, Codex, …) asked to install or remove this extension for a user. Read it fully before changing anything. **Asked to remove it?** Go to [Uninstalling](#uninstalling).

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
- **ffmpeg** (only needed if the user wants voice): run `ffmpeg -version`. Without it, text, images and files still work, but voice notes don't. If it's missing and they want voice, ask before installing it (it usually needs sudo: `sudo apt install ffmpeg`, `brew install ffmpeg`, …), and **record what you install** (see [Record what you install](#record-what-you-install-outside-pi)).
- **Voice support on this machine:** voice is optional and off by default. It works on Linux (x64 or ARM64), Windows (x64) and macOS on Apple Silicon, not on Intel Macs or Windows on ARM. What each part needs (check with `free -m` and `df -h ~`):

  | Part | Disk | Free RAM while a voice note is handled |
  |---|---|---|
  | Understand voice notes (speech-to-text) | 1.0 GB | about 2 GB |
  | Reply with voice notes (text-to-speech) | 0.6 GB | about 1.2 GB |
  | Both | 1.4 GB | about 3.4 GB |

  If the machine can't do voice, say so when you ask about it, and leave voice off.

## 2. Ask the basics

Ask these together, in one message, and wait for the answers:

1. **Which WhatsApp number will Pi use?** Recommend a **second number**. The extension uses an unofficial WhatsApp Web client (Baileys), and WhatsApp may restrict numbers that use one. Using their own number also works: they then talk to Pi in the "Message yourself" chat.
2. **Owner:** their own phone number, with country code. The owner is the only one who can change Pi from WhatsApp (`/model`, `/compact`, `/quit`, …). If they don't know it yet, skip it: the first person who messages the bot is offered as owner in the terminal.
3. **Languages:** which languages they'll write and speak in. The default is English only. Supported: English, Turkish, German, French, Spanish, Italian, Portuguese, Dutch, Polish, Russian, Ukrainian, Arabic, Hindi, Swedish and Finnish. Hindi voice notes are less accurate than the others (see the README's table). Adding languages downloads nothing extra.
4. **Voice notes:** off (the default), understand voice notes, reply with voice notes, or both? Give them the disk and RAM from the table in step 1, and the result of your check. Off means a voice note gets "🎤 Voice notes are off. Please type your message."; they can switch voice on later in `/whatsapp` → Voice notes.
5. **Background service:** should Pi keep running without a terminal (see "Run in the background" in the README)? Don't set it up unless they say yes. If they do, ask which project folder Pi should work in.

## 3. Offer the other settings

Then show the remaining settings in **one** message, with the default for each, and ask which ones they want changed. Make it clear they can answer "defaults are fine", and that everything can be changed later in `/whatsapp`. Don't ask about each setting one by one.

| Setting (name in `/whatsapp`) | What it does | Default | Other choices |
|---|---|---|---|
| Reply type (only with "reply with voice notes") | How Pi answers | **mirror me**: a voice note gets a voice reply, text gets text (without "understand voice notes": always a voice note) | text only · voice note · voice note + text |
| Reply language | Which language Pi answers in | **mirror me**: the language they used | always one of their languages |
| Fallback language | Used only when Pi can't tell the language (e.g. very short replies) | **the first language** they named | any of their languages |
| Voice per language (only with "reply with voice notes") | Which voice speaks each language | **F1** (female) | F2–F5 (female), M1–M5 (male); the same 10 voices for every language |
| Voice reply speed (only with "reply with voice notes") | How fast voice replies are spoken | **1.0** | 0.5–2.0 (0.9 slower, 1.2 faster) |
| Terminal answers | Also sends the owner Pi's answers to prompts typed in the terminal, as text | **off** | on |
| Progress messages | Sends what Pi writes while it's still working | **off** | on |
| Live tool log | One message, updated live, with the latest tool steps | **off** | on |
| Changed files | Adds the list of files Pi wrote or edited | **off** | on |
| Stats (tools · time) | Adds a line like `✅ 4/6 tool calls ok · ⏱ 2m 14s` | **off** | on |
| Auto-send tool images | Sends every image a tool makes while answering (e.g. browser screenshots) | **off** | on |
| Who can use commands | Who may change Pi from WhatsApp | **only the owner** | everyone in Allowed chats (warn them: they could then switch models, compact, or quit Pi) |
| Ask on/off at session start | Asks whether WhatsApp should be on each time a Pi session opens | **off** (new sessions use the last choice) | on |
| Other allowed chats | People or groups besides the owner who may talk to Pi | **nobody** | numbers or groups they name (warn them: allowed chats can make Pi run commands on this machine) |
| In groups, answer | Which messages in an allowed group reach Pi | **replies and @mentions** | replies to Pi only · @mentions only · every message (noisy, and every message uses the model) |

The final answer is always sent and can't be turned off.

## 4. Install

```bash
pi install npm:pi-harness-whatsapp
pi list    # should show npm:pi-harness-whatsapp
```

## 5. Write the settings

Settings live in `~/.pi/agent/pi-harness-whatsapp/config.json`. Unknown or invalid values are replaced with defaults, so writing only the fields that differ from the defaults is safe. Create the folder if needed, and keep the file private (`chmod 600`).

Pi reads this file when a session starts, and saves it when a setting changes. If a Pi with this extension is already running, ask the user to quit it before you write the file, so it doesn't keep the old settings or save over yours.

Example: English and Turkish, voice notes both ways, a male voice for Turkish, the owner set, stats on, a slightly faster voice:

```json
{
  "version": 1,
  "voice": { "understand": true, "reply": true },
  "languages": ["en", "tr"],
  "voices": { "tr": "M1" },
  "voiceMode": "mirror",
  "replyLanguage": "mirror",
  "voiceSpeed": 1.1,
  "replies": { "summary": true },
  "contacts": [{ "id": "905551234567", "name": "Alex", "owner": true }]
}
```

| Field | Setting | Values |
|---|---|---|
| `voice` | Voice notes | `{ "understand": <bool>, "reply": <bool> }`, both `false` by default. Always write this field, even when both are `false`. |
| `languages` | My languages, Fallback language | Language codes from the table below. The **first** one is the fallback language. |
| `voices` | Voice per language | `{ "<code>": "<voice>" }` with a voice from `F1`–`F5`, `M1`–`M5`, for the languages whose voice should differ from the default (`F1`) |
| `voiceMode` | Reply type | `mirror` (default) · `off` (text only) · `voice` · `voice+text`. Only used while `voice.reply` is `true`. |
| `replyLanguage` | Reply language | `mirror` (default) or one of `languages` |
| `voiceSpeed` | Voice reply speed | 0.5–2.0 (default 1.0) |
| `replies` | Terminal answers, Progress messages, Live tool log, Changed files, Stats | `{ "terminal", "interim", "toolActivity", "touchedFiles", "summary" }`, booleans, all `false` by default |
| `forwardToolImages` | Auto-send tool images | boolean, default `false` |
| `commandAccess` | Who can use commands | `owner` (default) · `allowed` |
| `groupReplies` | In groups, answer | `both` (default: replies and @mentions) · `replies` · `mentions` · `all` |
| `askAtSessionStart` | Ask on/off at session start | boolean, default `false` |
| `contacts` | Allowed chats | `id` is digits with country code and no `+` (e.g. `905551234567`), or a group JID like `120363…@g.us`. `owner: true` on exactly one person. `name` is optional. |

Leave out `lastEnabled` and the `lid` of contacts: the extension fills them in itself.

Language codes: `en` English · `tr` Turkish · `de` German · `fr` French · `es` Spanish · `it` Italian · `pt` Portuguese · `nl` Dutch · `pl` Polish · `ru` Russian · `uk` Ukrainian · `ar` Arabic · `hi` Hindi · `sv` Swedish · `fi` Finnish.

If the user can't decide on a voice, keep the default and tell them they can hear each one later: `/whatsapp` → Voice per language → a voice → "Send me a sample on WhatsApp".

Speech files download by themselves when first needed: with voice switched on in the file, the first voice note (or the first spoken reply) waits for the download, and the chat is told. You don't have to fetch them. Tell the user. If they'd rather download right away, leave `voice` off in the file and have them tick the parts in `/whatsapp` → Voice notes after starting Pi: leaving that menu asks "Download now (recommended)" or "When first needed".

## Record what you install outside Pi

Anything you install on the computer for this extension (ffmpeg, and tmux for the background service) must be recorded in `setup.json` in the data folder (`~/.pi/agent/pi-harness-whatsapp/setup.json`, or the folder from `PI_HARNESS_WHATSAPP_DIR`). When the user later uninstalls, `/whatsapp` → Remove everything reads it, asks the user about each entry, and removes **exactly those packages** again. A program that was already installed is not recorded.

Record every package the install added, not just the one you asked for: installing ffmpeg with apt pulls in about 100 libraries. List the packages before and after, and record the difference:

```bash
dpkg-query -W -f='${Package}\n' | sort > /tmp/phw-before.txt
sudo apt-get install -y ffmpeg
dpkg-query -W -f='${Package}\n' | sort > /tmp/phw-after.txt
comm -13 /tmp/phw-before.txt /tmp/phw-after.txt   # these are the "packages"
rm /tmp/phw-before.txt /tmp/phw-after.txt
```

Other package managers: list with `brew list --formula -1 | sort` (Homebrew), `rpm -qa --qf '%{NAME}\n' | sort` (dnf, zypper), `pacman -Qq` (pacman) or `apk info | sort` (apk), the same way. For winget, record the package id you installed.

Then write (or add to) `setup.json`, and keep it private (`chmod 600`):

```json
{
  "version": 1,
  "installed": [
    {
      "what": "ffmpeg",
      "manager": "apt",
      "packages": ["ffmpeg", "libavcodec61", "libavformat61", "…every name from the comm output…"],
      "at": "2026-10-15",
      "by": "Claude Code"
    }
  ]
}
```

- `manager` is one of `apt`, `dnf`, `pacman`, `zypper`, `apk`, `brew`, `winget`. Entries with anything else, or with package names that aren't plain names, are ignored.
- `what` is the name the user will see ("ffmpeg", "tmux"); `at` and `by` are optional and shown to the user.
- If the install added nothing (it was already there), don't add an entry.

A background service isn't recorded here (Pi can't remove the service it runs in); tell the user about it, and see Uninstalling, step 3.

## 6. Hand over to the user

Tell the user:

1. Start Pi: `pi`
2. Run `/whatsapp`, then set **WhatsApp** to **on** (Enter).
3. A QR code appears above the editor. On the phone that has the chosen number: **WhatsApp → Settings → Linked devices → Link a device**, then scan it.
4. From your own phone, send the bot number a message. If nobody is allowed yet, Pi asks in the terminal whether to allow you as owner.
5. **Send `/help` on WhatsApp.** It lists every command and shows the current settings (model, reply type, languages, which extras are on). Be sure to tell them this step: it's how they learn what they can do from the phone.

Then tell them, briefly:

- Anything that isn't a command goes to Pi as a prompt. Images and files work too: Pi sees images, gets files saved for it to open, and can send images and files back when asked ("send me the screenshot").
- Voice notes, if they turned them on: understanding and replying can each be switched on or off in `/whatsapp` → Voice notes; switching a part off deletes its files after asking. To stop voice replies without deleting anything, set Reply type to text.
- To remove it later, the README's **Uninstall** section has the steps (in Pi: `/whatsapp` → Danger → Remove everything, or `/whatsapp remove`, then `pi uninstall`).
- If they want Pi in a group: add the bot's number to the group, have someone write there, then allow it in `/whatsapp` → Allowed chats → Pick from recent chats. In the group, people @mention Pi or reply to its messages; Pi also sees the last 20 text messages before that for context. You can't allow a group for them in advance, because the group's id is only known once it appears in recent chats. Remind them that every member of an allowed group can prompt Pi.
- From WhatsApp they can switch the model (`/model`), the reasoning level (`/think`), compact (`/compact`), stop a run (`/stop`), start a new session (`/new`) and change the reply type, language, speed and extras (`/voice`, `/lang`, `/speed`, `/replies`). Menus come as polls: tap an option.
- Everything else, including on/off, allowed chats and voices, is in `/whatsapp` in the terminal.

Finally, tell the user **everything you set up outside Pi**: for example "installed ffmpeg with apt (recorded in setup.json, so Remove everything can take it out again)", "created `~/.config/systemd/user/pi-whatsapp.service` and enabled lingering". If you have a memory or notes file for this user, write it there too.

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
- Don't edit or delete Pi's session files (`~/.pi/agent/sessions/`), not even to remove WhatsApp traces; see [Uninstalling](#uninstalling).
- When uninstalling, don't delete more than the steps say: no whole `PI_HARNESS_WHATSAPP_DIR` folder that holds other files, and no ffmpeg, tmux or npm cache without the user's yes.

## Uninstalling

Goal: **nothing left behind** on the user's computer, and Pi unlinked from their phone. Follow these steps in order. Don't improvise extra deletions.

### What the extension leaves on a computer

| What | Where | Removed by |
|---|---|---|
| The code | Pi's package folder, plus an entry in `~/.pi/agent/settings.json` | `pi uninstall` |
| All its data: WhatsApp login (`auth/`), speech files (`models/`, ~1.5 GB), settings (`config.json`), recent chats, received files (`inbox/`), log (`log/`), lock, `setup.json` | `~/.pi/agent/pi-harness-whatsapp/` (or `$PI_HARNESS_WHATSAPP_DIR` if set; or `$PI_CODING_AGENT_DIR/pi-harness-whatsapp/` if that is set) | "Remove everything", or deleting the folder |
| The linked device on the phone | WhatsApp → Settings → Linked devices | "Remove everything", or the user on their phone |
| A background service, only if one was set up | a systemd unit (usually `~/.config/systemd/user/*.service` or `/etc/systemd/system/*.service`), maybe lingering and a tmux session | you, step 3 |
| Copies of it and its npm packages | npm's download cache (`~/.npm/_cacache`) | "Remove everything" (only these entries) |
| Programs installed for it, only if they were | `ffmpeg`, `tmux`; listed in `setup.json` when recorded | "Remove everything" asks about each; or you, step 6, with the user's yes |

The extension writes nowhere else. It never edits shell profiles or creates files outside its data folder.

### Steps

1. **Look first, change nothing yet.**
   - `pi list`: note the exact source (`npm:pi-harness-whatsapp`, or a `git:` source).
   - The data folder: check `PI_HARNESS_WHATSAPP_DIR` and `PI_CODING_AGENT_DIR` in the environment; otherwise it's `~/.pi/agent/pi-harness-whatsapp/`.
   - A service: `grep -rlE "pi-harness-whatsapp|PI_HARNESS_WHATSAPP|--whatsapp" ~/.config/systemd/user /etc/systemd/system 2>/dev/null`.
   - Programs installed just for this: read `setup.json` in the data folder. If there's none, check your notes or ask the user.
2. **Tell the user what will be removed and get a yes.** The WhatsApp login is deleted, so using it again means a new QR scan; the speech files would have to download again.
3. **Stop the service, if there is one** (so it can't start Pi again): `systemctl --user disable --now <unit>` (system unit: `sudo systemctl disable --now <unit>`). Delete its unit file, then run `systemctl --user daemon-reload` (or `sudo systemctl daemon-reload`). Kill its tmux session if it's still there (`tmux ls`, then `tmux kill-session -t <name>`). If lingering was turned on only for this service (your notes, or ask), run `loginctl disable-linger`.
4. **Clean up the data from inside Pi.** First ask the user to close every Pi window. Then either the user does it, or you do it through Pi's RPC mode.

   **You, over RPC** (from the user's usual project folder, with no other Pi running): start `pi --mode rpc`, and send this line on its stdin:
   ```json
   {"id": "1", "type": "prompt", "message": "/whatsapp remove"}
   ```
   Pi then sends `extension_ui_request` records on stdout. For each one with `"method": "confirm"`, show the user its `title` and `message`, and answer with their decision, using the request's `id`:
   ```json
   {"type": "extension_ui_response", "id": "<the request's id>", "confirmed": true}
   ```
   The first question is "Remove everything?"; then one "Also remove …?" per program in `setup.json`. Records with `"method": "notify"` are progress and the result; the last one starts with `WhatsApp removed.` and lists what was done and any command left for you to run. Show it to the user, then close stdin so Pi quits. Read stdout as a stream and split records on `\n` only (see Pi's `docs/rpc.md`).

   **Or the user**, in Pi:
   1. run `/whatsapp` → **Danger** → **Remove everything (before uninstalling)…** (or type `/whatsapp remove`) and confirm. It unlinks the phone, deletes the data folder, removes this extension's entries from npm's cache, and asks about each program in `setup.json` (removing exactly the recorded packages, after an apt dry run that keeps everything if anything else would go too),
   2. read you its summary (the last notice), then quit Pi.

   **Already uninstalled?** The cleanest way is to install it again (`pi install npm:pi-harness-whatsapp`) and do the step above (over RPC, or the user); it then also cleans what the first uninstall left behind.

   **By hand** (only if the user doesn't want that): read `setup.json` first (step 6 needs it). Make sure no Pi is running (the user quits them all; `connection.lock` in the data folder shows the pid of a Pi that holds WhatsApp), then delete the data folder: `rm -rf ~/.pi/agent/pi-harness-whatsapp`. **If `PI_HARNESS_WHATSAPP_DIR` points at a folder that also holds other things, delete only these entries in it:** `config.json*`, `recents.json*`, `auth/`, `models/`, `inbox/`, `log/`, `connection.lock`, `announce.json`, `setup.json`. This way, npm's cache keeps its copies: only "Remove everything" knows which entries are this extension's, and `npm cache clean --force` (only if the user asks) empties the whole cache. Then tell the user to unlink Pi on their phone: WhatsApp → Settings → Linked devices → tap the device that belongs to Pi → Log out.
5. **Remove the code:** `pi uninstall <source from step 1>`, with Pi not running. npm leaves some empty folders behind (e.g. `@types`); remove only empty ones:
   `find ~/.pi/agent/npm/node_modules ~/.pi/agent/git -mindepth 1 -type d -empty -delete 2>/dev/null`. Don't touch anything else in those folders; other Pi packages live there.
6. **Programs:** "Remove everything" already asked about each `setup.json` entry; its summary says what was removed, and gives the command for anything it couldn't do (for example when `sudo` needs a password). Run those commands only if the user says yes. If you went the manual way, for each entry, with the user's yes: for apt, first run `apt-get -s remove --purge <packages>` and continue only if every line starting with `Remv` or `Purg` names a package from the entry; then `sudo apt-get remove --purge -y <packages>` and delete those packages' downloaded files, `/var/cache/apt/archives/<name>_*.deb`. Never remove a program that wasn't recorded or confirmed by the user; other programs may need it.
7. **Verify, and show the user the output.** All of these must come back empty (or "No such file or directory"):
   ```bash
   pi list | grep -i whatsapp
   ls -a ~/.pi/agent/pi-harness-whatsapp
   find ~/.pi ~/.config/systemd /etc/systemd -iname "*pi-harness-whatsapp*" 2>/dev/null
   find ~/.pi/agent/npm/node_modules ~/.pi/agent/git -mindepth 1 -type d -empty 2>/dev/null
   grep -rlE "pi-harness-whatsapp|PI_HARNESS_WHATSAPP" ~/.config/systemd /etc/systemd ~/.bashrc ~/.profile ~/.zshrc 2>/dev/null
   npm cache ls 2>/dev/null | grep -i "pi-harness-whatsapp"
   ```
   For each removed `setup.json` entry, `dpkg-query -W <packages>` (or your package manager's equivalent) must no longer show them as installed.
8. **Report** what you removed, and what stays on purpose (below).

### What stays, on purpose; don't delete it

- **Pi's sessions** (`~/.pi/agent/sessions/`). Conversations with Pi from WhatsApp are normal Pi sessions and contain small `pi-harness-whatsapp/session` entries (WhatsApp on/off). Pi ignores them without the extension. **Never edit session files**: entries are linked to each other, and cutting some out breaks the session. If the user wants those conversations gone, they delete whole sessions in Pi.
- **Other packages in npm's cache.** Only this extension's entries are removed. Emptying the whole cache (`npm cache clean --force`) is only for when the user asks for it.
- **npm's own logs** (`~/.npm/_logs`, its last few runs) may mention the install; npm replaces them as it runs again.
- **The package manager's history** (`/var/log/apt/history.log`, `/var/log/dpkg.log`, …) records installs and removals of every program. Never edit system logs.

## Troubleshooting

See the README's **Troubleshooting** section. The most common issues:
- the QR code expired: `/whatsapp → Connection → Connect now`
- `WA: in use by Pi #…`: another Pi holds the connection
- `ffmpeg` missing: voice notes fail with a clear error
