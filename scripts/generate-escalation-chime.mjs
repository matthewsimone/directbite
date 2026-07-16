// Generates public/escalation-chime.wav — the ESCALATION alert tone, used for
// orders acknowledged but not yet marked in-progress. It must sound clearly
// DISTINCT from the new-order chime (generate-chime.mjs, a gentle ascending
// A-major arpeggio at 880–1318 Hz). So this is deliberately the opposite:
//
//   - LOWER pitch (A4 440 / E5 660) so it reads as more serious, not brighter.
//   - A staccato two-tone "nee-naw" siren that ALTERNATES A4↔E5 six times,
//     rather than a single ascending sweep that rings out.
//   - A little octave harmonic per beep for a harder, alarm-like timbre
//     (vs the pure-sine chime).
//   - A SHORTER 2.0s file (vs 3.0s), so the audio element's `loop` repeats it
//     faster — an insistent nag, not an occasional ding.
//
// Same synthesis approach as generate-chime.mjs: 22050 Hz mono 16-bit PCM,
// hand-written WAV header, no ffmpeg / lamejs. Nyquist (11025 Hz) clears the
// highest partial (E5 octave = 1320 Hz) comfortably.

import { writeFileSync, mkdirSync } from 'fs'

const SAMPLE_RATE = 22050
const DURATION = 2.0 // shorter than the 3.0s chime → faster, more insistent loop
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * DURATION)

// Two-tone siren: alternate low/high for each beep.
const TONE_LOW = 440.0    // A4
const TONE_HIGH = 660.0   // E5 (a perfect fifth above — the classic siren interval)
const NUM_BEEPS = 6
const BEEP_DUR = 0.16     // staccato — short and clipped, unlike the chime's ring-out
const BEEP_GAP = 0.02     // brief silence between beeps for articulation
const ATTACK = 0.01       // near-instant onset (percussive, urgent)
const PEAK = 0.32         // ~matches the chime's 0.3 loudness
const HARMONIC = 0.3      // octave partial amplitude (relative to fundamental) → harder timbre

const samples = new Float32Array(NUM_SAMPLES)

for (let b = 0; b < NUM_BEEPS; b++) {
  const freq = b % 2 === 0 ? TONE_LOW : TONE_HIGH
  const start = b * (BEEP_DUR + BEEP_GAP)
  const peakTime = start + ATTACK
  const endTime = start + BEEP_DUR
  const startSample = Math.floor(start * SAMPLE_RATE)
  const endSample = Math.min(Math.floor(endTime * SAMPLE_RATE), NUM_SAMPLES)
  for (let i = startSample; i < endSample; i++) {
    const t = i / SAMPLE_RATE
    // Fast attack, then linear decay to the end of the beep (staccato envelope).
    let gain
    if (t < peakTime) gain = PEAK * (t - start) / ATTACK
    else gain = PEAK * (1 - (t - peakTime) / (endTime - peakTime))
    const wave = Math.sin(2 * Math.PI * freq * t) + HARMONIC * Math.sin(2 * Math.PI * 2 * freq * t)
    samples[i] += gain * wave
  }
}

const pcm = new Int16Array(NUM_SAMPLES)
for (let i = 0; i < NUM_SAMPLES; i++) {
  const clipped = Math.max(-1, Math.min(1, samples[i]))
  pcm[i] = Math.round(clipped * 32767)
}

const pcmBytes = Buffer.from(pcm.buffer)
const buffer = Buffer.alloc(44 + pcmBytes.length)
buffer.write('RIFF', 0)
buffer.writeUInt32LE(36 + pcmBytes.length, 4)
buffer.write('WAVE', 8)
buffer.write('fmt ', 12)
buffer.writeUInt32LE(16, 16)
buffer.writeUInt16LE(1, 20)            // PCM
buffer.writeUInt16LE(1, 22)            // mono
buffer.writeUInt32LE(SAMPLE_RATE, 24)
buffer.writeUInt32LE(SAMPLE_RATE * 2, 28)
buffer.writeUInt16LE(2, 32)            // block align
buffer.writeUInt16LE(16, 34)           // bits per sample
buffer.write('data', 36)
buffer.writeUInt32LE(pcmBytes.length, 40)
pcmBytes.copy(buffer, 44)

mkdirSync('public', { recursive: true })
writeFileSync('public/escalation-chime.wav', buffer)
console.log(`Wrote public/escalation-chime.wav — ${buffer.length} bytes (${(buffer.length/1024).toFixed(1)} KB), ${DURATION}s @ ${SAMPLE_RATE}Hz`)
