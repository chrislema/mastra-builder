const behaviorCriterionPattern =
  /\b(adds?|removes?|updates?|rejects?|returns?|throws?|normalizes?|redacts?|validates?|resolves?|classif(?:y|ies)|creates?|receives?|executes?|fetch(?:es|ing)?|extract(?:s|ing)?|generat(?:es|ing)?|stor(?:es|ing)|scores?|does not|without|before|after|fallback|fails?|crash(?:es)?|calls?|posts?|persists?|hydrates?|excludes?|enforces?)\b|\bruns?\s+(?:all|the|provider|requested|tests?|locally|before|after|with|without|through|on|in|against)\b/i;

function isDocumentationCriterion(criterion: string) {
  return /^\s*(?:README\.md|docs\/|operator documentation)\b[\s\S]*\b(?:documents|explains|states|lists|mentions)\b/i.test(
    criterion,
  );
}

function isDeclarativeConfigCriterion(criterion: string) {
  return /^\s*(?:wrangler\.(?:jsonc?|toml)|package\.json|tsconfig\.json)\b[\s\S]*\b(?:declares|defines|documents|lists)\b/i.test(
    criterion,
  );
}

function isCrossTaskContractEvidenceCriterion(criterion: string) {
  return /\b(?:no\s+task\s+downstream|downstream\s+tasks?|downstream\s+consumers?)\b[\s\S]*\b(?:invent|duplicate|independent|outside\s+src\/contracts\.ts|same\s+(?:limits|contracts?|shapes?))\b/i.test(
    criterion,
  );
}

export function isBehaviorLikeAcceptanceCriterion(criterion: string) {
  if (isDocumentationCriterion(criterion) || isDeclarativeConfigCriterion(criterion)) return false;
  if (isCrossTaskContractEvidenceCriterion(criterion)) return true;
  return behaviorCriterionPattern.test(criterion);
}

export function isApiRouteBehaviorAcceptanceCriterion(criterion: string) {
  return (
    isBehaviorLikeAcceptanceCriterion(criterion) &&
    (/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/api\/[A-Za-z0-9_./:{}*-]+/i.test(criterion) ||
      /\b\/api\/(?:health|models|run)\b/i.test(criterion) ||
      /\bHTTP\s+(?:400|401|403|404|413|500)\b/i.test(criterion))
  );
}
