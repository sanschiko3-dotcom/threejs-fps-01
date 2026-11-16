# BLACKWATER DOCK — 5v5 plant/defuse tactical FPS

A round-based tactical shooter in three.js, built for the make.fun
`threejs-fps-01` bounty. Two teams of five fight over a harbour container
yard at night. The Jackals attack, the Sentinels defend, and the first team
to 8 rounds takes the match (15 rounds max; 7–7 is a draw).

## How a match plays

The human player is a Jackal and carries the device from the start of every
round. Plant it at site A (the gantry crane) or site B (the warehouse), or
wipe out the Sentinels. Die while carrying it and the device drops — a
teammate has to walk over it to pick it back up. The Sentinels win a round
by holding both sites, defusing a planted device, or running the clock out.

Each round opens with a 12-second buy phase, then 100 seconds of live play.
Rounds are worth $3250 to the winners and $1900 to the losers, with a $500
loss-streak bonus (max two in a row); kills pay $300. You start each match
with $800.

## The shooting

Four weapons plus grenades: the Dagger P9 sidearm (free), the Stinger-9 SMG
($1500), the AR-77 Kestrel rifle ($2700) and the Longshot-7 DMR ($4750), plus
HE grenades ($300) and Kevlar ($650). Fire is hitscan against body hitboxes
with 4× headshot damage. Recoil and spread grow when you fire on the move,
so planting your feet to aim pays off. Movement is acceleration-based with
crouching, jumping and AABB collision against the yard's containers, crates
and walls.

Nine bots fill out both teams and play the objective: per-round plans (A
push down the quay, B push down the alley, split, mid hold), holding angles,
reacting to gunfire they hear within 26 m, planting when a site is clear and
defusing when the device is down. They navigate a waypoint graph with BFS,
see through a 110° field of view, and only shoot what they have line of
sight to (segment-vs-AABB checks).

## The map

An original night terminal, 64 × 48 m: a gantry crane over site A, a
warehouse with a 6 m doorway over site B, container rows stacked up to three
high through mid, a quay lane along the harbour water, and sodium
floodlights pooling warm orange over cold blue dark. Three lanes connect the
spawns to the sites — west quay, mid container rows, east alley.

## Presentation

Procedural WebAudio for gunfire, beeps and explosions (no audio files),
pooled tracers, muzzle flash, hit sparks and a bomb explosion, and a full
HUD: health, armour, ammunition, round timer, score, money, alive counts,
killfeed and bomb status. Die and you spectate a living teammate (click to
switch between them).

## Controls

WASD move · mouse look · click fire · R reload · G throw grenade · E hold to
plant / defuse · 1–6 buy during the buy phase · Ctrl crouch · Space jump ·
C cycle spectate while dead.

## How it is built

- `game/index.html` — import map for three.js 0.187.0 (vendored byte for
  byte) and the HUD shell.
- `game/src/` — one module per job: `map` (the dock, waypoint graph and
  line-of-sight), `player` (movement and the shared AABB slide), `weapons`
  (definitions and view models), `bots` (AI: routes, perception, bursts,
  plant/defuse), `rounds` (match state machine, economy and the bomb),
  `effects` (pooled tracers, sparks, explosion), `audio` (synthesised
  sound effects), `hud` (DOM), `input` (pointer lock and keys), `main`
  (boot, fixed 60 Hz simulation, render loop).
- The simulation steps at a fixed 60 Hz, kept apart from rendering, with
  pooled vectors and effects — nothing allocates in the hot loops.
- `main.ts` copies `game/` and `screenshots/` to `/output` and writes
  `dossier.json` with the kit's `vendor/makefun-threejs.ts`.

## Screenshots

`?shot=start|play|plant|end&seed=N` stages a deterministic frame — buy
phase, mid firefight, planted device, round won — for capture; the page sets
`window.__shotReady` once the frame is painted. The four screenshots in
`screenshots/` are real renders of this code in desktop Chrome.

## Play locally

```sh
node serve.ts   # http://localhost:8080
```
