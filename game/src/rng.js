// Deterministic randomness: mulberry32, seeded per match (and per screenshot
// capture) so bot plans, spray patterns and smoke drift can be replayed exactly.
// Live play seeds from the clock; ?shot= captures seed from the URL.
export function mulberry32(initial) {
  let a = initial >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const random = mulberry32(seed);
  return {
    random,
    // Uniform in [min, max).
    range(min, max) {
      return min + random() * (max - min);
    },
    // Integer in [min, max] inclusive.
    int(min, max) {
      return min + Math.floor(random() * (max - min + 1));
    },
    // Pick one element of a non-empty array.
    pick(array) {
      return array[Math.floor(random() * array.length)];
    },
    // True with probability p.
    chance(p) {
      return random() < p;
    },
    // Fisher-Yates shuffle, in place, returning the same array.
    shuffle(array) {
      for (let i = array.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        const tmp = array[i];
        array[i] = array[j];
        array[j] = tmp;
      }
      return array;
    },
  };
}
