// A fast, dependency-free Markdown renderer producing byte-identical HTML to
// marked 18.1.3 with its default options (GFM on, breaks off, pedantic off).
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// Architecture: block parser builds a small token list (link definitions are
// collected on the way), then a renderer walks the tokens and parses inline
// markup straight to HTML. parse() keeps no state between calls.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_NO_ENCODE_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const NUM_REF_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const ANY_PUNCT_RE = /\\([\p{P}\p{S}])/gu;
const PUNCT_RE = /[\p{P}\p{S}]/u;
const PUNCT_START_RE = /^((?![*_])[\s\p{P}\p{S}])/u;
const ALPHA_NUM_RE = /[\p{L}\p{N}]/u;
const NON_SPACE_RE = /[^ ]/;
const BLANK_LINE_RE = /^[ \t]*$/;

// Escape text for HTML. With encode, every & < > " ' becomes an entity;
// otherwise only characters that are not already part of an entity do.
function esc(s, encode) {
  if (encode) {
    return ESC_RE.test(s) ? s.replace(ESC_RE, (c) => ESC_MAP[c]) : s;
  }
  return ESC_NO_ENCODE_RE.test(s) ? s.replace(ESC_NO_ENCODE_RE, (c) => (c === '&' ? '&amp;' : ESC_MAP[c])) : s;
}

// Decode numeric character references in a text run (named entities are left
// alone: they survive as-is into the HTML). A bare & becomes &amp;.
function decodeEntities(s) {
  if (!NUM_REF_RE.test(s)) return s;
  return s.replace(NUM_REF_OR_AMP_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Percent-encode a link destination the way marked does.
function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

// Normalize a link label (CommonMark label normalization).
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Expand tabs to spaces, tracking the column from `col`.
function expandTabs(s, col) {
  let out = '';
  let c = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\t') {
      const n = 4 - (c % 4);
      out += ' '.repeat(n);
      c += n;
    } else {
      out += ch;
      c++;
    }
  }
  return out;
}

// Strip trailing backslashes from a string (returns the stripped string).
function stripTrailingBackslashes(s) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === 92) n--;
  return s.slice(0, n);
}

// Check balanced parens in a link destination: -1 balanced, -2 too many
// closing, otherwise the index of the first unmatched opening paren.
function parenBalance(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth < 0) return i;
    }
  }
  return depth > 0 ? -2 : -1;
}

// The last code point of the string ending just before index `end` (handles
// surrogate pairs), or '' when end is 0.
function codePointBefore(s, end) {
  if (end <= 0) return '';
  const lo = s.charCodeAt(end - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && end >= 2) {
    const hi = s.charCodeAt(end - 2);
    if (hi >= 0xD800 && hi <= 0xDBFF) return s.slice(end - 2, end);
  }
  return s[end - 1];
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

const ESCAPE_RE = /\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/y;
const CODE_SPAN_RE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/y;
const BR_RE = /( {2,}|\\)\n(?!\s*$)[ \t]*/y;
const TAG_RE = /<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>/y;
const AUTOLINK_RE = /<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/y;
const EMAIL_LOCAL = /[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]/;
const URL_RE = /(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/y;
const BACKPEDAL_RE = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const DEL_LDELIM_RE = /~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/uy;
const EM_LDELIM_RE = /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/uy;

// Delimiter-run closer finders (GFM flavours), copied verbatim from the
// reference tokenizer's compiled patterns (see baselines/vendor/marked).
const EM_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const EM_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;

// Label / reference pieces used by the link tokenizers.
const LE_SRC = '\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]';
const LABEL_SRC = '(?:[^\\[\\]`]*(?:\\[(?:' + LE_SRC + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]`]*?';
const RE_LABEL_SRC = '(?:\\[(?:' + LE_SRC + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]`])*?';
const REF_SRC = '(?:(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})';
const LINK_RE = new RegExp('!?\\[(' + RE_LABEL_SRC + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)', 'y');
const REFLINK_RE = new RegExp('!?\\[(' + RE_LABEL_SRC + ')\\]\\[(' + REF_SRC + ')\\]', 'y');
const NOLINK_RE = new RegExp('!?\\[(' + REF_SRC + ')\\](?:\\[\\])?', 'y');

// Masking helpers for emphasis: link-like spans, code spans and inline HTML
// are hidden so delimiters inside them cannot act as emphasis closers.
const LINK_SPAN_SRC = '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)';
const BLOCK_SKIP_RE = new RegExp(LINK_SPAN_SRC + '|(?<!`)(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>', 'g');
const PUNCT_OUTSIDE_CODE_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const REFLINK_SEARCH_RE = new RegExp('(?:!?\\[(' + LABEL_SRC + ')\\]\\[(' + REF_SRC + ')\\]|!?\\[(' + REF_SRC + ')\\](?:\\[\\])?(?!\\())', 'g');

// Does `text` hold a link (inline or reference) that would resolve?
function linkInText(text, links) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(BLOCK_SKIP_RE)) {
    LINK_RE.lastIndex = 0;
    if (LINK_RE.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(REFLINK_SEARCH_RE)) {
    const s = m[0];
    const o = s.lastIndexOf('[');
    if (s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(o + 1, -1)))) continue;
    if (o > 1 && linkInText(s.slice(1, o - 1), links)) continue;
    return true;
  }
  return false;
}

// The masked copy of an inline source: links, code spans and HTML are
// replaced by same-length filler so emphasis closers cannot hide inside them.
function emMask(src, links) {
  let t = src;
  if (t.includes('[')) {
    const search = REFLINK_SEARCH_RE;
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(search, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(search, maskRef);
  }
  // The punctuation pass only changes code spans and backslash escapes.
  if (t.includes('`') || t.includes('\\')) {
    t = t.replace(PUNCT_OUTSIDE_CODE_RE, (m, ticks, punct) =>
      punct ? '+'.repeat(m.length) : ticks ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks : m);
  }
  // The block-skip pass only changes links, code spans and inline HTML.
  if (t.includes('`') || t.includes('[') || t.includes('<')) {
    t = t.replace(BLOCK_SKIP_RE, (m, _g1, ticks) => {
      const o = ticks ? ticks.length : 0;
      return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
    });
  }
  return t;
}

// For a masked source, the last index where a closer run for `*`, `_` or `~`
// may start (a run not preceded by whitespace).
function lastPossibleClosers(masked) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') out[r] = s;
    s = i - 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parser: renders one inline source straight to HTML.
// `st` is the per-document inline state ({inLink, inRawBlock}); linkEmitted
// is tracked on the state object while a link label is being parsed.
// ---------------------------------------------------------------------------

// End of the plain-text run starting at `i`: the reference tokenizer's
// own text-run pattern, run sticky from `i` so no substring is allocated.
const TEXT_RUN_RE = /(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\/\/|(?<![^\s*_~(])www\.|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@))))/y;

function scanTextEnd(src, i, n) {
  TEXT_RUN_RE.lastIndex = i;
  const m = TEXT_RUN_RE.exec(src);
  return m ? i + m[0].length : n;
}

// The `Be` check: a link label holding a `<` is not a link when a tag or
// autolink starting inside the label runs past the label's end.
function labelHasLongTag(src, label, offset) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      CODE_SPAN_RE.lastIndex = s;
      const m = CODE_SPAN_RE.exec(label);
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(offset + s);
    TAG_RE.lastIndex = 0;
    const t = TAG_RE.exec(rest);
    AUTOLINK_RE.lastIndex = 0;
    const a = t || AUTOLINK_RE.exec(rest);
    if (a) {
      if (a[0].length > label.length - s) return true;
      s += a[0].length - 1;
    }
  }
  return false;
}


// ---------------------------------------------------------------------------
// Links and images. `plain` selects the alt-text rendering (inner text only)
// instead of HTML. Returns {end, out} or {end, text} (reflink miss) or null.
// ---------------------------------------------------------------------------

function tryLink(src, i, links, st, plain) {
  if (!st.linkParenPossible) return null;
  LINK_RE.lastIndex = i;
  const m = LINK_RE.exec(src);
  if (!m) return null;
  const isImage = m[0].charAt(0) === '!';
  const label = m[1];
  if (labelHasLongTag(src, label, i + (isImage ? 2 : 1))) return null;
  let href = m[2].trim();
  let raw = m[0];
  let title = m[3] ? m[3].slice(1, -1) : '';
  if (href.charCodeAt(0) === 60) {
    if (href.charCodeAt(href.length - 1) !== 62) return null;
    const stripped = stripTrailingBackslashes(href.slice(0, -1));
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const bal = parenBalance(href);
    if (bal === -2) return null;
    if (bal > -1) {
      href = href.substring(0, bal);
      raw = raw.substring(0, (isImage ? 5 : 4) + label.length + bal).trim();
      title = '';
    }
  }
  const strippedMatch = stripTrailingBackslashes(raw.slice(0, -1));
  if ((raw.length - strippedMatch.length) % 2 === 0) return null;
  href = href.trim();
  if (href.charCodeAt(0) === 60) href = href.slice(1, -1);
  href = href.replace(ANY_PUNCT_RE, '$1');
  title = title.replace(ANY_PUNCT_RE, '$1');
  return buildLink(i, raw.length, isImage, label, href, title, links, st, plain);
}

function tryReflink(src, i, links, st, plain) {
  REFLINK_RE.lastIndex = i;
  let m = REFLINK_RE.exec(src);
  if (!m) {
    NOLINK_RE.lastIndex = i;
    m = NOLINK_RE.exec(src);
    if (!m) return null;
  }
  const isImage = m[0].charAt(0) === '!';
  const label = m[1];
  if (labelHasLongTag(src, label, i + (isImage ? 2 : 1))) return null;
  const ref = links[normLabel(m[2] || label)];
  if (!ref) return { end: i + 1, text: src[i] };
  return buildLink(i, m[0].length, isImage, label, ref.href, ref.title || '', links, st, plain);
}

function buildLink(i, rawLen, isImage, labelText, href, title, links, st, plain) {
  const label = labelText.replace(/\\([\[\]])/g, '$1');
  const savedInLink = st.inLink;
  const savedEmitted = st.linkEmitted;
  const savedRaw = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = plain ? inlinePlain(label, links, st) : inlineHTML(label, links, st);
  const nested = st.linkEmitted;
  st.linkEmitted = savedEmitted;
  st.inLink = savedInLink;
  if (!isImage) {
    // A link whose label holds another link is not a link at all: the
    // caller re-parses the text from here.
    if (nested) {
      st.inRawBlock = savedRaw;
      return null;
    }
    st.linkEmitted = true;
    if (plain) return { end: i + rawLen, out: inner };
    const h = encodeHref(href);
    if (h === null) return { end: i + rawLen, out: inner };
    let out = '<a href="' + esc(h, false) + '"';
    if (title) out += ' title="' + esc(title, false) + '"';
    return { end: i + rawLen, out: out + '>' + inner + '</a>' };
  }
  // Image: the alt text is the label rendered as plain text.
  const alt = plain ? inner : inlinePlain(label, links, st);
  if (plain) return { end: i + rawLen, out: alt };
  const h = encodeHref(href);
  if (h === null) return { end: i + rawLen, out: esc(alt, false) };
  let out = '<img src="' + esc(h, false) + '" alt="' + esc(alt, false) + '"';
  if (title) out += ' title="' + esc(title, false) + '"';
  return { end: i + rawLen, out: out + '>' };
}

// ---------------------------------------------------------------------------
// Emphasis / strong emphasis / strikethrough.
// ---------------------------------------------------------------------------

function tryEmStrong(src, i, mask, closers, prevChar, links, st, plain) {
  EM_LDELIM_RE.lastIndex = i;
  const s = EM_LDELIM_RE.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const opener = s[1] || s[3] || '';
  let prev = prevChar;
  let l = i;
  while (l > 0 && mask[l - 1] === r) l--;
  const p = codePointBefore(mask, l);
  const h = p === '*' || p === '_' || (p !== '' && PUNCT_START_RE.test(p));
  if (l < i) prev = p;
  const u = l < i ? h : (prev !== '' && PUNCT_START_RE.test(prev));
  if (s[4] && ALPHA_NUM_RE.test(prev)) return null;
  if (!opener || !prev || u) {
    const k = [...s[0]].length - 1;
    let m = k;
    let f = 0;
    const y = i - l + k;
    const canOpen = p.trim() !== '' && (opener !== '' || (r === '*' && !h));
    const rDelim = r === '*' ? EM_RDELIM_AST : EM_RDELIM_UND;
    const v = closers[r];
    const q = i + k;
    if (v < q) return null;
    const search = mask.slice(q);
    const limit = v - q;
    rDelim.lastIndex = 0;
    let c;
    while ((c = rDelim.exec(search)) !== null && !(c.index > limit)) {
      const g = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
      if (!g) continue;
      let b = [...g].length;
      if (c[3] || c[4]) { m += b; continue; }
      if (c[5] || c[6] || canOpen) {
        if (prev === r && (c[5] || c[6])) break;
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...c[0]][0].length;
      const raw = src.slice(i, i + k + c.index + te + b);
      if (Math.min(k, b) % 2 === 1) {
        const inner = raw.slice(1, -1);
        const out = plain ? inlinePlain(inner, links, st) : '<em>' + inlineHTML(inner, links, st) + '</em>';
        return { end: i + raw.length, out };
      }
      const inner = raw.slice(2, -2);
      const out = plain ? inlinePlain(inner, links, st) : '<strong>' + inlineHTML(inner, links, st) + '</strong>';
      return { end: i + raw.length, out };
    }
    return null;
  }
  return null;
}

function tryDel(src, i, mask, closers, prevChar, links, st, plain) {
  DEL_LDELIM_RE.lastIndex = i;
  const s = DEL_LDELIM_RE.exec(src);
  if (!s) return null;
  // s[1] is the punctuation char after the run (if any).
  if (s[1] && ALPHA_NUM_RE.test(prevChar)) return null;
  const punctAfter = s[1] || '';
  let prev = prevChar;
  let l = i;
  while (l > 0 && mask[l - 1] === '~') l--;
  const p = codePointBefore(mask, l);
  const h = p === '~' || (p !== '' && PUNCT_START_RE.test(p));
  if (l < i) prev = p;
  const u = l < i ? h : (prev !== '' && PUNCT_START_RE.test(prev));
  if (!punctAfter || !prev || u) {
    const o = [...s[0]].length - 1;
    let p2 = o;
    const u2 = closers['~'];
    const d = i + o;
    if (u2 < d) return null;
    const search = mask.slice(d);
    const limit = u2 - d;
    DEL_RDELIM.lastIndex = 0;
    let c;
    while ((c = DEL_RDELIM.exec(search)) !== null && !(c.index > limit)) {
      const g = c[1] || c[2] || c[3] || c[4] || c[5] || c[6];
      if (!g) continue;
      let l2 = [...g].length;
      if (l2 !== o) continue;
      if (c[3] || c[4]) { p2 += l2; continue; }
      p2 -= l2;
      if (p2 > 0) continue;
      l2 = Math.min(l2, l2 + p2);
      const te = [...c[0]][0].length;
      const raw = src.slice(i, i + o + c.index + te + l2);
      const inner = raw.slice(o, -o);
      const out = plain ? inlinePlain(inner, links, st) : '<del>' + inlineHTML(inner, links, st) + '</del>';
      return { end: i + raw.length, out };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The inline loops.
// ---------------------------------------------------------------------------

function inlineHTML(src, links, st) {
  const n = src.length;
  if (n === 0) return '';
  const savedLpp = st.linkParenPossible;
  st.linkParenPossible = savedLpp && src.includes(')');
  try {
    return inlineHTMLInner(src, links, st);
  } finally {
    st.linkParenPossible = savedLpp;
  }
}

function inlineHTMLInner(src, links, st) {
  const n = src.length;
  const needMask = src.includes('*') || src.includes('_') || src.includes('~');
  const mask = needMask ? emMask(src, links) : src;
  const closers = needMask ? lastPossibleClosers(mask) : null;
  let out = '';
  let i = 0;
  let prevChar = '';
  let wasText = false;
  while (i < n) {
    if (!wasText) prevChar = '';
    wasText = false;
    const c = src.charCodeAt(i);
    if (c === 92) { // backslash escape
      ESCAPE_RE.lastIndex = i;
      const m = ESCAPE_RE.exec(src);
      if (m) { out += esc(m[1], false); i += 2; continue; }
    }
    if (c === 60) { // < : tag or autolink
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(src);
      if (m) {
        const tag = m[0];
        if (!st.inLink && /^<a /i.test(tag)) st.inLink = true;
        else if (st.inLink && /^<\/a>/i.test(tag)) st.inLink = false;
        if (!st.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) st.inRawBlock = false;
        out += tag;
        i += tag.length;
        continue;
      }
      AUTOLINK_RE.lastIndex = i;
      const a = AUTOLINK_RE.exec(src);
      if (a) {
        const text = a[1];
        const href = a[2] === '@' ? 'mailto:' + text : text;
        const h = encodeHref(href);
        out += h === null ? esc(text, true) : '<a href="' + esc(h, true) + '">' + esc(text, true) + '</a>';
        i += a[0].length;
        continue;
      }
    }
    if (c === 91 || (c === 33 && src.charCodeAt(i + 1) === 91)) {
      const r = tryLink(src, i, links, st, false);
      if (r) { out += r.out; i = r.end; continue; }
      const rf = tryReflink(src, i, links, st, false);
      if (rf) {
        if (rf.text !== undefined) { out += esc(rf.text, false); i = rf.end; continue; }
        out += rf.out; i = rf.end; continue;
      }
    }
    if (c === 42 || c === 95) {
      const em = tryEmStrong(src, i, mask, closers, prevChar, links, st, false);
      if (em) { out += em.out; i = em.end; continue; }
    }
    if (c === 96) {
      CODE_SPAN_RE.lastIndex = i;
      const m = CODE_SPAN_RE.exec(src);
      if (m) {
        let t = m[2].replace(/\n/g, ' ');
        if (NON_SPACE_RE.test(t) && t.charCodeAt(0) === 32 && t.charCodeAt(t.length - 1) === 32) t = t.substring(1, t.length - 1);
        out += '<code>' + esc(t, true) + '</code>';
        i += m[0].length;
        continue;
      }
    }
    if (c === 32 || c === 92) { // hard break: two spaces or backslash + newline
      BR_RE.lastIndex = i;
      const m = BR_RE.exec(src);
      if (m) { out += '<br>'; i += m[0].length; continue; }
    }
    if (c === 126) {
      const d = tryDel(src, i, mask, closers, prevChar, links, st, false);
      if (d) { out += d.out; i = d.end; continue; }
    }
    if (!st.inLink) {
      const cc = c;
      if ((cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || cc === 46 || cc === 95 || cc === 43 || cc === 45) {
        URL_RE.lastIndex = i;
        const m = URL_RE.exec(src);
        if (m) {
          let text = m[0];
          let href;
          if (m[2] === '@') {
            href = 'mailto:' + text;
          } else {
            let cur = text;
            for (;;) {
              BACKPEDAL_RE.lastIndex = 0;
              const b = BACKPEDAL_RE.exec(cur);
              const next = b ? b[0] : '';
              if (next === cur) break;
              cur = next;
            }
            text = cur;
            href = m[1] === 'www.' ? 'http://' + text : text;
          }
          const h = encodeHref(href);
          out += h === null ? esc(text, true) : '<a href="' + esc(h, true) + '">' + esc(text, true) + '</a>';
          i += text.length;
          continue;
        }
      }
    }
    const j = scanTextEnd(src, i, n);
    const chunk = src.slice(i, j);
    out += st.inRawBlock ? chunk : esc(decodeEntities(chunk), false);
    if (chunk.charCodeAt(chunk.length - 1) !== 95) prevChar = chunk.charAt(chunk.length - 1);
    wasText = true;
    i = j;
  }
  return out;
}

function inlinePlain(src, links, st) {
  const n = src.length;
  if (n === 0) return '';
  const savedLpp = st.linkParenPossible;
  st.linkParenPossible = savedLpp && src.includes(')');
  try {
    return inlinePlainInner(src, links, st);
  } finally {
    st.linkParenPossible = savedLpp;
  }
}

function inlinePlainInner(src, links, st) {
  const n = src.length;
  const needMask = src.includes('*') || src.includes('_') || src.includes('~');
  const mask = needMask ? emMask(src, links) : src;
  const closers = needMask ? lastPossibleClosers(mask) : null;
  let out = '';
  let i = 0;
  let prevChar = '';
  let wasText = false;
  const savedInLink = st.inLink;
  st.inLink = true;
  while (i < n) {
    if (!wasText) prevChar = '';
    wasText = false;
    const c = src.charCodeAt(i);
    if (c === 92) {
      ESCAPE_RE.lastIndex = i;
      const m = ESCAPE_RE.exec(src);
      if (m) { out += m[1]; i += 2; continue; }
    }
    if (c === 60) {
      TAG_RE.lastIndex = i;
      const m = TAG_RE.exec(src);
      if (m) { out += m[0]; i += m[0].length; continue; }
      AUTOLINK_RE.lastIndex = i;
      const a = AUTOLINK_RE.exec(src);
      if (a) { out += a[1]; i += a[0].length; continue; }
    }
    if (c === 91 || (c === 33 && src.charCodeAt(i + 1) === 91)) {
      const r = tryLink(src, i, links, st, true);
      if (r) {
        if (r.text !== undefined) { out += r.text; i = r.end; continue; }
        out += r.out; i = r.end; continue;
      }
      const rf = tryReflink(src, i, links, st, true);
      if (rf) {
        if (rf.text !== undefined) { out += rf.text; i = rf.end; continue; }
        out += rf.out; i = rf.end; continue;
      }
    }
    if (c === 42 || c === 95) {
      const em = tryEmStrong(src, i, mask, closers, prevChar, links, st, true);
      if (em) { out += em.out; i = em.end; continue; }
    }
    if (c === 96) {
      CODE_SPAN_RE.lastIndex = i;
      const m = CODE_SPAN_RE.exec(src);
      if (m) {
        let t = m[2].replace(/\n/g, ' ');
        if (NON_SPACE_RE.test(t) && t.charCodeAt(0) === 32 && t.charCodeAt(t.length - 1) === 32) t = t.substring(1, t.length - 1);
        out += t;
        i += m[0].length;
        continue;
      }
    }
    if (c === 126) {
      const d = tryDel(src, i, mask, closers, prevChar, links, st, true);
      if (d) { out += d.out; i = d.end; continue; }
    }
    const j = scanTextEnd(src, i, n);
    const chunk = src.slice(i, j);
    out += st.inRawBlock ? chunk : decodeEntities(chunk);
    if (chunk.charCodeAt(chunk.length - 1) !== 95) prevChar = chunk.charAt(chunk.length - 1);
    wasText = true;
    i = j;
  }
  st.inLink = savedInLink;
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HR_SRC = '(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const ATX_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCE_LINE_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_START_SRC = ' {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const BQ_START_SRC = ' {0,3}>';
const CODE_LINE_SRC = '(?: {4}| {0,3}\\t)[^\\n]';
const LIST_INT_SRC = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
const LIST_ANY_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';
const LIST_TAB_SRC = ' {0,3}(?:[*+-]|1[.)])[ \\t]';
const TABLE_SRC = ' *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|' + HR_SRC + '|' + ATX_SRC + '|' + BQ_START_SRC + '|' + CODE_LINE_SRC + '|' + FENCE_LINE_SRC + '|' + LIST_TAB_SRC + '|' + HTML_START_SRC + ').*(?:\\n|$))*)\\n*|$)';

const PARA_GFM_RE = new RegExp('^([^\\n]+(?:\\n(?!' + HR_SRC + '|' + ATX_SRC + '|' + BQ_START_SRC + '|' + FENCE_LINE_SRC + '|' + LIST_INT_SRC + '|' + HTML_START_SRC + '|' + TABLE_SRC + '|[ \\t]+\\n)[^\\n]+)*)');
const PARA_BQ_RE = new RegExp('^([^\\n]+(?:\\n(?!' + HR_SRC + '|' + ATX_SRC + '|' + BQ_START_SRC + '|' + FENCE_LINE_SRC + '|' + LIST_ANY_SRC + '|' + HTML_START_SRC + '|[ \\t]+\\n)[^\\n]+)*)');
const TEXT_RE = /^[^\n]+/;

const SPACE_RE = /^(?:[ \t]*(?:\n|$))+/;
const INDENTED_CODE_RE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const CODE_INDENT_RE = /^(?: {0,3}\t| {1,4})/gm;
const FENCES_RE = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const ATX_RE = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const HR_RE = new RegExp('^ {0,3}(' + HR_SRC + ')');
const BLOCKQUOTE_RE = new RegExp('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + PARA_BQ_RE.source.slice(1) + ')|[^\\n]*)(?:\\n|$))+');
const HTML_COMMENT_RE = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_BLOCK_RE = new RegExp(
  '^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|' +
  HTML_COMMENT_RE.source + '[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|' +
  '</?(?:' + BLOCK_TAGS + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|' +
  '<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)|' +
  '</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$))', 'i');
const DEF_LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
const DEF_RE = new RegExp('^ {0,3}\\[(' + DEF_LABEL_SRC + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\)))? *(?:\\n+|$)');
const TABLE_RE = new RegExp('^' + TABLE_SRC);
const LHEADING_RE = new RegExp(
  '^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)' +
  '((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)');
const LIST_START_RE = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))((?:[ \t][^\n]*)?(?:\n|$))/;
const BQ_START_LINE_RE = /^ {0,3}>/;
const BQ_STRIP_RE = /^ {0,3}>[ \t]?/gm;
const BQ_MARKER_WS_RE = /^( {0,3}>)([ \t]+)/gm;
const BQ_SETEXT_RE = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const NEXT_BULLET_RE = (n) => new RegExp(`^ {0,${Math.max(0, Math.min(3, n - 1))}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`);
const HR_AT_RE = (n) => new RegExp(`^ {0,${Math.max(0, Math.min(3, n - 1))}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`);
const FENCES_AT_RE = (n) => new RegExp(`^ {0,${Math.max(0, Math.min(3, n - 1))}}(?:\`\`\`|~~~)`);
const HEADING_AT_RE = (n) => new RegExp(`^ {0,${Math.max(0, Math.min(3, n - 1))}}#{1,6}(?:\\s|$)`);
const HTML_AT_RE = (n) => new RegExp(`^ {0,${Math.max(0, Math.min(3, n - 1))}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
const BQ_AT_RE = (n) => new RegExp(`^ {0,${Math.max(0, Math.min(3, n - 1))}}>`);
// One regex for every way a line can interrupt a list item's lazy
// continuation (fences, ATX, HTML, blockquote, next bullet, hr).
const LIST_INTERRUPT_RE = (n) => {
  const k = Math.max(0, Math.min(3, n - 1));
  return new RegExp(`^ {0,${k}}(?:(?:\`\`\`|~~~)|#{1,6}(?:\\s|$)|</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[|>|(?:[*+-]|\\d{1,9}[.)])(?:[ \\t].*)?$|(?:-[ \\t]*){3,}$|(?:_[ \\t]*){3,}$|(?:\\*[ \\t]*){3,}$)`, 'i');
};
// The interrupt checks for the previous content line (no blockquote/bullet).
const LIST_INTERRUPT_M_RE = (n) => {
  const k = Math.max(0, Math.min(3, n - 1));
  return new RegExp(`^ {0,${k}}(?:(?:\`\`\`|~~~)|#{1,6}(?:\\s|$)|</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[|(?:-[ \\t]*){3,}$|(?:_[ \\t]*){3,}$|(?:\\*[ \\t]*){3,}$)`, 'i');
};
// The clamp in the factories above yields only 4 distinct patterns each;
// cache them so a long list does not recompile six regexes per item.
const _reCache = new Map();
function cachedRe(factory, n) {
  const k = Math.max(0, Math.min(3, n - 1));
  let m = _reCache.get(factory);
  if (!m) { m = []; _reCache.set(factory, m); }
  return m[k] || (m[k] = factory(n));
}

// Index of the first char that is not a space, or -1 (marked's nonSpaceChar
// is /[^ ]/: a tab counts as a non-space char here).
function firstNonSpaceIndex(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 32) return i;
  }
  return -1;
}

// First non-space column after replacing each tab with four spaces
// (the way marked's list code measures the previous content line).
function tabExpandedFirstNonSpace(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9) col += 4;
    else if (c === 32) col++;
    else return col;
  }
  return -1;
}

// Does the line look like a setext underline (`^ {0,3}(?:=+|-+) *$`)?
function isSetextLine(line) {
  let i = 0;
  while (i < 3 && line.charCodeAt(i) === 32) i++;
  const c = line.charCodeAt(i);
  if (c !== 61 && c !== 45) return false;
  let j = i;
  while (j < line.length && line.charCodeAt(j) === c) j++;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j === line.length;
}
const LIST_ITEM_RE = (a) => new RegExp(`^( {0,3}${a})((?:[ \t][^\\n]*)?(?:\\n|$))`);
const LEADING_WS_RE = /^[ \t]+/;
const NON_SPACE_AT_RE = /\S/;
const DOUBLE_BLANK_RE = /\n[ \t]*\n[ \t]*$/;
const ANY_LINE_RE = /\n.*\n/;
const TABLE_DELIM_RE = /[:|]/;

// Trim trailing blank lines the way marked does for code and HTML blocks:
// zero or one trailing blank line is kept, two or more are all dropped.
function trimTrailingBlankLines(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && BLANK_LINE_RE.test(lines[t])) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}

function stripTrailingChars(s, ch) {
  let n = s.length;
  while (n > 0 && s.charCodeAt(n - 1) === ch) n--;
  return s.slice(0, n);
}

// Strip trailing spaces, tabs and newlines without a regex scan.
function stripTrailingWS(s) {
  let n = s.length;
  while (n > 0) {
    const c = s.charCodeAt(n - 1);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
    n--;
  }
  return n === s.length ? s : s.slice(0, n);
}

// Split a table row on unescaped pipes.
function splitTableRow(row, count) {
  let t = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && row[j] === '\\'; j--) backslashes++;
      t += backslashes % 2 === 1 ? '|' : ' |';
    } else t += row[i];
  }
  const cells = t.split(' |');
  let s = 0;
  if (cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; s < cells.length; s++) cells[s] = cells[s].trim().replace(/\\\|/g, '|');
  return cells;
}

// --- block tokenizers -------------------------------------------------------

function trySpace(src) {
  SPACE_RE.lastIndex = 0;
  const m = SPACE_RE.exec(src);
  return m ? m[0] : null;
}

function tryIndentedCode(src) {
  INDENTED_CODE_RE.lastIndex = 0;
  const m = INDENTED_CODE_RE.exec(src);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  return { t: 'code', raw, text: raw.replace(CODE_INDENT_RE, ''), lang: null };
}

function tryFences(src) {
  FENCES_RE.lastIndex = 0;
  const m = FENCES_RE.exec(src);
  if (!m) return null;
  const raw = m[0];
  const info = m[2] || '';
  const lang = info ? info.trim().replace(ANY_PUNCT_RE, '$1') : info;
  // Indent compensation: lines lose up to the opening fence's indent.
  let text = m[3] || '';
  const open = /^(\s+)(?:```)/.exec(raw);
  if (open) {
    const ind = open[1].length;
    text = text.split('\n').map((line) => {
      const ws = LEADING_WS_RE.exec(line);
      if (!ws) return line;
      return line.slice(Math.min(ws[0].length, ind));
    }).join('\n');
  }
  return { t: 'code', raw, text, lang };
}

function tryHeading(src) {
  ATX_RE.lastIndex = 0;
  const m = ATX_RE.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (text.endsWith('#')) {
    const stripped = stripTrailingChars(text, 35);
    if (stripped === '' || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { t: 'heading', raw: stripTrailingChars(m[0], 10), depth: m[1].length, text };
}

function tryHr(src) {
  HR_RE.lastIndex = 0;
  const m = HR_RE.exec(src);
  return m ? { t: 'hr', raw: stripTrailingChars(m[0], 10) } : null;
}

function tryHtml(src) {
  HTML_BLOCK_RE.lastIndex = 0;
  const m = HTML_BLOCK_RE.exec(src);
  if (!m) return null;
  const raw = trimTrailingBlankLines(m[0]);
  return { t: 'html', raw, text: raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style' };
}

function tryDef(src, links) {
  DEF_RE.lastIndex = 0;
  const m = DEF_RE.exec(src);
  if (!m) return null;
  if (m[2].charCodeAt(0) !== 60 && parenBalance(m[2]) !== -1) return null;
  const tag = normLabel(m[1]);
  let href = m[2].replace(/^<(.*)>$/, '$1').replace(ANY_PUNCT_RE, '$1');
  let title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT_RE, '$1') : m[3];
  return { t: 'def', raw: stripTrailingChars(m[0], 10), tag, href, title };
}

function tryTable(src) {
  TABLE_RE.lastIndex = 0;
  const m = TABLE_RE.exec(src);
  if (!m || !TABLE_DELIM_RE.test(m[2])) return null;
  const headerCells = splitTableRow(m[1]);
  const aligns = m[2].replace(/^\||\| *$/g, '').split('|');
  const rowText = m[3] ? m[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  if (headerCells.length !== aligns.length) return null;
  const align = aligns.map((a) => {
    if (/^ *-+: *$/.test(a)) return 'right';
    if (/^ *:-+: *$/.test(a)) return 'center';
    if (/^ *:-+ *$/.test(a)) return 'left';
    return null;
  });
  const header = headerCells.map((text, i) => ({ text, align: align[i] }));
  const rows = rowText.map((line) => splitTableRow(line, header.length).map((text, i) => ({ text, align: align[i] })));
  return { t: 'table', raw: stripTrailingChars(m[0], 10), header, rows };
}

const SETEXT_GATE_RE = /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/;

function tryLheading(src) {
  // Cheap gate: a setext underline must sit before the first blank line.
  const blank = src.indexOf('\n\n');
  if (!SETEXT_GATE_RE.test(blank === -1 ? src : src.slice(0, blank))) return null;
  LHEADING_RE.lastIndex = 0;
  const m = LHEADING_RE.exec(src);
  if (!m) return null;
  return { t: 'heading', raw: stripTrailingChars(m[0], 10), depth: m[2].charAt(0) === '=' ? 1 : 2, text: m[1].trim() };
}

function tryParagraph(src) {
  PARA_GFM_RE.lastIndex = 0;
  const m = PARA_GFM_RE.exec(src);
  if (!m) return null;
  let text = m[1];
  if (text.charCodeAt(text.length - 1) === 10) text = text.slice(0, -1);
  return { t: 'paragraph', raw: m[0], text };
}

function tryText(src) {
  TEXT_RE.lastIndex = 0;
  const m = TEXT_RE.exec(src);
  return m ? { t: 'text', raw: m[0], text: m[0] } : null;
}

// --- blockquote -------------------------------------------------------------

function tryBlockquote(src, links) {
  BLOCKQUOTE_RE.lastIndex = 0;
  const m = BLOCKQUOTE_RE.exec(src);
  if (!m) return null;
  let lines = stripTrailingChars(m[0], 10).split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p = 0;
    for (; p < lines.length; p++) {
      if (BQ_START_LINE_RE.test(lines[p])) { chunk.push(lines[p]); hasMarker = true; }
      else if (!hasMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const joined = chunk.join('\n');
    const stripped = joined
      .replace(BQ_MARKER_WS_RE, (g, b, ws) => b + expandTabs(ws, b.length))
      .replace(BQ_SETEXT_RE, '\n    $1')
      .replace(BQ_STRIP_RE, '');
    raw = raw ? raw + '\n' + joined : joined;
    text = text ? text + '\n' + stripped : stripped;
    blockTokens(stripped, links, true, tokens, true);
    if (lines.length === 0) break;
    const last = tokens[tokens.length - 1];
    if (last && (last.t === 'code' || last.t === 'heading' || last.t === 'hr' || last.t === 'html' || last.t === 'table')) break;
    if (last && last.t === 'blockquote') {
      const g = last;
      const rest = lines.join('\n');
      const combined = g.raw + '\n' + rest.replace(BQ_STRIP_RE, '');
      const inner = tryBlockquote(combined, links);
      tokens[tokens.length - 1] = inner;
      const remaining = combined.substring(inner.raw.length).replace(/^\n/, '');
      const rCount = remaining ? remaining.split('\n').length : 0;
      const extra = rCount > 0 ? lines.slice(0, -rCount) : lines;
      if (extra.length > 0) raw = raw + '\n' + extra.join('\n');
      text = text.substring(0, text.length - g.text.length) + inner.text;
      lines = lines.slice(extra.length);
      if (lines.length > 0 && BQ_START_LINE_RE.test(lines[0])) continue;
      break;
    } else if (last && last.t === 'list') {
      const g = last;
      const combined = g.raw + '\n' + lines.join('\n');
      const reparsed = tryList(combined, links);
      tokens[tokens.length - 1] = reparsed;
      const consumed = reparsed.raw.length > g.raw.length
        ? combined.slice(g.raw.length + 1, reparsed.raw.length).split('\n').length : 0;
      if (consumed > 0) {
        const extra = lines.slice(0, consumed).join('\n');
        raw = raw + '\n' + extra;
        text = text + '\n' + extra;
      }
      lines = lines.slice(consumed);
      continue;
    }
  }
  return { t: 'blockquote', raw, text, tokens };
}

// --- lists ------------------------------------------------------------------

function tryList(src, links) {
  LIST_START_RE.lastIndex = 0;
  const first = LIST_START_RE.exec(src);
  if (!first) return null;
  const srcAll = src;
  let e = src;
  const pos = () => srcAll.length - e.length;
  const marker = first[1].trim();
  const ordered = marker.length > 1;
  const list = {
    t: 'list', raw: '', ordered, start: ordered ? +marker.slice(0, -1) : '',
    loose: false, items: [],
  };
  const bulletPat = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRe = LIST_ITEM_RE(bulletPat);
  let sawDoubleBlank = false;
  while (e) {
    let emptyItem = false;
    let d = '';
    itemRe.lastIndex = 0;
    const t = itemRe.exec(e);
    HR_RE.lastIndex = 0;
    if (!t || HR_RE.test(e)) break;
    const startPos = pos();
    e = e.substring(t[0].length);
    let g = t[2];
    if (g.charCodeAt(g.length - 1) === 10) g = g.slice(0, -1);
    const b = t[1].length;
    let content = g.replace(LEADING_WS_RE, (v) => expandTabs(v, b));
    const nl0 = e.indexOf('\n');
    const nextLine = nl0 === -1 ? e : e.slice(0, nl0);
    const y = !content.trim();
    let indent;
    if (y) {
      indent = b + 1;
    } else {
      indent = firstNonSpaceIndex(content);
      if (indent > 4) indent = 1;
      d = content.slice(indent);
      indent += b;
    }
    if (y && BLANK_LINE_RE.test(nextLine)) {
      e = e.substring(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const interrupt = cachedRe(LIST_INTERRUPT_RE, indent);
      const interruptM = cachedRe(LIST_INTERRUPT_M_RE, indent);
      let m = content;
      let isEmpty = y;
      while (e) {
        const nl = e.indexOf('\n');
        const line = nl === -1 ? e : e.slice(0, nl);
        const expanded = line.charCodeAt(0) === 32 || line.charCodeAt(0) === 9
          ? line.replace(LEADING_WS_RE, (v) => expandTabs(v, 0)) : line;
        if (interrupt.test(line)) break;
        const firstNonSpace = firstNonSpaceIndex(expanded);
        if (firstNonSpace >= indent || firstNonSpace === -1) {
          d += '\n' + expanded.slice(indent);
        } else {
          if (isEmpty || tabExpandedFirstNonSpace(m) >= 4 || interruptM.test(m)) break;
          const isSetext = isSetextLine(line) && (() => { LHEADING_RE.lastIndex = 0; return LHEADING_RE.test(m + '\n' + line); })();
          d += '\n' + (isSetext ? '    ' + expanded.replace(/^ {0,3}/, '') : line);
        }
        isEmpty = firstNonSpace === -1;
        e = nl === -1 ? '' : e.substring(nl + 1);
        m = expanded.slice(indent);
      }
    }
    const itemRaw = srcAll.slice(startPos, pos());
    if (!list.loose) {
      if (sawDoubleBlank) list.loose = true;
      else if (DOUBLE_BLANK_RE.test(itemRaw)) sawDoubleBlank = true;
    }
    list.items.push({
      t: 'list_item', raw: itemRaw, task: /^\[[ xX]\][ \t]+\S/.test(d),
      loose: false, text: d, tokens: [],
    });
  }
  const lastItem = list.items[list.items.length - 1];
  if (!lastItem) return null;
  lastItem.raw = stripTrailingWS(lastItem.raw);
  lastItem.text = stripTrailingWS(lastItem.text);
  list.raw = stripTrailingWS(srcAll.slice(0, pos()));
  for (const item of list.items) {
    blockTokens(item.text, links, false, item.tokens, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((tok) => tok.t === 'space');
      if (spaces.length > 0 && spaces.some((tok) => ANY_LINE_RE.test(tok.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && firstTok && (firstTok.t === 'text' || firstTok.t === 'paragraph')) {
      const strip = /^\[[ xX]\][ \t]+/;
      item.text = item.text.replace(strip, '');
      firstTok.raw = firstTok.raw.replace(strip, '');
      firstTok.text = firstTok.text.replace(strip, '');
      const cb = /\[[ xX]\]/.exec(item.raw);
      if (cb) {
        const checked = cb[0] !== '[ ]';
        const boxHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        if (list.loose) {
          firstTok.checkboxPrefix = boxHtml;
        } else {
          item.tokens.unshift({ t: 'checkbox', raw: cb[0] + ' ', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.t === 'text') tok.t = 'paragraph';
    }
  }
  return list;
}

// --- main block loop ---------------------------------------------------------

function blockTokens(src, links, top, out, inBlockquote) {
  let s = src;
  while (s) {
    const sp = trySpace(s);
    if (sp !== null) {
      s = s.substring(sp.length);
      const prev = out[out.length - 1];
      if (sp.length === 1 && prev !== undefined) prev.raw += '\n';
      else out.push({ t: 'space', raw: sp });
      continue;
    }
    const code = tryIndentedCode(s);
    if (code) {
      s = s.substring(code.raw.length);
      const prev = out[out.length - 1];
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + code.raw;
        prev.text += '\n' + code.text;
      } else out.push(code);
      continue;
    }
    const fence = tryFences(s);
    if (fence) { s = s.substring(fence.raw.length); out.push(fence); continue; }
    const head = tryHeading(s);
    if (head) { s = s.substring(head.raw.length); out.push(head); continue; }
    const hr = tryHr(s);
    if (hr) { s = s.substring(hr.raw.length); out.push(hr); continue; }
    const bq = tryBlockquote(s, links);
    if (bq) { s = s.substring(bq.raw.length); out.push(bq); continue; }
    const list = tryList(s, links);
    if (list) { s = s.substring(list.raw.length); out.push(list); continue; }
    const html = tryHtml(s);
    if (html) { s = s.substring(html.raw.length); out.push(html); continue; }
    const def = tryDef(s, links);
    if (def) {
      s = s.substring(def.raw.length);
      const prev = out[out.length - 1];
      if (prev && (prev.t === 'paragraph' || prev.t === 'text')) {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + def.raw;
        prev.text += '\n' + def.raw;
      } else {
        if (!Object.hasOwn(links, def.tag)) links[def.tag] = { href: def.href, title: def.title };
        out.push(def);
      }
      continue;
    }
    const table = tryTable(s);
    if (table) { s = s.substring(table.raw.length); out.push(table); continue; }
    const lh = tryLheading(s);
    if (lh) { s = s.substring(lh.raw.length); out.push(lh); continue; }
    if (top) {
      const para = tryParagraph(s);
      if (para) {
        s = s.substring(para.raw.length);
        const prev = out[out.length - 1];
        if (inBlockquote && prev && prev.t === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + para.raw;
          prev.text += '\n' + para.text;
        } else out.push(para);
        continue;
      }
    }
    const text = tryText(s);
    if (text) {
      s = s.substring(text.raw.length);
      const prev = out[out.length - 1];
      if (prev && prev.t === 'text') {
        prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + text.raw;
        prev.text += '\n' + text.text;
      } else out.push(text);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + s.charCodeAt(0));
  }
  return out;
}

// --- rendering ---------------------------------------------------------------

function renderTokens(tokens, links, st) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'space':
      case 'def':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading': {
        st.inRawBlock = false;
        out += '<h' + tok.depth + '>' + inlineHTML(tok.text, links, st) + '</h' + tok.depth + '>\n';
        break;
      }
      case 'code': {
        const lang = tok.lang ? (tok.lang.match(/^\S*/) || [''])[0] : '';
        const text = tok.text ? tok.text.replace(/\n$/, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + esc(lang, false) + '">' + esc(text, true) + '</code></pre>\n'
          : '<pre><code>' + esc(text, true) + '</code></pre>\n';
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of tok.header) {
          st.inRawBlock = false;
          head += cell.align ? '<th align="' + cell.align + '">' : '<th>';
          head += inlineHTML(cell.text, links, st) + '</th>\n';
        }
        let body = '';
        for (const row of tok.rows) {
          let rowHtml = '';
          for (const cell of row) {
            st.inRawBlock = false;
            rowHtml += cell.align ? '<td align="' + cell.align + '">' : '<td>';
            rowHtml += inlineHTML(cell.text, links, st) + '</td>\n';
          }
          body += '<tr>\n' + rowHtml + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' +
          (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderTokens(tok.tokens, links, st) + '</blockquote>\n';
        break;
      case 'list': {
        let items = '';
        for (const item of tok.items) items += '<li>' + renderTokens(item.tokens, links, st) + '</li>\n';
        const tag = tok.ordered ? 'ol' : 'ul';
        const start = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'checkbox':
        out += '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      case 'html':
        out += tok.text;
        break;
      case 'paragraph': {
        st.inRawBlock = false;
        out += '<p>' + (tok.checkboxPrefix || '') + inlineHTML(tok.text, links, st) + '</p>\n';
        break;
      }
      case 'text': {
        st.inRawBlock = false;
        out += (tok.checkboxPrefix || '') + inlineHTML(tok.text, links, st);
        break;
      }
    }
  }
  return out;
}

// --- entry point --------------------------------------------------------------

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const links = Object.create(null);
  const tokens = [];
  blockTokens(src, links, true, tokens, false);
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  return renderTokens(tokens, links, st);
}
