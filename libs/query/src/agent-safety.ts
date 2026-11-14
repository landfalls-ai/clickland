/**
 * The safety scan over captured GenAI content (docs/agent-value.md §5): personal data, secrets and prompt-injection
 * phrases. Pattern checks only: cheap, explainable, and they miss what a model would catch. A finding never carries the
 * matched value, only a masked form of it.
 */

export type SafetyKind = 'pii' | 'secret' | 'prompt_injection';

export interface SafetyFinding {
  kind: SafetyKind;
  detector: string;
  /** The match with its middle masked (`j***@e***.com`), or the injection phrase itself (it is not a secret). */
  sample: string;
  count: number;
}

const luhn = (digits: string) => {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
};

const mask = (value: string) =>
  value.length <= 6 ? `${value[0]}***` : `${value.slice(0, 3)}***${value.slice(-2)} (${value.length} chars)`;

const maskEmail = (value: string) => {
  const [user, host] = value.split('@');
  const tld = host!.slice(host!.lastIndexOf('.'));
  return `${user![0]}***@${host![0]}***${tld}`;
};

interface Detector {
  kind: SafetyKind;
  name: string;
  pattern: RegExp;
  accept?: (match: string) => boolean;
  show?: (match: string) => string;
}

const DETECTORS: Detector[] = [
  {
    kind: 'pii',
    name: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    show: maskEmail,
    // Addresses of documentation domains and no-reply senders are not a person's.
    accept: (m) =>
      !/@(example\.(com|org|net)|anthropic\.com|noreply\.|users\.noreply\.)/i.test(m) && !/^no-?reply@/i.test(m),
  },
  { kind: 'pii', name: 'phone', pattern: /(?<![\w.])\+\d{1,3}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}(?!\w)/g },
  { kind: 'pii', name: 'us_ssn', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g },
  {
    kind: 'pii',
    name: 'credit_card',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    show: (m) => `card ending ${m.replace(/\D/g, '').slice(-4)}`,
    accept: (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits);
    },
  },
  { kind: 'pii', name: 'iban', pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  {
    kind: 'secret',
    name: 'private_key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    show: () => '-----BEGIN … PRIVATE KEY-----',
  },
  { kind: 'secret', name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    kind: 'secret',
    name: 'api_key',
    pattern:
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})\b/g,
  },
  { kind: 'secret', name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: 'prompt_injection',
    name: 'ignore_instructions',
    show: (m) => m,
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules|messages?|context)\b/gi,
  },
  {
    kind: 'prompt_injection',
    name: 'reveal_system_prompt',
    show: (m) => m,
    pattern:
      /\b(?:reveal|show|print|repeat|output|leak)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions?|initial\s+instructions?|developer\s+message)\b/gi,
  },
  {
    kind: 'prompt_injection',
    name: 'role_override',
    show: (m) => m,
    pattern:
      /\b(?:you\s+are\s+now\s+(?:in\s+)?(?:DAN|developer\s+mode|an?\s+unrestricted|jailbroken)|do\s+anything\s+now|act\s+as\s+(?:an?\s+)?(?:unrestricted|unfiltered|jailbroken)\b|pretend\s+(?:you\s+have|there\s+are)\s+no\s+(?:rules|restrictions|guidelines))/gi,
  },
  {
    kind: 'prompt_injection',
    name: 'new_instructions',
    show: (m) => m,
    pattern: /(?:^|\n)\s*(?:#{1,3}\s*)?(?:new|updated|important)\s+(?:system\s+)?instructions?\s*:/gi,
  },
  {
    kind: 'prompt_injection',
    name: 'exfiltration',
    show: (m) => m,
    pattern:
      /\b(?:send|post|upload|email|exfiltrate)\s+(?:all\s+|the\s+|your\s+)*(?:secrets?|credentials?|api\s+keys?|passwords?|tokens?|env(?:ironment)?\s+variables?)\s+to\b/gi,
  },
];

/** Scans one piece of text. Findings are grouped per detector with a count and one masked sample. */
export function scanContent(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const detector of DETECTORS) {
    let matches = 0;
    let sample = '';
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[0].trim();
      if (detector.accept && !detector.accept(value)) continue;
      if (matches++ === 0) sample = (detector.show ?? mask)(value).slice(0, 120);
    }
    if (matches) findings.push({ kind: detector.kind, detector: detector.name, sample, count: matches });
  }
  return findings;
}

export const SAFETY_DETECTORS = DETECTORS.map((d) => ({ kind: d.kind, detector: d.name }));
