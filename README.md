# BLACKWATER DOCK — 5v5 tactical FPS in three.js

A round-based tactical shooter in the style Counter-Strike made famous, set
at a container terminal at night. Built for the make.fun `threejs-fps-01`
bounty.

## The game

Two teams of five fight over a harbour yard with three lanes. The Jackals
attack: plant the device at site A (the gantry crane) or site B (the
warehouse), or eliminate the Sentinels. The Sentinels defend: hold the
sites, defuse a planted device, or run the clock out. First to 8 rounds
takes the match (max 15; 7–7 is a draw). The human player is a Jackal and
carries the device at the start of every round — if you die, it drops and a
teammate must walk over it to pick it up.

- **Gunplay** — four weapons (Dagger P9 sidearm, Stinger-9 SMG, AR-77
  Kestrel rifle, Longshot-7 DMR) plus HE grenades. Hitscan against bodies
  with 4× headshot damage, recoil and spread that punish firing on the
  move, acceleration-based movement with crouching and jumping and AABB
  collision, so stopping to aim pays.
- **Tactics** — a plant/defuse objective, a buy menu between rounds with a
  Counter-Strike-shaped economy ($800 start, $300 per kill, $3250 round
  win, $1900 loss plus a $500 loss-streak bonus), and nine bots that follow
  per-round plans (A push down the quay, B push down the alley, split,
  mid hold), hold angles, react to gunfire they hear, plant when a site
  is clear and defuse when the device is down.
- **The map** — an original night terminal: a gantry crane over site A, a
  warehouse with a 6 m doorway over site B, container rows stacking up to
  three high through mid, a quay lane along the harbour water, and sodium
  floodlights pooling warm orange over cold blue dark.
- **Presentation** — procedural WebAudio gunfire, beeps and explosions (no
  audio files), tracers, muzzle flash, hit sparks, a bomb explosion, and a
  HUD with health, armour, ammunition, round timer, score, money, alive
  counts, killfeed and bomb status. Death switches to spectating a living
  teammate (click to switch).

## Controls

WASD move · mouse look · click fire · R reload · G throw grenade · E hold to
plant / defuse · 1–6 buy during the buy phase · Ctrl crouch · Space jump ·
C cycle spectate while dead.

## How it is built

- `game/index.html` — import map for three.js 0.187.0 (vendored byte for
  byte) and the HUD.
- `game/src/` — one module per job: `map` (the dock + waypoint graph +
  segment-vs-AABB line of sight), `player` (movement + shared AABB slide),
  `weapons` (defs + view models), `bots` (AI: routes, perception, bursts,
  plant/defuse), `rounds` (match state machine + economy + bomb),
  `effects` (pooled tracers/sparks/explosion), `audio` (synthesized SFX),
  `hud` (DOM), `input` (pointer lock + keys), `main` (boot + fixed 60 Hz
  simulation + render loop).
- The simulation runs on a fixed 60 Hz step kept apart from rendering, with
  pooled vectors and effects — no allocations in the hot loops.
- `main.ts` copies `game/` and `screenshots/` to `/output` and writes
  `dossier.json` with the kit's `vendor/makefun-threejs.ts`.

## Screenshots

`?shot=start|play|plant|end&seed=N` stages a deterministic frame (buy phase,
mid firefight, planted device, round won) for capture; the page sets
`window.__shotReady` when the frame is painted. The four screenshots in
`screenshots/` are real renders of this code in desktop Chrome.

## Play locally

```sh
node serve.ts   # http://localhost:8080
```
