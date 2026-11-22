// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// Written from scratch for this entry. It re-implements makefun-site's
// build (front matter, its Markdown subset, its template dialect, its slug
// rule and its report) from the behaviour the README and the reference
// program state, in a single pass wherever the rules allow: the sources
// are read as line arrays once, each body is lexed and rendered in one
// sweep, plain text is escaped in bulk instead of one character at a
// time, slugs are cached per case, and every template is compiled to a
// JavaScript function, with the partials that only read the site, its
// tags and its recent posts rendered once per case and reused.
//
// run(input) returns exactly the output tree makefun-site 1.0.0 returns
// for the same input. Nothing is cached from one case to the next: every
// cache below lives in the per-run context created inside run().

// ------------------------------------------------------------------ text

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a code unit is JavaScript whitespace (the \s set). */
function isWS(code) {
  return (
    code <= 32 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/** Whether `line` holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** `s` with spaces and tabs at its end dropped. */
function stripTrailing(s) {
  let b = s.length;
  while (b > 0 && (s.charCodeAt(b - 1) === 32 || s.charCodeAt(b - 1) === 9)) b--;
  return s.slice(0, b);
}

const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  if (!ESC_TEST.test(text)) return text;
  let out = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let r = '';
    if (c === 38) r = '&amp;';
    else if (c === 60) r = '&lt;';
    else if (c === 62) r = '&gt;';
    else if (c === 34) r = '&quot;';
    else if (c === 39) r = '&#39;';
    else continue;
    out += text.slice(start, i) + r;
    start = i + 1;
  }
  return out + text.slice(start);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/**
 * The slug of `text`, cached per run: NFKD, combining marks dropped, A-Z
 * lowered, every run of characters other than a-z and 0-9 one "-", none at
 * either end, at most 64 characters, "untitled" when nothing is left.
 */
function slugify(C, text) {
  const hit = C.slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = '';
    if (code >= 65 && code <= 90) keep = String.fromCharCode(code + 32);
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = plain[i];
    if (keep === '') {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  C.slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** The words of `lines` from `start`: runs of characters other than whitespace. */
function countWords(lines, start) {
  let n = 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      const code = line.charCodeAt(j);
      if (code <= 32) {
        inWord = false;
        continue;
      }
      if (code < 0xa0) {
        if (!inWord) {
          inWord = true;
          n++;
        }
        continue;
      }
      // Rare: a code unit at or above U+00A0 may still be whitespace.
      if (isWS(code)) {
        inWord = false;
        continue;
      }
      if (!inWord) {
        inWord = true;
        n++;
      }
    }
  }
  return n;
}

// ------------------------------------------------------------ front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
      return { error: 'a quoted string is not closed' };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) {
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        }
        out += nx;
        i++;
      } else if (c === '"') {
        return { error: 'a quoted string holds a stray quote' };
      } else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** Whether `s` is all digits. */
function allDigits(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return s.length > 0;
}

/** Whether `s` is a template name: a-z, 0-9 and -. */
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

/** Whether `s` is a slug: a-z and 0-9, single - between, at most 64 chars. */
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true; // a slug never opens on -
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 45) {
      if (prevDash) return false;
      prevDash = true;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
    } else return false;
  }
  return !prevDash; // never closes on -
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const okShape =
        raw.length === 10 &&
        raw.charCodeAt(4) === 45 &&
        raw.charCodeAt(7) === 45 &&
        allDigits(raw.slice(0, 4)) &&
        allDigits(raw.slice(5, 7)) &&
        allDigits(raw.slice(8, 10));
      const y = okShape ? Number(raw.slice(0, 4)) : 0;
      const mo = okShape ? Number(raw.slice(5, 7)) : 0;
      const d = okShape ? Number(raw.slice(8, 10)) : 0;
      if (!okShape || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) {
          const c = t.charCodeAt(i);
          if (c === 34 || c === 91 || c === 93) {
            return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          }
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body start: { data, bodyStart }, or
 * { error } with the first reason it is refused. `lines` is the source's
 * text split on "\n".
 */
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      j++;
    }
    if (j === 0 || line.charCodeAt(j) !== 58) {
      return { error: `line ${i + 1} is not "key: value"` };
    }
    const key = line.slice(0, j);
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line.charCodeAt(j + 1) === 32) raw = stripTrailing(line.slice(j + 2));
    else return { error: `line ${i + 1} is not "key: value"` };
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyStart: close + 1 };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, by code unit (all ASCII). */
const ESC_TBL = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESC_TBL[ch.charCodeAt(0)] = 1;
}

/** Whether `ch` (a code unit) is a fence language character. */
function isLangChar(code) {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 43 ||
    code === 45
  );
}

/** A fence's language when `line` opens one, else null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? lang : null;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 35) i++;
  if (i < 1 || i > 6) return null;
  let j = i;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === i) return null;
  const text = stripTrailing(line.slice(j));
  return text === '' ? null : { depth: i, text };
}

/** Whether `line` is a thematic break. */
function isHR(line) {
  const dash = line.charCodeAt(0) === 45 && line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45;
  const star = line.charCodeAt(0) === 42 && line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42;
  if (!dash && !star) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet list line's item text, or null. */
function bulletStart(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered list line's start and item text, or null. */
function orderedStart(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j < 1 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 32) k++;
  if (k < 2 || k >= line.length) return false;
  const c = line.charCodeAt(k);
  return c !== 32 && c !== 9;
}

/** Whether `line` ends a paragraph. */
function endsPara(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const wlen = what.length;
  for (let j = from; j <= s.length - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESC_TBL[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && ESC_TBL[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const HAS_WS = /\s/;

/** `s` rendered inline, appended to `out`; `link(target)` is a link's href.
 * The next special character is found by one regex scan; the plain text
 * between specials needs no escaping, so it is pushed as it stands. */
function inlineInto(C, s, link, out) {
  const re = /[*`\[\\&<>"']/g;
  let start = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const code = s.charCodeAt(j);
    if (code === 92) {
      // backslash before an escapable character writes that character (escaped)
      if (j + 1 < s.length && ESC_TBL[s.charCodeAt(j + 1)] === 1) {
        if (j > start) out.push(s.slice(start, j));
        const nx = s[j + 1];
        out.push(nx === '>' ? '&gt;' : nx);
        start = j + 2;
        re.lastIndex = start;
        continue;
      }
      continue; // a lone backslash is itself, and stays in the plain run
    }
    if (code === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > start) out.push(s.slice(start, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        start = k + 1;
        re.lastIndex = start;
        continue;
      }
      continue; // a backtick with no closer is itself
    }
    if (code === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > start) out.push(s.slice(start, j));
          out.push('<strong>');
          inlineInto(C, s.slice(j + 2, k), link, out);
          out.push('</strong>');
          start = k + 2;
          re.lastIndex = start;
          continue;
        }
        re.lastIndex = j + 2; // unclosed ** is itself; skip both stars
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > start) out.push(s.slice(start, j));
        out.push('<em>');
        inlineInto(C, s.slice(j + 1, k), link, out);
        out.push('</em>');
        start = k + 1;
        re.lastIndex = start;
        continue;
      }
      continue; // a * with no closer is itself
    }
    if (code === 91) {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !HAS_WS.test(target)) {
        if (j > start) out.push(s.slice(start, j));
        out.push('<a href="', esc(link(target)), '">');
        inlineInto(C, s.slice(j + 1, k), link, out);
        out.push('</a>');
        start = mm + 1;
        re.lastIndex = start;
        continue;
      }
      continue; // a [ with no link after it is itself
    }
    if (j > start) out.push(s.slice(start, j));
    out.push(
      code === 38 ? '&amp;' : code === 60 ? '&lt;' : code === 62 ? '&gt;' : code === 34 ? '&quot;' : '&#39;',
    );
    start = j + 1;
  }
  if (s.length > start) out.push(s.slice(start));
}

/** `s` rendered inline. */
function inlineStr(C, s, link) {
  const out = [];
  inlineInto(C, s, link, out);
  return out.join('');
}

/**
 * `lines` from `start` rendered: its HTML, its table of contents (every
 * level 2 and 3 heading) and its excerpt (the first paragraph's inline
 * HTML, or ""). `link(target)` is a link's href.
 */
function renderBody(C, lines, start, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      let code = '';
      for (const l of body) code += esc(l) + '\n';
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(C, heading.text), ids);
      const html = inlineStr(C, heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) {
        toc.push({ level: heading.depth, id, html });
      }
      i++;
      continue;
    }
    if (isHR(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.slice(1);
        if (l.charCodeAt(0) === 32) l = l.slice(1);
        body.push(trimLine(l));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(
        kept.length === 0
          ? '<blockquote>\n</blockquote>'
          : `<blockquote>\n<p>${inlineStr(C, kept.join('\n'), link)}</p>\n</blockquote>`,
      );
      continue;
    }
    const bullet = bulletStart(line);
    const ordered = bullet === null ? orderedStart(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const m = isOrdered ? orderedStart(lines[i]) : bulletStart(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let inner = '';
      for (const parts of items) inner += `<li>${inlineStr(C, parts.join('\n'), link)}</li>\n`;
      blocks.push(`${open}\n${inner}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsPara(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(C, body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) {
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  }
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      }
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) {
          throw new TemplateError(`template "${name}": an else outside an if`);
        }
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) {
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        }
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
        body.push({ kind: 'include', name: m[1] });
      } else {
        throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
      }
    }
  }
  if (stack.length > 1) {
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  }
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The free roots of a template's nodes: the first names of the paths it
 * reads that no enclosing for binds, following includes. `free` holds the
 * current value per template name (a fixpoint over the include graph).
 */
function collectFree(nodes, bound, free, out) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      collectFree(n.body, inner, free, out);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      collectFree(n.then, bound, free, out);
      if (n.else !== null) collectFree(n.else, bound, free, out);
    } else if (n.kind === 'include') {
      const sub = free.get(n.name);
      if (sub !== undefined) for (const r of sub) if (!bound.has(r)) out.add(r);
    }
  }
}

/** The longest include chain from `name` (Infinity when a cycle is reachable). */
function chainDepth(name, parsed, memo, seen) {
  if (memo.has(name)) return memo.get(name);
  if (seen.has(name)) return Infinity;
  const nodes = parsed.get(name);
  if (nodes === undefined) return 0;
  seen.add(name);
  let depth = 0;
  const walk = (ns) => {
    for (const n of ns) {
      if (n.kind === 'include') {
        const d = chainDepth(n.name, parsed, memo, seen);
        depth = Math.max(depth, d === Infinity ? Infinity : d + 1);
      } else if (n.kind === 'for') walk(n.body);
      else if (n.kind === 'if') {
        walk(n.then);
        if (n.else !== null) walk(n.else);
      }
    }
  };
  walk(nodes);
  seen.delete(name);
  memo.set(name, depth);
  return depth;
}

/** The names every render of a case reads the same value for. */
const CASE_CONSTANTS = new Set(['site', 'tags', 'recent']);

/** Compile one template's nodes to a function (S, T, D, H, C) => string. */
function compileTemplate(nodes) {
  const ctx = { temp: 0, uniq: 0, code: [] };
  const genPath = (scopeVar, path) => {
    const t = `_t${ctx.temp++}`;
    ctx.code.push(`${t}=${scopeVar}.${path[0]};`);
    for (let k = 1; k < path.length; k++) {
      const key = JSON.stringify(path[k]);
      ctx.code.push(
        `if(${t}!==null&&typeof ${t}==="object"&&H.ho(${t},${key})){${t}=${t}[${key}];}else{${t}=undefined;}`,
      );
    }
    return t;
  };
  const genNodes = (ns, scopeVar) => {
    for (const n of ns) {
      if (n.kind === 'text') {
        ctx.code.push(`_o.push(${JSON.stringify(n.text)});`);
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const t = genPath(scopeVar, n.path);
        ctx.code.push(
          n.kind === 'var'
            ? `_o.push(H.esc(H.textOf(${t})));`
            : `_o.push(H.textOf(${t}));`,
        );
      } else if (n.kind === 'if') {
        const t = genPath(scopeVar, n.path);
        ctx.code.push(`if(H.truthy(${t})!==${n.not}){`);
        genNodes(n.then, scopeVar);
        if (n.else !== null) {
          ctx.code.push('}else{');
          genNodes(n.else, scopeVar);
        }
        ctx.code.push('}');
      } else if (n.kind === 'for') {
        const t = genPath(scopeVar, n.path);
        const k = ctx.uniq++;
        const child = `S${ctx.uniq++}`;
        ctx.code.push(`if(Array.isArray(${t})){const _a${k}=${t};`);
        ctx.code.push(`for(let _i${k}=0;_i${k}<_a${k}.length;_i${k}++){`);
        ctx.code.push(`const ${child}=Object.create(${scopeVar});`);
        ctx.code.push(`${child}.${n.name}=_a${k}[_i${k}];`);
        ctx.code.push(
          `${child}.loop={index:_i${k}+1,first:_i${k}===0,last:_i${k}===_a${k}.length-1,length:_a${k}.length};`,
        );
        genNodes(n.body, child);
        ctx.code.push('}}');
      } else if (n.kind === 'include') {
        ctx.code.push(`_o.push(H.inc(T,${JSON.stringify(n.name)},${scopeVar},D,C));`);
      }
    }
  };
  genNodes(nodes, 'S');
  const temps = ctx.temp === 0 ? '' : `let ${Array.from({ length: ctx.temp }, (_, i) => `_t${i}`).join(',')};`;
  const src = `"use strict";const _o=[];${temps}\n${ctx.code.join('\n')}\nreturn _o.join("");`;
  return new Function('S', 'T', 'D', 'H', 'C', src);
}

/**
 * An include, with memoisation: a template whose free roots are all
 * case-constant renders once per case; one with a single other free root
 * renders once per value of that root. Both only where the include depth
 * can never cut a nested include off (D + chain <= 7), so the memoised
 * string cannot depend on the depth it was rendered at.
 */
function inc(T, name, S, D, C) {
  const fn = T.get(name);
  if (fn === undefined || D >= INCLUDE_DEPTH) return '';
  const info = C.memoInfo.get(name);
  if (info === undefined || info.kind === 2 || D + info.chain > 7) {
    return fn(S, T, D + 1, H, C);
  }
  if (info.kind === 0) {
    let hit = C.memoConst.get(name);
    if (hit === undefined) {
      hit = fn(S, T, D + 1, H, C);
      C.memoConst.set(name, hit);
    }
    return hit;
  }
  let m = C.memoKeyed.get(name);
  if (m === undefined) {
    m = new Map();
    C.memoKeyed.set(name, m);
  }
  const key = S[info.root];
  let hit = m.get(key);
  if (hit === undefined) {
    hit = fn(S, T, D + 1, H, C);
    m.set(key, hit);
  }
  return hit;
}

/** The helpers a compiled template calls. */
const H = { esc, textOf, truthy, ho: Object.hasOwn, inc };

// -------------------------------------------------------------------- build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const C = {
    slugCache: new Map(),
    memoConst: new Map(),
    memoKeyed: new Map(),
    memoInfo: new Map(),
    report: [],
    broken: new Set(),
  };
  const base = input.site.base_url.replace(/\/+$/, '');

  // Templates: parsed in code-unit order of name; one that does not
  // parse is reported and left out.
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      C.report.push(err.message);
    }
  }

  // Free roots per template (fixpoint over the include graph), the
  // longest include chain, the memo plan, and the compiled functions.
  const free = new Map();
  for (const name of parsed.keys()) free.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of parsed) {
      const out = new Set();
      collectFree(nodes, new Set(), free, out);
      const prev = free.get(name);
      if (out.size !== prev.size || [...out].some((r) => !prev.has(r))) {
        free.set(name, out);
        changed = true;
      }
    }
  }
  const chains = new Map();
  const fns = new Map();
  for (const [name, nodes] of parsed) {
    const roots = free.get(name);
    const rest = [...roots].filter((r) => !CASE_CONSTANTS.has(r));
    const chain = chainDepth(name, parsed, chains, new Set());
    C.memoInfo.set(
      name,
      rest.length === 0
        ? { kind: 0, root: null, chain }
        : rest.length === 1
          ? { kind: 1, root: rest[0], chain }
          : { kind: 2, root: null, chain },
    );
    fns.set(name, compileTemplate(nodes));
  }

  // 1. The sources, in code-unit order of their paths, line ends "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content;
      sources.push({ path: f.path, lines: text.split('\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: refused or draft sources are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      C.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyStart = fm.bodyStart;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      C.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      C.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!parsed.has(layout)) {
      C.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      C.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Each page's output directory and url: its slug made unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    const dirTaken = taken.get(dir);
    s.slug = uniqueSlug(s.data.slug ?? slugify(C, s.data.title), dirTaken);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) {
        return target;
      }
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      C.broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderBody(C, s.lines, s.bodyStart, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = countWords(s.lines, s.bodyStart);
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags, grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(C, name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(C, name);
      if (!bySlug.has(slug)) {
        bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      }
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map(
        (name) =>
          bySlug.get(slugify(C, name)) ?? { name, slug: slugify(C, name), url: '', posts: [] },
      );
    }
  }
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // A page's link record, a tag, and a post's card, as templates read them.
  const linkOf = (s) =>
    s === null
      ? null
      : {
          title: s.data.title,
          url: s.url,
          date: s.data.date ?? '',
          date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s, cards) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t, cards) => ({
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
    posts: t.posts.map((p) => cards.get(p)),
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = fns.get(name);
    if (fn === undefined) return null;
    const S = Object.create(null);
    S.site = site;
    S.tags = allTags;
    S.recent = recent;
    for (const k of Object.keys(vars)) S[k] = vars[k];
    return fn(S, fns, 0, H, C);
  };
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t, cards) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) {
      C.report.push(`shadowed ${f.path}: a built page has its path`);
    } else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...C.report, ...C.broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(
    `built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`,
  );
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
