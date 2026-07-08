---
id: voice-media-mobile
path: voice-media-mobile
label: Voice/media/mobile
title: Voice, media, and mobile
summary: Speech-to-text, VAD, text-to-speech, media generation, presets, and mobile companion.
group: Local data
order: 80
updated: 2026-07-03
---

These features are optional extensions around the same desktop session. Voice writes into the composer, TTS reads responses back, media routes submit provider jobs, and the mobile companion mirrors desktop threads while sending phone prompts through the desktop session.

## Setup paths

| Feature | Setup check |
|---|---|
| Speech-to-text | Configure the selected STT provider. Native Whisper builds require `MILIM_WHISPER_MODEL` and the `whisper` feature. |
| VAD | Native VAD is behind the `native-vad` build feature. |
| Text-to-speech | Piper and Kokoro presets install runtime assets under the Milim runtime directory. Native TTS is behind the `native-tts` feature. |
| Media generation | Add Replicate, fal, or OpenRouter media-capable provider credentials. |
| Mobile companion | Enable the companion bridge, use Tailscale setup or a manual phone URL, pair the phone, then use the phone view to read, switch, and send prompts through desktop threads. |

## Media route

```bash Generate media
curl "http://127.0.0.1:7377/media/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "provider_id": "provider-id",
    "kind": "image",
    "model": "black-forest-labs/flux-schnell",
    "prompt": "A clean product screenshot on a graphite desk"
  }'
```

Media prompts are remote-provider traffic. They pass through the privacy gate in Redact and Block modes before leaving the machine.

## Mobile companion

In the desktop app, open Settings -> Mobile, enable the companion bridge, then use **Set up with Tailscale** to expose the phone-only companion surface through Tailscale Serve. Milim uses the installed `tailscale` CLI, points Serve at a mobile-only loopback listener, fills the phone URL base, and creates the pairing QR. It prefers HTTPS on port `10000` so the installed phone app can request camera access for QR scanning, and falls back to tailnet-only HTTP if HTTPS setup fails. On later launches, if the companion bridge is still enabled, Milim best-effort reapplies Tailscale Serve to the new local relay listener. If no other tailnet devices are visible, Milim warns that the phone must be connected to the same Tailscale tailnet before scanning. If Tailscale is not installed, Milim opens the official Tailscale download page and shows an install shortcut in the panel. If Tailscale is installed but not logged in, the settings panel shows the CLI status and leaves the manual URL field available.

The phone page includes web-app metadata, an icon, and a small service worker so mobile browsers can add it to the home screen. The phone stores its device key locally, and the desktop app persists paired device records under the Milim config directory, so refreshes, home-screen launches, and Milim restarts keep the phone paired unless the bridge is disabled or the device is revoked.
Home-screen apps can have separate browser storage from the tab used to scan the QR. Pairing links stay redeemable for their short pairing window, so launching the installed app from the pairing link can automatically mint its own device key instead of failing on an already-used token. The installed pairing screen can also scan the desktop QR in place or accept a pasted pairing link, which avoids depending on a browser URL bar after the relay has been added to the home screen. Camera scanning requires a secure browser context such as HTTPS or localhost; use the paste field if the phone browser blocks camera access on a plain HTTP relay URL.

Manual setup still works: enter a phone-reachable base URL before pairing. Use a Tailscale Serve URL for a real phone, or `http://10.0.2.2:<port>` for the Android emulator.

```bash Mobile send event
curl http://127.0.0.1:7377/mobile/relay \
  -H "Content-Type: application/json" \
  -d '{"text":"send this from phone","action":"send"}'
```

The companion does not bypass the desktop session. The desktop app persists the phone URL base, then publishes a project-aware thread sidebar, available model IDs, the active desktop theme variables, and the active-thread snapshot to the mobile bridge; paired phones receive Markdown-rendered live thread updates, inherit light/dark mode, radii, glass, typography, and background image fit/treatment, can switch/create/rename/archive/delete threads, stop or regenerate runs, change the thread model, attach small files or phone photos, and send prompts through the same selected model, privacy, memory, and approval settings as the active desktop composer. Desktop relay event polling only runs while the app document is visible and the bridge has at least one paired device; a slower status check wakes relay polling after pairing.
