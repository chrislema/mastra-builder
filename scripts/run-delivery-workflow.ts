import { parseArgs } from 'node:util';
import { mastra } from '../src/mastra/index';
import { startDeliveryWorkflowRun } from '../src/mastra/delivery-engine/runner';

function usage() {
  return `Usage:
  npm run delivery:run -- --repo /absolute/path --vision vision.md --spec spec.md

Options:
  --repo, --repoPath       Target repository workspace. Required.
  --vision, --visionPath   Vision document path. Defaults to vision.md.
  --spec, --specPath       Spec document path. Defaults to spec.md.
  --deploy, --deployMode   mock or real. Defaults to mock.
  --maxRetries             Bounded retry count. Defaults to 2.
  --resourceId             Optional Mastra workflow resource id.
  --runId                  Optional Mastra workflow run id.
  --no-includeState        Omit native workflow state from the result.
`;
}

const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    repoPath: { type: 'string' },
    vision: { type: 'string' },
    visionPath: { type: 'string' },
    spec: { type: 'string' },
    specPath: { type: 'string' },
    deploy: { type: 'string' },
    deployMode: { type: 'string' },
    maxRetries: { type: 'string' },
    resourceId: { type: 'string' },
    runId: { type: 'string' },
    includeState: { type: 'boolean', default: true },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: false,
});

try {
  if (values.help) {
    console.log(usage());
    process.exit(0);
  }

  const repoPath = values.repoPath ?? values.repo;
  if (!repoPath) {
    console.error(usage());
    process.exit(1);
  }

  const response = await startDeliveryWorkflowRun(mastra, {
    repoPath,
    visionPath: values.visionPath ?? values.vision,
    specPath: values.specPath ?? values.spec,
    deployMode: values.deployMode ?? values.deploy,
    maxRetries: values.maxRetries === undefined ? undefined : Number(values.maxRetries),
    resourceId: values.resourceId,
    runId: values.runId,
    includeState: values.includeState,
  });

  console.log(JSON.stringify(response, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await mastra.shutdown();
}
