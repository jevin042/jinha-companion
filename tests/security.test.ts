import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { type Env } from '../worker/index';
import { billedSeconds, isPublicSupabaseKey, languageOrder, reserveSeconds } from '../worker/policy';

test('language choice changes opening order without dropping other supported languages', () => {
  assert.deepEqual(languageOrder('ko'), ['ko', 'en', 'es']);
  assert.throws(() => languageOrder('ar'));
});
test('session allocation respects both per-user and shared credit ceilings including buffer', () => {
  assert.deepEqual(reserveSeconds(1200, 900, 300), { duration: 300, reserved: 330 });
  assert.deepEqual(reserveSeconds(100, 900, 300), { duration: 70, reserved: 100 });
  assert.deepEqual(reserveSeconds(900, 80, 300), { duration: 50, reserved: 80 });
  assert.throws(() => reserveSeconds(40, 900, 300));
});
test('cleanup never refunds below minimum billing or charges more than reserved', () => {
  assert.equal(billedSeconds(0, 1000, 330), 30);
  assert.equal(billedSeconds(0, 61000, 330), 72);
  assert.equal(billedSeconds(0, 900000, 330), 330);
});
test('secret or service-role keys cannot be sent to browsers', async () => {
  const key = `header.${btoa(JSON.stringify({ role: 'service_role' }))}.signature`;
  assert.equal(isPublicSupabaseKey(key), false);
  assert.equal(isPublicSupabaseKey('sb_secret_private'), false);
  const response = await worker.fetch(new Request('https://demo.test/api/config'), { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: key, TAVUS_API_KEY: 'private-tavus-key' } as Env);
  const body = await response.text();
  assert.equal(body.includes(key), false);
  assert.equal(body.includes('private-tavus-key'), false);
  assert.equal(JSON.parse(body).supabaseKey, '');
});
test('cross-origin call creation is rejected before authentication or billing', async () => {
  const response = await worker.fetch(new Request('https://demo.test/api/start', { method: 'POST', headers: { Origin: 'https://attacker.test', 'Content-Type': 'application/json' }, body: '{}' }), {} as Env);
  assert.equal(response.status, 403);
});
test('unauthenticated users cannot query session state', async () => {
  const response = await worker.fetch(new Request('https://demo.test/api/status'), { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_example' } as Env);
  assert.equal(response.status, 401);
});
test('audio transcription requires same origin and an invited sign-in', async () => {
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_example' } as Env;
  const crossOrigin = await worker.fetch(new Request('https://demo.test/api/transcribe?id=x', { method: 'POST', headers: { Origin: 'https://attacker.test', 'Content-Type': 'audio/webm' }, body: 'audio' }), env);
  assert.equal(crossOrigin.status, 403);
  const anonymous = await worker.fetch(new Request('https://demo.test/api/transcribe?id=x', { method: 'POST', headers: { Origin: 'https://demo.test', 'Content-Type': 'audio/webm' }, body: 'audio' }), env);
  assert.equal(anonymous.status, 401);
});
