const SOUND_KEY = "quizroom_sound_enabled";
let audioContext = null;

export function isSoundEnabled() {
  return localStorage.getItem(SOUND_KEY) !== "false";
}

export function setSoundEnabled(enabled) {
  localStorage.setItem(SOUND_KEY, String(enabled));
}

function getAudioContext() {
  if (audioContext) return audioContext;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  audioContext = new AudioContext();
  return audioContext;
}

function tone(context, frequency, start, duration, volume = 0.07, type = "sine") {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export function playSound(kind) {
  if (!isSoundEnabled()) return;
  try {
    const context = getAudioContext();
    if (!context) return;
    if (context.state === "suspended") context.resume();
    const now = context.currentTime + 0.01;
    const patterns = {
      join: [[440, 0, 0.09], [660, 0.1, 0.13]],
      question: [[523, 0, 0.1], [659, 0.1, 0.1], [784, 0.2, 0.16]],
      tick: [[880, 0, 0.07, 0.045, "square"]],
      correct: [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.2]],
      wrong: [[220, 0, 0.18, 0.06, "sawtooth"], [174, 0.14, 0.22, 0.05, "sawtooth"]],
      closed: [[392, 0, 0.1], [330, 0.1, 0.15]],
      finish: [[523, 0, 0.13], [659, 0.12, 0.13], [784, 0.24, 0.13], [1047, 0.38, 0.3]]
    };
    for (const [frequency, offset, duration, volume, type] of patterns[kind] || patterns.join) {
      tone(context, frequency, now + offset, duration, volume, type);
    }
  } catch {
    // Звук — необязательное улучшение и не должен мешать игре.
  }
}
