# BLACKWATER DOCK

A 5v5 plant/defuse tactical FPS in three.js, built for the make.fun
`threejs-fps-01` bounty. Two teams of five fight over a harbour container
yard at night. The Jackals attack, the Sentinels defend, and the first
team to 8 rounds takes the match — 15 rounds max, 7–7 is a draw.

## A match, minute by minute

You are a Jackal, and you carry the device from the start of every round.
Plant it at site A (the gantry crane) or site B (the warehouse), or wipe
out the Sentinels. If you die while carrying it, the device drops where
you fell and a teammate has to walk over it to pick it back up. The
Sentinels take a round by holding both sites, defusing a planted device,
or running the clock out.

Every round opens with a 12-second buy phase, then 100 seconds of live
play. A round win pays $3250, a loss $1900, with a $500 loss-streak bonus
(max two in a row); every kill pays $300. Each match starts you on $800.

## Guns, money, and movement

The armoury is four weapons plus grenades: the Dagger P9 sidearm (free),
the Stinger-9 SMG ($1500), the AR-77 Kestrel rifle ($2700), the
Longshot-7 DMR ($4750), HE grenades ($300) and Kevlar ($650). Fire is
hitscan against body hitboxes, with 4× damage on a headshot. Recoil and
spread both grow when you shoot on the move, so planting your feet to
aim pays off. Movement is acceleration-based — crouch, jump, and AABB
collision against the yard's containers, crates and walls.

## The other nine players

Nine bots fill both teams and play the objective, not just the frags.
Each round they pick a plan — A push down the quay, B push down the
alley, a split, or a mid hold — then hold angles, react to gunfire they
hear within 26 m, plant when a site is clear, and defuse when the device
is down. They route over a waypoint graph with BFS, see through a 110°
field of view, and only shoot what they have line of sight to
(segment-vs-AABB checks, no raycasts in the hot loop).

## The yard

An original night terminal, 64 × 48 m: a gantry crane over site A, a
warehouse with a 6 m doorway over site B, container rows stacked up to
three high through mid, a quay lane along the harbour water, and sodium
floodlights pooling warm orange over cold blue dark. Three lanes connect
the spawns to the sites — west quay, mid container rows, east alley.

## Look and sound

All sound is procedural WebAudio — gunfire, beeps, explosions — with no
audio files. The visuals are pooled tracers, muzzle flash, hit sparks and
a bomb explosion, plus a full HUD: health, armour, ammunition, round
timer, score, money, alive counts, killfeed and bomb status. Die and you
spectate a living teammate; click to switch between them.

## Controls

| Input | Does |
| --- | --- |
| WASD | Move |
| Mouse | Look |
| Click | Fire |
| R | Reload |
| G | Throw grenade |
| E (hold) | Plant / defuse |
| 1–6 | Buy during the buy phase |
| Ctrl | Crouch |
| Space | Jump |
| C | Cycle spectate while dead |

## Under the hood

- `game/index.html` — the HUD shell and the import map for three.js
  0.187.0, vendored byte for byte.
- `game/src/` — one module per job: `map` (the dock, waypoint graph and
  line-of-sight), `player` (movement and the shared AABB slide),
  `weapons` (definitions and view models), `bots` (AI: routes,
  perception, bursts, plant/defuse), `rounds` (match state machine,
  economy and the bomb), `effects` (pooled tracers, sparks, explosion),
  `audio` (synthesised sound effects), `hud` (DOM), `input` (pointer
  lock and keys), `main` (boot, the fixed 60 Hz simulation, the render
  loop, and the screenshot staging).
- The simulation steps at a fixed 60 Hz, kept apart from rendering, with
  pooled vectors and effects — nothing allocates in the hot loops.
- `main.ts` copies `game/` and `screenshots/` to `/output` and writes
  `dossier.json` with the kit's `vendor/makefun-threejs.ts`.

## Screenshots

`?shot=start|play|plant|end&seed=N` stages a deterministic frame — buy
phase, mid firefight, planted device, round won — for capture; the page
sets `window.__shotReady` once the frame is painted. The four screenshots
in `screenshots/` are real renders of this code in desktop Chrome.

## Play locally

```sh
node serve.ts   # http://localhost:8080
```
