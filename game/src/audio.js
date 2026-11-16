// Procedural sound: every effect is synthesized with WebAudio, so the
// game ships no audio files. All calls are safe before the first user
// gesture — the context is created lazily and resumes on the play click.
export function createAudio() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;

  // Build (or resume) the shared context and the one white-noise buffer
  // every filtered burst reuses. Returns null when audio is unavailable.
  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.4;
      master.connect(ctx.destination);
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    } catch {
      ctx = null;
    }
    return ctx;
  }

  // A burst of filtered noise with an exponential decay envelope.
  function noise({ duration, filterType = 'bandpass', frequency = 1800, q = 0.8, gain = 0.5, when = 0 }) {
    if (!ensure()) return;
    const t = ctx.currentTime + when;
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(gain, t);
    envelope.gain.exponentialRampToValueAtTime(0.001, t + duration);
    source.connect(filter).connect(envelope).connect(master);
    source.start(t);
    source.stop(t + duration + 0.05);
  }

  // A single oscillator blip, optionally gliding down in pitch.
  function tone({ frequency, endFrequency = null, duration, type = 'sine', gain = 0.3, when = 0 }) {
    if (!ensure()) return;
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, t);
    if (endFrequency !== null) osc.frequency.exponentialRampToValueAtTime(endFrequency, t + duration);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(gain, t);
    envelope.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(envelope).connect(master);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  // Per-weapon crack: a filtered noise burst shaped by the gun.
  const SHOT_TONE = {
    dagger: { frequency: 2600, gain: 0.5, duration: 0.09 },
    stinger: { frequency: 2100, gain: 0.42, duration: 0.08 },
    kestrel: { frequency: 1500, gain: 0.55, duration: 0.11 },
    longshot: { frequency: 900, gain: 0.7, duration: 0.22 },
  };

  return {
    unlock() {
      ensure();
    },

    shot(weaponId, distant = false) {
      const spec = SHOT_TONE[weaponId] || SHOT_TONE.kestrel;
      const scale = distant ? 0.35 : 1;
      noise({ ...spec, gain: spec.gain * scale });
      tone({ frequency: 160, endFrequency: 55, duration: 0.1, gain: 0.5 * scale });
    },

    dryFire() {
      tone({ frequency: 2200, duration: 0.03, type: 'square', gain: 0.12 });
    },

    reload() {
      tone({ frequency: 900, duration: 0.04, type: 'square', gain: 0.15 });
      tone({ frequency: 620, duration: 0.04, type: 'square', gain: 0.15, when: 0.18 });
      tone({ frequency: 1100, duration: 0.05, type: 'square', gain: 0.18, when: 0.45 });
    },

    hitmarker(kill) {
      tone({ frequency: kill ? 1560 : 1240, duration: 0.05, type: 'square', gain: 0.2 });
      if (kill) tone({ frequency: 1960, duration: 0.07, type: 'square', gain: 0.2, when: 0.06 });
    },

    plantBeep() {
      tone({ frequency: 1180, duration: 0.08, type: 'square', gain: 0.22 });
    },

    bombBeep() {
      tone({ frequency: 980, duration: 0.12, type: 'square', gain: 0.25 });
    },

    defuseBeep() {
      tone({ frequency: 1420, duration: 0.08, type: 'square', gain: 0.22 });
    },

    explosion() {
      noise({ duration: 0.9, filterType: 'lowpass', frequency: 420, gain: 0.9 });
      tone({ frequency: 120, endFrequency: 28, duration: 0.8, gain: 0.7 });
    },

    roundWin() {
      tone({ frequency: 523, duration: 0.14, type: 'triangle', gain: 0.25 });
      tone({ frequency: 784, duration: 0.22, type: 'triangle', gain: 0.25, when: 0.14 });
    },

    roundLose() {
      tone({ frequency: 392, duration: 0.16, type: 'triangle', gain: 0.25 });
      tone({ frequency: 262, duration: 0.26, type: 'triangle', gain: 0.25, when: 0.16 });
    },

    grenadeThrow() {
      noise({ duration: 0.12, filterType: 'highpass', frequency: 1200, gain: 0.2 });
    },
  };
}
