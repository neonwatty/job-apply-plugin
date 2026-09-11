import { createHash } from 'node:crypto';
import { normalizeJobUrl, strip } from './job-url.js';
import { fromJSON, object, JobsError } from './values.js';
const whitespace = '[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]';
// CPython 3.12 uses Unicode 15.0 decimal digits; host ICU versions must not change item identity.
const decimalDigits = '[' + [
    String.raw `\u{30}-\u{39}\u{660}-\u{669}\u{6f0}-\u{6f9}\u{7c0}-\u{7c9}\u{966}-\u{96f}`,
    String.raw `\u{9e6}-\u{9ef}\u{a66}-\u{a6f}\u{ae6}-\u{aef}\u{b66}-\u{b6f}\u{be6}-\u{bef}`,
    String.raw `\u{c66}-\u{c6f}\u{ce6}-\u{cef}\u{d66}-\u{d6f}\u{de6}-\u{def}\u{e50}-\u{e59}`,
    String.raw `\u{ed0}-\u{ed9}\u{f20}-\u{f29}\u{1040}-\u{1049}\u{1090}-\u{1099}\u{17e0}-\u{17e9}`,
    String.raw `\u{1810}-\u{1819}\u{1946}-\u{194f}\u{19d0}-\u{19d9}\u{1a80}-\u{1a89}\u{1a90}-\u{1a99}`,
    String.raw `\u{1b50}-\u{1b59}\u{1bb0}-\u{1bb9}\u{1c40}-\u{1c49}\u{1c50}-\u{1c59}\u{a620}-\u{a629}`,
    String.raw `\u{a8d0}-\u{a8d9}\u{a900}-\u{a909}\u{a9d0}-\u{a9d9}\u{a9f0}-\u{a9f9}\u{aa50}-\u{aa59}`,
    String.raw `\u{abf0}-\u{abf9}\u{ff10}-\u{ff19}\u{104a0}-\u{104a9}\u{10d30}-\u{10d39}\u{11066}-\u{1106f}`,
    String.raw `\u{110f0}-\u{110f9}\u{11136}-\u{1113f}\u{111d0}-\u{111d9}\u{112f0}-\u{112f9}\u{11450}-\u{11459}`,
    String.raw `\u{114d0}-\u{114d9}\u{11650}-\u{11659}\u{116c0}-\u{116c9}\u{11730}-\u{11739}\u{118e0}-\u{118e9}`,
    String.raw `\u{11950}-\u{11959}\u{11c50}-\u{11c59}\u{11d50}-\u{11d59}\u{11da0}-\u{11da9}\u{11f50}-\u{11f59}`,
    String.raw `\u{16a60}-\u{16a69}\u{16ac0}-\u{16ac9}\u{16b50}-\u{16b59}\u{1d7ce}-\u{1d7ff}\u{1e140}-\u{1e149}`,
    String.raw `\u{1e2f0}-\u{1e2f9}\u{1e4f0}-\u{1e4f9}\u{1e950}-\u{1e959}\u{1fbf0}-\u{1fbf9}`,
].join('') + ']';
const pattern = (source) => new RegExp(source.replaceAll('\\s', whitespace).replaceAll('\\d', decimalDigits), 'u');
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);
/** Parse only the historical numbered report format, retaining invalid entries for preview. */
export function parseLegacyJobReport(relativePath, sourceSha256, content) {
    const lines = content.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u);
    if (lines.at(-1) === '')
        lines.pop();
    const starts = lines.flatMap((line, index) => line.startsWith('###') ? [index] : []);
    const identities = starts.map(start => strip(lines[start].replace(pattern('^###\\s+\\d+\\.\\s*'), '')));
    const totals = new Map();
    for (const identity of identities)
        totals.set(identity, (totals.get(identity) ?? 0) + 1);
    const occurrences = new Map();
    return starts.map((start, index) => {
        const body = lines.slice(start + 1, starts[index + 1] ?? lines.length);
        const identity = identities[index];
        const contentIdentity = totals.get(identity) > 1 ? strip([identity, ...body].join('\n')) : identity;
        const occurrence = (occurrences.get(contentIdentity) ?? 0) + 1;
        occurrences.set(contentIdentity, occurrence);
        const entryId = 'legacy-entry-' + digest(`${relativePath}\0${contentIdentity}\0${occurrence}`);
        const itemId = 'legacy-item-' + digest(entryId);
        const source = { sourceKind: 'timestamped-search-report', relativePath, entryId, sourceSha256 };
        const invalid = (reason) => object(fromJSON({ itemId, state: 'invalid', reason, source }), 'legacy item');
        const heading = pattern('^###\\s+\\d+\\.\\s+(.+?)\\s+—\\s+(.+)$').exec(lines[start]);
        if (!heading)
            return invalid('unsupported_heading');
        const role = strip(heading[1]);
        const company = strip(heading[2].replace(pattern('\\s+\\(Score:\\s*[^)]*\\)\\s*$'), ''));
        if (!role || !company)
            return invalid('incomplete_heading');
        const labels = new Map();
        for (const line of body) {
            const field = pattern('^- \\*\\*([^*]+)\\*\\*:\\s*(.*)$').exec(line);
            if (!field)
                continue;
            const label = strip(field[1]).toLowerCase();
            if (labels.has(label))
                return invalid('duplicate_field');
            labels.set(label, strip(field[2]));
        }
        const candidates = [];
        for (const label of ['url', 'apply']) {
            const value = labels.get(label) ?? '';
            if (!value.startsWith('http://') && !value.startsWith('https://') || pattern('\\s').test(value))
                continue;
            try {
                candidates.push([value, normalizeJobUrl(value)]);
            }
            catch (error) {
                if (!(error instanceof JobsError))
                    throw error;
            }
        }
        if (!candidates.length)
            return invalid('missing_url');
        if (new Set(candidates.map(([, url]) => url)).size !== 1)
            return invalid('ambiguous_url');
        const job = { url: candidates[0][0], role, company };
        for (const [label, field] of [['source', 'source'], ['location', 'location'], ['salary', 'compensation'], ['description', 'description']]) {
            if (labels.get(label))
                job[field] = labels.get(label);
        }
        return object(fromJSON({ itemId, state: 'valid', source, job }), 'legacy item');
    });
}
