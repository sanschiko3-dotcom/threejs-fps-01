// BLACKWATER DOCK — the build entrypoint for the make.fun threejs-fps-01
// bounty. It assembles the submission payload: it copies game/ and
// screenshots/ from beside this file into the output directory and writes
// /output/dossier.json with the vendored make.fun library, so the dossier
// the judge reads is built from exactly the files the player plays.
//
// The game itself is plain static files under game/ (three.js 0.187.0,
// vendored byte for byte) plus four real render screenshots. Node 22,
// standard library only — no build step, no bundler.
//
// Play it locally with `node serve.ts`, then open http://localhost:8080.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-threejs.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The scorer's own caps (reference/gate.json): text_max_bytes shapes the
// dossier bytes; the rest refuse an entry the scorer would refuse — more
// than 4 screenshots, one over 256 KiB, more than 993 game files, or more
// than 48 MiB of game files in all (game/ counts beside /output's own
// 1000-entry cap, its screenshots/ and dossier.json).
const LIMITS = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
};

function countFiles(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(join(dir, entry.name)) : 1;
  }
  return n;
}

function totalBytes(dir: string): number {
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    n += entry.isDirectory() ? totalBytes(p) : statSync(p).size;
  }
  return n;
}

// Refuse to build a payload the scorer would reject on sight: the check
// below mirrors the dossier builder's own gates, so a local run fails
// here with a plain message instead of silently shipping a bad entry.
const shotDir = join(here, 'screenshots');
const shots = existsSync(shotDir) ? readdirSync(shotDir).filter((f) => f.endsWith('.jpg')) : [];
if (shots.length === 0 || shots.length > LIMITS.screenshots.max) {
  throw new Error(`expected 1–${LIMITS.screenshots.max} screenshots, found ${shots.length}`);
}
for (const shot of shots) {
  const size = statSync(join(shotDir, shot)).size;
  if (size > LIMITS.screenshots.max_bytes) {
    throw new Error(`screenshot ${shot} is ${size} bytes, over the ${LIMITS.screenshots.max_bytes} cap`);
  }
}

mkdirSync(out, { recursive: true });
cpSync(join(here, 'game'), join(out, 'game'), { recursive: true });
mkdirSync(join(out, 'screenshots'), { recursive: true });
if (shots.length > 0) cpSync(shotDir, join(out, 'screenshots'), { recursive: true });

writeFileSync(join(out, 'dossier.json'), buildDossier(out, LIMITS));

// The dossier is the whole submission: refuse to report success if it did
// not land, or if its text — the part the scorer caps — is over the limit.
// (The file as a whole is larger than the text cap: it also carries the
// screenshots as base64 images, which the cap does not cover.)
const dossier = JSON.parse(readFileSync(join(out, 'dossier.json'), 'utf8'));
const dossierSize = statSync(join(out, 'dossier.json')).size;
if (typeof dossier.text !== 'string' || dossier.text.length > LIMITS.text_max_bytes) {
  throw new Error(`dossier text is ${dossier.text?.length ?? 0} chars, over the ${LIMITS.text_max_bytes} cap`);
}

// Short build summary on stdout so a local run shows at a glance that the
// entry copied cleanly. Pure reporting — it changes nothing in /output.
console.log(
  `BLACKWATER DOCK: ${countFiles(join(out, 'game'))} game files ` +
    `(${(totalBytes(join(out, 'game')) / 1048576).toFixed(2)} MiB), ` +
    `${shots.length} screenshots, dossier ${dossierSize} bytes -> ${out}`,
);
