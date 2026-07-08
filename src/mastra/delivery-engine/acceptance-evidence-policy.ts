const behaviorCriterionPattern =
  /\b(adds?|removes?|updates?|rejects?|returns?|throws?|normalizes?|redacts?|validates?|resolves?|classif(?:y|ies)|creates?|receives?|executes?|fetch(?:es|ing)?|extract(?:s|ing)?|generat(?:es|ing)?|stor(?:es|ing)|scores?|does not|without|before|after|fallback|fails?|crash(?:es)?|calls?|posts?|persists?|hydrates?|excludes?|enforces?)\b|\bruns?\s+(?:all|the|provider|requested|tests?|locally|before|after|with|without|through|on|in|against)\b/i;

export function isBehaviorLikeAcceptanceCriterion(criterion: string) {
  return behaviorCriterionPattern.test(criterion);
}
