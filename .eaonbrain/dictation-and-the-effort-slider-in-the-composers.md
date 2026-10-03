---
title: Dictation and the effort slider in the composers
tags: [eaon-desktop, composer, voice, ui]
created: 2026-10-02T23:20:39.548Z
updated: 2026-10-02T23:20:39.548Z
---

Added Oct 2 2026 (the aicss.dev request).

## Effort slider
The model menu's **Effort** submenu (`ModelMenu` in `Composer.tsx`) is now a slider rather than a list: `components/composer/ReasoningEffort.tsx` and `.module.css`. It's adapted from AICSS's free, MIT-licensed Reasoning Effort component. A header comment points to `components/aicss/LICENSE`; nothing in the UI credits it.
- Kept as the original: the geometry, the path that grows the label "shoulder" out of the track, the timings and easing, and the drag and keyboard handling.
- Changed:
  - `labels` (the model's own levels, `ModelInfo.efforts`, 2 to 7 of them), `value` and `model` are props;
  - tick heights spread 4.8 to 9.6px over however many levels there are;
  - `onChange` fires on release or a key press;
  - colours are the original's `--ss-*` variables set from theme tokens (accent for the blue), so its own light/dark detection is gone.
- Inside a `Popover` the contents are scaled during the open animation, so pointer maths and label measurement work in track units (rect width / `TRACK`, and the label width divided by the scale).
- A model with one level shows that level as a checked item; one with none keeps the row disabled.

## Dictation
A mic button sits beside Send in Chat's composer and in `WorkerComposer.tsx`. `useDictation` (`components/composer/useDictation.ts`) records with MediaRecorder (webm/opus at 32 kbps, stopping by itself at 10 minutes). Main transcribes it (`features/voice.ts`, `features/voice/transcribe.ts`): OpenAI `gpt-4o-mini-transcribe` (falling back to `whisper-1` when the account can't use it), else Groq `whisper-large-v3-turbo`, using the saved key. The text is appended to the box, never sent by itself.
- Order matters: check for a key (`voice:provider`) **before** asking for the mic (`voice:microphone`, which calls `askForMediaAccess` on macOS), so nobody talks for a minute only to learn there's no key.
- `VoiceBar.tsx` / `voice.css` replace the textarea while recording: Esc discards, Enter finishes. The waveform is an original design. Thin mirrored bars scroll right to left: a new bar every 55ms, sliding smoothly in between, older bars fading out under a mask, and silence drawn as a dotted line. While transcribing, the strip freezes and a highlight sweeps across it. With reduced motion (the OS setting or `body[data-reduce-motion]`) it updates about four times a second without scrolling or sweeping. Canvas colours come from tokens through a hidden probe element's computed `color`.
- macOS: Electron's Info.plist already declares the microphone, and `resources/entitlements.mac.plist` already had `com.apple.security.device.audio-input`. `electron-builder.yml` `mac.extendInfo` only replaces the usage text. No session permission handler is set, so Electron grants the page's `media` request by default.

## Testing it without a real mic, prompt or API call
Before **any** mic click on an isolated profile, override `voice:microphone` / `voice:transcribe` (and `voice:provider` if needed) in main via `ipcMain.removeHandler` + `handle`, and replace `navigator.mediaDevices.getUserMedia` in the page with an `AudioContext` oscillator piped to a `MediaStreamDestination`. Once, with a dummy key saved first, a click got past the key check and opened the real microphone for a few seconds, without a prompt because the terminal already had mic access; the run discarded it. Tests: `test/voice.test.ts` (fake fetch) and `test/reasoningEffort.test.ts` (react-dom/server).

Links: [[Composer and menus, and mentioning workers]], [[Electron 43 upgrade and the macOS 26 window look]]
