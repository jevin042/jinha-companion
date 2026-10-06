export type OpenMic = { pause(): void; resume(): void; mute(value: boolean): void; stop(): void };

// Local voice activity detection. Only finished utterances are sent for transcription.
export async function startOpenMic(onUtterance: (audio: Blob) => Promise<void>, onVoice: (active: boolean) => void): Promise<OpenMic> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  if (typeof MediaRecorder === 'undefined') { stream.getTracks().forEach(track => track.stop()); throw new Error('Audio recording is unavailable.'); }
  const context = new AudioContext();
  await context.resume();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find(type => MediaRecorder.isTypeSupported(type));
  let stopped = false;
  let paused = false;
  let muted = false;
  let recorder: MediaRecorder | null = null;
  let chunks: BlobPart[] = [];
  let speechFrames = 0;
  let speechStarted = 0;
  let lastVoice = 0;
  let noiseFloor = 0.007;

  function stopRecording(deliver: boolean) {
    const current = recorder;
    if (!current || current.state !== 'recording') return;
    recorder = null;
    onVoice(false);
    if (deliver) paused = true;
    current.onstop = () => {
      if (!deliver || stopped) { chunks = []; return; }
      const blob = new Blob(chunks, { type: current.mimeType || mime || 'audio/webm' });
      chunks = [];
      if (blob.size > 1500) void onUtterance(blob);
      else paused = false;
    };
    current.stop();
  }
  const timer = window.setInterval(() => {
    if (stopped || paused || muted) return;
    analyser.getFloatTimeDomainData(samples);
    let power = 0;
    for (const value of samples) power += value * value;
    const level = Math.sqrt(power / samples.length);
    const threshold = Math.max(0.012, noiseFloor * 2.2);
    const now = Date.now();
    if (!recorder && level < threshold) noiseFloor = noiseFloor * 0.97 + level * 0.03;
    if (level > threshold) { speechFrames++; lastVoice = now; } else speechFrames = 0;
    if (!recorder && speechFrames >= 2) {
      chunks = [];
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.start(); speechStarted = now; lastVoice = now;
      onVoice(true);
    }
    if (recorder && ((now - lastVoice > 900 && now - speechStarted > 650) || now - speechStarted > 15000)) {
      stopRecording(now - speechStarted > 500);
    }
  }, 80);
  return {
    pause() { paused = true; stopRecording(false); },
    resume() { if (!stopped && !muted) { paused = false; speechFrames = 0; } },
    mute(value) { muted = value; if (value) stopRecording(false); else if (!stopped) { paused = false; speechFrames = 0; } },
    stop() { stopped = true; window.clearInterval(timer); stopRecording(false); source.disconnect(); analyser.disconnect(); stream.getTracks().forEach(track => track.stop()); void context.close(); },
  };
}
