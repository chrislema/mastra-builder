import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { parseDeliveryStructuredOutput } from '../../src/mastra/delivery-engine/structured-output.ts';

const sampleSchema = z.object({
  artifact_type: z.literal('sample'),
  items: z.array(z.string()),
});

test('parseDeliveryStructuredOutput prefers a valid response object', () => {
  const output = parseDeliveryStructuredOutput(
    sampleSchema,
    {
      object: {
        artifact_type: 'sample',
        items: ['one'],
      },
      text: 'not json',
    },
    'sample',
  );

  assert.deepEqual(output, {
    artifact_type: 'sample',
    items: ['one'],
  });
});

test('parseDeliveryStructuredOutput falls back to fenced JSON text', () => {
  const output = parseDeliveryStructuredOutput(
    sampleSchema,
    {
      text: 'Here is the result:\n```json\n{"artifact_type":"sample","items":["one","two"]}\n```',
    },
    'sample',
  );

  assert.deepEqual(output, {
    artifact_type: 'sample',
    items: ['one', 'two'],
  });
});

test('parseDeliveryStructuredOutput extracts balanced JSON from surrounding text', () => {
  const output = parseDeliveryStructuredOutput(
    sampleSchema,
    {
      text: 'Done. {"artifact_type":"sample","items":["alpha { beta }"]} Ready.',
    },
    'sample',
  );

  assert.deepEqual(output, {
    artifact_type: 'sample',
    items: ['alpha { beta }'],
  });
});

test('parseDeliveryStructuredOutput reports the delivery stage when no object or JSON is usable', () => {
  assert.throws(
    () =>
      parseDeliveryStructuredOutput(
        sampleSchema,
        {
          text: 'plain text only',
        },
        'planner',
      ),
    /planner returned invalid structured output: response\.object was undefined/,
  );
});
