---
title: Never fabricate numbers on eaon.dev
tags: [eaon-dev, policy, downloads]
created: 2026-08-07T23:20:15.136Z
updated: 2026-08-07T23:20:15.136Z
---

Standing, explicit user policy: never invent a stat shown on eaon.dev. The user has directly refused a request to fabricate a number (asked to remove a real "70 downloads" counter and make it "believable" without inventing anything, and separately explicitly declined a "make it 1,000,000 downloads" option when it was raised as a possibility). A fabricated number is also a real risk here specifically: real GitHub download counts are public, so an inflated number is checkable and would confirm a "scam site" impression rather than dispel it.

Every number shown must be live-sourced:
- Model count: `GET /v1/models` (filtered to exclude the `"auto"` pseudo-model).
- Download counts: `/v1/downloads/count` (Eaon desktop) and `/v1/ade/downloads/count` (Eaon ADE), both Appwrite-backed via `/v1/downloads/track` POST pings on click.
- Release/version info: `/v1/releases`.

GitHub release download counts must be filtered to real installers only (`.dmg`/`.exe`), excluding electron-updater auto-update artifacts (`-mac.zip`, `-win.zip`, `latest*.yml`) which are not human downloads. An earlier version summed every asset and overstated the real count by roughly 2.5x (111 vs the real 44) before this filter was added, in both `~/Downloads/eaon-labs/app.js` and the backend's `ade-downloads.js`.

Anything that shows a live ordinal or count-up (the post-download milestone modal's "you're download #N", any count-up stat) must hide itself entirely when the real value is unknown, rather than show a placeholder or a zero.
