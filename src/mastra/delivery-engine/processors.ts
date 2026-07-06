import {
  RegexFilterProcessor,
  TokenLimiterProcessor,
  UnicodeNormalizer,
  type InputProcessorOrWorkflow,
  type OutputProcessorOrWorkflow,
  type ProcessInputArgs,
  type ProcessOutputStepArgs,
  type Processor,
} from '@mastra/core/processors';
import { deliveryRepoPathFromRequestContext } from './context';

type DeliveryTripwireMetadata = {
  processorId: string;
  agentId?: string;
  rule?: string;
  retryable?: boolean;
};

type TextLikeMessage = {
  content?: {
    parts?: Array<{ type?: string; text?: unknown }>;
    content?: unknown;
  };
};

const textFromMessage = (message: unknown) => {
  const content = (message as TextLikeMessage)?.content;
  const partText = Array.isArray(content?.parts)
    ? content.parts
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n')
    : '';

  if (partText.trim()) return partText;
  return typeof content?.content === 'string' ? content.content : '';
};

const textFromMessages = (messages: unknown[]) => messages.map(textFromMessage).filter(Boolean).join('\n');

export class DeliveryRepoPathGuard implements Processor<'delivery-repo-path-guard', DeliveryTripwireMetadata> {
  readonly id = 'delivery-repo-path-guard';
  readonly name = 'Delivery Repo Path Guard';
  readonly description = 'Blocks delivery agent calls that do not include requestContext.repoPath.';

  processInput({ messages, requestContext, agent, abort }: ProcessInputArgs<DeliveryTripwireMetadata>) {
    try {
      deliveryRepoPathFromRequestContext(requestContext);
    } catch {
      abort('Delivery agents require requestContext.repoPath so workspace and state tools target the intended repo.', {
        retry: false,
        metadata: {
          processorId: this.id,
          agentId: agent?.id,
          rule: 'missing-repo-path',
        },
      });
    }

    return messages;
  }
}

export class DeliveryInstructionOverrideGuard
  implements Processor<'delivery-instruction-override-guard', DeliveryTripwireMetadata>
{
  readonly id = 'delivery-instruction-override-guard';
  readonly name = 'Delivery Instruction Override Guard';
  readonly description = 'Blocks direct attempts to bypass delivery state, gates, or role boundaries.';

  private readonly rules = [
    {
      name: 'ignore-delivery-state',
      pattern:
        /\b(ignore|override|forget|discard)\b.{0,80}\b(delivery engine|\.delivery|delivery state|run state|boundary|release gate|delivery tools|deterministic checks)\b/i,
    },
    {
      name: 'bypass-gates',
      pattern:
        /\b(bypass|skip)\b.{0,60}\b(release gate|deployment approval|production deployment approval|real deployment approval|deterministic checks)\b/i,
    },
    {
      name: 'disable-state-writes',
      pattern:
        /\bdo\s+not\b.{0,60}\b(use|write|record|read)\b.{0,60}\b(\.delivery|delivery tools|delivery events|delivery artifacts|release gate)\b/i,
    },
    {
      name: 'pretend-evidence',
      pattern: /\bpretend\b.{0,60}\b(tests?|checks?|deployment|release gate)\b.{0,60}\b(passed|succeeded|completed)\b/i,
    },
  ];

  processInput({ messages, agent, abort }: ProcessInputArgs<DeliveryTripwireMetadata>) {
    const text = textFromMessages(messages);
    const matched = this.rules.find((rule) => rule.pattern.test(text));

    if (matched) {
      abort('Delivery policy override detected. Use delivery state, gates, and role boundaries instead.', {
        retry: false,
        metadata: {
          processorId: this.id,
          agentId: agent?.id,
          rule: matched.name,
        },
      });
    }

    return messages;
  }
}

export class DeliveryEvidenceClaimGuard implements Processor<'delivery-evidence-claim-guard', DeliveryTripwireMetadata> {
  readonly id = 'delivery-evidence-claim-guard';
  readonly name = 'Delivery Evidence Claim Guard';
  readonly description = 'Retries completion claims that do not cite delivery artifacts, checks, or events.';

  private readonly completionClaimPatterns = [
    /\b(i|we)\s+(am|are|have|had)?\s*(done|finished|complete|completed)\b/i,
    /\b(implemented|built|fixed|deployed)\b.{0,80}\b(successfully|done|complete|completed|ready)\b/i,
    /\btask\s+(is\s+)?(done|complete|completed|implemented)\b/i,
    /\bdeployment\s+(is\s+)?(successful|complete|completed|done)\b/i,
  ];

  private readonly evidencePatterns = [
    /\.delivery\//i,
    /\bevents?\.jsonl\b/i,
    /\brun_code\b/i,
    /\blive_verify\b/i,
    /\brelease[- ]gate\b/i,
    /\bjudg(e)?ment\b/i,
    /\bartifact\b/i,
    /\bchecks?\b/i,
    /\btests?\b.{0,50}\b(pass|passed|green|output|evidence|ran|run)\b/i,
  ];

  processOutputStep({
    messages,
    text,
    retryCount,
    agent,
    abort,
  }: ProcessOutputStepArgs<DeliveryTripwireMetadata>) {
    const outputText = text?.trim() ? text : textFromMessages(messages);
    const claimsCompletion = this.completionClaimPatterns.some((pattern) => pattern.test(outputText));
    const citesEvidence = this.evidencePatterns.some((pattern) => pattern.test(outputText));

    if (claimsCompletion && !citesEvidence) {
      const retryable = retryCount < 1;
      abort(
        'Completion claims need evidence. Cite .delivery artifacts, run_code/live_verify events, checks, judgments, or release-gate references.',
        {
          retry: retryable,
          metadata: {
            processorId: this.id,
            agentId: agent?.id,
            rule: 'completion-without-evidence',
            retryable,
          },
        },
      );
    }

    return messages;
  }
}

export const deliveryRepoPathGuard = new DeliveryRepoPathGuard();
export const deliveryInstructionOverrideGuard = new DeliveryInstructionOverrideGuard();
export const deliveryEvidenceClaimGuard = new DeliveryEvidenceClaimGuard();

export const deliveryUnicodeNormalizer = new UnicodeNormalizer({
  stripControlChars: true,
  preserveEmojis: true,
  collapseWhitespace: true,
  trim: true,
});

export const deliveryTokenLimiter = new TokenLimiterProcessor({
  limit: 60_000,
  trimMode: 'contiguous',
});

export const deliverySecretRedactor = new RegexFilterProcessor({
  presets: ['secrets'],
  strategy: 'redact',
  phase: 'output',
});

export const deliveryInputProcessors: InputProcessorOrWorkflow[] = [
  deliveryUnicodeNormalizer,
  deliveryRepoPathGuard,
  deliveryInstructionOverrideGuard,
  deliveryTokenLimiter,
];

export const deliveryOutputProcessors: OutputProcessorOrWorkflow[] = [
  deliverySecretRedactor,
  deliveryEvidenceClaimGuard,
];

export const deliveryProcessors = {
  deliveryUnicodeNormalizer,
  deliveryRepoPathGuard,
  deliveryInstructionOverrideGuard,
  deliveryTokenLimiter,
  deliverySecretRedactor,
  deliveryEvidenceClaimGuard,
};
