// Short chat sounds made with the Web Audio API: no audio files, nothing loaded from outside.
// Sent: a higher, quick pop. Received: a lower, softer pop. Browsers only start audio after a click or key press,
// and sending a question is such a press, so the first send opens the audio context.
let ctx = null;

function audio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function pop({ from, to, dur, vol }) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

export function playSend() {
  pop({ from: 880, to: 1320, dur: 0.09, vol: 0.06 });
}

// Opens the audio context during a click, so a sound that plays much later (a long Generate) is not blocked.
export function primeSound() {
  audio();
}

export function playReceive() {
  pop({ from: 620, to: 480, dur: 0.14, vol: 0.05 });
}
