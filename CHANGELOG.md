# Changelog

## 0.1.4 — 2026-10-24

- The data folder follows pi's own agent folder setting exactly (`PI_CODING_AGENT_DIR`, also with `~`).
- `baileys` is a version range instead of one exact version, and the pi packages it works with are stated as ranges.
- Development: the entry file is `src/index.ts`, the tests use Node's own test runner (no vitest), and the type check
  and tests run on GitHub for every push, on Linux and macOS.

## 0.1.3 — 2026-10-16

- No more npm warning about skipped install scripts when installing from GitHub (the two scripts, version checks in `baileys` and `protobufjs`, are now refused explicitly; they never ran before either).

## 0.1.2 — 2026-10-16

- **Fixed file permissions:** the data folder and the WhatsApp login in it were readable by other users on the same machine. Every folder the extension creates is now private (only your user can open it), and existing installs are fixed the next time Pi starts.

## 0.1.1 — 2026-10-15

- **Voice is optional, and off by default.** `/whatsapp` → Voice → **Voice notes** has two ticks: understand voice notes (speech-to-text, 1.0 GB) and reply with voice notes (text-to-speech, 0.6 GB), plus "Delete all speech files". Leaving the menu asks before deleting the files of a part you unticked ("You set speech-to-text for removal. 828 MB will be freed."; No puts the tick back) and offers to download a part you ticked (now, or when first needed). Nothing is downloaded while voice is off.
- While understanding is off, a voice note gets "🎤 Voice notes are off. Please type your message." (in groups, only one that replies to Pi) and never reaches the model.
- Reply type, the voices and the voice speed are greyed out until voice replies are on, and say which tick turns them on. `/voice` and `/speed` on WhatsApp say so instead of changing anything; `/help` and `/status` show both switches.
- The panel has a VOICE section and a DANGER section (Remove everything, and where the log file is); the Speech files row is gone.
- Existing setups keep the voice parts whose files are already on disk. Leftovers from older versions (Piper voices, older Whisper models, unfinished downloads nothing needs) are deleted on start.
- README and AGENT_INSTALL: what voice costs in disk and RAM per part, the new settings, and an install question about voice.

- **Uninstall without leftovers:** `/whatsapp` → Connection → **Remove everything (before uninstalling)**, or `/whatsapp remove`, unlinks Pi from the phone (connecting first if needed), stops running downloads, deletes every file the extension made, removes its copies (and its dependencies') from npm's download cache, and keeps Pi from writing any more until it quits. It refuses while another Pi holds WhatsApp. AI agents can run it over Pi's RPC mode.
- **`setup.json`:** programs installed just for the extension (ffmpeg, tmux) are recorded with the exact packages that came with them; Remove everything asks about each and removes exactly those (apt: after a dry run that keeps everything if anything else would go too; Homebrew: `brew uninstall`; otherwise it shows the command). AGENT_INSTALL tells agents how to record them.
- The README and AGENT_INSTALL describe the full uninstall, the background service, what stays on purpose and how to check that nothing is left.
- A Pi that never turned WhatsApp on no longer creates a log or recent-chats file when it quits.
- README: a section on sending and receiving images and files.
- The examples in Pi's instructions for spoken replies are in English.

## 0.1.0 — 2026-10-15

First release.

- **Pairing and connection:** QR code in the terminal; saved login; automatic reconnects with backoff; asks for a new QR when WhatsApp logs the device out; one Pi at a time holds the connection, and the next one takes over when it's free.
- **A real off switch:** off disconnects, hides the WhatsApp tools, and skips (and reports) messages that arrived meanwhile. On/off is saved per session.
- **Automatic replies:** only for runs started from WhatsApp, with optional summary, in-between messages, touched files and a live tool-activity message. Each answer goes to the chat whose message it answers; a prompt typed in the terminal keeps its answer in the terminal, even when WhatsApp messages wait behind it. If Pi can't start on a message, the chat is told. Optional "Terminal answers" also sends the owner the answers to terminal prompts. Each message's label says who is talking and where (and whether spoken) the reply goes, so small models answer the sender directly. Status lines are always text, and a cut-off answer is reported instead of "Done". Markdown is converted to WhatsApp formatting, and long messages are split safely.
- **Voice:** voice notes are understood by Whisper large-v3-turbo and replies are spoken by Supertonic 3, both run locally through Intel's OpenVINO on the CPU; 15 languages and 10 voices, chosen per language; reply modes text / voice / voice + text / mirror me. The engine and the models download on first use (pinned versions, checked against their checksums), not through npm; an interrupted download continues where it stopped. Voice notes are handed to Pi in the order they were sent, even while one is still being transcribed.
- **Commands and poll menus:** /help /status /stop /compact /autocompact /model /think /voice /lang /speed /replies /languages /new /off /quit /restart, with owner-only access by default. Replying with a number answers a menu only until it's answered or you message Pi; in groups, only when it replies to the menu.
- **Media:** images go to the model; files are saved for Pi to read; optional tools send images and files; long spoken answers are split into several voice notes; images made by tools can be forwarded automatically (off by default).
- **Contacts and groups:** allow-list by phone number or WhatsApp's hidden id (LID), recent chats, first-contact onboarding, "message yourself" support. In groups Pi answers replies and @mentions by default (or only one of them, or every message), gets the last 20 text messages as context, and sees images that are @mentioned in a caption or replied to.
- **AGENT_INSTALL.md:** guidance for AI agents installing the extension: what to check, what to ask the user (including every setting with its default), how to write the settings, voice ids per language, telling the user about `/help`, and what never to touch.
- **Settings panel:** grouped into Connection, Replies, Languages and Technical; every row opens a small menu with short descriptions; voice samples on WhatsApp; speech files are only downloaded when you confirm (or when first needed) and unused ones are deleted from a ticked list.
- **Privacy:** the log never contains message text; received files are removed after 7 days.
