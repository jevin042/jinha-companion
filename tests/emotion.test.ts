import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiText, emotionalReply } from '../worker/index';

test('nested model replies are extracted without object coercion', () => {
  const value = { response: { emotion: 'sad', reply: 'I am sorry to hear that.' } };
  assert.deepEqual(emotionalReply(aiText(value), 'I feel sad'), { emotion: 'sad', reply: 'I am sorry to hear that.' });
});

test('distress overrides an inappropriately cheerful model emotion', () => {
  const answer = emotionalReply('{"emotion":"excited","reply":"That sounds hard."}', 'My friend died.');
  assert.equal(answer.emotion, 'sad');
});

test('invalid Tavus emotion values do not reach the video stream', () => {
  const answer = emotionalReply('{"emotion":"happy","reply":"Great news!"}', 'I got the job.');
  assert.equal(answer.emotion, 'neutral');
});
