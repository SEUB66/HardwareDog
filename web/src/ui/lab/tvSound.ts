/**
 * The TV's optional sounds: a click and a short static hiss on power on,
 * a click and a falling whine on power off. Off by default; a blocked
 * audio context is not an error.
 */
export function tvSound(kind: 'on' | 'off'): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    // the click
    const click = ctx.createOscillator();
    click.type = 'square';
    click.frequency.value = 90;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.08, t);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    click.connect(cg).connect(ctx.destination);
    click.start(t);
    click.stop(t + 0.05);
    if (kind === 'on') {
      // static: a fraction of a second of noise
      const len = Math.floor(ctx.sampleRate * 0.35);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      gain.gain.setValueAtTime(0.03, t + 0.6);
      src.connect(gain);
      src.start(t + 0.6);
    } else {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2400, t);
      osc.frequency.exponentialRampToValueAtTime(200, t + 0.5);
      gain.gain.setValueAtTime(0.02, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      osc.connect(gain);
      osc.start(t);
      osc.stop(t + 0.55);
    }
    setTimeout(() => void ctx.close(), 1500);
  } catch {
    // no audio device, or blocked: stay silent
  }
}
