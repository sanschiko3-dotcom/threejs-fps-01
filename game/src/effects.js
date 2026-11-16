// Pooled visual effects: tracers, hit sparks and bomb explosions.
// Everything is pre-allocated — a firefight must never allocate in the
// hot loop. Clocks here are seconds from performance.now(), matching the
// `now` the main loop passes into step().
import * as THREE from 'three';

const TRACER_POOL = 24;
const TRACER_LIFE = 0.09;
const SPARK_POOL = 8;
const SPARK_POINTS = 14;
const SPARK_LIFE = 0.35;
const EXPLOSION_SLOTS = 2;
const EXPLOSION_LIFE = 0.6;

export function createEffects(scene) {
  // --- tracers: one fading line per shot ---------------------------------
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i += 1) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const material = new THREE.LineBasicMaterial({
      color: 0xffc46b, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const line = new THREE.Line(geometry, material);
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, until: 0 });
  }
  let tracerNext = 0;

  // --- sparks: one burst of flying points per impact ----------------------
  const sparks = [];
  for (let i = 0; i < SPARK_POOL; i += 1) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARK_POINTS * 3), 3));
    const material = new THREE.PointsMaterial({
      color: 0xffd27a, size: 0.09, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    scene.add(points);
    sparks.push({ points, velocities: new Float32Array(SPARK_POINTS * 3), until: 0 });
  }
  let sparkNext = 0;

  // --- explosions: expanding sphere + point light -------------------------
  const explosions = [];
  for (let i = 0; i < EXPLOSION_SLOTS; i += 1) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 12),
      new THREE.MeshBasicMaterial({
        color: 0xff9a2e, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    );
    mesh.visible = false;
    scene.add(mesh);
    const light = new THREE.PointLight(0xff9a2e, 0, 26, 1.6);
    scene.add(light);
    explosions.push({ mesh, light, until: 0, start: 0 });
  }
  let explosionNext = 0;

  return {
    tracer(from, to, color = 0xffc46b) {
      const slot = tracers[tracerNext];
      tracerNext = (tracerNext + 1) % TRACER_POOL;
      const pos = slot.line.geometry.attributes.position;
      pos.setXYZ(0, from.x, from.y, from.z);
      pos.setXYZ(1, to.x, to.y, to.z);
      pos.needsUpdate = true;
      slot.line.material.color.setHex(color);
      slot.line.material.opacity = 0.9;
      slot.until = performance.now() / 1000 + TRACER_LIFE;
    },

    sparksAt(point, count = SPARK_POINTS) {
      const slot = sparks[sparkNext];
      sparkNext = (sparkNext + 1) % SPARK_POOL;
      const pos = slot.points.geometry.attributes.position;
      for (let i = 0; i < SPARK_POINTS; i += 1) {
        pos.setXYZ(i, point.x, point.y, point.z);
        const a = Math.random() * Math.PI * 2;
        const b = Math.random() * Math.PI - Math.PI / 2;
        const speed = 2 + Math.random() * 4;
        slot.velocities[i * 3] = Math.cos(a) * Math.cos(b) * speed;
        slot.velocities[i * 3 + 1] = Math.sin(b) * speed + 2;
        slot.velocities[i * 3 + 2] = Math.sin(a) * Math.cos(b) * speed;
      }
      pos.needsUpdate = true;
      slot.points.material.opacity = 1;
      slot.until = performance.now() / 1000 + SPARK_LIFE;
      slot.count = count;
    },

    explosion(point, now) {
      const slot = explosions[explosionNext];
      explosionNext = (explosionNext + 1) % EXPLOSION_SLOTS;
      slot.mesh.position.copy(point);
      slot.mesh.visible = true;
      slot.light.position.copy(point);
      slot.light.position.y += 1;
      slot.start = now;
      slot.until = now + EXPLOSION_LIFE;
    },

    step(now, dt) {
      for (const slot of tracers) {
        if (slot.until > 0 && now >= slot.until) {
          slot.line.material.opacity = 0;
          slot.until = 0;
        }
      }
      for (const slot of sparks) {
        if (slot.until <= 0) continue;
        if (now >= slot.until) {
          slot.points.material.opacity = 0;
          slot.until = 0;
          continue;
        }
        const pos = slot.points.geometry.attributes.position;
        for (let i = 0; i < SPARK_POINTS; i += 1) {
          slot.velocities[i * 3 + 1] -= 9 * dt;
          pos.setXYZ(
            i,
            pos.getX(i) + slot.velocities[i * 3] * dt,
            pos.getY(i) + slot.velocities[i * 3 + 1] * dt,
            pos.getZ(i) + slot.velocities[i * 3 + 2] * dt,
          );
        }
        pos.needsUpdate = true;
        slot.points.material.opacity = (slot.until - now) / SPARK_LIFE;
      }
      for (const slot of explosions) {
        if (slot.until <= 0) continue;
        const t = (now - slot.start) / EXPLOSION_LIFE;
        if (t >= 1) {
          slot.mesh.visible = false;
          slot.light.intensity = 0;
          slot.until = 0;
          continue;
        }
        const radius = 1 + t * 7;
        slot.mesh.scale.setScalar(radius);
        slot.mesh.material.opacity = 0.85 * (1 - t);
        slot.light.intensity = 260 * (1 - t);
      }
    },
  };
}
