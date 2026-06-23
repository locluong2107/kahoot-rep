// Sound engine using WebAudio — no audio files needed.
// Generates lobby music (looped chord progression) and sound effects on demand.
// Exposed globally as window.Sound.

(function () {
  let ctx = null;
  let masterGain = null;
  let musicGain = null;
  let sfxGain = null;
  let musicTimer = null;
  let musicEnabled = true;
  let sfxEnabled = true;

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.7;
    masterGain.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.18;
    musicGain.connect(masterGain);
    sfxGain = ctx.createGain();
    sfxGain.gain.value = 0.55;
    sfxGain.connect(masterGain);
    return ctx;
  }

  // Browsers require a user gesture before audio plays. Call resume() inside a click handler.
  function resume() {
    ensureCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  // ----- low level helpers -----
  function tone({ freq, dur, type = 'sine', attack = 0.005, release = 0.1, vol = 0.4, when = 0, dest }) {
    if (!ensureCtx()) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + attack);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    osc.connect(g);
    g.connect(dest || sfxGain);
    osc.start(t0);
    osc.stop(t0 + dur + release);
  }

  function noiseBurst({ dur = 0.15, vol = 0.3, when = 0 }) {
    if (!ensureCtx()) return;
    const t0 = ctx.currentTime + when;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g); g.connect(sfxGain);
    src.start(t0);
  }

  // ----- sound effects -----
  const SFX = {
    join() {
      if (!sfxEnabled) return;
      tone({ freq: 523, dur: 0.08, type: 'triangle', vol: 0.4 });
      tone({ freq: 784, dur: 0.12, type: 'triangle', vol: 0.4, when: 0.07 });
    },
    click() {
      if (!sfxEnabled) return;
      tone({ freq: 660, dur: 0.05, type: 'square', vol: 0.25 });
    },
    questionStart() {
      if (!sfxEnabled) return;
      // ascending arpeggio
      [392, 523, 659, 784].forEach((f, i) => tone({ freq: f, dur: 0.12, type: 'sawtooth', vol: 0.3, when: i * 0.07 }));
    },
    tick() {
      if (!sfxEnabled) return;
      tone({ freq: 880, dur: 0.04, type: 'square', vol: 0.15 });
    },
    timesUp() {
      if (!sfxEnabled) return;
      tone({ freq: 220, dur: 0.4, type: 'sawtooth', vol: 0.35 });
      tone({ freq: 165, dur: 0.5, type: 'sawtooth', vol: 0.35, when: 0.1 });
    },
    correct() {
      if (!sfxEnabled) return;
      [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.14, type: 'triangle', vol: 0.45, when: i * 0.08 }));
    },
    wrong() {
      if (!sfxEnabled) return;
      tone({ freq: 311, dur: 0.18, type: 'sawtooth', vol: 0.35 });
      tone({ freq: 233, dur: 0.3, type: 'sawtooth', vol: 0.35, when: 0.14 });
    },
    reveal() {
      if (!sfxEnabled) return;
      tone({ freq: 660, dur: 0.1, type: 'triangle', vol: 0.35 });
      tone({ freq: 880, dur: 0.16, type: 'triangle', vol: 0.35, when: 0.08 });
    },
    podium() {
      if (!sfxEnabled) return;
      // little fanfare
      const notes = [523, 659, 784, 659, 784, 1047, 1319];
      notes.forEach((f, i) => tone({ freq: f, dur: 0.18, type: 'triangle', vol: 0.5, when: i * 0.12 }));
      noiseBurst({ dur: 0.4, vol: 0.15, when: notes.length * 0.12 });
    },
  };

  // ----- lobby music -----
  // Simple I-vi-IV-V loop in C major with a wandering melody. Pleasant, low-stakes.
  function startMusic() {
    if (!musicEnabled) return;
    ensureCtx();
    if (musicTimer) return;
    const chords = [
      [261.63, 329.63, 392.00], // C
      [220.00, 261.63, 329.63], // Am
      [174.61, 220.00, 261.63], // F
      [196.00, 246.94, 293.66], // G
    ];
    const melody = [523.25, 659.25, 587.33, 523.25, 493.88, 587.33, 659.25, 523.25];
    let step = 0;
    const bpm = 92;
    const beat = 60 / bpm; // seconds per beat
    const tick = () => {
      if (!ctx || !musicEnabled) return;
      const chord = chords[Math.floor(step / 4) % chords.length];
      // pad chord
      chord.forEach(f => tone({ freq: f, dur: beat * 3.5, type: 'sine', vol: 0.08, attack: 0.05, release: 0.3, dest: musicGain }));
      // gentle melody every other beat
      if (step % 2 === 0) {
        const m = melody[Math.floor(step / 2) % melody.length];
        tone({ freq: m, dur: beat * 0.9, type: 'triangle', vol: 0.07, attack: 0.02, dest: musicGain });
      }
      step++;
    };
    tick();
    musicTimer = setInterval(tick, beat * 1000 * 4); // every full chord
  }
  function stopMusic() {
    if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    if (musicGain) {
      // quick fade
      const t = ctx.currentTime;
      musicGain.gain.cancelScheduledValues(t);
      musicGain.gain.setValueAtTime(musicGain.gain.value, t);
      musicGain.gain.linearRampToValueAtTime(0, t + 0.4);
      setTimeout(() => { if (musicGain) musicGain.gain.value = 0.18; }, 600);
    }
  }

  window.Sound = {
    resume,
    play(name) { resume(); if (SFX[name]) SFX[name](); },
    startMusic() { resume(); startMusic(); },
    stopMusic,
    setMusic(on) { musicEnabled = on; if (!on) stopMusic(); },
    setSfx(on) { sfxEnabled = on; },
    isMusicOn() { return musicEnabled; },
    isSfxOn() { return sfxEnabled; },
  };
})();
