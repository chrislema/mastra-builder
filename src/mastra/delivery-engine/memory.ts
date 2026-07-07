import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export type DeliveryMemoryRole =
  | 'planner'
  | 'architect'
  | 'engineer'
  | 'designer'
  | 'tester'
  | 'deployer'
  | 'judge'
  | 'supervisor';

export const deliveryMemoryRolePolicies: Record<
  DeliveryMemoryRole,
  { readOnly: boolean; purpose: string }
> = {
  planner: { readOnly: false, purpose: 'write planning handoff facts and live blockers' },
  architect: { readOnly: false, purpose: 'write review handoff facts and structural risks' },
  engineer: { readOnly: false, purpose: 'write implementation progress and evidence needs' },
  designer: { readOnly: false, purpose: 'write UI progress and visual evidence needs' },
  tester: { readOnly: false, purpose: 'write release-gate evidence and verification state' },
  deployer: { readOnly: false, purpose: 'write deployment readiness and approval state' },
  supervisor: { readOnly: false, purpose: 'write interactive coordination state' },
  judge: { readOnly: true, purpose: 'read run context without mutating coordination memory' },
};

export function deliveryMemoryResourceId(repoPath: string) {
  const repo = resolve(repoPath);
  const hash = createHash('sha256').update(repo).digest('hex').slice(0, 16);
  return `delivery:${hash}`;
}

export function deliveryRunMemory({
  repoPath,
  runId,
  role,
}: {
  repoPath: string;
  runId: string;
  role: DeliveryMemoryRole;
}) {
  const policy = deliveryMemoryRolePolicies[role];
  return {
    resource: deliveryMemoryResourceId(repoPath),
    thread: {
      id: runId,
      title: `Delivery ${runId}`,
      metadata: {
        deliveryEngine: true,
        repoPath: resolve(repoPath),
        runId,
      },
    },
    options: {
      readOnly: policy.readOnly,
    },
  };
}
