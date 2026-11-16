// Bots: nine teammates and opponents with a real state machine.
// Each round the Jackals get a plan — A push, B push, split, or a mid hold —
// while the Sentinels spread two-two-one across the sites. Bots route on the
// waypoint graph, hold angles, react to what they see (110° field of view,
// line of sight through the map's AABBs) and to gunfire they hear within
// 26 m, fire in bursts with a reaction delay and an aim error that shrinks
// as they track a target, and plant or defuse when the site is theirs. One
// Jackal carries the device; if he dies it drops and another Jackal must
// walk over it to pick it up.
import * as THREE from 'three';
import { createBody } from './player.js';
import { WEAPON_DEFS } from './weapons.js';
import { findRoute, segmentBlocked } from './map.js';
import { PALETTE } from './palette.js';

// Movement speed, perception cadence and ranges, plant/defuse channel times.
const BOT_SPEED = 3.9;
const PERCEIVE_EVERY = 0.22;
const FOV_COS = Math.cos((110 * Math.PI) / 360); // cos of the 55° half-angle
const SEE_RANGE = 46;
const HEAR_RANGE = 26;
const PLANT_TIME = 3.5;
const DEFUSE_TIME = 5;

// Roster: four Jackal attackers, five Sentinel defenders.
const JACKAL_NAMES = ['Rook', 'Vex', 'Marlowe', 'Kade'];
const SENTINEL_NAMES = ['Harbor', 'Quay', 'Tamsin', 'Bollard', 'Wren'];

// Bot body parts: [size, offset] for each piece, built from two materials —
// a team-tinted suit and dark trim — plus a skin-tone head. The gun is a
// dark box held forward. All parts cast shadows.
const BODY_PARTS = [
  { key: 'torso', size: [0.52, 0.62, 0.3], at: [0, 1.08, 0], mat: 'suit' },
  { key: 'head', size: [0.32, 0.32, 0.32], at: [0, 1.56, 0], mat: 'skin' },
  { key: 'helmet', size: [0.36, 0.14, 0.36], at: [0, 1.72, 0], mat: 'dark' },
  { key: 'legL', size: [0.2, 0.72, 0.24], at: [-0.14, 0.36, 0], mat: 'dark' },
  { key: 'legR', size: [0.2, 0.72, 0.24], at: [0.14, 0.36, 0], mat: 'dark' },
  { key: 'gun', size: [0.07, 0.09, 0.66], at: [0.2, 1.18, -0.3], mat: 'dark' },
];

function buildBotMesh(team) {
  const group = new THREE.Group();
  const mats = {
    suit: new THREE.MeshStandardMaterial({
      color: new THREE.Color(team === 'attack' ? PALETTE.jackal : PALETTE.sentinel),
      roughness: 0.85,
    }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.7, metalness: 0.2 }),
    skin: new THREE.MeshStandardMaterial({ color: 0x8a6a4a, roughness: 0.9 }),
  };
  const parts = {};
  for (const part of BODY_PARTS) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...part.size), mats[part.mat]);
    mesh.position.set(...part.at);
    mesh.castShadow = true;
    group.add(mesh);
    parts[part.key] = mesh;
  }
  return { group, torso: parts.torso, head: parts.head };
}

// A fresh weapon loadout for a bot: pistol stats, ready to be overwritten
// by the round economy in armBot.
function freshWeapon(id) {
  const def = WEAPON_DEFS[id];
  return { id, mag: def.mag, reserve: def.reserve, lastShot: -10, reloadEnd: 0, reloading: false };
}

export function createBots(scene, map, hooks, rng) {
  const bots = [];
  const shootables = [];

  // Create one bot at its team's spawn slot and wire its torso/head meshes
  // into the hitscan list. Attacker spawn slot 0 belongs to the human
  // player, so Jackal bots take slots 1-4.
  function addBot(name, team, spawnIndex) {
    const spawn = map.spawns[team][spawnIndex];
    const body = createBody(map.aabbs, map.bounds, spawn.x, spawn.z, spawn.yaw);
    const { group, torso, head } = buildBotMesh(team);
    scene.add(group);
    const bot = {
      id: `${team}-${spawnIndex}`,
      name,
      team,
      body,
      mesh: group,
      weapon: freshWeapon('dagger'),
      state: 'idle',
      route: [],
      routeIndex: 0,
      holdPos: null,
      holdYaw: spawn.yaw,
      target: null,
      targetIsPlayer: false,
      lastSeenAt: 0,
      trackTime: 0,
      reactUntil: 0,
      burstLeft: 0,
      nextBurstAt: 0,
      strafeDir: 1,
      strafeUntil: 0,
      investigatePos: null,
      investigateUntil: 0,
      plantProgress: 0,
      defuseProgress: 0,
      isCarrier: false,
      site: null,
      perceiveAt: rng.random() * PERCEIVE_EVERY,
      scanPhase: rng.random() * Math.PI * 2,
    };
    torso.userData.bot = bot;
    torso.userData.part = 'body';
    head.userData.bot = bot;
    head.userData.part = 'head';
    shootables.push(torso, head);
    bots.push(bot);
    return bot;
  }

  JACKAL_NAMES.forEach((name, i) => addBot(name, 'attack', i + 1));
  SENTINEL_NAMES.forEach((name, i) => addBot(name, 'defend', i));

  let playerBody = null;
  let playerName = 'You';
  // Stable stand-in for the human player so bots can target them exactly
  // like a bot: target.body.state is the player's body state either way.
  const playerTarget = { isPlayer: true, name: 'You', team: 'attack', body: { state: null } };

  // --- perception ---------------------------------------------------------
  // Eye position of a bot, and chest position of a body (the aim point).
  function eyeOf(bot) {
    const p = bot.body.state.position;
    return { x: p.x, y: p.y + bot.body.state.eye, z: p.z };
  }

  function chestOf(body) {
    const p = body.position;
    return { x: p.x, y: p.y + 1.2, z: p.z };
  }

  // Can this bot see this body? Range, then field of view (skipped up
  // close, where a bot notices anything next to it), then line of sight
  // through the map's solid boxes.
  function canSee(bot, body) {
    const eye = eyeOf(bot);
    const chest = chestOf(body);
    const dx = chest.x - eye.x;
    const dy = chest.y - eye.y;
    const dz = chest.z - eye.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist > SEE_RANGE) return null;
    const fx = -Math.sin(bot.body.state.yaw);
    const fz = -Math.cos(bot.body.state.yaw);
    const dot = (dx * fx + dz * fz) / Math.max(0.001, Math.hypot(dx, dz));
    if (dot < FOV_COS && dist > 3) return null;
    if (segmentBlocked(eye, chest, map.aabbs)) return null;
    return { dist, chest };
  }

  // Nearest visible enemy: every living enemy bot, plus the human player
  // when this bot defends (attackers never shoot their own teammate).
  function nearestEnemy(bot) {
    let best = null;
    let bestDist = Infinity;
    const candidates = [];
    for (const other of bots) {
      if (other.team !== bot.team && other.body.state.alive) {
        candidates.push({ body: other.body.state, bot: other });
      }
    }
    if (playerBody && playerBody.alive && bot.team === 'defend') {
      candidates.push({ body: playerBody, bot: playerTarget });
    }
    for (const candidate of candidates) {
      const seen = canSee(bot, candidate.body);
      if (seen && seen.dist < bestDist) {
        bestDist = seen.dist;
        best = { ...candidate, dist: seen.dist, chest: seen.chest };
      }
    }
    return best;
  }

  // --- movement -----------------------------------------------------------
  // Route to a point over the waypoint graph; fall back to a straight walk
  // when the graph gives nothing.
  function setRoute(bot, to) {
    const from = bot.body.state.position;
    const route = findRoute(map.waypoints, { x: from.x, z: from.z }, to);
    bot.route = route || [to];
    bot.routeIndex = 0;
  }

  // Route through intermediate points (a lane), chaining one BFS leg per hop
  // so attackers spread across the west quay, mid and the east alley instead
  // of all funnelling down the middle.
  function routeThrough(bot, points) {
    const legs = [];
    let from = { x: bot.body.state.position.x, z: bot.body.state.position.z };
    for (const point of points) {
      const leg = findRoute(map.waypoints, from, point);
      if (leg) legs.push(...leg);
      from = point;
    }
    bot.route = legs.length > 0 ? legs : [points[points.length - 1]];
    bot.routeIndex = 0;
  }

  // Next step along the current route: a unit direction, or arrived when the
  // route is exhausted. Waypoints within 0.7 m count as reached.
  function routeStep(bot, dt, speed) {
    if (bot.routeIndex >= bot.route.length) return { x: 0, z: 0, arrived: true };
    const target = bot.route[bot.routeIndex];
    const p = bot.body.state.position;
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.7) {
      bot.routeIndex += 1;
      return routeStep(bot, dt, speed);
    }
    return { x: dx / dist, z: dz / dist, arrived: false };
  }

  // Turn the bot's yaw toward a point, fastest way around, capped by rate.
  function faceToward(bot, x, z, dt, rate = 7) {
    const p = bot.body.state.position;
    const want = Math.atan2(-(x - p.x), -(z - p.z));
    let diff = want - bot.body.state.yaw;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    bot.body.state.yaw += diff * Math.min(1, rate * dt);
  }

  // --- plans --------------------------------------------------------------
  // Round plan for a team. Defenders always hold; attackers push A or B on
  // round one, then mostly push a site, sometimes split, rarely hold mid.
  function choosePlan(team, round) {
    if (team === 'defend') return 'hold';
    const roll = rng.random();
    if (round === 1) return roll < 0.5 ? 'a-push' : 'b-push';
    if (roll < 0.35) return 'a-push';
    if (roll < 0.7) return 'b-push';
    if (roll < 0.9) return 'split';
    return 'mid-hold';
  }

  // Which site this attacker is playing for under the plan. Split alternates
  // down the roster; mid-hold drifts to a site after the pause.
  function siteTarget(bot, plan) {
    if (bot.team === 'defend') return null;
    const index = bots.filter((b) => b.team === 'attack').indexOf(bot);
    if (plan === 'a-push') return 'A';
    if (plan === 'b-push') return 'B';
    if (plan === 'split') return index % 2 === 0 ? 'A' : 'B';
    return index < 2 ? 'A' : 'B';
  }

  function sitePoint(site) {
    const s = site === 'A' ? map.sites.siteA : map.sites.siteB;
    return { x: s.x, z: s.z };
  }

  // Simple economy: pistols round one, rifles once the match is moving,
  // one DMR per team from round three.
  function armBot(bot, round) {
    const teamBots = bots.filter((b) => b.team === bot.team);
    const index = teamBots.indexOf(bot);
    let id = 'dagger';
    if (round >= 2) id = index < 3 ? 'kestrel' : 'stinger';
    if (round >= 3 && index === 0) id = 'longshot';
    bot.weapon = freshWeapon(id);
  }

  // Reset every bot for a new round: back to spawn, fresh weapon, fresh plan.
  // Defenders walk to their site (first two to A, next two to B, the fifth
  // holds mid); attackers take their plan's lane, or hold mid first on a
  // mid-hold. No bot carries the device at round start: the human player is
  // the carrier, and a bot only becomes carrier by picking up a dropped device.
  function spawnRound(round) {
    const attackPlan = choosePlan('attack', round);
    for (const bot of bots) {
      const teamIndex = bots.filter((b) => b.team === bot.team).indexOf(bot);
      const spawn = map.spawns[bot.team][bot.team === 'attack' ? teamIndex + 1 : teamIndex];
      bot.body.reset(spawn.x, spawn.z, spawn.yaw);
      bot.mesh.visible = true;
      bot.mesh.scale.y = 1;
      bot.state = 'idle';
      bot.route = [];
      bot.routeIndex = 0;
      bot.target = null;
      bot.trackTime = 0;
      bot.burstLeft = 0;
      bot.investigatePos = null;
      bot.plantProgress = 0;
      bot.defuseProgress = 0;
      bot.isCarrier = false;
      bot.site = bot.team === 'attack' ? siteTarget(bot, attackPlan) : null;
      armBot(bot, round);
      if (bot.team === 'defend') {
        const index = bots.filter((b) => b.team === 'defend').indexOf(bot);
        const site = index < 2 ? 'A' : index < 4 ? 'B' : null;
        bot.site = site;
        if (site) {
          const point = sitePoint(site);
          setRoute(bot, { x: point.x + rng.range(-2, 2), z: point.z + rng.range(-2, 2) });
          bot.state = 'toSite';
        } else {
          setRoute(bot, { x: rng.range(-3, 3), z: -6 });
          bot.state = 'toSite';
        }
      } else if (attackPlan === 'mid-hold') {
        setRoute(bot, { x: rng.range(-3, 3), z: 2 });
        bot.state = 'toSite';
        bot.holdUntil = 6 + rng.range(0, 4);
      } else {
        const point = sitePoint(bot.site);
        // Spread the push across lanes: two bots take the site's side lane
        // (west quay to A, east alley to B), the rest push through mid.
        const index = bots.filter((b) => b.team === 'attack').indexOf(bot);
        if (bot.site === 'A' && index < 2) {
          routeThrough(bot, [{ x: -26, z: 14 }, { x: -26, z: -11 }, point]);
        } else if (bot.site === 'B' && index < 2) {
          routeThrough(bot, [{ x: 26, z: 14 }, { x: 26, z: -11 }, point]);
        } else {
          setRoute(bot, { x: point.x, z: point.z });
        }
        bot.state = 'toSite';
      }
    }
  }

  // --- combat -------------------------------------------------------------
  // One tick of a bot that has a target: face it, strafe and mind the range,
  // then fire in bursts once the reaction delay has passed. Aim error starts
  // wide and shrinks as the bot tracks — fresh targets are hard to hit.
  function fightStep(bot, dt, now) {
    const target = bot.target;
    if (!target || !target.body.state.alive) {
      bot.target = null;
      bot.state = bot.holdPos ? 'hold' : 'toSite';
      return;
    }
    const p = bot.body.state.position;
    const tp = target.body.state.position;
    const dx = tp.x - p.x;
    const dz = tp.z - p.z;
    const dist = Math.hypot(dx, dz);
    faceToward(bot, tp.x, tp.z, dt, 9);
    bot.trackTime += dt;

    // Strafe to stay a hard target; close in when far, back off when close.
    let wishX = 0;
    let wishZ = 0;
    if (now > bot.strafeUntil) {
      bot.strafeDir = rng.chance(0.5) ? 1 : -1;
      bot.strafeUntil = now + rng.range(0.7, 1.5);
    }
    const rightX = Math.cos(bot.body.state.yaw);
    const rightZ = -Math.sin(bot.body.state.yaw);
    wishX += rightX * bot.strafeDir * 0.7;
    wishZ += rightZ * bot.strafeDir * 0.7;
    if (dist > 26) { wishX += dx / dist; wishZ += dz / dist; }
    if (dist < 5) { wishX -= dx / dist; wishZ -= dz / dist; }
    const crouch = rng.chance(0.0015) ? !bot.body.state.crouching : bot.body.state.crouching;
    bot.body.step(dt, wishX, wishZ, BOT_SPEED * 0.75, crouch, false);

    // Fire in bursts once the reaction delay has passed.
    if (now < bot.reactUntil) return;
    const def = WEAPON_DEFS[bot.weapon.id];
    const w = bot.weapon;
    if (w.reloading) {
      if (now >= w.reloadEnd) {
        w.mag = def.mag;
        w.reserve = Math.max(0, w.reserve - def.mag);
        w.reloading = false;
      }
      return;
    }
    if (w.mag <= 0) {
      if (w.reserve <= 0) return;
      w.reloading = true;
      w.reloadEnd = now + def.reloadTime;
      return;
    }
    if (bot.burstLeft <= 0) {
      if (now < bot.nextBurstAt) return;
      bot.burstLeft = bot.weapon.id === 'longshot' ? 1 : 3 + rng.int(0, 2);
      bot.nextBurstAt = now + rng.range(0.45, 0.95);
    }
    if (now - w.lastShot < def.interval) return;
    w.lastShot = now;
    w.mag -= 1;
    bot.burstLeft -= 1;
    const error = Math.max(0.012, 0.075 - bot.trackTime * 0.045) * (1 + dist / 40);
    const aimY = tp.y + (rng.chance(0.25) ? 1.5 : 1.2);
    const eye = eyeOf(bot);
    const dir = new THREE.Vector3(tp.x - eye.x, aimY - eye.y, tp.z - eye.z).normalize();
    dir.x += (rng.random() * 2 - 1) * error;
    dir.y += (rng.random() * 2 - 1) * error;
    dir.z += (rng.random() * 2 - 1) * error;
    dir.normalize();
    hooks.shoot(bot, new THREE.Vector3(eye.x, eye.y, eye.z), dir);
  }

  // --- the brain ----------------------------------------------------------
  // One tick of one bot. Buy phase: stand at spawn — perception and fighting
  // belong to the live round only, or bots spot and shoot each other across
  // the map during the 12 s buy and the round starts with corpses.
  function stepBot(bot, dt, now, ctx) {
    if (!bot.body.state.alive) return;
    if (ctx.phase !== 'live') return;
    const p = bot.body.state.position;

    // Perception runs on a stagger so nine bots never raycast on one frame.
    if (now >= bot.perceiveAt) {
      bot.perceiveAt = now + PERCEIVE_EVERY;
      const seen = nearestEnemy(bot);
      if (seen) {
        if (bot.target !== seen.bot) {
          bot.reactUntil = now + rng.range(0.35, 0.7);
          bot.trackTime = 0;
        }
        bot.target = seen.bot;
        bot.targetIsPlayer = seen.bot === playerTarget;
        bot.lastSeenAt = now;
        if (bot.state !== 'fight') {
          bot.state = 'fight';
          bot.plantProgress = 0;
          bot.defuseProgress = 0;
        }
      } else if (bot.state === 'fight' && now - bot.lastSeenAt > 1.2) {
        // Lost sight for over a second: fall back to the plan.
        bot.target = null;
        bot.trackTime = 0;
        bot.state = bot.holdPos ? 'hold' : 'toSite';
      }
    }

    if (bot.state === 'fight') {
      fightStep(bot, dt, now);
      return;
    }

    // Bomb planted: attackers defend the site, defenders converge on it.
    if (ctx.bomb.state === 'planted') {
      const site = ctx.bomb.site === 'A' ? map.sites.siteA : map.sites.siteB;
      if (bot.team === 'attack') {
        if (Math.hypot(p.x - site.x, p.z - site.z) > 7) {
          if (bot.state !== 'toSite') { setRoute(bot, { x: site.x, z: site.z }); bot.state = 'toSite'; }
          const wish = routeStep(bot, dt, BOT_SPEED);
          faceToward(bot, p.x + wish.x, p.z + wish.z, dt);
          bot.body.step(dt, wish.x, wish.z, BOT_SPEED, false, false);
        } else {
          bot.state = 'hold';
          bot.holdPos = { x: p.x, z: p.z };
        }
      } else {
        if (bot.state !== 'toSite') { setRoute(bot, { x: ctx.bomb.pos.x, z: ctx.bomb.pos.z }); bot.state = 'toSite'; }
        const dist = Math.hypot(p.x - ctx.bomb.pos.x, p.z - ctx.bomb.pos.z);
        if (dist < 1.6) {
          // Defusing: stand still, channel 5 s. Any damage or sighting aborts.
          bot.state = 'defusing';
          bot.defuseProgress += dt;
          faceToward(bot, ctx.bomb.pos.x, ctx.bomb.pos.z, dt);
          if (bot.defuseProgress >= DEFUSE_TIME) {
            bot.defuseProgress = 0;
            hooks.defused();
          }
          return;
        }
        const wish = routeStep(bot, dt, BOT_SPEED);
        faceToward(bot, p.x + wish.x, p.z + wish.z, dt);
        bot.body.step(dt, wish.x, wish.z, BOT_SPEED, false, false);
      }
      return;
    }

    // Planting: the carrier channels 3.5 s inside a clear site.
    if (bot.state === 'planting') {
      bot.plantProgress += dt;
      if (bot.plantProgress >= PLANT_TIME) {
        bot.plantProgress = 0;
        bot.state = 'hold';
        hooks.planted(bot.site);
      }
      return;
    }

    // Dropped device: the nearest Jackal walks over it to pick it up.
    if (ctx.bomb.state === 'dropped' && bot.team === 'attack' && !bot.isCarrier) {
      const dist = Math.hypot(p.x - ctx.bomb.pos.x, p.z - ctx.bomb.pos.z);
      if (dist < 1.5) {
        bot.isCarrier = true;
        hooks.bombPickedUp(bot);
      }
    }

    if (bot.state === 'toSite') {
      const wish = routeStep(bot, dt, BOT_SPEED);
      if (wish.arrived) {
        bot.state = 'hold';
        bot.holdPos = { x: p.x, z: p.z };
        bot.holdYaw = bot.body.state.yaw;
        // Attackers who reach their site with the device plant when clear.
        if (bot.team === 'attack' && bot.isCarrier && bot.site) {
          const site = sitePoint(bot.site);
          if (Math.hypot(p.x - site.x, p.z - site.z) <= map.sites[`site${bot.site}`].r) {
            bot.state = 'planting';
            bot.plantProgress = 0;
            hooks.plantStarted?.(bot);
          }
        }
        return;
      }
      faceToward(bot, p.x + wish.x, p.z + wish.z, dt);
      bot.body.step(dt, wish.x, wish.z, BOT_SPEED, false, false);
      return;
    }

    if (bot.state === 'hold') {
      // Slow scan sweep; mid-hold attackers drift to their site when time is up.
      bot.scanPhase += dt * 0.5;
      const sweep = Math.sin(bot.scanPhase) * 0.7;
      bot.body.state.yaw = bot.holdYaw + sweep;
      if (bot.team === 'attack' && bot.holdUntil && now >= bot.holdUntil && bot.site) {
        bot.holdUntil = 0;
        setRoute(bot, sitePoint(bot.site));
        bot.state = 'toSite';
      }
      // Investigate a heard shot nearby.
      if (bot.investigatePos && now < bot.investigateUntil) {
        const d = Math.hypot(p.x - bot.investigatePos.x, p.z - bot.investigatePos.z);
        if (d > 3) {
          setRoute(bot, bot.investigatePos);
          bot.state = 'toSite';
          bot.investigatePos = null;
        }
      }
    }
  }

  // Copy body state into the visible meshes every tick.
  function syncMeshes() {
    for (const bot of bots) {
      const p = bot.body.state.position;
      bot.mesh.position.set(p.x, p.y, p.z);
      bot.mesh.rotation.y = bot.body.state.yaw;
      bot.mesh.scale.y = bot.body.state.crouching ? 0.72 : 1;
      bot.mesh.visible = bot.body.state.alive;
    }
  }

  return {
    list: bots,
    shootables,

    setPlayer(body, name) {
      playerBody = body;
      playerName = name;
      playerTarget.body.state = body;
      playerTarget.name = name;
    },

    spawnRound,

    step(dt, now, ctx) {
      for (const bot of bots) stepBot(bot, dt, now, ctx);
      syncMeshes();
    },

    aliveCount(team) {
      return bots.filter((b) => b.team === team && b.body.state.alive).length;
    },

    firstAliveTeammate() {
      return bots.find((b) => b.team === 'attack' && b.body.state.alive) || null;
    },

    carrier() {
      return bots.find((b) => b.isCarrier && b.body.state.alive) || null;
    },

    // A shot rings out: enemy bots holding position nearby turn to
    // investigate it for a few seconds.
    hearShot(pos, team) {
      for (const bot of bots) {
        if (!bot.body.state.alive || bot.team === team) continue;
        const p = bot.body.state.position;
        const d = Math.hypot(p.x - pos.x, p.z - pos.z);
        if (d < HEAR_RANGE && bot.state === 'hold') {
          bot.investigatePos = { x: pos.x, z: pos.z };
          bot.investigateUntil = performance.now() / 1000 + 4;
        }
      }
    },

    // A bot died: hide the mesh, and if it carried the device, drop it
    // where it fell so another Jackal can pick it up.
    handleDeath(bot) {
      bot.state = 'dead';
      bot.target = null;
      bot.mesh.visible = false;
      if (bot.isCarrier) {
        bot.isCarrier = false;
        const p = bot.body.state.position;
        hooks.bombDropped({ x: p.x, z: p.z });
      }
    },
  };
}
