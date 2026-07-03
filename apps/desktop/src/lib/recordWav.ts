// Record mic audio and encode a 16 kHz mono 16-bit WAV (what whisper wants).
// Uses ScriptProcessor (deprecated but universally supported in WebView2).

export interface Recorder {
  stop: () => Promise<Blob>;
  cancel: () => void;
  elapsedMs: () => number;
}

export type AutoStopReason = "silence" | "max";

export interface RecordWavOptions {
  autoStopOnSilence?: boolean;
  silenceMs?: number;
  minRecordMs?: number;
  maxMs?: number;
  rmsThreshold?: number;
  onAutoStop?: (reason: AutoStopReason) => void;
  onLevel?: (rms: number) => void;
}

export async function recordWav(options: RecordWavOptions = {}): Promise<Recorder> {
  const autoStopOnSilence = options.autoStopOnSilence ?? false;
  const silenceMs = Math.max(300, options.silenceMs ?? 1200);
  const minRecordMs = Math.max(0, options.minRecordMs ?? 900);
  const maxMs = Math.max(1000, options.maxMs ?? 60000);
  const rmsThreshold = Math.max(0, options.rmsThreshold ?? 0.015);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext({ sampleRate: 16000 });
  const source = ctx.createMediaStreamSource(stream);
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  const startedAt = Date.now();
  let lastVoiceAt = startedAt;
  let stopped = false;
  let autoStopFired = false;
  let maxTimer: ReturnType<typeof setInterval> | null = null;

  const elapsedMs = () => Date.now() - startedAt;
  const fireAutoStop = (reason: AutoStopReason) => {
    if (stopped || autoStopFired) return;
    autoStopFired = true;
    options.onAutoStop?.(reason);
  };

  node.onaudioprocess = (e) => {
    const channel = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(channel));

    let sum = 0;
    for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i];
    const rms = Math.sqrt(sum / channel.length);
    options.onLevel?.(rms);

    const now = Date.now();
    if (rms >= rmsThreshold) lastVoiceAt = now;
    if (autoStopOnSilence && now - startedAt >= minRecordMs && now - lastVoiceAt >= silenceMs) {
      fireAutoStop("silence");
    }
  };
  source.connect(node);
  node.connect(ctx.destination);

  const teardown = () => {
    if (stopped) return;
    stopped = true;
    if (maxTimer) {
      clearInterval(maxTimer);
      maxTimer = null;
    }
    node.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  maxTimer = setInterval(() => {
    if (elapsedMs() >= maxMs) fireAutoStop("max");
  }, 100);

  return {
    stop: async () => {
      teardown();
      return encodeWav(chunks, ctx.sampleRate);
    },
    cancel: teardown,
    elapsedMs,
  };
}

export function createSilentWav(durationMs = 300, sampleRate = 16000): Blob {
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
  return encodeWav([new Float32Array(sampleCount)], sampleRate);
}

export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const pcm = new Float32Array(len);
  let o = 0;
  for (const c of chunks) {
    pcm.set(c, o);
    o += c.length;
  }
  const buf = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buf);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + len * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: "audio/wav" });
}
