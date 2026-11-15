// Arsenal: four hitscan guns plus an HE grenade, priced on a Counter-Strike
// shaped economy. Damage is flat with distance (the dock is small); the
// skill is in the recoil and the spread, which both punish firing on the move,
// and in the headshot multiplier (x4). Each gun gets a simple box-built view
// model parented to the camera, with walk bob, fire kick and a reload dip.
import * as THREE from 'three';

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
export const BUY_ORDER = ['dagger', 'stinger', 'kestrel', 'longshot', 'grenade', 'kevlar'];

const VIEW = {
  dagger: { body: [0.09, 0.11, 0.34], barrel: [0.05, 0.05, 0.16], color: 0x2b2f36 },
  stinger: { body: [0.1, 0.12, 0.5], barrel: [0.05, 0.05, 0.22], color: 0x23272e },
  kestrel: { body: [0.1, 0.13, 0.62], barrel: [0.05, 0.05, 0.3], color: 0x2e2a24 },
  longshot: { body: [0.1, 0.14, 0.72], barrel: [0.045, 0.045, 0.42], color: 0x272d33 },
};

export function createWeapons(camera) {
  const group = new THREE.Group();
  camera.add(group);

  const gunMat = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.45, metalness: 0.6 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xff9a2e, roughness: 0.5, metalness: 0.3 });
  const models = {};
  for (const [id, spec] of Object.entries(VIEW)) {
    const model = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(...spec.body), gunMat);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(...spec.barrel), gunMat);
    barrel.position.set(0, 0.02, -spec.body[2] / 2 - spec.barrel[2] / 2 + 0.02);
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.16, 0.1), gunMat);
    grip.position.set(0, -0.12, 0.1);
    grip.rotation.x = 0.3;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(spec.body[0] + 0.005, 0.015, 0.12), accentMat);
    stripe.position.set(0, spec.body[1] / 2 - 0.005, -0.05);
    model.add(body, barrel, grip, stripe);
    model.position.set(0.28, -0.26, -0.55);
    model.visible = false;
    group.add(model);
    models[id] = model;
  }

  // Muzzle flash: a small additive plane at the barrel tip, shown for 40 ms.
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xffc46b, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.22), flashMat);
  flash.position.set(0.28, -0.22, -1.05);
  group.add(flash);

  const state = {
    current: 'dagger',
    ammo: {},
    grenades: 0,
    reloading: false,
    reloadEnd: 0,
    lastShot: -10,
    kick: 0, // view-model kick, decays
    bobPhase: 0,
    flashUntil: 0,
  };
  for (const id of Object.keys(WEAPON_DEFS)) {
    state.ammo[id] = { mag: WEAPON_DEFS[id].mag, reserve: WEAPON_DEFS[id].reserve };
  }
  models.dagger.visible = true;

  const muzzleWorld = new THREE.Vector3();
  const forward = new THREE.Vector3();

  function def() {
    return WEAPON_DEFS[state.current];
  }

  return {
    state,
    def,

    currentId() {
      return state.current;
    },

    // Spread now: base + movement penalty + a little while airborne.
    spread(moveSpeed, airborne) {
      const d = def();
      return d.spread + d.moveSpread * Math.min(1, moveSpeed / 4.3) + (airborne ? 0.02 : 0);
    },

    ready(now) {
      return !state.reloading && now - state.lastShot >= def().interval;
    },

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

    reload(now) {
      const ammo = state.ammo[state.current];
      const d = def();
      if (state.reloading || ammo.mag === d.mag || ammo.reserve <= 0) return false;
      state.reloading = true;
      state.reloadEnd = now + d.reloadTime;
      return true;
    },

    equip(id) {
      if (!WEAPON_DEFS[id] || id === state.current) return;
      state.current = id;
      state.reloading = false;
      for (const [key, model] of Object.entries(models)) model.visible = key === id;
    },

    // Buy a weapon (or grenade / kevlar) during the buy phase. Returns the
    // price on success, -1 when already owned or unaffordable.
    buy(id, money) {
      if (id === 'grenade') {
        if (state.grenades >= 2 || money < GRENADE_PRICE) return -1;
        state.grenades += 1;
        return GRENADE_PRICE;
      }
      if (id === 'kevlar') {
        if (money < KEVLAR_PRICE) return -1;
        return KEVLAR_PRICE; // armour is applied by the caller
      }
      const d = WEAPON_DEFS[id];
      if (!d || money < d.price) return -1;
      if (id === state.current && state.ammo[id].mag === d.mag) return -1;
      state.ammo[id] = { mag: d.mag, reserve: d.reserve };
      state.current = id;
      for (const [key, model] of Object.entries(models)) model.visible = key === id;
      return d.price;
    },

    hasWeapon(id) {
      return id === 'dagger' || state.ammo[id].reserve > 0 || state.ammo[id].mag > 0;
    },

    resetToPistol() {
      state.current = 'dagger';
      state.grenades = 0;
      state.reloading = false;
      for (const id of Object.keys(WEAPON_DEFS)) {
        state.ammo[id] = { mag: WEAPON_DEFS[id].mag, reserve: WEAPON_DEFS[id].reserve };
      }
      for (const [key, model] of Object.entries(models)) model.visible = key === 'dagger';
    },

    muzzleWorld(out) {
      camera.getWorldDirection(forward);
      out.copy(camera.position).addScaledVector(forward, 0.6);
      out.y -= 0.12;
      return out;
    },

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
      model.position.y = -0.26 + Math.sin(state.bobPhase * 2) * bob - (state.reloading ? 0.12 : 0);
      model.position.z = -0.55 + state.kick * 0.09;
      model.rotation.x = state.kick * 0.12 + (state.reloading ? 0.35 : 0);
      flashMat.opacity = now < state.flashUntil ? 0.95 : 0;
      flash.rotation.z = Math.random() * Math.PI;
    },
  };
}
