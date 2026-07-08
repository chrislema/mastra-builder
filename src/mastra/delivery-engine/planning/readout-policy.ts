import type { Readout, TaskPlan } from '../workflow-schemas';

const openDecisionRequiredFields = ['topic', 'why it matters', 'options considered', 'follow-up impact'];

function hasOpenDecisionField(decision: string, field: string) {
  return new RegExp(`\\b${field.replaceAll(' ', '\\s+')}\\s*:`, 'i').test(decision);
}

function looksLikeSafeAssumptionOrRisk(decision: string) {
  return (
    /\bconfirm only if\b/i.test(decision) ||
    /\bdefault assumed\b/i.test(decision) ||
    /\bsafe assumption\b/i.test(decision) ||
    /\bwatch\b|\brisk\b/i.test(decision) ||
    /\bwhether\b.*\b(or simply|or only|can be|could be|should simply)\b/i.test(decision)
  );
}

function looksLikeSettledDeliveryPolicy(decision: string) {
  return (
    /\b(?:Pages Functions?|Cloudflare Pages)\b[\s\S]{0,80}\bWorkers?\b/i.test(decision) ||
    /\bWorkers?\b[\s\S]{0,80}\b(?:Pages Functions?|Cloudflare Pages)\b/i.test(decision) ||
    /\b(?:React|Next\.?js|Vue|Svelte|JSX|TSX|Vite|frontend framework)\b/i.test(decision) ||
    /\bGitHub Actions?\b[\s\S]{0,80}\bdeploy/i.test(decision) ||
    /\bdeploy\b[\s\S]{0,80}\bGitHub Actions?\b/i.test(decision) ||
    /\bWrangler\b[\s\S]{0,80}\bdeploy/i.test(decision) ||
    /\bWorkers AI\b[\s\S]{0,80}\bbinding\b/i.test(decision) ||
    /\blocal validation\b|\bproduction approval\b/i.test(decision)
  );
}

function namesTaskScopedBlocker(decision: string) {
  return /\bblocks?\s+T\d[\w-]*\b/i.test(decision) || /\bbefore\s+T\d[\w-]*\b/i.test(decision);
}

function looksLikeSafeExternalServiceAdapterAmbiguity(question: string) {
  return (
    /\b(?:external\s+Worker\s+service|Worker\s+service|service\s+binding|env\.[A-Z][A-Z0-9_]*)\b/i.test(question) &&
    /\b(endpoint|RPC|method|path|parameters?|response envelope|contract|date-window|date window|API shape)\b/i.test(question)
  );
}

export function normalizeReadoutSafeAdapterAmbiguities(readout: Readout) {
  const safeAdapterQuestions = readout.blocking_ambiguities.filter(looksLikeSafeExternalServiceAdapterAmbiguity);
  if (!safeAdapterQuestions.length) return readout;

  const blocking_ambiguities = readout.blocking_ambiguities.filter(
    (question) => !looksLikeSafeExternalServiceAdapterAmbiguity(question),
  );
  const safeAssumptions = safeAdapterQuestions.map(
    (question) =>
      `Safe adapter default: ${question} Proceed with a small typed adapter around the source-declared external Worker service binding; keep the assumed request/response shape isolated and document the contract risk instead of blocking unrelated delivery work.`,
  );

  return {
    ...readout,
    blocking_ambiguities,
    safe_assumptions: Array.from(new Set([...readout.safe_assumptions, ...safeAssumptions])),
  };
}

export function openDecisionHygiene(taskPlan: TaskPlan) {
  for (const [index, decision] of taskPlan.open_decisions.entries()) {
    const missingFields = openDecisionRequiredFields.filter((field) => !hasOpenDecisionField(decision, field));
    if (missingFields.length) {
      return {
        passed: false,
        reason: `open_decisions[${index}] is not decision-shaped; include Topic, Why it matters, Options considered, and Follow-up impact.`,
      };
    }

    if (looksLikeSettledDeliveryPolicy(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] asks about settled delivery policy; move it to readout.safe_assumptions or taskPlan.risks and proceed with the Worker-first defaults.`,
      };
    }

    if (looksLikeSafeAssumptionOrRisk(decision) && !namesTaskScopedBlocker(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] appears to be a safe assumption or risk, not a blocker; move it to readout.safe_assumptions or taskPlan.risks.`,
      };
    }

    if (!/\b(blocks?|blocked|cannot|prevents?|required before|must be resolved before|implementation impossible)\b/i.test(decision)) {
      return {
        passed: false,
        reason: `open_decisions[${index}] does not explain what implementation work it blocks.`,
      };
    }
  }

  return { passed: true, reason: 'ok' };
}

export const hasExecutableRootTask = (taskPlan: TaskPlan) =>
  taskPlan.tasks.some((task) => task.depends_on.length === 0 && task.acceptance_criteria.length && task.owned_surfaces.length);

export function isTrueBlockingAmbiguity(question: string) {
  if (looksLikeSettledDeliveryPolicy(question)) return false;
  if (looksLikeSafeAssumptionOrRisk(question)) return false;
  const namesBlockingImpact =
    /\b(blocks?|blocked|cannot|prevents?|required before|must be resolved before|implementation impossible|missing required)\b/i.test(
      question,
    );
  if (!namesBlockingImpact) return false;

  return /\b(?:vision|spec|source docs?|requirements?|explicitly|TBD|not specified|missing required|omits required|unprovided|unavailable)\b/i.test(
    question,
  );
}

export const shouldSuspendForPlannerQuestions = (readout: Readout, taskPlan: TaskPlan) =>
  readout.blocking_ambiguities.some(isTrueBlockingAmbiguity) && !hasExecutableRootTask(taskPlan);
