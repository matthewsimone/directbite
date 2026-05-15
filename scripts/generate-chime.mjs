// Generates public/chime.wav matching the synthesized chime in the old
// useOrderPolling.js (A5 → C#6 → E6 sine arpeggio, 0.05s attack /
// 0.55s decay envelope per note, 80ms stagger, peak gain 0.3).
//
// Output is 3 seconds total = 0.86s chime + 2.14s silence so the audio
// element's `loop` attribute reproduces the original 3-second cadence
// without needing a setInterval.
//
// 22050 Hz mono 16-bit PCM keeps the file small (~66KB) while staying
// well above the 7-8kHz needed for the highest oscillator (E6 ≈ 1318Hz
// — Nyquist comfortably clears it).

import { writeFileSync, mkdirSync } from 'fs'

const SAMPLE_RATE = 22050
const DURATION = 3.0
const NUM_SAMPLES = Math.floor(SAMPLE_RATE * DURATION)
const FREQUENCIES = [880, 1108.73, 1318.51]
const STAGGER = 0.08
const ATTACK = 0.05
const RELEASE = 0.55
const PEAK = 0.3

const samples = new Float32Array(NUM_SAMPLES)

for (let n = 0; n < FREQUENCIES.length; n++) {
  const freq = FREQUENCIES[n]
  const start = n * STAGGER
  const peakTime = start + ATTACK
  const endTime = start + ATTACK + RELEASE
  const startSample = Math.floor(start * SAMPLE_RATE)
  const endSample = Math.min(Math.floor(endTime * SAMPLE_RATE), NUM_SAMPLES)
  for (let i = startSample; i < endSample; i++) {
    const t = i / SAMPLE_RATE
    let gain
    if (t < peakTime) gain = PEAK * (t - start) / ATTACK
    else gain = PEAK * (1 - (t - peakTime) / RELEASE)
    samples[i] += gain * Math.sin(2 * Math.PI * freq * t)
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
writeFileSync('public/chime.wav', buffer)
console.log(`Wrote public/chime.wav — ${buffer.length} bytes (${(buffer.length/1024).toFixed(1)} KB)`)
