---
title: Effort levels: old ids, provider names and clamping
tags: [eaon-desktop, providers, models, convention]
created: 2026-10-01T02:39:38.190Z
updated: 2026-10-01T02:39:38.190Z
---

`EffortLevel` = `none | minimal | light | medium | high | extra-high | ultra`. The ids `light`, `extra-high` and `ultra` are **kept for compatibility** with saved settings and chats; they mean low, xhigh and max. Labels and wire names live in one place, `src/shared/effort.ts` (`EFFORT_LABEL`: Off, Minimal, Low, Medium, High, Extra high, Max; `WIRE_EFFORT`: none, minimal, low, medium, high, xhigh, max). Don't add per-component label maps; the old Composer/Configuration maps disagreed ("Light", "Ultra") and that was part of "efforts are not right".

## Rules
- **The menu shows exactly `model.efforts`.** There is no user filter any more: the "Available reasoning efforts" setting and "Ultra in model picker slider" (default off, which is why Max never appeared, and there was no slider) were removed from Configuration and the Settings type.
- **One global preference, clamped per model, never overwritten.** `clampEffort` (shared, used by the chip, the menu and every adapter): the chosen level if the model takes it, else the nearest lower one, else the model's lowest. `selectModel` used to rewrite `settings.effort` to the model's *highest* level on a switch. That silently jumped to Max, and switching back lost the choice.
- **Deriving `efforts` from Pi's `thinkingLevelMap`** (`effortsFromLevelMap`): offer a level only if it reaches the wire as itself. `null` = unsupported; a missing key counts only for low/medium/high. So Codex's `minimal: 'low'` shows Low once, and off is offered only when mapped to a real value (`'none'`). From models.dev, read `reasoning_options[type=effort].values` and drop `default`. Toggle- or budget-only models get `[]`. A list that would be only Off becomes `[]`, otherwise thinking would be switched off with no way back.
- **Off on the wire:** OpenAI/OpenRouter send effort `none`; toggle hosts (DeepSeek, Z.ai, Qwen, Together) send their disabled toggle and no `reasoning_effort` (`openaiChat.ts`); Claude never offers Off; budget models get no `thinking`.

See [[Model catalog: generated from Pi and models.dev, with user overlays]].
