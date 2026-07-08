import {
  auditDeliveryTaskPlan,
  formatSmellAuditReport,
  resolveSmellAuditInput,
} from '../src/mastra/delivery-engine/smell-audit';

type ParsedArgs = {
  projectFolder: string;
  taskPlanPath?: string;
  json: boolean;
  failOnSmells: boolean;
  performed: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    projectFolder: process.cwd(),
    json: false,
    failOnSmells: false,
    performed: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if ((arg === '--projectFolder' || arg === '--project-folder' || arg === '--repo') && next) {
      parsed.projectFolder = next;
      index += 1;
      continue;
    }
    if (arg === '--taskPlan' || arg === '--task-plan') {
      if (!next) throw new Error(`${arg} requires a path`);
      parsed.taskPlanPath = next;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--fail-on-smells') {
      parsed.failOnSmells = true;
      continue;
    }
    if (arg === '--assume-typecheck') {
      parsed.performed.push('npm run typecheck passed');
      continue;
    }
    if (arg === '--assume-tests') {
      parsed.performed.push('npm test passed');
      continue;
    }
    if (arg === '--performed') {
      if (!next) throw new Error('--performed requires evidence text');
      parsed.performed.push(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const input = resolveSmellAuditInput({
  projectFolder: args.projectFolder,
  taskPlanPath: args.taskPlanPath,
});
const report = auditDeliveryTaskPlan({
  repoPath: input.repoPath,
  taskPlan: input.taskPlan,
  taskPlanPath: input.taskPlanPath,
  verification: { performed: args.performed, missing: [] },
});

console.log(args.json ? JSON.stringify(report, null, 2) : formatSmellAuditReport(report));

if (args.failOnSmells && report.summary.smellCount > 0) {
  process.exitCode = 1;
}
