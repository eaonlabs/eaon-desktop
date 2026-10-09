# Eaon for iPhone

The iOS app: run models and talk to them on the phone, run agents on the
phone, or connect to Eaon on the Mac and control its agents from there.

It opens on the landing screen, where you come in with Apple, with GitHub, or
without an account; behind that are three tabs: **Chat**, **Agents** and
**Settings**.

## Building

Open `Eaon.xcodeproj` in Xcode 26 or later and run the **Eaon** scheme. It
targets iOS 18. To run on a device, pick your team under Signing & Capabilities.

`project.yml` is the source of the project file. After changing build
settings there, run `xcodegen` in this folder. The `Eaon` folder is a
synchronized folder, so files added under it don't need a regenerate.

The shaders need Xcode's Metal toolchain. If the build stops with "missing
Metal Toolchain", install it with
`xcodebuild -downloadComponent MetalToolchain`.

## Coming in

The welcome offers three ways in (`Landing/`, `Auth/`):

- **Continue with Apple**: the system sheet. The App ID `dev.eaon.ios` is
  registered with the *Sign in with Apple* capability (developer team
  W9MHT9V982), and `Eaon.entitlements` asks for it. To run on a device, pick
  that team under Signing & Capabilities; automatic signing makes the profile. Apple sends a name and email
  only the first time; `SessionStore` keeps them in the Keychain so signing in
  again still knows who you are. At launch the app asks Apple whether the
  credential is still valid and signs out if it was revoked; if Apple can't
  say (offline), you stay in.
- **Continue with GitHub**: GitHub's *device flow*, which needs no server and no
  client secret. The app shows a code, you enter it at github.com/login/device,
  and the app, meanwhile polling, is handed a token. The token is used once to
  read your profile (`read:user`) and isn't kept. The OAuth App is **Eaon**, under
  the **eaonlabs** org (Settings › Developer settings › OAuth Apps), with
  **Enable Device Flow** on; its client ID is the default
  `EAON_GITHUB_CLIENT_ID` in `project.yml` (a client ID is public). Override it
  with `EAON_GITHUB_CLIENT_ID=… xcodebuild …`. With none set, the button says
  what's missing.
- **Continue without signing up**: for people who don't have Eaon on a Mac.
  Everything works on this iPhone.

An account is only who you are on this iPhone: it's kept in the Keychain, and
nothing is sent to an Eaon server. Signing out returns to the welcome and
leaves chats where they are; **Settings › Erase everything** clears chats,
keys and the Mac connection too. A guest can sign in later from Settings.

## The app

- **Chat** (`Chat/`): a greeting and a few things to ask, then the thread, with
  Markdown, code blocks that copy, stop, try again, and a history sheet with
  search and swipe actions. Chats are one JSON file in Application Support.
- **Models**: one list behind the composer's model chip.
  - *Apple Intelligence*, on this iPhone (iOS 26 and an Apple Intelligence
    iPhone), with no key or account.
  - *Your Mac*: the models set up in Eaon on a Mac.
  - *Providers* you add: OpenAI, OpenRouter, Groq, Ollama, LM Studio, anything
    that speaks the OpenAI chat API (`OpenAICompatibleBackend`). Keys live in
    the Keychain.
- **Agents** (`Agents/`): spin up agents on this iPhone, or control the ones on
  your Mac. See below.
- **Connecting a Mac** (`Mac/`, from Agents or Settings): scan the QR code the
  Mac shows, tap the Mac Bonjour finds on the network, or type its address and
  key. It uses Eaon Desktop's Remote API (`docs/remote-api.md` in the desktop
  repo), so the same pairing gives you the Mac's agents and its models in Chat.
- **Settings** (`Settings/`): profile, models and providers, appearance
  (system, light, dark), haptics, your data.

The design is in `Design/`: Eaon's paper and ink, white cards on the paper,
Liquid Glass for what floats (the composer, tab bar, sheets' controls, the
landing's buttons), native sheets, swipe actions and toggles.

## Agents

An agent is a small face with a job. It has a purpose and a manner, notes it
keeps for itself, a goal, a conversation, questions it can put to you, and a
schedule it can set. The faces are the desktop's workers' faces (`AgentFace`),
with the same moods.

**On this iPhone** (`Agents/Phone/`): `PhoneAgents` runs them. A turn is one
call to a model that can use tools, in a loop: ask, run what it asked for,
show it the results, ask again (`OpenAIToolEngine` for a Mac and every
provider; `OnDeviceToolEngine` for Apple's model, which runs the same tools
through FoundationModels). The tools (`PhoneTools`): `web_fetch` (public
addresses only; anything on this network is refused, redirects included),
`calendar_events`, `add_calendar_event`, `add_reminder`, `update_notes`,
`ask_user`, `notify_user`, `set_heartbeat`, `add_routine`, `finish_goal`, and a
few more. Three access levels, as on the desktop: *Autonomous*, *Careful* (it
may read and keep notes, but asks you before adding an event or a reminder:
the question appears with the exact action, and Allow does it) and *Look only*.
An agent wakes when you write to it, at a time it set itself, or to carry on
with a goal. iOS doesn't let an app run in the background, so schedules run
while Eaon is open; a wake-up that comes due while it's closed is a
notification, and runs once, however many were missed, when you open Eaon.
An agent that wakes itself more than 12 times an hour is stopped. Agents and
conversations are JSON files in Application Support; **Settings › Erase
everything** deletes them.

**On your Mac** (`Agents/Remote/`): `MacAgents` follows the Mac's Workers over
the event stream and sends your commands back: write to one, give it a goal,
stop it, pause it, answer its questions and approve what it asks, spin up a
new one, remove one. They run on the Mac all the time, with its files, browser
and tools. The Mac's side is in the desktop repo (`src/main/remote/`, off until
you turn on **Settings › Remote devices**).

A phone agent can't command a Mac agent: a page the phone agent reads could
otherwise talk a limited agent into using a powerful one.

## The landing screen

`Eaon/Landing/` holds the opening sequence:

1. A glass dome rests on the bottom edge under the opening line.
2. Pressing it gathers a haze of light in the glass.
3. The finger carries the glass the whole way. Sliding up, it lifts the dome
   as a lens: the haze spreads into a crescent of cyan, blue and violet, the
   opening line blurs away, and "Meet Eaon." shows through the glass. Further
   up, the lens shrinks under the finger into a small orb, in the orb's place
   above the welcome.
4. Let go past the threshold and it settles the rest of the way; short of it,
   it springs back. Nothing moves on its own while it's held.
5. The welcome and the ways in (Apple, GitHub, "Continue without signing up") arrive, and marbles (agents' faces and the
   things they do) stream out of the orb and heap up under the top edge.
6. The orb can be picked up and slid anywhere: a magnifier that grows as it
   comes down. Bring it to the bottom and let go to go back to the start.

With Reduce Motion on, a swipe crossfades between the two places instead, and
there are no marbles.

### How it's drawn

- **The live UI** (`LandingScene`) is ordinary SwiftUI: the text and the
  Liquid Glass buttons.
- **The glass** is Metal (`Glass/`), drawn over it in a transparent view
  (`GlassLensView`, `LensRenderer`, `Lens.metal`). The lens refracts the UI
  behind it, rendered once into textures (`BackdropTexture`), and the marbles,
  drawn each frame into a texture of their own. The shader is a circle SDF, a
  height profile (a low dome with a squircle bevel) whose normal sets where
  each of red, green and blue looks, plus rim light, a soft shadow and the
  crescent.
- It doesn't use SwiftUI's `layerEffect`, which only hands a shader the part
  of the layer near the tile being shaded, so a lens that looks a radius away
  got blank paper back.
- `LandingEngine` steps the springs, the drag and the marbles' physics
  (`Marbles/`) once a frame; the Metal view draws in the same frame as SwiftUI.

### Tuning

In a Debug build, the slider button at the top right opens a panel with every
knob in `LandingTuning`: refraction, magnification, dispersion, rim width and
curve, highlight, the radius at rest and at the end, the crescent's colour and
intensity, the springs' stiffness and damping, and the marbles' count, size
range and spawn rate. Numbers can also be set at launch, e.g.
`-refraction 0 -stiffness 300`. Launch with `-lab` for a still lens over test
text, `-reduceMotion` to force the crossfade.

### Testing

The **EaonTests** unit tests (accounts and the Keychain, the GitHub device flow
against a stubbed network, SSE parsing, address handling, the chat store and
controller, the model catalog, Markdown) run in a second:

```sh
xcodebuild -project Eaon.xcodeproj -scheme Eaon \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:EaonTests test
```

`AuthFlowUITests` (in **EaonUITests**) goes through the ways in and the screens
behind them. Debug builds take launch arguments to start in a state:
`-resetAll`, `-guest`, `-demoAccount apple|github`, `-demoMac`, `-seedChats`,
`-tab chat|agents|settings`, `-sheet history|picker|provider|github|issue|newAgent|connectMac`,
`-demoAgents`, `-newAgent "Name|access|purpose"`, `-agentSend "Name|text"`,
`-connectMac "host:port|key"`, `-openAgent <name>`,
`-demoProvider <address>` (a fake OpenAI-style server, say) and `-send <text>`;
see `App/DebugLaunch.swift`. To try the Mac side without the app, the desktop
repo has a demo server: `EAON_REMOTE_DEMO=1 node out/test/remote-demo.test.mjs`.

Apple's on-device model **doesn't work in the Simulator**: it reports itself
available and then fails every request. Try on-device agents on a real iPhone
with Apple Intelligence.

The **EaonUITests** target also drags the glass with real (synthesized) touches:
sliding through, springing back, letting go past the threshold, bringing the
orb back down, and Reduce Motion. Run them with Product › Test, or:

```sh
xcodebuild -project Eaon.xcodeproj -scheme Eaon \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

They read the screen's state from a probe element that Debug builds add.
(The test runner sees elements hidden from VoiceOver, so it can't tell a
faded-out button from a live one by looking for it.)

`-autoplay` plays the whole sequence with a pretend finger, for recording the
Simulator. It moves the glass by itself, so don't use it on a simulator
someone is trying out:

```sh
xcrun simctl launch booted dev.eaon.ios -autoplay
```
