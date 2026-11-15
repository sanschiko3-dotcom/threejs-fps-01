// Bodies: one physics model shared by the human player and every bot.
// A capsule approximated as a circle in XZ (radius 0.35) sliding against the
// map's AABBs, with acceleration-based movement, crouch, jump and gravity.
// Movement is deliberately weighty: stopping to aim pays, sprinting through
// the open does not. No per-frame allocations in the step.
import * as THREE from 'three';

const RADIUS = 0.35;
const HEIGHT = 1.7;
const EYE_STAND = 1.62;
const EYE_CROUCH = 1.12;
const WALK_SPEED = 4.3;
const CROUCH_SPEED = 2.1;
const GROUND_ACCEL = 34;
const AIR_ACCEL = 9;
const FRICTION = 26;
const GRAVITY = 14;
const JUMP_SPEED = 5.4;

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function createBody(aabbs, bounds, x, z, yaw) {
  const state = {
    position: new THREE.Vector3(x, 0, z),
    velocity: new THREE.Vector3(),
    yaw,
    pitch: 0,
    eye: EYE_STAND,
    crouching: false,
    onGround: true,
    health: 100,
    armor: 0,
    alive: true,
    recoilPitch: 0,
    recoilYaw: 0,
  };

  function resolveCollisions() {
    const p = state.position;
    // Keep inside the yard.
    p.x = clamp(p.x, bounds.minX + RADIUS, bounds.maxX - RADIUS);
    p.z = clamp(p.z, bounds.minZ + RADIUS, bounds.maxZ - RADIUS);
    for (let pass = 0; pass < 2; pass += 1) {
      for (const b of aabbs) {
        if (p.y + HEIGHT <= b.minY || p.y >= b.maxY) continue;
        const cx = clamp(p.x, b.minX, b.maxX);
        const cz = clamp(p.z, b.minZ, b.maxZ);
        let dx = p.x - cx;
        let dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= RADIUS * RADIUS) continue;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          const push = (RADIUS - d) / d;
          p.x += dx * push;
          p.z += dz * push;
        } else {
          // Centre inside the box: push out along the smallest penetration.
          const pushLeft = p.x - b.minX + RADIUS;
          const pushRight = b.maxX - p.x + RADIUS;
          const pushBack = p.z - b.minZ + RADIUS;
          const pushFront = b.maxZ - p.z + RADIUS;
          const min = Math.min(pushLeft, pushRight, pushBack, pushFront);
          if (min === pushLeft) p.x = b.minX - RADIUS;
          else if (min === pushRight) p.x = b.maxX + RADIUS;
          else if (min === pushBack) p.z = b.minZ - RADIUS;
          else p.z = b.maxZ + RADIUS;
        }
      }
    }
  }

  return {
    state,

    reset(x, z, yaw) {
      state.position.set(x, 0, z);
      state.velocity.set(0, 0, 0);
      state.yaw = yaw;
      state.pitch = 0;
      state.eye = EYE_STAND;
      state.crouching = false;
      state.onGround = true;
      state.health = 100;
      state.armor = 0;
      state.alive = true;
      state.recoilPitch = 0;
      state.recoilYaw = 0;
    },

    look(dx, dy, sensitivity = 0.0022) {
      state.yaw -= dx * sensitivity;
      state.pitch = clamp(state.pitch - dy * sensitivity, -1.45, 1.45);
    },

    recoil(pitchKick, yawKick) {
      state.recoilPitch += pitchKick;
      state.recoilYaw += yawKick;
    },

    // wishX/wishZ: desired move direction in world space (not necessarily
    // unit length). speed: target horizontal speed. jump: request a jump.
    step(dt, wishX, wishZ, speed, crouch, jump) {
      if (!state.alive) return;
      const p = state.position;
      const v = state.velocity;
      state.crouching = crouch;

      const wishLen = Math.hypot(wishX, wishZ);
      const targetSpeed = wishLen > 0.01 ? speed : 0;
      const nx = wishLen > 0.01 ? wishX / wishLen : 0;
      const nz = wishLen > 0.01 ? wishZ / wishLen : 0;
      const accel = state.onGround ? GROUND_ACCEL : AIR_ACCEL;
      v.x += (nx * targetSpeed - v.x) * Math.min(1, accel * dt);
      v.z += (nz * targetSpeed - v.z) * Math.min(1, accel * dt);
      if (wishLen <= 0.01 && state.onGround) {
        const f = Math.max(0, 1 - FRICTION * dt);
        v.x *= f;
        v.z *= f;
      }

      if (jump && state.onGround) {
        v.y = JUMP_SPEED;
        state.onGround = false;
      }
      v.y -= GRAVITY * dt;
      p.x += v.x * dt;
      p.z += v.z * dt;
      p.y += v.y * dt;
      if (p.y <= 0) {
        p.y = 0;
        v.y = 0;
        state.onGround = true;
      }
      resolveCollisions();

      // Recoil decays back toward zero; eye height eases to the stance.
      state.recoilPitch *= Math.max(0, 1 - 9 * dt);
      state.recoilYaw *= Math.max(0, 1 - 9 * dt);
      const eyeTarget = state.crouching ? EYE_CROUCH : EYE_STAND;
      state.eye += (eyeTarget - state.eye) * Math.min(1, 12 * dt);
    },

    // Horizontal speed, for spread: firing on the move is punished.
    groundSpeed() {
      return Math.hypot(state.velocity.x, state.velocity.z);
    },

    // Armour soaks half the damage until it is gone.
    applyDamage(amount) {
      if (!state.alive) return 0;
      let remaining = amount;
      if (state.armor > 0) {
        const soaked = Math.min(state.armor, remaining * 0.5);
        state.armor -= soaked;
        remaining -= soaked;
      }
      state.health -= remaining;
      if (state.health <= 0) {
        state.health = 0;
        state.alive = false;
      }
      return remaining;
    },
  };
}

// The human player: keyboard input mapped onto a body, with the camera
// following the eye. Bots drive createBody directly with steering wishes.
export function createPlayer(aabbs, bounds) {
  const body = createBody(aabbs, bounds, 0, 20, 0);
  const sin = Math.sin;
  const cos = Math.cos;

  return {
    body,
    state: body.state,

    groundSpeed() {
      return body.groundSpeed();
    },

    applyDamage(amount) {
      body.applyDamage(amount);
    },

    step(dt, keys) {
      const yaw = body.state.yaw;
      // Forward is -z rotated by yaw; right is +x rotated by yaw.
      const forwardX = -sin(yaw);
      const forwardZ = -cos(yaw);
      const rightX = cos(yaw);
      const rightZ = -sin(yaw);
      let wishX = 0;
      let wishZ = 0;
      if (keys.has('KeyW')) { wishX += forwardX; wishZ += forwardZ; }
      if (keys.has('KeyS')) { wishX -= forwardX; wishZ -= forwardZ; }
      if (keys.has('KeyD')) { wishX += rightX; wishZ += rightZ; }
      if (keys.has('KeyA')) { wishX -= rightX; wishZ -= rightZ; }
      const crouch = keys.has('ControlLeft') || keys.has('KeyC');
      const speed = crouch ? CROUCH_SPEED : WALK_SPEED;
      body.step(dt, wishX, wishZ, speed, crouch, keys.has('Space'));
    },

    look(dx, dy) {
      body.look(dx, dy);
    },

    recoil(pitchKick, yawKick) {
      body.recoil(pitchKick, yawKick);
    },

    reset(x, z, yaw) {
      body.reset(x, z, yaw);
    },
  };
}
