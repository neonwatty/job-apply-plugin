export type DiscoveryStatus = 'observed' | 'logged_out' | 'blocked' | 'unavailable' | 'empty';
export type DiscoveryCategory = 'core' | 'adjacent' | 'stretch';
export type DiscoveryEvidence = { source: string; url: string; observedTitle: string; company?: string };
export type DiscoverySuggestion = { title: string; category: DiscoveryCategory; rationale: string; evidence: DiscoveryEvidence[] };
export type TitleDiscoveryPacket = {
  version: 1;
  source: { status: DiscoveryStatus; detail: string };
  suggestions: DiscoverySuggestion[];
};

const statuses: DiscoveryStatus[] = ['observed', 'logged_out', 'blocked', 'unavailable', 'empty'];
const categories: DiscoveryCategory[] = ['core', 'adjacent', 'stretch'];
type RecordValue = Record<string, unknown>;
function record(value: unknown, keys: string[], optional: string[] = []): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected a packet object.');
  const object = value as RecordValue;
  if (Object.keys(object).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in object)))
    throw Error('The discovery packet has missing or unsupported fields.');
  return object;
}
function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 600) throw Error(`Invalid ${label}.`);
  return value.trim();
}
function publicUrl(value: unknown): string {
  const input = string(value, 'evidence URL');
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw Error('Invalid evidence URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password)
    throw Error('Evidence URL must be a public web link.');
  if (parsed.hostname === 'localhost' || parsed.hostname.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(parsed.hostname))
    throw Error('Evidence URL must be a public web link.');
  return parsed.toString();
}
export function titleKey(title: string): string {
  return title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}
export function parseTitleDiscoveryPacket(input: string | unknown): TitleDiscoveryPacket {
  let value: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    const content = trimmed.startsWith('```json\n') && trimmed.endsWith('\n```')
      ? trimmed.slice(8, -4).trim() : trimmed;
    try { value = JSON.parse(content); } catch { throw Error('Paste a valid title discovery JSON packet.'); }
  }
  const root = record(value, ['version', 'source', 'suggestions']);
  if (root.version !== 1) throw Error('Unsupported title discovery packet version.');
  const source = record(root.source, ['status', 'detail']);
  if (!statuses.includes(source.status as DiscoveryStatus)) throw Error('Invalid discovery source status.');
  const status = source.status as DiscoveryStatus;
  const detail = string(source.detail, 'source detail');
  if (!Array.isArray(root.suggestions) || root.suggestions.length > 30) throw Error('Invalid discovery suggestions.');
  const suggestions: DiscoverySuggestion[] = [];
  const seen = new Map<string, DiscoverySuggestion>();
  for (const raw of root.suggestions) {
    const item = record(raw, ['title', 'category', 'rationale', 'evidence']);
    const title = string(item.title, 'title');
    const key = titleKey(title);
    if (!categories.includes(item.category as DiscoveryCategory)) throw Error('Invalid title category.');
    if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 8)
      throw Error('Each suggestion needs inspectable evidence.');
    const evidence = item.evidence.map((rawEvidence: unknown): DiscoveryEvidence => {
      const entry = record(rawEvidence, ['source', 'url', 'observedTitle'], ['company']);
      return {
        source: string(entry.source, 'evidence source'), url: publicUrl(entry.url),
        observedTitle: string(entry.observedTitle, 'observed title'),
        ...(entry.company === undefined ? {} : { company: string(entry.company, 'company') }),
      };
    });
    const category = item.category as DiscoveryCategory;
    const rationale = string(item.rationale, 'rationale');
    const prior = seen.get(key);
    if (prior) {
      if (prior.category !== category) throw Error('Duplicate title has conflicting categories.');
      for (const entry of evidence) {
        if (!prior.evidence.some(existing => existing.url === entry.url)) prior.evidence.push(entry);
      }
    } else {
      const suggestion = { title, category, rationale, evidence };
      seen.set(key, suggestion);
      suggestions.push(suggestion);
    }
  }
  if ((status === 'observed') !== (suggestions.length > 0))
    throw Error('Source status and observed suggestions disagree.');
  return { version: 1, source: { status, detail }, suggestions };
}
