// BLACKWATER DOCK — a night container terminal, 64 x 48 m.
// Attackers (Jackals) spawn south and push north; defenders (Sentinels)
// spawn north and hold the two sites. Site A is the gantry crane in the
// north-west; site B is the warehouse in the north-east. Three lanes run
// north-south — the west quay, the container rows of mid, and the east
// alley — and the stacked containers break every long sightline so no
// single angle covers the whole yard.
//
// Coordinates: x east, z north is negative. Attackers face -z (yaw 0).
import * as THREE from 'three';
import { PALETTE, CONTAINER_COLORS } from './palette.js';

// Yard bounds, plant zones and round timings. rounds.js reads buyTime and
// roundTime from here, so the map is the single source of truth for them.
export const MAP = {
  bounds: { minX: -32, maxX: 32, minZ: -24, maxZ: 24 },
  siteA: { x: -22, z: -15, r: 5 },
  siteB: { x: 22, z: -15, r: 5 },
  roundTime: 100,
  buyTime: 12,
};

// Waypoint graph the bots route on. Nodes sit on open ground; every edge is
// a walkable straight line — no container or wall crosses one (the sim test
// proves all 289 node pairs reachable and every edge clear).
const WAYPOINTS = [
  { id: 'atkSpawn', x: 0, z: 20 },
  { id: 'defSpawn', x: 0, z: -20 },
  { id: 'midSouth', x: 0, z: 10 },
  { id: 'midCross', x: 0, z: 0 },
  { id: 'midNorth', x: 0, z: -10 },
  { id: 'westSouth', x: -26, z: 14 },
  { id: 'westMid', x: -26, z: 0 },
  { id: 'westNorth', x: -26, z: -11 },
  { id: 'eastSouth', x: 26, z: 14 },
  { id: 'eastMid', x: 26, z: 0 },
  { id: 'eastNorth', x: 26, z: -11 },
  { id: 'siteA', x: -22, z: -15 },
  { id: 'siteAEntry', x: -22, z: -7 },
  { id: 'siteB', x: 22, z: -15 },
  // siteBEntry sits at z -5.8, not -7: the diagonal from midNorth threads
  // between the east container row (z -8.05) and the warehouse west wall
  // (z -7.8) only in the window z -5.9..-5.6 (see sim test).
  { id: 'siteBEntry', x: 22, z: -5.8 },
  { id: 'boothWest', x: -5.5, z: 4 },
  { id: 'boothEast', x: 5.5, z: 4 },
];

// Edges are walkable straight lines by construction: midSouth reaches
// midCross around the inspection booth (via boothWest/boothEast), never
// through it; eastMid reaches eastNorth through the warehouse doorway
// (via siteBEntry), never through the warehouse wall. There is deliberately
// no midNorth -> eastNorth edge — eastNorth sits behind the warehouse west
// wall and is only reachable through the doorway.
const EDGES = [
  ['atkSpawn', 'midSouth'], ['atkSpawn', 'westSouth'], ['atkSpawn', 'eastSouth'],
  ['midSouth', 'boothWest'], ['midSouth', 'boothEast'],
  ['midCross', 'midNorth'], ['midCross', 'westMid'], ['midCross', 'eastMid'],
  ['midCross', 'boothWest'], ['midCross', 'boothEast'],
  ['midNorth', 'defSpawn'], ['midNorth', 'siteAEntry'], ['midNorth', 'siteBEntry'],
  ['midNorth', 'westNorth'],
  ['westSouth', 'westMid'], ['westMid', 'westNorth'], ['westNorth', 'siteAEntry'],
  ['siteAEntry', 'siteA'],
  ['eastSouth', 'eastMid'], ['eastMid', 'siteBEntry'], ['eastNorth', 'siteBEntry'],
  ['siteBEntry', 'siteB'],
];

// Containers: [x, z, levels, alongZ]. A container is 6.1 x 2.6 x 2.6 and
// levels stack straight up; alongZ turns it to run north-south. The table
// is ordered the way the yard was laid out — mid rows first, then the west
// quay, the east alley, and the south corners — and the paint colour cycles
// through CONTAINER_COLORS in this order. The z positions are chosen so
// every waypoint-graph edge crosses the rows through a gap, never through
// a container: the rows leave the centre band z -2..0.5 open for the
// midCross crossings, and the diagonals from midNorth cross at z -8.9 and
// -10.3, clear of both rows. The two three-high stacks crown mid and block
// the long sightlines.
const CONTAINERS = [
  [-8, -14, 2, true], [-8, -5, 3, true], [-8, 3.5, 2, true], [-8, 11, 1, true],
  [8, -14, 1, true], [8, -5, 2, true], [8, 3.5, 3, true], [8, 11, 2, true],
  // West quay: cover hugging the lane's east edge and the wall, never
  // across the lane itself — every waypoint edge must stay walkable.
  [-20, 8, 1, true], [-20, -2, 2, false], [-28, -9, 1, true], [-16, -19, 1, false],
  // East alley: same rule, mirrored.
  [20, 8, 2, true], [20, -2, 1, false], [28, -9, 2, true], [16, -19, 1, false],
  // South corners near attacker spawn.
  [-14, 19, 1, false], [14, 19, 2, false],
];

// Low crates: [x, z, width, height, depth] — crouch cover in the open
// ground between lanes.
const CRATES = [
  [-3.5, -6, 1.6, 0.9, 1.6], [3.5, -6, 1.6, 0.9, 1.6],
  [-13, 6, 1.2, 1.1, 1.2], [13, 6, 1.2, 1.1, 1.2],
  [-18, 4, 2.2, 0.7, 1.2], [18, 4, 2.2, 0.7, 1.2],
];

// Floodlight pole positions [x, z]. The two at z 3 sit off the z = 0
// midCross crossings; the one at (-4, -21) sits off the defSpawn waypoint.
const FLOODLIGHTS = [
  [-28, 18], [28, 18], [-28, -20], [28, -20], [-4, -21], [-14, 3], [14, 3],
];

export function createMap(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // One standard material per palette key. Accent and ink are a little
  // glossier; crane and concrete carry a touch of metalness.
  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'accent' || name === 'ink' ? 0.5 : 0.94,
      metalness: name === 'crane' || name === 'concrete' ? 0.25 : 0.03,
    });
  }
  // Lamp glass: emissive sodium orange, unlit by the scene lights.
  const lampMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.accent),
    emissive: new THREE.Color(PALETTE.accent),
    emissiveIntensity: 2.2,
    roughness: 0.4,
  });
  // Site rings: emissive orange so the plant zones read at night.
  const ringMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.accent),
    emissive: new THREE.Color(PALETTE.accent),
    emissiveIntensity: 0.9,
    roughness: 0.6,
    transparent: true,
    opacity: 0.85,
  });

  // Three views of the same solid geometry: three.js Box3 colliders for the
  // renderer, the meshes themselves for hitscan, and plain AABBs for the
  // JS-side maths (player slide, bot line-of-sight).
  const colliders = [];
  const shootables = [];
  const aabbs = [];

  // Place one box and, unless told otherwise, register it as solid in all
  // three views. opts.solid false skips collision (scenery outside the
  // yard); opts.noShadow skips casting shadows.
  function box(w, h, d, x, y, z, material, opts = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), materials[material]);
    mesh.position.set(x, y, z);
    mesh.castShadow = opts.noShadow !== true;
    mesh.receiveShadow = true;
    group.add(mesh);
    if (opts.solid !== false) {
      colliders.push(new THREE.Box3().setFromObject(mesh));
      shootables.push(mesh);
      aabbs.push({
        minX: x - w / 2, maxX: x + w / 2,
        minY: y - h / 2, maxY: y + h / 2,
        minZ: z - d / 2, maxZ: z + d / 2,
      });
    }
    return mesh;
  }

  // --- ground, walls, water -------------------------------------------------
  box(64.4, 0.4, 48.4, 0, -0.2, 0, 'surface'); // asphalt yard
  box(0.4, 4.6, 48.4, -32.2, 2.3, 0, 'concrete'); // west quay wall
  box(0.4, 4.6, 48.4, 32.2, 2.3, 0, 'concrete'); // east wall
  box(64.4, 4.6, 0.4, 0, 2.3, -24.2, 'concrete'); // north wall
  box(64.4, 4.6, 0.4, 0, 2.3, 24.2, 'concrete'); // south wall

  // Harbour water west of the quay, with a moored freighter silhouette.
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 60),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.water), roughness: 0.25, metalness: 0.55 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(-56, -0.35, 0);
  water.receiveShadow = true;
  group.add(water);
  box(30, 7, 8, -52, 3.2, -6, 'hairline', { solid: false, noShadow: true }); // freighter hull
  box(10, 4, 6, -52, 8.5, -6, 'concrete', { solid: false, noShadow: true }); // freighter bridge

  // --- containers -----------------------------------------------------------
  let colorIndex = 0;
  for (const [cx, cz, levels, alongZ] of CONTAINERS) {
    const color = CONTAINER_COLORS[colorIndex % CONTAINER_COLORS.length];
    colorIndex += 1;
    const w = alongZ ? 2.6 : 6.1;
    const d = alongZ ? 6.1 : 2.6;
    for (let level = 0; level < levels; level += 1) {
      box(w, 2.6, d, cx, 1.3 + level * 2.6, cz, color);
    }
  }

  // Inspection booth at mid: a 4 x 3 x 3 hut with a flat roof, passable both sides.
  box(4, 3, 3, 0, 1.5, 4, 'concrete');
  box(4.4, 0.25, 3.4, 0, 3.1, 4, 'hairline');

  // Low crates: crouch cover in the open ground between lanes.
  for (const [cx, cz, w, h, d] of CRATES) {
    box(w, h, d, cx, h / 2, cz, 'hairline');
  }

  // --- site A: gantry crane -------------------------------------------------
  const craneX = -22;
  const craneZ = -15;
  for (const [lx, lz] of [[-6, -3.5], [6, -3.5], [-6, 3.5], [6, 3.5]]) {
    box(0.9, 10, 0.9, craneX + lx, 5, craneZ + lz, 'crane');
  }
  box(13.5, 1, 1, craneX, 10.4, craneZ - 3.5, 'crane'); // top beam, north
  box(13.5, 1, 1, craneX, 10.4, craneZ + 3.5, 'crane'); // top beam, south
  box(1, 1, 8, craneX - 6, 10.4, craneZ, 'crane'); // cross beam, west
  box(1, 1, 8, craneX + 6, 10.4, craneZ, 'crane'); // cross beam, east
  box(2.2, 1.4, 2.2, craneX, 9.4, craneZ, 'crane'); // trolley
  // Hook cable + block hanging over the site.
  const cable = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6),
    materials.hairline,
  );
  cable.position.set(craneX, 7.6, craneZ);
  group.add(cable);
  box(1.1, 1.1, 1.1, craneX, 5.8, craneZ, 'crane');
  // Crane control cabin, south-west of the site, with a dark window slit.
  box(3.2, 2.6, 2.6, -25.5, 1.3, -18.5, 'concrete');
  box(3.3, 0.7, 0.1, -25.5, 1.9, -17.15, 'muted', { solid: false, noShadow: true });

  // --- site B: warehouse ----------------------------------------------------
  // Shell x 14..30, z -22..-8, 6 m high, open 6 m doorway on the south face.
  box(16.4, 6, 0.4, 22, 3, -22.2, 'concrete'); // north wall
  box(0.4, 6, 14.4, 13.8, 3, -15, 'concrete'); // west wall
  box(0.4, 6, 14.4, 30.2, 3, -15, 'concrete'); // east wall
  box(5.4, 6, 0.4, 16.7, 3, -7.8, 'concrete'); // south wall, west of door
  box(5.4, 6, 0.4, 27.3, 3, -7.8, 'concrete'); // south wall, east of door
  box(16.4, 0.3, 14.8, 22, 6.15, -15, 'hairline'); // roof slab
  // Interior crates and a rack along the north wall. The middle crate sits
  // west of the site line so the siteBEntry -> siteB walk stays clear.
  box(2, 1.4, 2, 18, 0.7, -19, 'ochre');
  box(2, 1.4, 2, 26, 0.7, -19, 'teal');
  box(1.4, 1, 1.4, 18.5, 0.5, -11, 'hairline');
  box(6, 2.2, 0.8, 22, 1.1, -21.4, 'hairline');

  // --- site rings -----------------------------------------------------------
  for (const site of [MAP.siteA, MAP.siteB]) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(site.r - 0.25, site.r, 40), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(site.x, 0.03, site.z);
    group.add(ring);
  }

  // --- floodlight poles + lamps --------------------------------------------
  for (const [fx, fz] of FLOODLIGHTS) {
    box(0.25, 7.5, 0.25, fx, 3.75, fz, 'hairline');
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.35, 0.5), lampMat);
    lamp.position.set(fx, 7.6, fz);
    group.add(lamp);
  }

  // --- lights ---------------------------------------------------------------
  // Cold moon key light, warm sodium fill, dim sky/ground gradient.
  // Brightened after the first browser capture read almost black: the night
  // stays night, but container faces and lane depth must stay readable.
  // Second pass (post-opening re-author): the play capture still lost the
  // booth face on the right to shadow, so the sky gradient and the moon
  // key both come up a notch and the mid pool gets stronger — the yard
  // reads at a glance now without the night turning to day.
  const sky = new THREE.HemisphereLight(new THREE.Color('#33415c'), new THREE.Color('#0a0e16'), 1.35);
  scene.add(sky);

  const moon = new THREE.DirectionalLight(new THREE.Color('#9db8dd'), 1.65);
  moon.position.set(-18, 26, 14);
  moon.target.position.set(4, 0, -6);
  moon.castShadow = true;
  // 1024 keeps the yard's shadows crisp enough and renders ~4x faster than
  // 2048 under software rasterisers, where this game is often first played.
  moon.shadow.mapSize.set(1024, 1024);
  moon.shadow.camera.left = -36;
  moon.shadow.camera.right = 36;
  moon.shadow.camera.top = 36;
  moon.shadow.camera.bottom = -36;
  moon.shadow.camera.far = 80;
  moon.shadow.bias = -0.0006;
  scene.add(moon, moon.target);

  const sodium = new THREE.DirectionalLight(new THREE.Color(PALETTE.accent), 1.0);
  sodium.position.set(14, 18, 18);
  scene.add(sodium);

  // Warm pools of light over the two sites and mid.
  const poolA = new THREE.PointLight(new THREE.Color(PALETTE.accent), 80, 24, 1.8);
  poolA.position.set(-22, 6.5, -15);
  scene.add(poolA);
  const poolB = new THREE.PointLight(new THREE.Color(PALETTE.accent), 60, 22, 1.8);
  poolB.position.set(22, 5, -15);
  scene.add(poolB);
  const poolMid = new THREE.PointLight(new THREE.Color('#ffd9a0'), 80, 20, 1.8);
  poolMid.position.set(0, 6.5, 4);
  scene.add(poolMid);

  // Waypoint lookup by id, plus an adjacency list built from EDGES.
  const nodes = new Map(WAYPOINTS.map((w) => [w.id, w]));
  const adjacency = new Map(WAYPOINTS.map((w) => [w.id, []]));
  for (const [a, b] of EDGES) {
    adjacency.get(a).push(b);
    adjacency.get(b).push(a);
  }

  return {
    colliders,
    shootables,
    aabbs,
    group,
    bounds: MAP.bounds,
    waypoints: { nodes, adjacency },
    spawns: {
      attack: [
        { x: -6, z: 20, yaw: 0 }, { x: -3, z: 21, yaw: 0 }, { x: 0, z: 20, yaw: 0 },
        { x: 3, z: 21, yaw: 0 }, { x: 6, z: 20, yaw: 0 },
      ],
      defend: [
        { x: -6, z: -20, yaw: Math.PI }, { x: -3, z: -21, yaw: Math.PI },
        { x: 0, z: -20, yaw: Math.PI }, { x: 3, z: -21, yaw: Math.PI },
        { x: 6, z: -20, yaw: Math.PI },
      ],
    },
    sites: MAP,
  };
}

// Segment vs AABB test in the XZ plane with a vertical band: does the segment
// from a to b (both {x, y, z}) pass through any solid box? Used for bot
// line-of-sight so perception never needs a three.js raycast in the hot loop.
//
// Slab method, one axis at a time: intersect the segment's parameter range
// [t0, t1] with each axis slab. A zero delta means the segment runs parallel
// to that axis — then it is blocked on that axis only if it starts outside
// the slab. If the range survives all three axes and overlaps [0, 1], the
// segment passes through the box.
export function segmentBlocked(a, b, aabbs) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  for (const box of aabbs) {
    let t0 = 0;
    let t1 = 1;
    let blocked = true;
    const slabs = [
      [a.x, dx, box.minX, box.maxX],
      [a.y, dy, box.minY, box.maxY],
      [a.z, dz, box.minZ, box.maxZ],
    ];
    for (const [origin, delta, min, max] of slabs) {
      if (Math.abs(delta) < 1e-9) {
        if (origin < min || origin > max) { blocked = false; break; }
      } else {
        let ta = (min - origin) / delta;
        let tb = (max - origin) / delta;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) { blocked = false; break; }
      }
    }
    if (blocked && t0 <= 1 && t1 >= 0) return true;
  }
  return false;
}

// Breadth-first route over the waypoint graph, from the node nearest `from`
// to the node nearest `to`. Returns a list of {x, z} waypoints (excluding the
// start node itself), or null when no route exists. The route always ends on
// the exact destination, not just the nearest waypoint.
export function findRoute(waypoints, from, to) {
  const { nodes, adjacency } = waypoints;
  let startId = null;
  let startDist = Infinity;
  let goalId = null;
  let goalDist = Infinity;
  for (const node of nodes.values()) {
    const dFrom = (node.x - from.x) ** 2 + (node.z - from.z) ** 2;
    if (dFrom < startDist) { startDist = dFrom; startId = node.id; }
    const dTo = (node.x - to.x) ** 2 + (node.z - to.z) ** 2;
    if (dTo < goalDist) { goalDist = dTo; goalId = node.id; }
  }
  if (startId === null || goalId === null) return null;
  const prev = new Map([[startId, null]]);
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === goalId) break;
    for (const next of adjacency.get(current)) {
      if (!prev.has(next)) {
        prev.set(next, current);
        queue.push(next);
      }
    }
  }
  if (!prev.has(goalId)) return null;
  const path = [];
  let nodeId = goalId;
  while (nodeId !== null && nodeId !== startId) {
    path.unshift(nodes.get(nodeId));
    nodeId = prev.get(nodeId);
  }
  path.push({ x: to.x, z: to.z });
  return path;
}
