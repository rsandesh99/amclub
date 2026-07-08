/**
 * Client-side WAV recorder (Phase 8b hotfix). Sarvam's REST API rejects
 * MediaRecorder's WebM/Opus outright ("Invalid file type: audio/webm" — seen
 * in ai_invocations 2026-07-07/08), and WebM blobs carry the Chromium
 * infinite-duration metadata bug. Capturing raw PCM via Web Audio and encoding
 * WAV ourselves fixes both: a vendor-accepted format AND a correct duration
 * header, identically on every browser.
 *
 * 16 kHz mono 16-bit (Sarvam's preferred rate): 60 s ≈ 1.92 MB — under the
 * server's 3 MB cap. ScriptProcessorNode is deprecated but universally
 * supported and needs no worklet module; fine for ≤60 s voice memos.
 */

const TARGET_RATE = 16_000

export interface WavRecorderHandle {
  /** Stop capturing and return the encoded WAV. */
  stop: () => Promise<{ blob: Blob; durationMs: number }>
}

export async function startWavRecording(stream: MediaStream): Promise<WavRecorderHandle> {
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  // 4096-frame buffers ≈ 85 ms at 48 kHz — small enough for a live UI.
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let frames = 0

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(input))
    frames += input.length
  }

  source.connect(processor)
  // Chromium only runs a ScriptProcessor that is connected to the destination.
  processor.connect(ctx.destination)

  return {
    async stop() {
      processor.disconnect()
      source.disconnect()
      const sourceRate = ctx.sampleRate
      await ctx.close()

      const pcm = mergeChunks(chunks, frames)
      const down = downsample(pcm, sourceRate, TARGET_RATE)
      return {
        blob: encodeWav(down, TARGET_RATE),
        durationMs: Math.round((down.length / TARGET_RATE) * 1000),
      }
    },
  }
}

function mergeChunks(chunks: Float32Array[], frames: number): Float32Array {
  const out = new Float32Array(frames)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Average-pooling downsample — plenty for speech into a 16 kHz STT model. */
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLength = Math.floor(input.length / ratio)
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.floor((i + 1) * ratio), input.length)
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]!
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)

  const writeString = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }

  return new Blob([buffer], { type: 'audio/wav' })
}
