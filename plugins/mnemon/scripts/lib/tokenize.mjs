/**
 * Tokenizer and text helpers.
 *
 * Latin text is split into words; CJK text is split into characters and
 * character bigrams, which gives usable recall for Chinese memory without any
 * external dependency or model call.
 */
const STOP = new Set(
  ('a,an,the,and,or,but,if,then,than,of,to,in,on,at,for,with,by,from,as,is,are,was,were,be,been,being,' +
    'do,does,did,it,its,this,that,these,those,i,you,he,she,we,they,my,your,our,their,not,no,yes,can,' +
    'could,should,would,will,just,about,into,over,under,again,more,most,some,any,all,each,other,only,' +
    'also,very,much,many,use,used,using,get,got,make,made,need,needs,want,wants,like,well,still,when,' +
    'where,which,who,whom,how,what,why,me,him,her,them,us,let,may,might,must,shall,have,has,had,so,up,' +
    'out,off,down,new,old,one,two,per,via,etc').split(','),
);

const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g;

export function cjkRuns(text) {
  return String(text || '').match(CJK_RE) || [];
}

export function hasCJK(text) {
  return cjkRuns(text).length > 0;
}

function stem(word) {
  if (word.length <= 3) return word;
  for (const suffix of ['ing', 'ies', 'es', 'ed', 's']) {
    if (!word.endsWith(suffix)) continue;
    const base = word.slice(0, word.length - suffix.length);
    if (base.length < 3) continue;
    return suffix === 'ies' ? `${base}y` : base;
  }
  return word;
}

export function tokens(text) {
  const out = new Set();
  const lower = String(text || '').toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_.+#/-]{1,31}/g)) {
    const word = m[0].replace(/[.+#/-]+$/, '');
    if (word.length < 2 || STOP.has(word)) continue;
    out.add(word);
    const base = stem(word);
    if (base !== word) out.add(base);
  }
  for (const run of cjkRuns(lower)) {
    for (let i = 0; i < run.length; i += 1) {
      out.add(run[i]);
      if (i + 1 < run.length) out.add(run.slice(i, i + 2));
    }
  }
  return [...out];
}

/** Case-, punctuation- and width-insensitive form used for duplicate detection. */
export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * Similarity of two token collections: Jaccard for symmetric similarity and
 * containment for "one fact is the other plus a detail". Containment is what
 * lets a short fact merge into its longer, more specific restatement without
 * swallowing a genuinely different number.
 */
export function overlap(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size || !B.size) return { intersection: 0, jaccard: 0, containment: 0 };
  let intersection = 0;
  for (const t of A) if (B.has(t)) intersection += 1;
  const union = A.size + B.size - intersection;
  return {
    intersection,
    jaccard: intersection / union,
    containment: intersection / Math.min(A.size, B.size),
  };
}

export function extractNumbers(text) {
  return (String(text || '').match(/\d+(?:\.\d+)?/g) || []).map((n) => Number(n));
}

export function hasNegation(text) {
  const s = String(text || '').toLowerCase();
  return /(\b(not|never|no longer|instead of|without|avoid|deprecated|remove|revert)\b)|(不|别|无需|禁止|取消|不再|废弃|改回|去掉)/.test(s);
}

/**
 * Secret scrubbing before anything is written to disk. Deliberately narrow so
 * ordinary identifiers, file names and git hashes survive.
 */
export function redactSecrets(text) {
  return String(text || '')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|ghr|xox[baprs]|npm|pypi|glpat)[-_][A-Za-z0-9_-]{16,}/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g, '[redacted]')
    .replace(/\b[A-Za-z0-9_\-=]{40,}\b/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? '[redacted]' : m));
}

export function truncate(text, max) {
  const s = String(text || '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 24))} …(truncated)`;
}

export function oneLine(text, max = 240) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
