// BLACKWATER DOCK — boot and the one loop.
// A fixed 60 Hz simulation feeds a render at the display's rate; the two are
// kept apart so the game plays the same on any refresh rate. Shooting is
// hitscan raycasts against the map and the bots' head/body boxes; the player
// is hit by an analytic ray-vs-capsule test. ?shot=start|play|plant|end
// with &seed=N stages a deterministic frame for capture, renders it twice,
// then freezes it and sets window.__shotReady.
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

const FIXED_STEP = 1 / 60;
const params = new URLSearchParams(window.location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;
const rng = makeRng(seed * 7919 + 13);

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
// three 0.187 removed PCFSoftShadowMap; PCFShadowMap is the softest it offers.
renderer.shadowMap.type = THREE.PCFShadowMap;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
// Fog starts further out than the first capture's 20 m: at 20 m the mid
// containers were already fogged to near-black and the yard lost its depth.
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 30, 95);
const camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.05, 160);
scene.add(camera);

const map = createMap(scene);
const effects = createEffects(scene);
const audio = createAudio();
const hud = createHud();
const player = createPlayer(map.aabbs, map.bounds);
const weapons = createWeapons(camera);
const input = createInput(renderer.domElement, onLockChange);
const raycaster = new THREE.Raycaster();
raycaster.far = 90;

const shootables = [...map.shootables];
const body = player.state;
const markerHoldMs = shot ? 4000 : 90;

// --- bomb ---------------------------------------------------------------
const bombMesh = new THREE.Group();
{
  const bombBody = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.28, 0.34),
    new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.5, metalness: 0.5 }),
  );
  const bombLight = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.06, 0.06),
    new THREE.MeshStandardMaterial({
      color: 0xff2a1e, emissive: 0xff2a1e, emissiveIntensity: 2.5,
    }),
  );
  bombLight.position.set(0.18, 0.17, 0);
  bombMesh.add(bombBody, bombLight);
  bombMesh.visible = false;
  scene.add(bombMesh);
}
let bombPos = null;
let bombBeepAt = 0;

// --- grenades -----------------------------------------------------------
const grenades = [];
for (let i = 0; i < 2; i += 1) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x2e4a2e, roughness: 0.6, metalness: 0.4 }),
  );
  mesh.visible = false;
  scene.add(mesh);
  grenades.push({ mesh, active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), fuse: 0, bounces: 0 });
}
let grenadeNext = 0;

// --- match state ----------------------------------------------------------
let playerIsCarrier = true;
let playerDiedThisRound = false;
let spectateTarget = null;
let spectateIndex = 0;
let plantProgress = 0;
let defuseProgress = 0;
let prevFiring = false;
let frozen = false;
let started = false;
let accumulator = 0;
let lastTime = performance.now();
let now = performance.now() / 1000;

const bots = createBots(scene, map, {
  shoot(bot, origin, dir) {
    shootFrom(origin, dir, bot, bot.weapon.id, false);
  },
  bombDropped(pos) {
    rounds.dropBomb(pos);
    if (playerIsCarrier) playerIsCarrier = false;
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
    placeBomb(site);
  },
  defused() {
    bombMesh.visible = false;
    bombPos = null;
    hud.setBomb('');
  },
}, rng);
shootables.push(...bots.shootables);
bots.setPlayer(body, 'You');

const rounds = createRounds({
  onRoundStart(round) {
    // Died last round: respawn with the pistol only, like the bots.
    const died = playerDiedThisRound;
    playerDiedThisRound = false;
    spectateTarget = null;
    player.reset(...Object.values(pickSpawn()));
    if (died) weapons.resetToPistol();
    playerIsCarrier = true;
    plantProgress = 0;
    defuseProgress = 0;
    bombMesh.visible = false;
    bombPos = null;
    bots.spawnRound(round);
    hud.setBomb('');
    hud.setSpectate('');
    if (started) hud.showBuy(rounds.state.money, ownedList());
    else hud.hideBuy();
    updateHud();
  },
  onLiveStart(round) {
    hud.hideBuy();
    hud.showBanner(`ROUND ${round}`, 'Plant the device at A (crane) or B (warehouse)');
    updateHud();
  },
  onRoundEnd(winner, reason, score) {
    const reasonText = { elimination: 'enemy team eliminated', detonation: 'device detonated', defuse: 'device defused', time: 'time expired' }[reason] || reason;
    hud.showBanner(
      winner === 'attack' ? 'JACKALS WIN THE ROUND' : 'SENTINELS WIN THE ROUND',
      reasonText,
    );
    if (winner === 'attack') audio.roundWin();
    else audio.roundLose();
    if (document.pointerLockElement) document.exitPointerLock();
    updateHud();
  },
  onMatchEnd(winner, score) {
    hud.showOverlay('end', score, { winner });
    if (document.pointerLockElement) document.exitPointerLock();
  },
  onBombPlanted(site) {
    hud.setBomb(`DEVICE PLANTED AT ${site} — defend it`);
    bombBeepAt = now + 1;
  },
  onBombExploded(site) {
    if (bombPos) {
      effects.explosion(new THREE.Vector3(bombPos.x, 0.6, bombPos.z), now);
      audio.explosion();
      const d = Math.hypot(body.position.x - bombPos.x, body.position.z - bombPos.z);
      if (d < 30) player.body.recoil(0.05 * (1 - d / 30), 0);
    }
    bombMesh.visible = false;
    bombPos = null;
    hud.setBomb('');
  },
  onBombDefused() {
    bombMesh.visible = false;
    bombPos = null;
    hud.setBomb('');
  },
});

function pickSpawn() {
  const spawn = map.spawns.attack[0];
  return { x: spawn.x, z: spawn.z, yaw: spawn.yaw };
}

function placeBomb(site) {
  const s = site === 'A' ? map.sites.siteA : map.sites.siteB;
  bombPos = { x: s.x, z: s.z };
  bombMesh.position.set(s.x, 0.16, s.z);
  bombMesh.visible = true;
  rounds.plant(site, now);
}

// --- shooting -------------------------------------------------------------
const tmpDir = new THREE.Vector3();
const tmpOrigin = new THREE.Vector3();

function rayHitsPlayer(origin, dir, maxDist) {
  // Analytic ray vs the player's vertical capsule (radius 0.35, 0..1.7 m).
  const px = body.position.x;
  const pz = body.position.z;
  const py = body.position.y;
  const dxz = dir.x * dir.x + dir.z * dir.z;
  let t;
  if (dxz < 1e-9) {
    if (Math.hypot(origin.x - px, origin.z - pz) > 0.35) return null;
    t = 0;
  } else {
    t = -((origin.x - px) * dir.x + (origin.z - pz) * dir.z) / dxz;
    if (t < 0 || t > maxDist) return null;
  }
  const hitY = origin.y + t * dir.y;
  if (hitY < py || hitY > py + 1.7) return null;
  const hx = origin.x + t * dir.x;
  const hz = origin.z + t * dir.z;
  if (Math.hypot(hx - px, hz - pz) > 0.35) return null;
  return { distance: t, head: hitY > py + 1.35, point: new THREE.Vector3(hx, hitY, hz) };
}

function applyKill(victimBody, victimName, killerName, killerTeam, headshot, killerIsPlayer) {
  hud.killfeed(killerName, victimName, killerTeam, headshot);
  if (killerIsPlayer) {
    rounds.addKillReward();
    audio.hitmarker(true);
  }
}

function handleDeath(victimBody, victimName, killerName, killerTeam, headshot, killerIsPlayer) {
  applyKill(victimBody, victimName, killerName, killerTeam, headshot, killerIsPlayer);
  if (victimBody === body) {
    playerDiedThisRound = true;
    if (playerIsCarrier) {
      playerIsCarrier = false;
      rounds.dropBomb({ x: body.position.x, z: body.position.z });
      hud.setBomb('DEVICE DROPPED — a Jackal must pick it up');
    }
    if (document.pointerLockElement) document.exitPointerLock();
    spectateTarget = bots.firstAliveTeammate();
    spectateIndex = 0;
    hud.setSpectate(spectateTarget ? spectateTarget.name : '');
  } else {
    const bot = bots.list.find((b) => b.body.state === victimBody);
    if (bot) bots.handleDeath(bot);
  }
  updateHud();
}

function shootFrom(origin, dir, shooter, weaponId, isPlayer) {
  const def = WEAPON_DEFS[weaponId];
  scene.updateMatrixWorld(true);
  raycaster.set(origin, dir);
  const candidates = isPlayer
    ? shootables
    : shootables.filter((mesh) => mesh.userData.bot !== shooter);
  const hits = raycaster.intersectObjects(candidates, false);
  const worldHit = hits.length > 0 ? hits[0] : null;
  const maxDist = worldHit ? worldHit.distance : 90;

  // Bots can hit the player; the player is not a mesh in shootables.
  let playerHit = null;
  if (!isPlayer && body.alive) playerHit = rayHitsPlayer(origin, dir, maxDist);

  let endPoint = null;
  if (playerHit && (!worldHit || playerHit.distance < worldHit.distance)) {
    endPoint = playerHit.point;
    player.applyDamage(def.damage * (playerHit.head ? def.headMult : 1));
    if (!body.alive) {
      handleDeath(body, 'You', shooter.name, 'defend', playerHit.head, false);
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
        handleDeath(hitBot.body.state, hitBot.name, isPlayer ? 'You' : shooter.name, isPlayer ? 'attack' : shooter.team, head, isPlayer);
      }
    } else {
      effects.sparksAt(endPoint, 6);
    }
  } else {
    endPoint = tmpOrigin.copy(origin).addScaledVector(dir, 80);
  }

  effects.tracer(origin, endPoint, def.tracer);
  const distToPlayer = Math.hypot(origin.x - body.position.x, origin.z - body.position.z);
  audio.shot(weaponId, !isPlayer && distToPlayer > 25);
  if (!isPlayer) bots.hearShot(origin, shooter.team);
  else bots.hearShot(origin, 'attack');
}

function playerShoot() {
  if (!weapons.takeRound(now)) {
    if (weapons.state.ammo[weapons.currentId()].mag === 0) audio.dryFire();
    return;
  }
  camera.getWorldDirection(tmpDir);
  const spread = weapons.spread(player.groundSpeed(), !body.onGround);
  tmpDir.x += (rng.random() * 2 - 1) * spread;
  tmpDir.y += (rng.random() * 2 - 1) * spread;
  tmpDir.z += (rng.random() * 2 - 1) * spread;
  tmpDir.normalize();
  weapons.muzzleWorld(tmpOrigin);
  shootFrom(tmpOrigin, tmpDir, null, weapons.currentId(), true);
  player.recoil(
    WEAPON_DEFS[weapons.currentId()].recoil * (0.9 + rng.random() * 0.2),
    (rng.random() * 2 - 1) * WEAPON_DEFS[weapons.currentId()].recoil * 0.4,
  );
  updateHud();
}

// --- grenades ---------------------------------------------------------------
function throwGrenade() {
  if (weapons.state.grenades <= 0 || rounds.state.phase !== 'live' || !body.alive) return;
  weapons.state.grenades -= 1;
  const slot = grenades[grenadeNext];
  grenadeNext = (grenadeNext + 1) % grenades.length;
  camera.getWorldDirection(tmpDir);
  slot.pos.copy(camera.position).addScaledVector(tmpDir, 0.5);
  slot.vel.copy(tmpDir).multiplyScalar(16);
  slot.vel.y += 2.5;
  slot.fuse = 1.6;
  slot.bounces = 0;
  slot.active = true;
  slot.mesh.visible = true;
  slot.mesh.position.copy(slot.pos);
  audio.grenadeThrow();
  updateHud();
}

function stepGrenades(dt) {
  for (const g of grenades) {
    if (!g.active) continue;
    g.fuse -= dt;
    g.vel.y -= 12 * dt;
    g.pos.addScaledVector(g.vel, dt);
    if (g.pos.y <= 0.09) {
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
    // Yard walls stop it cold.
    g.pos.x = Math.max(map.bounds.minX + 0.1, Math.min(map.bounds.maxX - 0.1, g.pos.x));
    g.pos.z = Math.max(map.bounds.minZ + 0.1, Math.min(map.bounds.maxZ - 0.1, g.pos.z));
    g.mesh.position.copy(g.pos);
    if (g.fuse <= 0) {
      g.active = false;
      g.mesh.visible = false;
      effects.explosion(g.pos, now);
      audio.explosion();
      explodeDamage(g.pos);
    }
  }
}

function explodeDamage(pos) {
  const targets = [{ body: body, name: 'You', team: 'attack' }];
  for (const bot of bots.list) targets.push({ body: bot.body.state, name: bot.name, team: bot.team });
  for (const target of targets) {
    if (!target.body.alive) continue;
    const p = target.body.position;
    const d = Math.hypot(p.x - pos.x, p.z - pos.z, (p.y + 1) - pos.y);
    if (d > 7) continue;
    const damage = 15 + 75 * (1 - d / 7);
    target.body.applyDamage(damage);
    if (!target.body.alive) {
      const killerName = 'HE grenade';
      if (target.body === body) handleDeath(body, 'You', killerName, 'attack', false, false);
      else {
        const bot = bots.list.find((b) => b.body.state === target.body);
        if (bot) {
          hud.killfeed(killerName, bot.name, 'attack', false);
          bots.handleDeath(bot);
        }
      }
    }
  }
  updateHud();
}

// --- plant / defuse (player) --------------------------------------------------
function stepPlantDefuse(dt) {
  if (!body.alive || rounds.state.phase !== 'live') {
    plantProgress = 0;
    defuseProgress = 0;
    return;
  }
  const holding = input.state.keys.has('KeyE');
  const p = body.position;
  if (holding && playerIsCarrier && rounds.state.bomb.state === 'carried') {
    const site = inSite(p, map.sites.siteA) ? 'A' : inSite(p, map.sites.siteB) ? 'B' : null;
    if (site) {
      plantProgress += dt;
      hud.setBomb(`PLANTING… ${Math.max(0, 3.5 - plantProgress).toFixed(1)}s`);
      if (plantProgress >= 3.5) {
        plantProgress = 0;
        placeBomb(site);
      }
      return;
    }
  }
  if (holding && rounds.state.bomb.state === 'planted' && bombPos) {
    const d = Math.hypot(p.x - bombPos.x, p.z - bombPos.z);
    if (d < 1.8) {
      defuseProgress += dt;
      hud.setBomb(`DEFUSING… ${Math.max(0, 5 - defuseProgress).toFixed(1)}s`);
      if (defuseProgress >= 5) {
        defuseProgress = 0;
        audio.defuseBeep();
        rounds.defuse();
      }
      return;
    }
  }
  if (plantProgress > 0 || defuseProgress > 0) {
    plantProgress = 0;
    defuseProgress = 0;
    if (rounds.state.bomb.state === 'planted') hud.setBomb(`DEVICE PLANTED — ${Math.ceil(rounds.bombTimeLeft(now))}s`);
    else hud.setBomb('');
  }
  // Pick up a dropped device by walking over it.
  if (rounds.state.bomb.state === 'dropped' && rounds.state.bomb.pos) {
    const d = Math.hypot(p.x - rounds.state.bomb.pos.x, p.z - rounds.state.bomb.pos.z);
    if (d < 1.5) {
      rounds.pickupBomb();
      playerIsCarrier = true;
      hud.setBomb('');
      hud.killfeed('You', 'picked up the device', 'attack', false);
    }
  }
}

function inSite(p, site) {
  return Math.hypot(p.x - site.x, p.z - site.z) <= site.r;
}

// --- HUD ----------------------------------------------------------------------
function updateHud() {
  const ammo = weapons.state.ammo[weapons.currentId()];
  hud.setHealth(body.health, body.armor);
  hud.setAmmo(ammo.mag, ammo.reserve, WEAPON_DEFS[weapons.currentId()].name);
  hud.setMoney(rounds.state.money);
  hud.setScore(rounds.state.score.attack, rounds.state.score.defend, rounds.state.round);
  const attackAlive = (body.alive ? 1 : 0) + bots.aliveCount('attack');
  hud.setAlive(attackAlive, bots.aliveCount('defend'));
  if (rounds.state.phase === 'buy') hud.setTimer(rounds.state.timer, 'buy');
  else if (rounds.state.bomb.state === 'planted') hud.setTimer(rounds.bombTimeLeft(now), 'live');
  else hud.setTimer(rounds.state.timer, rounds.state.phase);
}

// --- input callbacks ------------------------------------------------------------
function onLockChange(locked) {
  if (shot) return;
  if (locked) {
    started = true;
    hud.hideOverlay();
    audio.unlock();
    if (rounds.state.phase === 'buy') hud.showBuy(rounds.state.money, ownedList());
  } else if (rounds.state.phase !== 'matchEnd') {
    hud.showOverlay(started ? 'paused' : 'start', rounds.state.score);
  }
}

hud.onPlay(() => {
  if (shot) return;
  audio.unlock();
  if (rounds.state.phase === 'matchEnd') {
    rounds.startMatch();
    resetMatch();
  }
  input.requestLock();
});

window.addEventListener('keydown', (event) => {
  if (event.repeat || shot) return;
  if (event.code === 'KeyG') throwGrenade();
  if (event.code === 'KeyR' && body.alive) {
    if (weapons.reload(now)) audio.reload();
  }
  if (rounds.state.phase === 'buy' && body.alive) {
    const buyIndex = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6'].indexOf(event.code);
    if (buyIndex >= 0) {
      const id = ['dagger', 'stinger', 'kestrel', 'longshot', 'grenade', 'kevlar'][buyIndex];
      const price = id === 'kevlar' ? KEVLAR_PRICE : id === 'grenade' ? GRENADE_PRICE : WEAPON_DEFS[id].price;
      if (rounds.spend(price)) {
        if (id === 'kevlar') {
          body.armor = 100;
        } else {
          weapons.buy(id, rounds.state.money + price);
        }
        hud.showBuy(rounds.state.money, ownedList());
        updateHud();
      }
    }
  }
  // Spectate cycling while dead.
  if (!body.alive && event.code === 'KeyC') cycleSpectate();
});

document.addEventListener('mousedown', () => {
  if (!body.alive && rounds.state.phase === 'live') cycleSpectate();
});

function cycleSpectate() {
  const alive = bots.list.filter((b) => b.team === 'attack' && b.body.state.alive);
  if (alive.length === 0) return;
  spectateIndex = (spectateIndex + 1) % alive.length;
  spectateTarget = alive[spectateIndex];
  hud.setSpectate(spectateTarget.name);
}

function ownedList() {
  const owned = ['dagger'];
  for (const id of ['stinger', 'kestrel', 'longshot']) {
    if (weapons.hasWeapon(id)) owned.push(id);
  }
  if (weapons.state.grenades > 0) owned.push('grenade');
  if (body.armor > 0) owned.push('kevlar');
  return owned;
}

// --- simulation -----------------------------------------------------------------
function step(dt) {
  now = performance.now() / 1000;
  const alive = {
    attack: (body.alive ? 1 : 0) + bots.aliveCount('attack'),
    defend: bots.aliveCount('defend'),
  };
  rounds.step(dt, now, alive);

  if (body.alive) {
    player.step(dt, input.state.keys);
    const look = input.takeLook();
    player.look(look.x, look.y);
    const firing = input.state.firing && rounds.state.phase === 'live';
    const def = WEAPON_DEFS[weapons.currentId()];
    if (firing && (def.auto || !prevFiring)) playerShoot();
    prevFiring = input.state.firing;
    if (input.state.keys.has('KeyR')) {
      if (weapons.reload(now)) audio.reload();
    }
    stepPlantDefuse(dt);
  }

  weapons.step(dt, now, player.groundSpeed());
  bots.step(dt, now, {
    phase: rounds.state.phase,
    bomb: {
      state: rounds.state.bomb.state,
      site: rounds.state.bomb.site,
      pos: bombPos || rounds.state.bomb.pos,
    },
  });
  stepGrenades(dt);
  effects.step(now, dt);

  // Bomb beeps accelerate in the last ten seconds.
  if (rounds.state.bomb.state === 'planted') {
    const left = rounds.bombTimeLeft(now);
    if (now >= bombBeepAt) {
      audio.bombBeep();
      bombBeepAt = now + (left <= 10 ? 0.5 : 1);
    }
    hud.setBomb(`DEVICE PLANTED — ${Math.ceil(left)}s`);
  }
  updateHud();
}

function syncCamera() {
  if (body.alive) {
    camera.position.set(body.position.x, body.position.y + body.eye, body.position.z);
    camera.rotation.set(body.pitch + body.recoilPitch, body.yaw + body.recoilYaw, 0, 'YXZ');
  } else if (spectateTarget && spectateTarget.body.state.alive) {
    const tp = spectateTarget.body.state.position;
    camera.position.set(tp.x, tp.y + spectateTarget.body.state.eye, tp.z);
    camera.rotation.set(spectateTarget.body.state.pitch, spectateTarget.body.state.yaw, 0, 'YXZ');
  }
}

function frame(frameNow) {
  requestAnimationFrame(frame);
  const dt = Math.min((frameNow - lastTime) / 1000, 0.1);
  lastTime = frameNow;
  now = performance.now() / 1000;
  if (!frozen) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_STEP && steps < 5) {
      step(FIXED_STEP);
      accumulator -= FIXED_STEP;
      steps += 1;
    }
    if (accumulator > FIXED_STEP * 5) accumulator = 0;
    syncCamera();
  }
  renderer.render(scene, camera);
}

function resetMatch() {
  weapons.resetToPistol();
  player.reset(...Object.values(pickSpawn()));
  rounds.startMatch();
  hud.hideOverlay();
  updateHud();
}

function settle(steps) {
  for (let i = 0; i < steps; i += 1) step(FIXED_STEP);
}

function aimAt(point) {
  const dx = point.x - body.position.x;
  const dy = point.y - (body.position.y + body.eye);
  const dz = point.z - body.position.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  body.yaw = Math.atan2(-dx, -dz);
  body.pitch = Math.asin(Math.max(-1, Math.min(1, dy / len)));
  syncCamera();
}

function runShot(name) {
  hud.hideOverlay();
  body.pitch = 0;
  body.yaw = 0;
  rounds.startMatch();
  if (name === 'start') {
    // Buy phase at attacker spawn, looking north down mid.
    body.position.set(0, 0, 20);
    body.yaw = 0;
    settle(20);
    hud.showBuy(rounds.state.money, ownedList());
    hud.showOverlay('start', rounds.state.score);
  } else if (name === 'play') {
    // Live firefight: a Sentinel holds mid, the player drops him.
    rounds.state.phase = 'live';
    rounds.state.timer = 90;
    const guard = bots.list.find((b) => b.team === 'defend');
    // (-6, -2): the sim test proves this lane from (0, 10) is clear of the
    // booth and the container rows; (0, -6) sits behind the booth.
    guard.body.state.position.set(-6, 0, -2);
    guard.body.state.yaw = Math.PI * 0.75;
    guard.state = 'hold';
    guard.holdPos = { x: -6, z: -2 };
    guard.perceiveAt = 1e9; // staging only: he must not shoot back mid-shot
    body.position.set(0, 0, 10);
    weapons.equip('kestrel');
    settle(20);
    const chest = { x: -6, y: 1.2, z: -2 };
    aimAt(chest);
    playerShoot();
    settle(12);
    aimAt(chest);
    playerShoot();
  } else if (name === 'plant') {
    // Device planted at A; the player covers the crane site.
    rounds.state.phase = 'live';
    rounds.state.timer = 60;
    body.position.set(-14, 0, -8);
    settle(10);
    placeBomb('A');
    settle(10);
    aimAt({ x: -22, y: 1.4, z: -15 });
  } else {
    // Round won: Jackals 8-3, end overlay up.
    rounds.state.phase = 'live';
    rounds.state.score = { attack: 7, defend: 3 };
    body.position.set(0, 0, 0);
    settle(20);
    rounds.forceEnd('attack', 'elimination');
    hud.showOverlay('end', rounds.state.score, { winner: 'attack' });
    aimAt({ x: -22, y: 1.5, z: -15 });
  }
  updateHud();
  paintTwiceThenReady();
}

function paintTwiceThenReady() {
  let painted = 0;
  function paint() {
    requestAnimationFrame(paint);
    syncCamera();
    renderer.render(scene, camera);
    painted += 1;
    if (painted === 2) {
      window.__shotReady = true;
      frozen = true;
    }
  }
  requestAnimationFrame(paint);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Debug handle for play-tests: state, bots, rounds, map.
window.__game = {
  get phase() { return rounds.state.phase; },
  get round() { return rounds.state.round; },
  get score() { return { ...rounds.state.score }; },
  get money() { return rounds.state.money; },
  get bomb() { return { ...rounds.state.bomb }; },
  get playerAlive() { return body.alive; },
  get playerPos() { return { x: body.position.x, y: body.position.y, z: body.position.z }; },
  get playerYaw() { return body.yaw; },
  get playerHealth() { return body.health; },
  bots: bots.list,
  player,
  rounds,
  weapons,
};

// Buy menu shows during the buy phase even before pointer lock.
syncCamera();
updateHud();
if (rounds.state.phase === 'buy') hud.showBuy(rounds.state.money, ownedList());
if (shot) runShot(shot);
else {
  rounds.startMatch();
  hud.showOverlay('start', rounds.state.score);
  requestAnimationFrame(frame);
}
