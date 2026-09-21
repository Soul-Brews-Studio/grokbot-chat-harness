/**
 * Scrub secrets out of anything on its way into the event log.
 *
 * Two sources feed this harness and both are dangerous. The relic index is built
 * from raw session transcripts and contains live keys printed during past
 * sessions (`gsk_…`, `sk-…`, found 2026-09-20). The Grok box holds
 * `SAND_GATEWAY_TOKEN` in Chrome's argv, so any transcript that ever captured a
 * `ps` listing carries it.
 *
 * The log is append-only by design. A secret written into it cannot be deleted,
 * which is exactly why the scrub happens on the way *in* rather than on read.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bgsk_[A-Za-z0-9]{20,}/g, "gsk_…[redacted]"],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, "sk-…[redacted]"],
  [/\bghp_[A-Za-z0-9]{20,}/g, "ghp_…[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_…[redacted]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AKIA…[redacted]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox…[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "jwt…[redacted]"],
  // NetBird setup keys are bare UPPERCASE uuids. Deliberately case-sensitive:
  // Grok agent ids are lowercase uuids and must survive, or the model loses the
  // handle it needs to address a bot.
  [/\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/g, "[setup-key-redacted]"],
  [/(?<=(?:TOKEN|SECRET|PASSWORD|API_KEY|KEY)\s*[=:]\s*)\S{12,}/gi, "[redacted]"],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}
