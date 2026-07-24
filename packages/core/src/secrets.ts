/** High-precision credential detection for the write gate. Returns the pattern
 *  KIND only — the matched text must never leave this module, so a secret can
 *  never leak through logs, audit entries, or error messages.
 *  Deliberately no entropy scoring: tight prefixed-token patterns only. */
export interface SecretMatch {
  kind: string;
}

// Order matters only for which kind is reported on multi-hits; first match wins.
const PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: "slack-token", re: /\bxox[bpars]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { kind: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY/ },
  { kind: "api-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "assignment", re: /\b(?:password|passwd|secret|api[_-]?key|token)\s*[=:]\s*\S{8,}/i },
];

export function detectSecret(content: string): SecretMatch | null {
  for (const { kind, re } of PATTERNS) {
    if (re.test(content)) return { kind };
  }
  return null;
}
