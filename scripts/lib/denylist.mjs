// Pure helpers for the leak guard: parsing the private list, folding text,
// finding matches, masking terms and parsing git's machine-readable output.
// No file system and no child processes here, so every rule can be unit-tested
// with invented data. The CLI (scripts/check-denylist.mjs) does the IO.

/** Commit e-mails allowed in this repository: a GitHub no-reply address or the local placeholder. */
export const ALLOWED_EMAIL = /^[^@\s<>]+@(users\.noreply\.github\.com|example\.invalid)$/i;

/** The committer of merges and edits made on github.com. Accepted in history as a committer only. */
export const WEB_COMMITTER_EMAIL = 'noreply@github.com';

/** C0 and C1 control characters, including NUL. A term never contains one. */
const CONTROL = /\p{Cc}/u;

/**
 * Folds text so comparisons ignore case, accents and invisible characters.
 * Canonical decomposition (NFD gives the same result for NFC and NFD input) splits
 * "é" into "e" + a combining accent; the accents and the invisible format characters
 * (soft hyphen, zero-width space, BOM, bidi marks) are stripped; then the text is lowercased.
 * "Élodie", "ELODIE" and "E\u0301lodie" all fold to "elodie".
 * The Greek final sigma is folded to the ordinary sigma so the result of each character
 * does not depend on its neighbours (maskTerms relies on that).
 * Line breaks are never changed, so line numbers survive folding.
 * @param {string} text
 */
export function fold(text) {
  return text.normalize('NFD').replace(/[\p{M}\p{Cf}]/gu, '').toLowerCase().replace(/ς/g, 'σ');
}

/** Swaps byte pairs (UTF-16BE <-> UTF-16LE). Throws on an odd length. */
function swapBytes(bytes) {
  return Buffer.from(bytes).swap16();
}

/**
 * Decodes the private list strictly: UTF-16LE/BE by BOM, otherwise UTF-8 (BOM stripped).
 * Invalid bytes throw, because a wrongly encoded list must fail loudly instead of
 * scanning with garbage terms.
 * @param {Uint8Array} bytes
 */
function decodeList(bytes) {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16le', { fatal: true }).decode(swapBytes(bytes));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('the denylist is not valid UTF-8 or UTF-16; save it as UTF-8');
  }
}

/**
 * Parses the private list: one term per line, blank lines and `#` comments ignored.
 * Terms are returned folded (see fold). Entry #k in reports is the k-th term here.
 * Error messages give line numbers only, never the term.
 * @param {string | Uint8Array} input the list as text (environment variable) or raw file bytes
 * @returns {string[]}
 */
export function parseTerms(input) {
  const raw = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeList(input);
  const terms = [];
  raw.split(/\r\n|\n|\r/).forEach((line, i) => {
    const entry = line.trim();
    if (!entry || entry.startsWith('#')) return;
    if (CONTROL.test(entry)) {
      throw new Error(`line ${i + 1} of the denylist contains a control character; save the list as UTF-8 (or UTF-16 with a BOM)`);
    }
    const term = fold(entry);
    if (!term) throw new Error(`line ${i + 1} of the denylist is empty once accents and invisible characters are removed`);
    terms.push(term);
  });
  return terms;
}

/**
 * Cuts a commit message at git's scissors line ("# ------------------------ >8 ------------------------",
 * with any comment string). Git drops that line and everything below it (the diff of `git commit -v`).
 * @param {string} text
 */
export function cutAtScissors(text) {
  const m = /^\S+ -{24} >8 -{24}\r?$/m.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/**
 * Splits a git identity ("Name <email>", optionally followed by a date) into its parts.
 * @param {string} ident
 * @returns {{ name: string, email: string } | null}
 */
export function splitIdent(ident) {
  const m = /^(.*?) ?<([^<>]*)>( .*)?$/.exec(ident);
  return m ? { name: m[1], email: m[2] } : null;
}

/**
 * Finds terms in a block of text, line by line (lines are numbered from 1).
 * Text and terms are both folded, so the match ignores case and accents.
 * @param {string} text
 * @param {string[]} terms
 * @returns {{ line: number, term: number }[]} term is the 1-based entry number
 */
export function matchText(text, terms) {
  const wanted = terms.map(fold);
  const hits = [];
  fold(text).split(/\r?\n/).forEach((line, i) => {
    wanted.forEach((term, j) => {
      if (term && line.includes(term)) hits.push({ line: i + 1, term: j + 1 });
    });
  });
  return hits;
}

/**
 * Line 0 is the file path itself; lines 1..n are the content.
 * @param {{ path: string, text: string }[]} files
 * @param {string[]} terms
 */
export function findMatches(files, terms) {
  const hits = [];
  for (const file of files) {
    const inPath = new Set(matchText(file.path, terms).map((h) => h.term));
    for (const term of inPath) hits.push({ path: file.path, line: 0, term });
    for (const h of matchText(file.text, terms)) hits.push({ path: file.path, line: h.line, term: h.term });
  }
  return hits;
}

/**
 * Replaces every occurrence of any term with `***`, ignoring case and accents.
 * Every string the guard prints goes through this, so a private term can never reach
 * a terminal or a CI log, even as part of a file path.
 * @param {string} text
 * @param {string[]} terms
 */
export function maskTerms(text, terms) {
  const wanted = terms.map(fold).filter(Boolean);
  if (!text || wanted.length === 0) return text;

  // Fold character by character, remembering which original character produced
  // each folded unit, so a match in the folded text maps back to the original.
  const chars = []; // { start, end, empty } in the original string
  const owner = []; // folded unit index -> index in chars
  let folded = '';
  let pos = 0;
  for (const ch of text) {
    const f = fold(ch);
    chars.push({ start: pos, end: pos + ch.length, empty: f.length === 0 });
    for (let k = 0; k < f.length; k++) owner.push(chars.length - 1);
    folded += f;
    pos += ch.length;
  }

  // Collect the original ranges to hide.
  const ranges = [];
  for (const term of wanted) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + 1)) {
      const first = owner[at];
      let last = owner[at + term.length - 1];
      // Accents after the last letter fold to nothing but belong to the match.
      while (last + 1 < chars.length && chars[last + 1].empty) last++;
      ranges.push([chars[first].start, chars[last].end]);
    }
  }
  if (ranges.length === 0) return text;

  // Merge overlapping or touching ranges and rebuild the string.
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  let [from, to] = ranges[0];
  for (const [s, e] of ranges.slice(1)) {
    if (s <= to) {
      to = Math.max(to, e);
      continue;
    }
    out += text.slice(cursor, from) + '***';
    cursor = to;
    [from, to] = [s, e];
  }
  return out + text.slice(cursor, from) + '***' + text.slice(to);
}

/**
 * Decodes a scanned blob: UTF-16LE/BE when it starts with a UTF-16 BOM, otherwise UTF-8
 * (lenient, so binary files still expose their ASCII and UTF-8 runs).
 * @param {Uint8Array} bytes
 */
export function decodeText(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const even = (b) => b.subarray(0, b.length - (b.length % 2));
  if (buf[0] === 0xff && buf[1] === 0xfe) return even(buf.subarray(2)).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return swapBytes(even(buf.subarray(2))).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  return buf.toString('utf8');
}

const RAW_HEADER = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z])\d*$/;

/**
 * Parses `git diff --raw -z` / `git log --raw -z` output (full object names).
 * Renames and copies carry two paths; the destination path is the one returned.
 * Anything that is not a raw entry (commit separators) is skipped.
 * @param {Uint8Array | string} output
 * @returns {{ srcMode: string, dstMode: string, srcSha: string, dstSha: string, status: string, path: string }[]}
 */
export function parseRawDiff(output) {
  const tokens = (typeof output === 'string' ? output : Buffer.from(output).toString('utf8')).split('\0');
  const entries = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = RAW_HEADER.exec(tokens[i].replace(/^\n+/, ''));
    if (!m) continue;
    const [, srcMode, dstMode, srcSha, dstSha, status] = m;
    const twoPaths = status === 'R' || status === 'C';
    const p = twoPaths ? tokens[i + 2] : tokens[i + 1];
    i += twoPaths ? 2 : 1;
    if (p !== undefined) entries.push({ srcMode, dstMode, srcSha, dstSha, status, path: p });
  }
  return entries;
}

/**
 * Parses `git cat-file --batch` output.
 * @param {Uint8Array} output
 * @returns {{ sha: string, type?: string, content?: Buffer, missing?: boolean }[]}
 */
export function parseCatFileBatch(output) {
  const buf = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  const objects = [];
  let pos = 0;
  while (pos < buf.length) {
    const eol = buf.indexOf(0x0a, pos);
    if (eol === -1) throw new Error('truncated cat-file output');
    const header = buf.subarray(pos, eol).toString('utf8');
    const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(header);
    if (!m) {
      // "<name> missing" or "<name> ambiguous": the object could not be read.
      objects.push({ sha: header.split(' ')[0], missing: true });
      pos = eol + 1;
      continue;
    }
    const size = Number(m[3]);
    const start = eol + 1;
    if (start + size > buf.length) throw new Error('truncated cat-file output');
    objects.push({ sha: m[1], type: m[2], content: buf.subarray(start, start + size) });
    pos = start + size + 1; // the content is followed by a newline
  }
  return objects;
}

/**
 * Parses `git rev-list --objects` output: "<sha>" or "<sha> <path>" per line.
 * @param {Uint8Array | string} output
 * @returns {{ sha: string, path: string }[]}
 */
export function parseRevListObjects(output) {
  const text = typeof output === 'string' ? output : Buffer.from(output).toString('utf8');
  const objects = [];
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{40,64})(?: (.*))?$/.exec(line);
    if (m) objects.push({ sha: m[1], path: m[2] ?? '' });
  }
  return objects;
}

/**
 * The entries of a tar archive (already gunzipped): each header's path and its content, whatever
 * the entry type. Extended headers (pax, GNU long names) come out as entries too, so a long path
 * they carry is scanned as content.
 * @param {Uint8Array} bytes
 * @returns {{ path: string, type: string, content: Buffer }[]}
 */
export function readTar(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const field = (from, length) => {
    const raw = buf.subarray(from, from + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? length : end).toString('utf8');
  };
  const entries = [];
  let pos = 0;
  while (pos + 512 <= buf.length) {
    if (buf.subarray(pos, pos + 512).every((b) => b === 0)) break; // the end-of-archive blocks
    const size = Number.parseInt(field(pos + 124, 12).trim() || '0', 8);
    if (field(pos + 257, 5) !== 'ustar' || !Number.isInteger(size) || size < 0 || pos + 512 + size > buf.length) {
      throw new Error('malformed tar archive');
    }
    const prefix = field(pos + 345, 155);
    const name = field(pos, 100);
    entries.push({
      path: prefix ? `${prefix}/${name}` : name,
      type: String.fromCharCode(buf[pos + 156] || 48), // an empty type flag is a regular file
      content: buf.subarray(pos + 512, pos + 512 + size),
    });
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
