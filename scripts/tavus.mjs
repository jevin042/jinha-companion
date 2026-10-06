import { readFileSync, writeFileSync } from 'node:fs';
const key = process.env.TAVUS_API_KEY;
if (!key) { console.error('Set TAVUS_API_KEY in .dev.vars first.'); process.exit(1); }
async function request(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`https://tavusapi.com/v2${path}`, {
    method, headers: { 'x-api-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Tavus returned HTTP ${response.status}. ${response.status === 409 ? 'Check for unpublished PAL Maker changes.' : 'Check account access and the documented API version.'}`);
  return response.json();
}
try {
  if (process.argv[2] === 'inspect') {
    const data = await request('/faces?limit=100');
    const list = Array.isArray(data) ? data : data.data || data.faces || [];
    console.log(JSON.stringify({ faces: list.map(x => ({ id: x.face_id, name: x.face_name, status: x.status, description: x.description, image: x.thumbnail_url })), note: 'Read-only check. No conversations started. Confirm minute allowance in Tavus billing/usage dashboard.' }, null, 2));
  } else if (process.argv[2] === 'sync') {
    if (!process.env.TAVUS_PAL_ID) throw new Error('Set TAVUS_PAL_ID before syncing.');
    const source = readFileSync(new URL('../worker/policy.ts', import.meta.url), 'utf8');
    const prompt = source.match(/export const personality = `([\s\S]*?)`;/)?.[1];
    if (!prompt) throw new Error('Personality configuration could not be loaded.');
    const pal = await request(`/pals/${process.env.TAVUS_PAL_ID}`);
    const changes = [
      { path: '/system_prompt', value: prompt },
      { path: '/layers/conversational_flow/turn_detection_model', value: 'sparrow-2' },
      { path: '/layers/conversational_flow/turn_taking_patience', value: 'low' },
      { path: '/layers/conversational_flow/idle_engagement', value: 'patient' },
      { path: '/layers/perception/perception_model', value: 'raven-1' },
      { path: '/layers/perception/emotion_recognition', value: 'auto' },
      { path: '/layers/perception/audio_awareness_queries', value: ['Does the participant sound sad, frustrated, amused, or neutral? Describe only cues actually present in their voice.'] },
    ];
    const operations = changes.filter(({ path, value }) => JSON.stringify(path.split('/').slice(1).reduce((part, segment) => part?.[segment], pal)) !== JSON.stringify(value))
      .map(({ path, value }) => ({ op: 'replace', path, value }));
    if (operations.length) await request(`/pals/${process.env.TAVUS_PAL_ID}`, operations, 'PATCH');
    console.log(`Jinha PAL synced (${operations.length} changed settings). No conversation was started.`);
  } else if (process.argv[2] === 'configure') {
    if (process.env.TAVUS_PAL_ID) throw new Error('A PAL is already configured. Inspect it before creating another.');
    if (!process.env.TAVUS_FACE_ID) throw new Error('Set TAVUS_FACE_ID after choosing an available stock face.');
    const source = readFileSync(new URL('../worker/policy.ts', import.meta.url), 'utf8');
    const prompt = source.match(/export const personality = `([\s\S]*?)`;/)?.[1];
    if (!prompt) throw new Error('Personality configuration could not be loaded.');
    const result = await request('/pals', {
      pal_name: 'Jinha', pipeline_mode: 'full', default_face_id: process.env.TAVUS_FACE_ID,
      system_prompt: prompt, languages: ['en', 'ko', 'es'], dynamic_greeting: true,
      layers: { perception: { perception_model: 'raven-1', emotion_recognition: 'auto', audio_awareness_queries: ['Does the participant sound sad, frustrated, amused, or neutral? Describe only cues actually present in their voice.'] }, ...(process.env.TAVUS_VOICE_ID ? { tts: { voice_id: process.env.TAVUS_VOICE_ID } } : {}) },
    });
    if (!result.pal_id) throw new Error('No PAL ID returned; check dashboard before retrying.');
    const file = new URL('../.dev.vars', import.meta.url);
    const current = readFileSync(file, 'utf8');
    const updated = /^TAVUS_PAL_ID=.*$/m.test(current) ? current.replace(/^TAVUS_PAL_ID=.*$/m, `TAVUS_PAL_ID=${result.pal_id}`) : `${current}\nTAVUS_PAL_ID=${result.pal_id}\n`;
    writeFileSync(file, updated);
    console.log('Jinha PAL created and saved locally. No conversation was started.');
  } else throw new Error('Use inspect, sync, or configure.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
