// Seeded randomness for BLACKWATER DOCK.
//
// One deterministic stream per match (and per screenshot capture) drives
// bot plans, spray jitter and smoke drift, so a match can be replayed
// exactly from its seed. Live matches seed from the clock; ?shot=
// captures read the seed out of the URL.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const next = mulberry32(seed);

  // Uniform float in [min, max).
  function range(min, max) {
    return min + next() * (max - min);
  }

  // Uniform integer in [min, max], both ends inclusive.
  function int(min, max) {
    return min + Math.floor(next() * (max - min + 1));
  }

  // One element of a non-empty list, uniformly.
  function pick(list) {
    return list[Math.floor(next() * list.length)];
  }

  // True with probability p.
  function chance(p) {
    return next() < p;
  }

  // Fisher-Yates shuffle, in place, returning the same list.
  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(next() * (i + 1));
      const held = list[i];
      list[i] = list[j];
      list[j] = held;
    }
    return list;
  }

  return { random: next, range, int, pick, chance, shuffle };
}
