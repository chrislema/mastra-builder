export type ReleaseGateJsonExpectation = Record<string, string | number | boolean | null>;

export type ReleaseGateProcessCommand = {
  command: string;
  executable: string;
  args: string[];
};

export type ReleaseGateHttpProbePlan = {
  method: 'GET' | 'POST';
  path: string;
  expected: string;
  expectedStatus?: number;
  statusBelow?: number;
  textContains?: string;
  jsonContains?: ReleaseGateJsonExpectation;
  jsonContainsAny?: ReleaseGateJsonExpectation[];
  jsonFieldMatches?: Record<string, string>;
  jsonFieldsEqualVariables?: Record<string, string>;
  jsonArrayAssertions?: ReleaseGateJsonArrayAssertion[];
  headersContain?: Record<string, string>;
  captures?: Record<string, string>;
  body?: ReleaseGateHttpRequestBody;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
  reason: string;
};

export type ReleaseGateRuntimeProbePlan = {
  tier: 'api';
  command: ReleaseGateProcessCommand;
  probes: ReleaseGateHttpProbePlan[];
  required: boolean;
  reason: string;
};

export type ReleaseGateHttpProbeResult = {
  method: ReleaseGateHttpProbePlan['method'];
  path: string;
  url: string;
  expected: string;
  ok: boolean;
  status?: number;
  response_summary?: string;
  error?: string;
};

export type ReleaseGateHttpRequestBody =
  | { type: 'json'; value: unknown }
  | { type: 'text'; value: string; contentType?: string }
  | {
      type: 'multipart-profile';
      kind: 'audience_segments' | 'voice_profile';
      filename: string;
      markdown: string;
      setActive?: boolean;
    };

export type ReleaseGateJsonArrayAssertion =
  | { type: 'minLength'; min: number }
  | { type: 'containsObject'; where: Record<string, string | number | boolean | null> }
  | { type: 'countObjects'; where: Record<string, string | number | boolean | null>; count: number };

function compactProbeDiagnostic(error: unknown, limit = 600) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? `${text.slice(0, limit)}... (${text.length} chars total)` : text;
}

function probeStatusMatches(probe: ReleaseGateHttpProbePlan, status: number) {
  if (probe.expectedStatus !== undefined) return status === probe.expectedStatus;
  if (probe.statusBelow !== undefined) return status < probe.statusBelow;
  return status >= 200 && status < 400;
}

function jsonContainsExpected(
  body: string,
  expected: ReleaseGateJsonExpectation,
): { ok: boolean; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: `Response was not valid JSON: ${compactProbeDiagnostic(error, 300)}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Response JSON was not an object.' };
  }

  const record = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    if (record[key] !== value) {
      return { ok: false, error: `Expected JSON field ${key}=${JSON.stringify(value)}, received ${JSON.stringify(record[key])}.` };
    }
  }

  return { ok: true };
}

function jsonContainsAnyExpected(body: string, expectedOptions: ReleaseGateJsonExpectation[]) {
  const failures = expectedOptions.map((expected) => jsonContainsExpected(body, expected));
  if (failures.some((result) => result.ok)) return { ok: true };

  return {
    ok: false,
    error: `Expected response JSON to match one of ${JSON.stringify(expectedOptions)}. ${
      failures.find((result) => result.error)?.error ?? ''
    }`.trim(),
  };
}

function parseJsonRecordExpected(body: string): { ok: true; record: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: `Response was not valid JSON: ${compactProbeDiagnostic(error, 300)}` };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Response JSON was not an object.' };
  }

  return { ok: true, record: parsed as Record<string, unknown> };
}

function jsonFieldMatchesExpected(body: string, expected: Record<string, string>) {
  const parsed = parseJsonRecordExpected(body);
  if (!parsed.ok) return parsed;

  for (const [key, pattern] of Object.entries(expected)) {
    const value = parsed.record[key];
    if (typeof value !== 'string' || !new RegExp(pattern).test(value)) {
      return {
        ok: false,
        error: `Expected JSON field ${key} to match /${pattern}/, received ${JSON.stringify(value)}.`,
      };
    }
  }

  return { ok: true };
}

function jsonFieldsEqualVariablesExpected(
  body: string,
  expected: Record<string, string>,
  variables: Record<string, string>,
) {
  const parsed = parseJsonRecordExpected(body);
  if (!parsed.ok) return parsed;

  for (const [field, variableName] of Object.entries(expected)) {
    const expectedValue = variables[variableName];
    if (expectedValue === undefined) return { ok: false, error: `Probe variable ${variableName} was not captured.` };
    if (parsed.record[field] !== expectedValue) {
      return {
        ok: false,
        error: `Expected JSON field ${field} to equal captured ${variableName}=${JSON.stringify(expectedValue)}, received ${JSON.stringify(parsed.record[field])}.`,
      };
    }
  }

  return { ok: true };
}

function jsonCapturesExpected(body: string, captures: Record<string, string>) {
  const parsed = parseJsonRecordExpected(body);
  if (!parsed.ok) return parsed;

  const values: Record<string, string> = {};
  for (const [variableName, field] of Object.entries(captures)) {
    const value = parsed.record[field];
    if (value === undefined || value === null) {
      return { ok: false, error: `Expected response JSON field ${field} to capture ${variableName}.` };
    }
    values[variableName] = String(value);
  }

  return { ok: true, values };
}

function headersContainExpected(headers: Headers, expected: Record<string, string>) {
  for (const [key, value] of Object.entries(expected)) {
    const actual = headers.get(key);
    if (!actual || !actual.includes(value)) {
      return { ok: false, error: `Expected response header ${key} to include ${JSON.stringify(value)}, received ${JSON.stringify(actual)}.` };
    }
  }

  return { ok: true };
}

function textContainsExpected(body: string, expected: string) {
  if (body.includes(expected)) return { ok: true };
  return { ok: false, error: `Expected response body to include ${JSON.stringify(expected)}.` };
}

function recordContainsExpected(
  record: Record<string, unknown>,
  expected: Record<string, string | number | boolean | null>,
) {
  return Object.entries(expected).every(([key, value]) => record[key] === value);
}

function jsonArrayAssertionsExpected(body: string, assertions: ReleaseGateJsonArrayAssertion[]) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    return { ok: false, error: `Response was not valid JSON: ${compactProbeDiagnostic(error, 300)}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Response JSON was not an array.' };
  }

  const records = parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item));
  for (const assertion of assertions) {
    if (assertion.type === 'minLength' && parsed.length < assertion.min) {
      return { ok: false, error: `Expected JSON array length at least ${assertion.min}, received ${parsed.length}.` };
    }

    if (assertion.type === 'containsObject' && !records.some((record) => recordContainsExpected(record, assertion.where))) {
      return { ok: false, error: `Expected JSON array to contain object fields ${JSON.stringify(assertion.where)}.` };
    }

    if (assertion.type === 'countObjects') {
      const count = records.filter((record) => recordContainsExpected(record, assertion.where)).length;
      if (count !== assertion.count) {
        return {
          ok: false,
          error: `Expected ${assertion.count} JSON array object(s) matching ${JSON.stringify(assertion.where)}, received ${count}.`,
        };
      }
    }
  }

  return { ok: true };
}

function requestInitForProbe(probe: ReleaseGateHttpProbePlan): RequestInit {
  const init: RequestInit = {
    method: probe.method,
    headers: probe.headers,
    redirect: probe.redirect,
    signal: AbortSignal.timeout(5_000),
  };

  if (!probe.body) return init;

  if (probe.body.type === 'json') {
    return {
      ...init,
      headers: { 'content-type': 'application/json', ...probe.headers },
      body: JSON.stringify(probe.body.value),
    };
  }

  if (probe.body.type === 'text') {
    return {
      ...init,
      headers: { 'content-type': probe.body.contentType ?? 'text/plain', ...probe.headers },
      body: probe.body.value,
    };
  }

  const form = new FormData();
  form.set('kind', probe.body.kind);
  form.set('setActive', String(probe.body.setActive ?? true));
  form.set('file', new Blob([probe.body.markdown], { type: 'text/markdown' }), probe.body.filename);
  return {
    ...init,
    body: form,
  };
}

function renderProbeTemplate(template: string, variables: Record<string, string>) {
  const missing = new Set<string>();
  const rendered = template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_match, variableName: string) => {
    const value = variables[variableName];
    if (value === undefined) {
      missing.add(variableName);
      return '';
    }
    return encodeURIComponent(value);
  });

  if (missing.size) return { ok: false as const, error: `Missing captured probe variable(s): ${Array.from(missing).join(', ')}` };
  return { ok: true as const, value: rendered };
}

export async function runHttpProbe(
  baseUrl: string,
  probe: ReleaseGateHttpProbePlan,
  variables: Record<string, string> = {},
): Promise<ReleaseGateHttpProbeResult> {
  const renderedPath = renderProbeTemplate(probe.path, variables);
  if (!renderedPath.ok) {
    return {
      method: probe.method,
      path: probe.path,
      url: new URL('/', baseUrl).toString(),
      expected: probe.expected,
      ok: false,
      error: renderedPath.error,
    };
  }

  const url = new URL(renderedPath.value, baseUrl).toString();
  try {
    const response = await fetch(url, requestInitForProbe(probe));
    const body = await response.text();
    const statusOk = probeStatusMatches(probe, response.status);
    const textCheck = probe.textContains ? textContainsExpected(body, probe.textContains) : { ok: true };
    const jsonCheck = probe.jsonContains ? jsonContainsExpected(body, probe.jsonContains) : { ok: true };
    const jsonAnyCheck = probe.jsonContainsAny ? jsonContainsAnyExpected(body, probe.jsonContainsAny) : { ok: true };
    const jsonFieldCheck = probe.jsonFieldMatches ? jsonFieldMatchesExpected(body, probe.jsonFieldMatches) : { ok: true };
    const jsonVariableCheck = probe.jsonFieldsEqualVariables
      ? jsonFieldsEqualVariablesExpected(body, probe.jsonFieldsEqualVariables, variables)
      : { ok: true };
    const jsonArrayCheck = probe.jsonArrayAssertions
      ? jsonArrayAssertionsExpected(body, probe.jsonArrayAssertions)
      : { ok: true };
    const headerCheck = probe.headersContain ? headersContainExpected(response.headers, probe.headersContain) : { ok: true };
    const captureCheck = probe.captures ? jsonCapturesExpected(body, probe.captures) : { ok: true, values: {} };
    const ok =
      statusOk &&
      textCheck.ok &&
      jsonCheck.ok &&
      jsonAnyCheck.ok &&
      jsonFieldCheck.ok &&
      jsonVariableCheck.ok &&
      jsonArrayCheck.ok &&
      headerCheck.ok &&
      captureCheck.ok;
    if (ok && captureCheck.ok) Object.assign(variables, captureCheck.values);
    const summary = [
      `HTTP ${response.status}`,
      response.headers.get('content-type') ? `content-type ${response.headers.get('content-type')}` : undefined,
      probe.headersContain
        ? Object.keys(probe.headersContain)
            .map((header) => `${header} ${response.headers.get(header) ?? ''}`.trim())
            .join('; ')
        : undefined,
      body.trim() ? `body ${compactProbeDiagnostic(body.trim(), 300)}` : undefined,
    ]
      .filter(Boolean)
      .join('; ');

    return {
      method: probe.method,
      path: probe.path,
      url,
      expected: probe.expected,
      ok,
      status: response.status,
      response_summary: summary,
      error: ok
        ? undefined
        : textCheck.error ??
          jsonCheck.error ??
          jsonAnyCheck.error ??
          jsonFieldCheck.error ??
          jsonVariableCheck.error ??
          jsonArrayCheck.error ??
          headerCheck.error ??
          captureCheck.error ??
          `Expected ${probe.expected}, received HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      method: probe.method,
      path: probe.path,
      url,
      expected: probe.expected,
      ok: false,
      error: compactProbeDiagnostic(error, 500),
    };
  }
}
