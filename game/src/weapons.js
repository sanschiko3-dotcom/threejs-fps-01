// BLACKWATER DOCK arsenal — four hitscan guns, an HE grenade and Kevlar,
// priced on a Counter-Strike-shaped economy. Damage does not fall off with
// range (the yard is small enough that it never matters); what separates the
// guns is recoil, spread, fire rate and magazine size. Spread grows while
// moving or airborne, and every gun punishes holding the trigger. Headshots
// deal four times body damage. Each gun also gets a simple box-built view
// model parented to the camera, with walk bob, a fire kick and a reload dip.
import * as THREE from 'three';

// One entry per gun: price, damage, headshot multiplier, magazine, reserve
// ammo, time between shots, reload time, base spread, extra spread while
// moving, recoil kick, full-auto flag, tracer colour.
export const WEAPON_DEFS = {
  dagger: {
    name: 'Dagger P9', price: 0, damage: 34, headMult: 4,
    mag: 12, reserve: 36, interval: 0.19, reloadTime: 1.4,
    spread: 0.006, moveSpread: 0.02, recoil: 0.011, auto: false,
    tracer: 0xffe0a0,
  },
  stinger: {
    name: 'Stinger-9', price: 1500, damage: 26, headMult: 4,
    mag: 30, reserve: 90, interval: 0.08, reloadTime: 2.0,
    spread: 0.011, moveSpread: 0.024, recoil: 0.008, auto: true,
    tracer: 0xffd27a,
  },
  kestrel: {
    name: 'AR-77 Kestrel', price: 2700, damage: 36, headMult: 4,
    mag: 25, reserve: 75, interval: 0.1, reloadTime: 2.2,
    spread: 0.008, moveSpread: 0.022, recoil: 0.012, auto: true,
    tracer: 0xffc46b,
  },
  longshot: {
    name: 'Longshot-7', price: 4750, damage: 88, headMult: 4,
    mag: 5, reserve: 15, interval: 0.8, reloadTime: 2.8,
    spread: 0.002, moveSpread: 0.018, recoil: 0.03, auto: false,
    tracer: 0xfff2c0,
  },
};

export const GRENADE_PRICE = 300;
export const KEVLAR_PRICE = 650;

// Buy-menu order: the four guns, then grenade, then Kevlar.
export const BUY_ORDER = ['dagger', 'stinger', 'kestrel', 'longshot', 'grenade', 'kevlar'];

// View-model dimensions per gun: [width, height, length] of the receiver,
// [width, height, length] of the barrel, and the receiver tint. The Dagger
// is short and light; the Longshot is long and heavy — the silhouette alone
// tells the player which gun is up.
const VIEW_MODELS = {
  dagger: { size: [0.09, 0.11, 0.34], barrel: [0.05, 0.05, 0.16], tint: 0x2b2f36 },
  stinger: { size: [0.1, 0.12, 0.5], barrel: [0.05, 0.05, 0.22], tint: 0x23272e },
  kestrel: { size: [0.1, 0.13, 0.62], barrel: [0.05, 0.05, 0.3], tint: 0x2e2a24 },
  longshot: { size: [0.1, 0.14, 0.72], barrel: [0.045, 0.045, 0.42], tint: 0x272d33 },
};

// Where every view model sits when idle, relative to the camera.
const MODEL_HOME = { x: 0.28, y: -0.26, z: -0.55 };

export function createWeapons(camera) {
  const group = new THREE.Group();
  camera.add(group);

  const gunMat = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.45, metalness: 0.6 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xff9a2e, roughness: 0.5, metalness: 0.3 });

  // Build one view model per gun: receiver, barrel, angled grip, orange
  // stripe on top. Only the equipped one is visible at a time.
  const models = {};
  for (const [id, spec] of Object.entries(VIEW_MODELS)) {
    const tintMat = new THREE.MeshStandardMaterial({ color: spec.tint, roughness: 0.45, metalness: 0.6 });
    const model = new THREE.Group();
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(...spec.size), tintMat);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(...spec.barrel), gunMat);
    barrel.position.set(0, 0.02, -spec.size[2] / 2 - spec.barrel[2] / 2 + 0.02);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.1), gunMat);
    grip.position.set(0, -0.12, 0.1);
    grip.rotation.x = 0.3;
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(spec.size[0] + 0.005, 0.015, 0.12), accentMat);
    stripe.position.set(0, spec.size[1] / 2 - 0.005, -0.05);
    model.add(receiver, barrel, grip, stripe);
    model.position.set(MODEL_HOME.x, MODEL_HOME.y, MODEL_HOME.z);
    model.visible = false;
    group.add(model);
    models[id] = model;
  }

  // Muzzle flash: a small additive plane at the barrel tip, lit for 40 ms
  // after each shot and spun to a random angle so it never looks static.
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffc46b, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), flashMat);
  flash.position.set(0.28, -0.22, -1.05);
  group.add(flash);

  // Live state: which gun is up, ammo per gun, grenades, reload timing,
  // time of the last shot, view-model kick (decays) and bob phase.
  const state = {
    current: 'dagger',
    ammo: {},
    grenades: 0,
    reloading: false,
    reloadEnd: 0,
    lastShot: -10,
    kick: 0,
    bobPhase: 0,
    flashUntil: 0,
  };
  for (const id of Object.keys(WEAPON_DEFS)) {
    state.ammo[id] = { mag: WEAPON_DEFS[id].mag, reserve: WEAPON_DEFS[id].reserve };
  }
  models.dagger.visible = true;

  const muzzleWorld = new THREE.Vector3();
  const forward = new THREE.Vector3();

  // The definition of the gun currently in hand.
  function def() {
    return WEAPON_DEFS[state.current];
  }

  function showModel(id) {
    for (const [key, model] of Object.entries(models)) model.visible = key === id;
  }

  return {
    state,
    def,

    currentId() {
      return state.current;
    },

    // Current spread: base spread, plus a movement penalty that saturates
    // at full sprint speed, plus a flat penalty while airborne.
    spread(moveSpeed, airborne) {
      const d = def();
      return d.spread + d.moveSpread * Math.min(1, moveSpeed / 4.3) + (airborne ? 0.02 : 0);
    },

    // True when the gun can fire right now: not reloading, and the
    // per-gun interval since the last shot has elapsed.
    ready(now) {
      return !state.reloading && now - state.lastShot >= def().interval;
    },

    // Spend one round. Returns false when reloading, still inside the
    // fire interval, or dry — the caller plays the dry-fire click then.
    takeRound(now) {
      if (state.reloading) return false;
      if (now - state.lastShot < def().interval) return false;
      const ammo = state.ammo[state.current];
      if (ammo.mag <= 0) return false;
      ammo.mag -= 1;
      state.lastShot = now;
      state.kick = 1;
      state.flashUntil = now + 0.04;
      return true;
    },

    // Start a reload. Refused when already reloading, when the magazine
    // is full, or when there is no reserve ammo left.
    reload(now) {
      const ammo = state.ammo[state.current];
      const d = def();
      if (state.reloading || ammo.mag === d.mag || ammo.reserve <= 0) return false;
      state.reloading = true;
      state.reloadEnd = now + d.reloadTime;
      return true;
    },

    // Switch guns. Switching cancels a reload in progress.
    equip(id) {
      if (!WEAPON_DEFS[id] || id === state.current) return;
      state.current = id;
      state.reloading = false;
      showModel(id);
    },

    // Buy during the buy phase. Returns the price charged, or -1 when the
    // purchase is refused: already owned (full pistol magazine), a third
    // grenade, or not enough money. Kevlar returns its price here and the
    // caller applies the armour itself.
    buy(id, money) {
      if (id === 'grenade') {
        if (state.grenades >= 2 || money < GRENADE_PRICE) return -1;
        state.grenades += 1;
        return GRENADE_PRICE;
      }
      if (id === 'kevlar') {
        if (money < KEVLAR_PRICE) return -1;
        return KEVLAR_PRICE;
      }
      const d = WEAPON_DEFS[id];
      if (!d || money < d.price) return -1;
      if (id === state.current && state.ammo[id].mag === d.mag) return -1;
      state.ammo[id] = { mag: d.mag, reserve: d.reserve };
      state.current = id;
      showModel(id);
      return d.price;
    },

    // The Dagger is always owned; any other gun counts as owned while it
    // still has a round anywhere, magazine or reserve.
    hasWeapon(id) {
      return id === 'dagger' || state.ammo[id].reserve > 0 || state.ammo[id].mag > 0;
    },

    // Back to the pistol with full ammo everywhere — the loadout a player
    // respawns with after dying in the previous round.
    resetToPistol() {
      state.current = 'dagger';
      state.grenades = 0;
      state.reloading = false;
      for (const id of Object.keys(WEAPON_DEFS)) {
        state.ammo[id] = { mag: WEAPON_DEFS[id].mag, reserve: WEAPON_DEFS[id].reserve };
      }
      showModel('dagger');
    },

    // World position of the muzzle: 0.6 m ahead of the camera, slightly low.
    muzzleWorld(out) {
      camera.getWorldDirection(forward);
      out.copy(camera.position).addScaledVector(forward, 0.6);
      out.y -= 0.12;
      return out;
    },

    // Per-frame housekeeping: finish reloads, decay the kick, advance the
    // walk bob and pose the view model, and show or hide the muzzle flash.
    step(dt, now, moveSpeed) {
      if (state.reloading && now >= state.reloadEnd) {
        const ammo = state.ammo[state.current];
        const d = def();
        const need = d.mag - ammo.mag;
        const take = Math.min(need, ammo.reserve);
        ammo.mag += take;
        ammo.reserve -= take;
        state.reloading = false;
      }
      state.kick = Math.max(0, state.kick - dt * 7);
      state.bobPhase += dt * (2 + moveSpeed * 2.2);
      const bob = Math.min(1, moveSpeed / 4.3) * 0.012;
      const model = models[state.current];
      model.position.y = MODEL_HOME.y + Math.sin(state.bobPhase * 2) * bob - (state.reloading ? 0.12 : 0);
      model.position.z = MODEL_HOME.z + state.kick * 0.09;
      model.rotation.x = state.kick * 0.12 + (state.reloading ? 0.35 : 0);
      flashMat.opacity = now < state.flashUntil ? 0.95 : 0;
      flash.rotation.z = Math.random() * Math.PI;
    },
  };
}
