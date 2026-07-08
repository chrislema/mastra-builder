import assert from 'node:assert/strict';
import test from 'node:test';
import {
  redactSecretsFromText,
  responseText,
  serializeAgentResponse,
} from '../../src/mastra/delivery-engine/agent-runtime/trace-artifacts';

test('responseText returns trimmed model text', () => {
  assert.equal(responseText({ text: '  done  ' }), 'done');
  assert.equal(responseText({ text: '   ' }), undefined);
  assert.equal(responseText(null), undefined);
});

test('agent response serialization redacts known environment secrets', () => {
  const secretName = 'DELIVERY_TRACE_TEST_SECRET';
  const secretValue = 'trace-secret-12345';
  const previous = process.env[secretName];
  process.env[secretName] = secretValue;

  try {
    const serialized = serializeAgentResponse({
      text: `token ${secretValue}`,
      object: { nested: secretValue },
      finishReason: 'stop',
      usage: { totalTokens: 42 },
      ignored: secretValue,
    });

    assert.deepEqual(serialized, {
      text: 'token [REDACTED]',
      object: { nested: '[REDACTED]' },
      finishReason: 'stop',
      usage: { totalTokens: 42 },
      warnings: undefined,
    });
    assert.equal(redactSecretsFromText(`x-${secretValue}-y`), 'x-[REDACTED]-y');
  } finally {
    if (previous === undefined) delete process.env[secretName];
    else process.env[secretName] = previous;
  }
});
