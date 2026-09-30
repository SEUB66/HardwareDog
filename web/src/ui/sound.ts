/**
 * One short low electronic beep (spec 09). Off by default.
 * Browsers may block audio before a user gesture; that is not an error.
 */
export function beep(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 220;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.005);
    gain.gain.setValueAtTime(0.06, t + 0.07);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.1);
    osc.onended = () => void ctx.close();
  } catch {
    // No audio device or blocked by the browser: stay silent.
  }
}
