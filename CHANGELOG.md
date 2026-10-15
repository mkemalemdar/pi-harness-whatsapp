# Changelog

## 0.1.0 — unreleased

First release.

- **Pairing and connection:** QR code in the terminal; saved login; automatic reconnects with backoff; asks for a new QR when WhatsApp logs the device out; one Pi at a time holds the connection, and the next one takes over when it's free.
- **A real off switch:** off disconnects, hides the WhatsApp tools, and skips (and reports) messages that arrived meanwhile. On/off is saved per session.
- **Automatic replies:** only for runs started from WhatsApp, with optional summary, in-between messages, touched files and a live tool-activity message. Each answer goes to the chat whose message it answers; a prompt typed in the terminal keeps its answer in the terminal, even when WhatsApp messages wait behind it. If Pi can't start on a message, the chat is told. Optional "Terminal answers" also sends the owner the answers to terminal prompts. Markdown is converted to WhatsApp formatting, and long messages are split safely.
- **Voice:** local Whisper (base by default, or small/turbo) and Piper voices through sherpa-onnx in a worker thread; many languages; reply modes off / voice / voice + text / mirror me; automatic model downloads.
- **Commands and poll menus:** /help /status /stop /compact /autocompact /model /think /voice /lang /speed /replies /languages /new /off /quit /restart, with owner-only access by default. Replying with a number answers a menu only until it's answered or you message Pi.
- **Media:** images go to the model; files are saved for Pi to read; optional tools send images, files and voice notes; images made by tools can be forwarded automatically (off by default).
- **Contacts:** allow-list by phone number or WhatsApp's hidden id (LID), recent chats, first-contact onboarding, "message yourself" support.
- **AGENT_INSTALL.md:** guidance for AI agents installing the extension: what to check, what to ask the user (including every setting with its default), how to write the settings, voice ids per language, telling the user about `/help`, and what never to touch.
- **Settings panel:** grouped into Connection, Replies, Languages and Technical; every row opens a small menu with short descriptions; voice samples on WhatsApp; speech files are only downloaded when you confirm (or when first needed) and unused ones are deleted from a ticked list.
- **Privacy:** the log never contains message text; received files are removed after 7 days.
