// BLACKWATER DOCK — entry point.
//
// The game runs on two clocks: a fixed 60 Hz simulation that owns all
// rules (movement, shooting, rounds, economy) and a render loop that runs
// as fast as the display allows. Splitting them keeps a match identical
// on a 60 Hz laptop and a 144 Hz monitor. Hits are hitscan: the shooter's
// ray is tested against the map meshes and the bots' head/body boxes,
// while shots at the human player use an analytic ray-vs-capsule test
// (the player has no mesh of their own).
//
// Capture mode: ?shot=start|play|plant|end&seed=N stages one deterministic
// frame, renders it twice so the GPU settles, then freezes and raises
// window.__shotReady for the screenshot driver.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { makeRng } from './rng.js';
import { createMap } from './map.js';
import { createPlayer } from './player.js';
import { createWeapons, WEAPON_DEFS, GRENADE_PRICE, KEVLAR_PRICE } from './weapons.js';
import { createBots } from './bots.js';
import { createRounds } from './rounds.js';
import { createEffects } from './effects.js';
import { createAudio } from './audio.js';
import { createHud } from './hud.js';
import { createInput } from './input.js';

// --- tunables that belong to the boot layer (the rest live in their modules)
const TICK = 1 / 60; // fixed simulation step
const MAX_SHOT_RANGE = 90; // raycaster far plane for bullets
const PLANT_SECONDS = 3.5;
const DEFUSE_SECONDS = 5;
const GRENADE_FUSE = 1.6;
const GRENADE_BLAST_RADIUS = 7;
const PICKUP_RADIUS = 1.5;
const DEFUSE_RADIUS = 1.8;
const PLAYER_CAPSULE_RADIUS = 0.35;
const PLAYER_HEIGHT = 1.7;
const HEAD_HEIGHT = 1.35; // head hit if the ray lands above this
const CARRY_BOMB_BEEP_FIRST = 1; // seconds after planting before the first beep

// --- URL parameters: capture mode and its deterministic seed
const query = new URLSearchParams(window.location.search);
const shotName = query.get('shot');
const shotSeed = Number.parseInt(query.get('seed') ?? '1', 10) || 1;
const rng = makeRng(shotSeed * 7919 + 13);

// --- renderer, scene, camera
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// three 0.187 dropped PCFSoftShadowMap; PCFShadowMap is the softest left.
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
// Fog opens at 30 m: the first capture sits 20 m out, and at that range the
// mid-yard containers were already fogging to near-black, killing depth.
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 30, 95);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

// --- subsystems (each owns one slice of the game)
const map = createMap(scene);
const effects = createEffects(scene);
const audio = createAudio();
const hud = createHud();
const player = createPlayer(map.aabbs, map.bounds);
const weapons = createWeapons(camera);
const input = createInput(renderer.domElement, handleLockChange);
const raycaster = new THREE.Raycaster();
raycaster.far = MAX_SHOT_RANGE;

// Everything a bullet can hit: map meshes first, bot hitboxes appended below.
const shootables = [...map.shootables];
// The player's body state (position/health/alive) — bots aim at this.
const me = player.state;
// In capture mode the hitmarker lingers so it is visible in the still.
const markerHoldMs = shotName ? 4000 : 90;

// --- the device: a small prop with a blinking red lamp, hidden until planted
const bombMesh = new THREE.Group();
{
  const casing = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.28, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.5, metalness: 0.5 }),
  );
  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.06, 0.06),
    new THREE.MeshStandardMaterial({
      color: 0xff2a1e, emissive: 0xff2a1e, emissiveIntensity: 2.5,
    }),
  );
  lamp.position.set(0.18, 0.17, 0);
  bombMesh.add(casing, lamp);
  bombMesh.visible = false;
  scene.add(bombMesh);
}

// --- grenades: two reusable slots, pooled so throws never allocate
const grenades = [];
for (let slot = 0; slot < 2; slot += 1) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x2e4a2e, roughness: 0.6, metalness: 0.4 }),
  );
  mesh.visible = false;
  scene.add(mesh);
  grenades.push({
    mesh, active: false,
    pos: new THREE.Vector3(), vel: new THREE.Vector3(),
    fuse: 0, bounces: 0,
  });
}
let grenadeCursor = 0;

// --- match session state (reset per round / per match where noted)
const session = {
  carryingDevice: true, // the human starts every match carrying the device
  diedLastRound: false,
  spectating: null, // bot currently followed while dead
  spectateIndex: 0,
  plantHeld: 0, // seconds E has been held toward a plant
  defuseHeld: 0, // seconds E has been held toward a defuse
  firingLastTick: false, // edge detection for semi-auto weapons
  frozen: false, // capture mode freezes the sim after the staged frame
  started: false, // true once the player has locked the pointer once
  accumulator: 0,
  lastFrame: performance.now(),
  now: performance.now() / 1000, // sim clock, seconds
  bombPos: null, // {x, z} of the planted device, or null
  nextBeepAt: 0, // when the planted device beeps next
};

// Scratch vectors so the hot path never allocates.
const aimDir = new THREE.Vector3();
const muzzlePos = new THREE.Vector3();

// --- bots -----------------------------------------------------------------
// Bots call back into main through these hooks: shooting, and everything
// to do with the device (drop / pickup / plant / defuse).
const bots = createBots(scene, map, {
  shoot(bot, origin, dir) {
    fireShot(origin, dir, bot, bot.weapon.id, false);
  },
  bombDropped(pos) {
    rounds.dropBomb(pos);
    if (session.carryingDevice) session.carryingDevice = false;
    hud.setBomb('DEVICE DROPPED — walk over it to pick it up');
  },
  bombPickedUp(bot) {
    rounds.pickupBomb();
    hud.setBomb('');
    hud.killfeed(bot.name, 'picked up the device', 'attack', false);
  },
  plantStarted(bot) {
    hud.setBomb(`${bot.name} is planting the device…`);
  },
  planted(site) {
    placeDevice(site);
  },
  defused() {
    bombMesh.visible = false;
    session.bombPos = null;
    hud.setBomb('');
  },
}, rng);
shootables.push(...bots.shootables);
bots.setPlayer(me, 'You');

// --- rounds ---------------------------------------------------------------
// The rounds module owns phase/timer/score/money; main reacts to its events.
const rounds = createRounds({
  onRoundStart(round) {
    // Died last round: respawn with the pistol only, like the bots.
    const died = session.diedLastRound;
    session.diedLastRound = false;
    session.spectating = null;
    player.reset(...Object.values(attackerSpawn()));
    if (died) weapons.resetToPistol();
    session.carryingDevice = true;
    session.plantHeld = 0;
    session.defuseHeld = 0;
    bombMesh.visible = false;
    session.bombPos = null;
    bots.spawnRound(round);
    hud.setBomb('');
    hud.setSpectate('');
    if (session.started) hud.showBuy(rounds.state.money, ownedItems());
    else hud.hideBuy();
    refreshHud();
  },
  onLiveStart(round) {
    hud.hideBuy();
    hud.showBanner(`ROUND ${round}`, 'Plant the device at A (crane) or B (warehouse)');
    refreshHud();
  },
  onRoundEnd(winner, reason) {
    const reasonText = {
      elimination: 'enemy team eliminated',
      detonation: 'device detonated',
      defuse: 'device defused',
      time: 'time expired',
    }[reason] || reason;
    hud.showBanner(
      winner === 'attack' ? 'JACKALS WIN THE ROUND' : 'SENTINELS WIN THE ROUND',
      reasonText,
    );
    if (winner === 'attack') audio.roundWin();
    else audio.roundLose();
    if (document.pointerLockElement) document.exitPointerLock();
    refreshHud();
  },
  onMatchEnd(winner, score) {
    hud.showOverlay('end', score, { winner });
    if (document.pointerLockElement) document.exitPointerLock();
  },
  onBombPlanted(site) {
    hud.setBomb(`DEVICE PLANTED AT ${site} — defend it`);
    session.nextBeepAt = session.now + CARRY_BOMB_BEEP_FIRST;
  },
  onBombExploded(site) {
    if (session.bombPos) {
      effects.explosion(
        new THREE.Vector3(session.bombPos.x, 0.6, session.bombPos.z), session.now,
      );
      audio.explosion();
      // A nearby detonation rattles the player's view.
      const dist = Math.hypot(
        me.position.x - session.bombPos.x, me.position.z - session.bombPos.z,
      );
      if (dist < 30) player.body.recoil(0.05 * (1 - dist / 30), 0);
    }
    bombMesh.visible = false;
    session.bombPos = null;
    hud.setBomb('');
  },
  onBombDefused() {
    bombMesh.visible = false;
    session.bombPos = null;
    hud.setBomb('');
  },
});

// The human always spawns at the first attacker slot, facing north.
function attackerSpawn() {
  const spawn = map.spawns.attack[0];
  return { x: spawn.x, z: spawn.z, yaw: spawn.yaw };
}

function placeDevice(site) {
  const target = site === 'A' ? map.sites.siteA : map.sites.siteB;
  session.bombPos = { x: target.x, z: target.z };
  bombMesh.position.set(target.x, 0.16, target.z);
  bombMesh.visible = true;
  rounds.plant(site, session.now);
}

// --- combat ---------------------------------------------------------------
// Analytic ray vs the player's vertical capsule (radius 0.35, 0–1.7 m).
// Returns { distance, head, point } or null when the ray misses.
function rayHitsPlayer(origin, dir, maxDist) {
  const px = me.position.x;
  const pz = me.position.z;
  const py = me.position.y;
  const dxz = dir.x * dir.x + dir.z * dir.z;
  let t;
  if (dxz < 1e-9) {
    // Ray is (near-)vertical: it hits only if it starts inside the column.
    const inside = Math.hypot(origin.x - px, origin.z - pz) <= PLAYER_CAPSULE_RADIUS;
    if (!inside) return null;
    t = 0;
  } else {
    t = -((origin.x - px) * dir.x + (origin.z - pz) * dir.z) / dxz;
    if (t < 0 || t > maxDist) return null;
  }
  const hitY = origin.y + t * dir.y;
  if (hitY < py || hitY > py + PLAYER_HEIGHT) return null;
  const hx = origin.x + t * dir.x;
  const hz = origin.z + t * dir.z;
  if (Math.hypot(hx - px, hz - pz) > PLAYER_CAPSULE_RADIUS) return null;
  return {
    distance: t,
    head: hitY > py + HEAD_HEIGHT,
    point: new THREE.Vector3(hx, hitY, hz),
  };
}

// One kill, whoever pulled the trigger: feed + reward + sound.
function recordKill(victimBody, victimName, killerName, killerTeam, headshot, byPlayer) {
  hud.killfeed(killerName, victimName, killerTeam, headshot);
  if (byPlayer) {
    rounds.addKillReward();
    audio.hitmarker(true);
  }
}

// Death bookkeeping shared by player and bot victims.
function handleDeath(victimBody, victimName, killerName, killerTeam, headshot, byPlayer) {
  recordKill(victimBody, victimName, killerName, killerTeam, headshot, byPlayer);
  if (victimBody === me) {
    session.diedLastRound = true;
    if (session.carryingDevice) {
      session.carryingDevice = false;
      rounds.dropBomb({ x: me.position.x, z: me.position.z });
      hud.setBomb('DEVICE DROPPED — a Jackal must pick it up');
    }
    if (document.pointerLockElement) document.exitPointerLock();
    session.spectating = bots.firstAliveTeammate();
    session.spectateIndex = 0;
    hud.setSpectate(session.spectating ? session.spectating.name : '');
  } else {
    const bot = bots.list.find((b) => b.body.state === victimBody);
    if (bot) bots.handleDeath(bot);
  }
  refreshHud();
}

// One hitscan shot from any shooter. `shooter` is a bot object for bot
// shots and null for the player; `isPlayer` picks the candidate set (the
// player never shoots themselves, bots never shoot each other).
function fireShot(origin, dir, shooter, weaponId, isPlayer) {
  const def = WEAPON_DEFS[weaponId];
  scene.updateMatrixWorld(true);
  raycaster.set(origin, dir);
  const candidates = isPlayer
    ? shootables
    : shootables.filter((mesh) => mesh.userData.bot !== shooter);
  const hits = raycaster.intersectObjects(candidates, false);
  const worldHit = hits.length > 0 ? hits[0] : null;
  const maxDist = worldHit ? worldHit.distance : MAX_SHOT_RANGE;

  // Bots can hit the player; the player is not a mesh in shootables.
  let playerHit = null;
  if (!isPlayer && me.alive) playerHit = rayHitsPlayer(origin, dir, maxDist);

  let endPoint = null;
  if (playerHit && (!worldHit || playerHit.distance < worldHit.distance)) {
    endPoint = playerHit.point;
    player.applyDamage(def.damage * (playerHit.head ? def.headMult : 1));
    if (!me.alive) {
      handleDeath(me, 'You', shooter.name, 'defend', playerHit.head, false);
    }
    effects.sparksAt(endPoint);
  } else if (worldHit) {
    endPoint = worldHit.point;
    const hitBot = worldHit.object.userData.bot;
    if (hitBot && hitBot.body.state.alive) {
      const head = worldHit.object.userData.part === 'head';
      hitBot.body.applyDamage(def.damage * (head ? def.headMult : 1));
      effects.sparksAt(endPoint);
      if (isPlayer) {
        hud.hitMarker(!hitBot.body.state.alive, markerHoldMs);
        audio.hitmarker(!hitBot.body.state.alive);
      }
      if (!hitBot.body.state.alive) {
        // The killer's team is the player's side when the player fired.
        const killerName = isPlayer ? 'You' : shooter.name;
        const killerTeam = isPlayer ? 'attack' : shooter.team;
        handleDeath(hitBot.body.state, hitBot.name, killerName, killerTeam, head, isPlayer);
      }
    } else {
      effects.sparksAt(endPoint, 6);
    }
  } else {
    endPoint = muzzlePos.copy(origin).addScaledVector(dir, 80);
  }

  effects.tracer(origin, endPoint, def.tracer);
  const distToPlayer = Math.hypot(
    origin.x - me.position.x, origin.z - me.position.z,
  );
  // Distant shots are quieter; every shot is heard by nearby bots.
  audio.shot(weaponId, !isPlayer && distToPlayer > 25);
  bots.hearShot(origin, isPlayer ? 'attack' : shooter.team);
}

// The player's trigger pull: rate-limit, spread, recoil, then fireShot.
function playerShoot() {
  if (!weapons.takeRound(session.now)) {
    if (weapons.state.ammo[weapons.currentId()].mag === 0) audio.dryFire();
    return;
  }
  camera.getWorldDirection(aimDir);
  // Spread grows with movement and while airborne; each shot jitters
  // independently on all three axes.
  const spread = weapons.spread(player.groundSpeed(), !me.onGround);
  aimDir.x += (rng.random() * 2 - 1) * spread;
  aimDir.y += (rng.random() * 2 - 1) * spread;
  aimDir.z += (rng.random() * 2 - 1) * spread;
  aimDir.normalize();
  weapons.muzzleWorld(muzzlePos);
  fireShot(muzzlePos, aimDir, null, weapons.currentId(), true);
  const kick = WEAPON_DEFS[weapons.currentId()].recoil;
  const pitchKick = kick * (0.9 + rng.random() * 0.2);
  const yawKick = (rng.random() * 2 - 1) * kick * 0.4;
  player.recoil(pitchKick, yawKick);
  refreshHud();
}

// --- grenades ---------------------------------------------------------------
// Throw from the camera with a slight upward arc; the pool slot cycles so
// two live grenades can exist at once.
function throwGrenade() {
  if (weapons.state.grenades <= 0 || rounds.state.phase !== 'live' || !me.alive) return;
  weapons.state.grenades -= 1;
  const slot = grenades[grenadeCursor];
  grenadeCursor = (grenadeCursor + 1) % grenades.length;
  camera.getWorldDirection(aimDir);
  slot.pos.copy(camera.position).addScaledVector(aimDir, 0.5);
  slot.vel.copy(aimDir).multiplyScalar(16);
  slot.vel.y += 2.5;
  slot.fuse = GRENADE_FUSE;
  slot.bounces = 0;
  slot.active = true;
  slot.mesh.visible = true;
  slot.mesh.position.copy(slot.pos);
  audio.grenadeThrow();
  refreshHud();
}

function stepGrenades(dt) {
  for (const g of grenades) {
    if (!g.active) continue;
    g.fuse -= dt;
    g.vel.y -= 12 * dt;
    g.pos.addScaledVector(g.vel, dt);
    bounceGrenade(g);
    clampGrenadeToYard(g);
    g.mesh.position.copy(g.pos);
    if (g.fuse <= 0) detonateGrenade(g);
  }
}

// Floor bounce: two soft bounces, then it stops dead on the ground.
function bounceGrenade(g) {
  if (g.pos.y > 0.09) return;
  g.pos.y = 0.09;
  if (Math.abs(g.vel.y) > 2 && g.bounces < 2) {
    g.vel.y = -g.vel.y * 0.35;
    g.vel.x *= 0.6;
    g.vel.z *= 0.6;
    g.bounces += 1;
  } else {
    g.vel.set(0, 0, 0);
  }
}

// Yard walls stop a grenade cold.
function clampGrenadeToYard(g) {
  g.pos.x = Math.max(map.bounds.minX + 0.1, Math.min(map.bounds.maxX - 0.1, g.pos.x));
  g.pos.z = Math.max(map.bounds.minZ + 0.1, Math.min(map.bounds.maxZ - 0.1, g.pos.z));
}

function detonateGrenade(g) {
  g.active = false;
  g.mesh.visible = false;
  effects.explosion(g.pos, session.now);
  audio.explosion();
  grenadeDamage(g.pos);
}

// Splash damage: linear falloff from 90 at the centre to 15 at the edge.
function grenadeDamage(pos) {
  const targets = [{ body: me, name: 'You', team: 'attack' }];
  for (const bot of bots.list) {
    targets.push({ body: bot.body.state, name: bot.name, team: bot.team });
  }
  for (const target of targets) {
    if (!target.body.alive) continue;
    const p = target.body.position;
    // Blast is a sphere around the grenade, measured to chest height.
    const d = Math.hypot(p.x - pos.x, p.z - pos.z, (p.y + 1) - pos.y);
    if (d > GRENADE_BLAST_RADIUS) continue;
    const damage = 15 + 75 * (1 - d / GRENADE_BLAST_RADIUS);
    target.body.applyDamage(damage);
    if (target.body.alive) continue;
    if (target.body === me) {
      handleDeath(me, 'You', 'HE grenade', 'attack', false, false);
    } else {
      const bot = bots.list.find((b) => b.body.state === target.body);
      if (bot) {
        hud.killfeed('HE grenade', bot.name, 'attack', false);
        bots.handleDeath(bot);
      }
    }
  }
  refreshHud();
}

// --- plant / defuse (player, hold E) ----------------------------------------
function stepPlantDefuse(dt) {
  if (!me.alive || rounds.state.phase !== 'live') {
    session.plantHeld = 0;
    session.defuseHeld = 0;
    return;
  }
  const holding = input.state.keys.has('KeyE');
  const p = me.position;
  if (holding && session.carryingDevice && rounds.state.bomb.state === 'carried') {
    const site = insideSite(p, map.sites.siteA)
      ? 'A'
      : insideSite(p, map.sites.siteB) ? 'B' : null;
    if (site) {
      session.plantHeld += dt;
      hud.setBomb(`PLANTING… ${Math.max(0, PLANT_SECONDS - session.plantHeld).toFixed(1)}s`);
      if (session.plantHeld >= PLANT_SECONDS) {
        session.plantHeld = 0;
        placeDevice(site);
      }
      return;
    }
  }
  if (holding && rounds.state.bomb.state === 'planted' && session.bombPos) {
    const d = Math.hypot(p.x - session.bombPos.x, p.z - session.bombPos.z);
    if (d < DEFUSE_RADIUS) {
      session.defuseHeld += dt;
      hud.setBomb(`DEFUSING… ${Math.max(0, DEFUSE_SECONDS - session.defuseHeld).toFixed(1)}s`);
      if (session.defuseHeld >= DEFUSE_SECONDS) {
        session.defuseHeld = 0;
        audio.defuseBeep();
        rounds.defuse();
      }
      return;
    }
  }
  // Holding E with no site and no device in reach just clears the hold.
  if (session.plantHeld > 0 || session.defuseHeld > 0) {
    session.plantHeld = 0;
    session.defuseHeld = 0;
    if (rounds.state.bomb.state === 'planted') {
      hud.setBomb(`DEVICE PLANTED — ${Math.ceil(rounds.bombTimeLeft(session.now))}s`);
    } else {
      hud.setBomb('');
    }
  }
  // Pick up a dropped device by walking over it.
  if (rounds.state.bomb.state === 'dropped' && rounds.state.bomb.pos) {
    const d = Math.hypot(
      p.x - rounds.state.bomb.pos.x, p.z - rounds.state.bomb.pos.z,
    );
    if (d >= PICKUP_RADIUS) return;
    rounds.pickupBomb();
    session.carryingDevice = true;
    hud.setBomb('');
    hud.killfeed('You', 'picked up the device', 'attack', false);
  }
}

function insideSite(p, site) {
  return Math.hypot(p.x - site.x, p.z - site.z) <= site.r;
}

// --- HUD ----------------------------------------------------------------------
// One place that pushes the whole sim state into the HUD every tick.
function refreshHud() {
  const ammo = weapons.state.ammo[weapons.currentId()];
  const weaponName = WEAPON_DEFS[weapons.currentId()].name;
  hud.setHealth(me.health, me.armor);
  hud.setAmmo(ammo.mag, ammo.reserve, weaponName);
  hud.setMoney(rounds.state.money);
  hud.setScore(
    rounds.state.score.attack, rounds.state.score.defend, rounds.state.round,
  );
  const attackAlive = (me.alive ? 1 : 0) + bots.aliveCount('attack');
  hud.setAlive(attackAlive, bots.aliveCount('defend'));
  if (rounds.state.phase === 'buy') {
    hud.setTimer(rounds.state.timer, 'buy');
  } else if (rounds.state.bomb.state === 'planted') {
    hud.setTimer(rounds.bombTimeLeft(session.now), 'live');
  } else {
    hud.setTimer(rounds.state.timer, rounds.state.phase);
  }
}

// --- input ----------------------------------------------------------------------
// Pointer lock is the game's start button: locking hides the overlay and
// (re)opens the buy menu; unlocking pauses unless the match is over.
function handleLockChange(locked) {
  if (shotName) return;
  if (locked) {
    session.started = true;
    hud.hideOverlay();
    audio.unlock();
    if (rounds.state.phase === 'buy') {
      hud.showBuy(rounds.state.money, ownedItems());
    }
    return;
  }
  if (rounds.state.phase !== 'matchEnd') {
    hud.showOverlay(session.started ? 'paused' : 'start', rounds.state.score);
  }
}

hud.onPlay(() => {
  if (shotName) return;
  audio.unlock();
  if (rounds.state.phase === 'matchEnd') {
    rounds.startMatch();
    resetMatch();
  }
  input.requestLock();
});

window.addEventListener('keydown', (event) => {
  if (event.repeat || shotName) return;
  if (event.code === 'KeyG') throwGrenade();
  if (event.code === 'KeyR' && me.alive) {
    if (weapons.reload(session.now)) audio.reload();
  }
  if (rounds.state.phase === 'buy' && me.alive) buyKey(event.code);
  // Spectate cycling while dead.
  if (!me.alive && event.code === 'KeyC') cycleSpectate();
});

document.addEventListener('mousedown', () => {
  if (!me.alive && rounds.state.phase === 'live') cycleSpectate();
});

// Buy keys 1–6 during the buy phase. weapons.buy gets the pre-spend wallet
// (rounds.spend already deducted the price) so its affordability check
// sees the money the player had before buying.
function buyKey(code) {
  const buyIndex = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].indexOf(code);
  if (buyIndex < 0) return;
  const id = ['dagger', 'stinger', 'kestrel', 'longshot', 'grenade', 'kevlar'][buyIndex];
  const price = id === 'kevlar'
    ? KEVLAR_PRICE
    : id === 'grenade' ? GRENADE_PRICE : WEAPON_DEFS[id].price;
  if (rounds.spend(price)) {
    if (id === 'kevlar') {
      me.armor = 100;
    } else {
      weapons.buy(id, rounds.state.money + price);
    }
    hud.showBuy(rounds.state.money, ownedItems());
    refreshHud();
  }
}

function cycleSpectate() {
  const alive = bots.list.filter((b) => b.team === 'attack' && b.body.state.alive);
  if (alive.length === 0) return;
  session.spectateIndex = (session.spectateIndex + 1) % alive.length;
  session.spectating = alive[session.spectateIndex];
  hud.setSpectate(session.spectating.name);
}

// What the buy menu marks as owned (dagger is always owned).
function ownedItems() {
  const owned = ['dagger'];
  for (const id of ['stinger', 'kestrel', 'longshot']) {
    if (weapons.hasWeapon(id)) owned.push(id);
  }
  if (weapons.state.grenades > 0) owned.push('grenade');
  if (me.armor > 0) owned.push('kevlar');
  return owned;
}

// --- simulation -----------------------------------------------------------------
// One fixed step: rounds, player, weapons, bots, grenades, effects, beeps.
function tick(dt) {
  session.now = performance.now() / 1000;
  const alive = {
    attack: (me.alive ? 1 : 0) + bots.aliveCount('attack'),
    defend: bots.aliveCount('defend'),
  };
  rounds.step(dt, session.now, alive);

  if (me.alive) {
    player.step(dt, input.state.keys);
    const look = input.takeLook();
    player.look(look.x, look.y);
    const firing = input.state.firing && rounds.state.phase === 'live';
    const def = WEAPON_DEFS[weapons.currentId()];
    // Semi-auto weapons fire on the trigger edge, not while held.
    if (firing && (def.auto || !session.firingLastTick)) playerShoot();
    session.firingLastTick = input.state.firing;
    if (input.state.keys.has('KeyR') && weapons.reload(session.now)) {
      audio.reload();
    }
    stepPlantDefuse(dt);
  }

  weapons.step(dt, session.now, player.groundSpeed());
  stepBots(dt);
  stepGrenades(dt);
  effects.step(session.now, dt);
  stepBombBeeps();
  refreshHud();
}

// Bots get the round phase and the device state each tick.
function stepBots(dt) {
  bots.step(dt, session.now, {
    phase: rounds.state.phase,
    bomb: {
      state: rounds.state.bomb.state,
      site: rounds.state.bomb.site,
      pos: session.bombPos || rounds.state.bomb.pos,
    },
  });
}

// The planted device beeps faster in its last ten seconds.
function stepBombBeeps() {
  if (rounds.state.bomb.state !== 'planted') return;
  const left = rounds.bombTimeLeft(session.now);
  if (session.now >= session.nextBeepAt) {
    audio.bombBeep();
    session.nextBeepAt = session.now + (left <= 10 ? 0.5 : 1);
  }
  hud.setBomb(`DEVICE PLANTED — ${Math.ceil(left)}s`);
}

// Camera follows the player's eye (with recoil), or the spectated bot's.
function syncCamera() {
  if (me.alive) {
    camera.position.set(me.position.x, me.position.y + me.eye, me.position.z);
    camera.rotation.set(
      me.pitch + me.recoilPitch, me.yaw + me.recoilYaw, 0, 'YXZ',
    );
    return;
  }
  const target = session.spectating;
  if (!target || !target.body.state.alive) return;
  const tp = target.body.state.position;
  camera.position.set(tp.x, tp.y + target.body.state.eye, tp.z);
  camera.rotation.set(target.body.state.pitch, target.body.state.yaw, 0, 'YXZ');
}

// The frame loop: accumulate real time and run fixed steps (at most five
// per frame, so a hitch never spirals), then render once.
function frame(frameNow) {
  requestAnimationFrame(frame);
  const dt = Math.min((frameNow - session.lastFrame) / 1000, 0.1);
  session.lastFrame = frameNow;
  session.now = performance.now() / 1000;
  if (!session.frozen) {
    session.accumulator += dt;
    let steps = 0;
    while (session.accumulator >= TICK && steps < 5) {
      tick(TICK);
      session.accumulator -= TICK;
      steps += 1;
    }
    // A long hitch leaves stale time behind rather than replaying it.
    if (session.accumulator > TICK * 5) session.accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function resetMatch() {
  weapons.resetToPistol();
  player.reset(...Object.values(attackerSpawn()));
  rounds.startMatch();
  hud.hideOverlay();
  refreshHud();
}

// --- capture staging ------------------------------------------------------------
// Run N fixed steps without rendering (used to settle a staged shot).
function settle(steps) {
  for (let i = 0; i < steps; i += 1) tick(TICK);
}

// Point the player's view at a world point (used by the staged shots).
function aimAt(point) {
  const dx = point.x - me.position.x;
  const dy = point.y - (me.position.y + me.eye);
  const dz = point.z - me.position.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  // Yaw turns around Y; pitch is clamped so the view never flips over.
  me.yaw = Math.atan2(-dx, -dz);
  me.pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
  syncCamera();
}

// Stage one of the four dossier screenshots, then freeze on a double-painted
// frame and raise window.__shotReady.
function runShot(name) {
  hud.hideOverlay();
  me.pitch = 0;
  me.yaw = 0;
  rounds.startMatch();
  if (name === 'start') stageStart();
  else if (name === 'play') stagePlay();
  else if (name === 'plant') stagePlant();
  else stageEnd();
  refreshHud();
  paintTwiceThenReady();
}

// Buy phase at attacker spawn, looking north down mid.
function stageStart() {
  me.position.set(0, 0, 20);
  me.yaw = 0;
  settle(20);
  hud.showBuy(rounds.state.money, ownedItems());
  hud.showOverlay('start', rounds.state.score);
}

// Live firefight: a Sentinel holds mid, the player drops him.
function stagePlay() {
  rounds.state.phase = 'live';
  rounds.state.timer = 90;
  const guard = bots.list.find((b) => b.team === 'defend');
  // (-6, -2): the sim test proves this lane from (0, 10) is clear of the
  // booth and the container rows; (0, -6) sits behind the booth.
  guard.body.state.position.set(-6, 0, -2);
  guard.body.state.yaw = Math.PI * 0.75;
  guard.state = 'hold';
  guard.holdPos = { x: -6, z: -2 };
  // Staging only: he must not shoot back mid-shot.
  guard.perceiveAt = 1e9;
  me.position.set(0, 0, 10);
  weapons.equip('kestrel');
  settle(20);
  const chest = { x: -6, y: 1.2, z: -2 };
  aimAt(chest);
  playerShoot();
  settle(12);
  aimAt(chest);
  playerShoot();
}

// Device planted at A; the player covers the crane site.
function stagePlant() {
  rounds.state.phase = 'live';
  rounds.state.timer = 60;
  me.position.set(-14, 0, -8);
  settle(10);
  placeDevice('A');
  settle(10);
  aimAt({ x: -22, y: 1.4, z: -15 });
}

// Round won: Jackals 8-3, end overlay up.
function stageEnd() {
  rounds.state.phase = 'live';
  rounds.state.score = { attack: 7, defend: 3 };
  me.position.set(0, 0, 0);
  settle(20);
  rounds.forceEnd('attack', 'elimination');
  hud.showOverlay('end', rounds.state.score, { winner: 'attack' });
  aimAt({ x: -22, y: 1.5, z: -15 });
}

// Render twice (the GPU settles), then freeze the sim and signal the driver.
// Render twice so the GPU settles, then freeze the sim and signal the driver.
function paintTwiceThenReady() {
  let painted = 0;
  function paintOneMore() {
    requestAnimationFrame(paintOneMore);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted < 2) return;
    window.__shotReady = true;
    session.frozen = true;
  }
  requestAnimationFrame(paintOneMore);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Debug handle for play-tests: state, bots, rounds, map.
window.__game = {
  get phase() {
    return rounds.state.phase;
  },
  get round() {
    return rounds.state.round;
  },
  get score() {
    return { ...rounds.state.score };
  },
  get money() {
    return rounds.state.money;
  },
  get bomb() {
    return { ...rounds.state.bomb };
  },
  get playerAlive() {
    return me.alive;
  },
  get playerPos() {
    return { x: me.position.x, y: me.position.y, z: me.position.z };
  },
  get playerYaw() {
    return me.yaw;
  },
  get playerHealth() {
    return me.health;
  },
  bots: bots.list,
  player,
  rounds,
  weapons,
};

// --- boot -----------------------------------------------------------------------
// The buy menu shows during the buy phase even before pointer lock.
syncCamera();
refreshHud();
if (rounds.state.phase === 'buy') hud.showBuy(rounds.state.money, ownedItems());
if (shotName) {
  runShot(shotName);
} else {
  rounds.startMatch();
  hud.showOverlay('start', rounds.state.score);
  requestAnimationFrame(frame);
}
