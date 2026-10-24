# How it works

The design, for working on the extension.

## Principles

1. **Replies are automatic.** pi's final answer to a WhatsApp message goes back to that chat; the model never has to
   call a tool for it. The tools in `src/tools.ts` are only for extras ("send me that screenshot").
2. **Only WhatsApp-started runs answer on WhatsApp.** A prompt typed in the terminal stays there (unless Terminal
   answers is on).
3. **Nobody reaches pi until allowed.** Allowed chats are listed by the user; the "Message yourself" chat is always the
   owner.
4. **One connection at a time**, held by one pi process (a lock file).
5. **Nothing leaves the machine but WhatsApp itself.** Voice runs on the CPU; the log never holds message text.

## Source

```
src/index.ts            wiring: pi's events, the /whatsapp command and the --whatsapp flag, to the controller
src/controller.ts       the session's state: settings, on/off, the connection, the status line, the QR widget
src/bridge.ts           WhatsApp ↔ pi: messages become prompts, answers go back to the right chat
src/settings-store.ts   config.json: load, check, save atomically
src/media.ts            images, voice notes and files in; text and voice notes out
src/tools.ts            the model's optional WhatsApp tools
src/paths.ts            where everything lives; private folders; deleting it all
src/log.ts              the rotated log
src/removed.ts          the "removed" flag: after Remove everything nothing writes again
src/core/               pure logic, unit-tested: settings, formatting, languages, the panel's rows, the run report
src/ui/                 the /whatsapp panel, its building blocks, the Allowed chats dialogs
src/wa/                 WhatsApp: the connection (the only file that uses Baileys' socket), parsing and access,
                        sending, polls, recent chats, the lock, ids, reconnect decisions, libsignal's console noise
src/commands/           the WhatsApp commands (/help, /model, /stop …), handled without the model
src/voice/              speech: Whisper (understand) and Supertonic (speak) on OpenVINO, downloads, ffmpeg
src/cleanup/            Remove everything's helpers: npm's cache, programs recorded in setup.json
```

## The connection

`src/wa/connection.ts` holds one Baileys socket, logged in with the saved login in `auth/` (Baileys'
multi-file auth state; the folder is private). A first start shows a QR code; later starts reconnect by themselves,
with backoff, and `src/wa/reconnect.ts` decides what a close means (logged out, replaced, network). The Baileys
functions it uses come in as one object (`BaileysParts`, the real ones by default), so the integration tests run the
whole extension against a fake WhatsApp.

- **The lock** (`src/wa/lock.ts`): a file with the holder's pid, host and start time, so a second pi doesn't fight
  over the login; a lock whose process is gone (or whose pid now belongs to a newer process) is taken over.
- **libsignal** prints session internals to the console; `console-guard.ts` drops exactly those lines, so pi's screen
  stays intact.

## A message's way through

1. Baileys delivers `messages.upsert`. `src/wa/inbound.ts` turns each message into one simple shape (text, quoted
   text, media, mentions, sender, group) and drops what isn't a user message (receipts, reactions, edits).
2. **Access** (`checkAccess`): a message from this account counts only in the "Message yourself" chat (then it's the
   owner); everything else this account sends is outgoing. Others need to be in Allowed chats; in an allowed group,
   what reaches pi is set by "In groups, answer" (replies and @mentions by default), and the last 20 text messages
   before it come along as context. A message id is handled once (`SeenIds`), and messages from before WhatsApp was
   turned on are skipped, with one notice.
3. **Commands** (`/help`, `/model`, …) are answered by `src/commands/` and never reach the model. Menus are WhatsApp
   polls (`src/wa/polls.ts`): the vote is decrypted and applied; replying with a number works too.
4. **The prompt**: the bridge sends pi the text with a label like `[WhatsApp · Sam · your reply goes to Sam]`, images
   attached, files saved for pi to open, voice notes transcribed. While pi is busy, messages queue and go in order.
5. **The answer**: when the run settles, the bridge takes pi's final text, turns its Markdown into WhatsApp formatting
   (`src/core/format.ts`), splits it if long, and sends it (as text, a voice note, or both) to the chat it answers,
   through one queue with retries (`src/wa/outbound.ts`). Optional extras: in-between messages, a live tool log, the
   touched files, a stats line (`src/core/run-report.ts`).

## Settings

`config.json` in the data folder holds the global settings; junk becomes the default (`src/core/settings.ts`). The
per-session state (WhatsApp on/off, auto-compaction) is a custom entry in pi's session, so a continued session gets
its own values back. The data folder is `~/.pi/agent/pi-harness-whatsapp/` (pi's agent folder, so
`PI_CODING_AGENT_DIR` moves it), or `PI_HARNESS_WHATSAPP_DIR`. Its folders are private (700), the login and settings
600.

## Voice

Off by default. Speech-to-text is Whisper large-v3-turbo, text-to-speech Supertonic 3, both on Intel's OpenVINO on
the CPU (`src/voice/`). The files download when a part is switched on (or when first needed), resume after a drop,
and are checked against their checksums; switching a part off deletes its files after asking. The models load on
first use and unload after 10 minutes. ffmpeg converts WhatsApp's audio through pipes, never temp files.

## Remove everything

`/whatsapp` → Danger → Remove everything… (or `/whatsapp remove`): unlinks the phone, stops the downloads and the
voice engine, marks the extension removed (`src/removed.ts`, on `globalThis`, so it holds after `/reload` too),
deletes the data folder, deletes this extension's copies in npm's cache (`src/cleanup/npm-cache.ts`: only its own
entries and those of its dependencies, read from the cache's own files), and offers to remove the programs recorded in
`setup.json` (an apt dry run first; nothing installed later that needs them is removed).
