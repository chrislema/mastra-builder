import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isBehaviorLikeAcceptanceCriterion } from './acceptance-evidence-policy';
import { acceptanceContractsForTask, normalizeTaskPlanCloudflareWorkerContracts } from './workflow';
import { taskPlanSchema, type TaskPlan } from './workflow-schemas';

type AcceptanceContract = ReturnType<typeof acceptanceContractsForTask>[number];

export type SmellAuditEvidenceKind = 'structured' | 'command' | 'generic_file_evidence' | 'unverified';

export type SmellAuditContract = {
  task: string;
  title: string;
  id: string;
  criterion: string;
  status: AcceptanceContract['status'];
  evidenceKind: SmellAuditEvidenceKind;
  behaviorCriterion: boolean;
  evidenceTask: boolean;
  smell:
    | 'behavior_by_file_evidence'
    | 'behavior_unverified'
    | 'generic_file_evidence'
    | 'unverified'
    | undefined;
  evidence: string[];
  gaps: string[];
};

export type SmellAuditReport = {
  repoPath: string;
  taskPlanPath?: string;
  summary: {
    tasks: number;
    contracts: number;
    structured: number;
    command: number;
    genericFileEvidence: number;
    unverified: number;
    behaviorCriteria: number;
    behaviorByFileEvidence: number;
    behaviorUnverified: number;
    pendingBehaviorEvidence: number;
    smellCount: number;
  };
  taskRows: Array<{
    task: string;
    title: string;
    contracts: number;
    genericFileEvidence: number;
    unverified: number;
    behaviorByFileEvidence: number;
    behaviorUnverified: number;
    pendingBehaviorEvidence: number;
  }>;
  smells: SmellAuditContract[];
};

export function isBehaviorCriterion(criterion: string) {
  return isBehaviorLikeAcceptanceCriterion(criterion);
}

export function acceptanceContractEvidenceKind(contract: AcceptanceContract): SmellAuditEvidenceKind {
  if (contract.status !== 'verified') return 'unverified';
  const evidenceText = contract.evidence.join('\n');
  if (/^file evidence covered/m.test(evidenceText)) return 'generic_file_evidence';
  if (/^(verification command|provider behavior test)/m.test(evidenceText)) return 'command';
  return 'structured';
}

function taskIsEvidenceTask(task: TaskPlan['tasks'][number]) {
  return (
    task.owned_surfaces.some((surface) => /^test\/|\.test\.[cm]?[jt]s$/i.test(surface)) ||
    /\b(?:test|tests|coverage|evidence|smoke)\b/i.test(task.deliverable)
  );
}

export function loadTaskPlanForSmellAudit(taskPlanPath: string): TaskPlan {
  return taskPlanSchema.parse(JSON.parse(readFileSync(taskPlanPath, 'utf8')));
}

export function auditDeliveryTaskPlan({
  repoPath,
  taskPlan,
  taskPlanPath,
  verification = { performed: [], missing: [] },
}: {
  repoPath: string;
  taskPlan: TaskPlan;
  taskPlanPath?: string;
  verification?: { performed: string[]; missing: string[] };
}): SmellAuditReport {
  const normalizedPlan = normalizeTaskPlanCloudflareWorkerContracts(taskPlan);
  const contracts: SmellAuditContract[] = [];
  const taskRows = new Map<
    string,
    {
      task: string;
      title: string;
      contracts: number;
      genericFileEvidence: number;
      unverified: number;
      behaviorByFileEvidence: number;
      behaviorUnverified: number;
      pendingBehaviorEvidence: number;
    }
  >();

  for (const task of normalizedPlan.tasks) {
    const row = {
      task: task.id,
      title: task.deliverable,
      contracts: 0,
      genericFileEvidence: 0,
      unverified: 0,
      behaviorByFileEvidence: 0,
      behaviorUnverified: 0,
      pendingBehaviorEvidence: 0,
    };
    const evidenceTask = taskIsEvidenceTask(task);

    for (const contract of acceptanceContractsForTask({ repoPath, task, verification })) {
      const evidenceKind = acceptanceContractEvidenceKind(contract);
      const behaviorCriterion = isBehaviorCriterion(contract.criterion);
      const pendingBehaviorEvidence = behaviorCriterion && evidenceKind === 'unverified' && evidenceTask;
      const smell =
        pendingBehaviorEvidence
          ? undefined
          : behaviorCriterion && evidenceKind === 'generic_file_evidence'
          ? 'behavior_by_file_evidence'
          : behaviorCriterion && evidenceKind === 'unverified' && !pendingBehaviorEvidence
            ? 'behavior_unverified'
            : evidenceKind === 'generic_file_evidence'
              ? 'generic_file_evidence'
              : evidenceKind === 'unverified'
                ? 'unverified'
                : undefined;

      row.contracts += 1;
      if (evidenceKind === 'generic_file_evidence') row.genericFileEvidence += 1;
      if (evidenceKind === 'unverified') row.unverified += 1;
      if (smell === 'behavior_by_file_evidence') row.behaviorByFileEvidence += 1;
      if (smell === 'behavior_unverified') row.behaviorUnverified += 1;
      if (pendingBehaviorEvidence) row.pendingBehaviorEvidence += 1;

      contracts.push({
        task: task.id,
        title: task.deliverable,
        id: contract.id,
        criterion: contract.criterion,
        status: contract.status,
        evidenceKind,
        behaviorCriterion,
        evidenceTask,
        smell,
        evidence: contract.evidence,
        gaps: contract.gaps,
      });
    }

    taskRows.set(task.id, row);
  }

  const smells = contracts.filter((contract) => contract.smell);
  const summary = {
    tasks: normalizedPlan.tasks.length,
    contracts: contracts.length,
    structured: contracts.filter((contract) => contract.evidenceKind === 'structured').length,
    command: contracts.filter((contract) => contract.evidenceKind === 'command').length,
    genericFileEvidence: contracts.filter((contract) => contract.evidenceKind === 'generic_file_evidence').length,
    unverified: contracts.filter((contract) => contract.evidenceKind === 'unverified').length,
    behaviorCriteria: contracts.filter((contract) => contract.behaviorCriterion).length,
    behaviorByFileEvidence: contracts.filter((contract) => contract.smell === 'behavior_by_file_evidence').length,
    behaviorUnverified: contracts.filter((contract) => contract.smell === 'behavior_unverified').length,
    pendingBehaviorEvidence: contracts.filter(
      (contract) => contract.behaviorCriterion && contract.evidenceKind === 'unverified' && contract.evidenceTask,
    ).length,
    smellCount: smells.length,
  };

  return {
    repoPath,
    taskPlanPath,
    summary,
    taskRows: [...taskRows.values()].filter(
      (row) =>
        row.genericFileEvidence ||
        row.unverified ||
        row.behaviorByFileEvidence ||
        row.behaviorUnverified ||
        row.pendingBehaviorEvidence,
    ),
    smells,
  };
}

export function defaultTaskPlanPath(projectFolder: string) {
  return join(resolve(projectFolder), '.delivery/artifacts/task-plan.revision-1.json');
}

export function resolveSmellAuditInput({
  projectFolder,
  taskPlanPath,
}: {
  projectFolder: string;
  taskPlanPath?: string;
}) {
  const repoPath = resolve(projectFolder);
  const resolvedTaskPlanPath = taskPlanPath ? resolve(taskPlanPath) : defaultTaskPlanPath(repoPath);
  if (!existsSync(resolvedTaskPlanPath)) {
    throw new Error(`Task plan not found: ${resolvedTaskPlanPath}`);
  }
  return {
    repoPath,
    taskPlanPath: resolvedTaskPlanPath,
    taskPlan: loadTaskPlanForSmellAudit(resolvedTaskPlanPath),
  };
}

export function formatSmellAuditReport(report: SmellAuditReport) {
  const lines = [
    `Delivery smell audit for ${report.repoPath}`,
    report.taskPlanPath ? `Task plan: ${report.taskPlanPath}` : undefined,
    '',
    `Contracts: ${report.summary.contracts}`,
    `Structured evidence: ${report.summary.structured}`,
    `Command/test evidence: ${report.summary.command}`,
    `Generic file evidence: ${report.summary.genericFileEvidence}`,
    `Unverified: ${report.summary.unverified}`,
    `Behavior criteria: ${report.summary.behaviorCriteria}`,
    `Behavior by file evidence: ${report.summary.behaviorByFileEvidence}`,
    `Behavior unverified: ${report.summary.behaviorUnverified}`,
    `Pending behavior evidence on test tasks: ${report.summary.pendingBehaviorEvidence}`,
    `Total smells: ${report.summary.smellCount}`,
    '',
    'Task rows with smells or gaps:',
    ...report.taskRows.map(
      (row) =>
        `- ${row.task}: contracts=${row.contracts}, fileEvidence=${row.genericFileEvidence}, unverified=${row.unverified}, behaviorByFile=${row.behaviorByFileEvidence}, behaviorUnverified=${row.behaviorUnverified}, pendingBehaviorEvidence=${row.pendingBehaviorEvidence}`,
    ),
    '',
    'Top smell examples:',
    ...report.smells.slice(0, 20).map((smell) => `- ${smell.task} ${smell.id} ${smell.smell}: ${smell.criterion}`),
  ].filter((line): line is string => line !== undefined);

  return `${lines.join('\n')}\n`;
}
