// solve.js — fast drop-in for csv-reader 1.0.0 (make.fun csv-reader-speed-01).
// Pure JavaScript, no dependencies, no regex, no split, no workers, no WASM.
//
// Design: the hot function `run` is kept small (record loop + the fast
// unquoted-field path) so V8 compiles and optimises it quickly on a cold run;
// the quoted-field and stray-CR work lives in module-level helpers. The hot
// path costs one native indexOf(',') per unquoted field; the next LF and the
// next CR are tracked across the whole text and refreshed only at record
// starts and after slow-path fields. Fields are String slices (views, no
// copy). Quoted fields, stray CRs and every error take the slow path.

const COMMA = 44; // ,
const LF = 10;    // \n
const CR = 13;    // \r
const QUOTE = 34; // "

// Scratch result shared by the slow-path helpers (run is never re-entrant).
// kind: 0 = field ends at a comma, 1 = record ends at a line break, 2 = EOF.
const S = {
  value: '',
  kind: 0,
  nextF: 0,
  contentEnd: 0,
  nextPos: 0,
  lineDelta: 0,
  strayAdded: 0,
  unterminated: false,
};

// Count '\n' in text[a..b).
function countLF(text, a, b) {
  let c = 0;
  let p = a;
  for (;;) {
    const x = text.indexOf('\n', p);
    if (x === -1 || x >= b) return c;
    c++;
    p = x + 1;
  }
}

// Convert text[a..b) with every CRLF and every lone CR turned into LF.
// Returns [converted, breaks]; breaks counts the line breaks in the segment
// (one per LF, one per CRLF, one per lone CR). Only called for segments
// known to contain a CR.
function convertSegment(text, a, b) {
  let out = '';
  let breaks = 0;
  let p = a;
  for (;;) {
    const x = text.indexOf('\r', p);
    if (x === -1 || x >= b) {
      out += text.slice(p, b);
      breaks += countLF(text, p, b);
      return [out, breaks];
    }
    out += text.slice(p, x);
    breaks += countLF(text, p, x);
    out += '\n';
    breaks++;
    p = x + 1;
    if (p < b && text.charCodeAt(p) === LF) p++; // skip LF of a CRLF
  }
}

// Append one literal segment of a quoted field to parts; returns its line
// break count.
function addSeg(text, parts, a, b) {
  const cr = text.indexOf('\r', a);
  if (cr === -1 || cr >= b) {
    parts.push(text.slice(a, b));
    return countLF(text, a, b);
  }
  const r = convertSegment(text, a, b);
  parts.push(r[0]);
  return r[1];
}

// Parse a quoted field starting at f (text[f] === '"'). Fills S.
// On an unterminated quote S.unterminated is true, the error is recorded,
// and the caller must re-read the field as unquoted from f.
function parseQuoted(text, n, f, recStartLine, rowIdx, errors) {
  const q0 = f;
  const parts = [];
  let seg = f + 1;
  let p = seg;
  let closed = -1;
  let lineDelta = 0;
  S.unterminated = false;
  S.strayAdded = 0;
  for (;;) {
    const q = text.indexOf('"', p);
    if (q === -1) break; // never closes
    if (text.charCodeAt(q + 1) === QUOTE) {
      // doubled quote: one literal quote
      lineDelta += addSeg(text, parts, seg, q);
      parts.push('"');
      seg = q + 2;
      p = q + 2;
      continue;
    }
    closed = q;
    lineDelta += addSeg(text, parts, seg, q);
    break;
  }
  if (closed === -1) {
    errors.push({ code: 'unterminated_quote', line: recStartLine, row: rowIdx });
    S.unterminated = true;
    return;
  }
  const a = closed + 1;
  let value = parts.length === 1 ? parts[0] : parts.join('');
  if (a >= n) {
    S.value = value;
    S.kind = 2;
    S.contentEnd = n;
    S.nextPos = n;
    S.lineDelta = lineDelta;
    return;
  }
  const nx = text.charCodeAt(a);
  if (nx === COMMA) {
    S.value = value;
    S.kind = 0;
    S.nextF = a + 1;
    S.lineDelta = lineDelta;
    return;
  }
  if (nx === LF) {
    S.value = value;
    S.kind = 1;
    S.contentEnd = a;
    S.nextPos = a + 1;
    S.lineDelta = lineDelta + 1;
    return;
  }
  if (nx === CR && text.charCodeAt(a + 1) === LF) {
    S.value = value;
    S.kind = 1;
    S.contentEnd = a;
    S.nextPos = a + 2;
    S.lineDelta = lineDelta + 1;
    return;
  }
  // What follows the closing quote, up to the next comma or line break, is
  // appended as it stands (quote_junk when the field ends).
  let junkParts = null;
  let jseg = a;
  let jp = a;
  let junkEnd;
  let junkTerm;
  let junkNext;
  let stray = 0;
  for (;;) {
    const c = text.indexOf(',', jp);
    const nl = text.indexOf('\n', jp);
    const r = text.indexOf('\r', jp);
    let m = -1;
    let kind = -1;
    if (c !== -1) { m = c; kind = 0; }
    if (nl !== -1 && (m === -1 || nl < m)) { m = nl; kind = 1; }
    if (r !== -1 && (m === -1 || r < m)) { m = r; kind = 2; }
    if (m === -1) {
      junkEnd = n; junkTerm = 2; junkNext = n;
      break;
    }
    if (kind === 0) {
      junkEnd = m; junkTerm = 0; junkNext = m + 1;
      break;
    }
    if (kind === 1) {
      junkEnd = m; junkTerm = 1; junkNext = m + 1;
      break;
    }
    if (text.charCodeAt(m + 1) === LF) {
      junkEnd = m; junkTerm = 1; junkNext = m + 2;
      break;
    }
    // Stray CR inside the junk: dropped, error recorded.
    errors.push({ code: 'stray_cr', line: recStartLine, row: rowIdx });
    stray++;
    if (junkParts === null) junkParts = [];
    junkParts.push(text.slice(jseg, m));
    jseg = m + 1;
    jp = m + 1;
  }
  let junk;
  if (junkParts === null) junk = text.slice(jseg, junkEnd);
  else {
    junkParts.push(text.slice(jseg, junkEnd));
    junk = junkParts.join('');
  }
  if (junk.length > 0) {
    errors.push({ code: 'quote_junk', line: recStartLine, row: rowIdx });
    value = value + junk;
  }
  S.value = value;
  S.strayAdded = stray;
  if (junkTerm === 0) {
    S.kind = 0;
    S.nextF = junkNext;
    S.lineDelta = lineDelta;
    return;
  }
  S.kind = junkTerm;
  S.contentEnd = junkEnd;
  S.nextPos = junkNext;
  S.lineDelta = lineDelta + (junkTerm === 1 ? 1 : 0);
}

// Parse an unquoted field starting at f that is known to contain a stray CR
// before its end. Drops each stray CR. Fills S.
function parseSlowUnquoted(text, n, f, recStartLine, rowIdx, errors) {
  let uparts = null;
  let useg = f;
  let up = f;
  let uvalue;
  let uterm;
  let unext;
  let ufend;
  let stray = 0;
  for (;;) {
    const cc = text.indexOf(',', up);
    const nl = text.indexOf('\n', up);
    const rr = text.indexOf('\r', up);
    let m = -1;
    let kind = -1;
    if (cc !== -1) { m = cc; kind = 0; }
    if (nl !== -1 && (m === -1 || nl < m)) { m = nl; kind = 1; }
    if (rr !== -1 && (m === -1 || rr < m)) { m = rr; kind = 2; }
    if (m === -1) {
      if (uparts === null) uvalue = text.slice(useg, n);
      else { uparts.push(text.slice(useg, n)); uvalue = uparts.join(''); }
      uterm = 2; unext = n; ufend = n;
      break;
    }
    if (kind === 0) {
      if (uparts === null) uvalue = text.slice(useg, m);
      else { uparts.push(text.slice(useg, m)); uvalue = uparts.join(''); }
      uterm = 0; unext = m + 1; ufend = m;
      break;
    }
    if (kind === 1) {
      if (uparts === null) uvalue = text.slice(useg, m);
      else { uparts.push(text.slice(useg, m)); uvalue = uparts.join(''); }
      uterm = 1; unext = m + 1; ufend = m;
      break;
    }
    if (text.charCodeAt(m + 1) === LF) {
      if (uparts === null) uvalue = text.slice(useg, m);
      else { uparts.push(text.slice(useg, m)); uvalue = uparts.join(''); }
      uterm = 1; unext = m + 2; ufend = m;
      break;
    }
    errors.push({ code: 'stray_cr', line: recStartLine, row: rowIdx });
    stray++;
    if (uparts === null) uparts = [];
    uparts.push(text.slice(useg, m));
    useg = m + 1;
    up = m + 1;
  }
  S.value = uvalue;
  S.strayAdded = stray;
  if (uterm === 0) {
    S.kind = 0;
    S.nextF = unext;
    S.lineDelta = 0;
    return;
  }
  S.kind = uterm;
  S.contentEnd = ufend;
  S.nextPos = unext;
  S.lineDelta = uterm === 1 ? 1 : 0;
}

export function run(input) {
  const text = input.text;
  const header = !!input.header;
  const n = text.length;

  let i = 0;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) i = 1; // drop leading BOM

  let line = 1; // 1-based line number at the current scan position
  let columns = null;
  const rows = [];
  const errors = [];
  let width = -1;
  let recIndex = 0; // number of real records seen so far

  // Lazily tracked positions of the next LF / CR at or after the last refresh
  // anchor (Infinity once a refresh has found none ahead). Valid while
  // needRefresh is false: fast unquoted fields never consume an LF or a CR,
  // so the tracked positions stay true for them.
  let nextLF = -1;
  let nextCR = -1;

  while (i < n) {
    const recStart = i;
    const recStartLine = line;
    const rowIdx = header && recIndex === 0 ? null : header ? recIndex - 1 : recIndex;
    const errMark = errors.length;

    if (nextLF < i) {
      const x = text.indexOf('\n', i);
      nextLF = x === -1 ? Infinity : x;
    }
    if (nextCR < i) {
      const x = text.indexOf('\r', i);
      nextCR = x === -1 ? Infinity : x;
    }

    // A line left with no characters is no record.
    if (nextLF === i) {
      i = nextLF + 1;
      line++;
      continue;
    }
    if (text.charCodeAt(i) === CR && text.charCodeAt(i + 1) === LF) {
      i += 2;
      line++;
      continue;
    }

    const fields = [];
    let f = i;
    let needRefresh = true;
    let stray = 0; // stray CRs dropped inside this record
    let contentEnd = -1; // where this record's content ends (start of its line break, or n)
    let nextPos = -1; // position just past this record's line break
    let ended = false;

    while (!ended) {
      if (needRefresh) {
        if (nextLF < f) {
          const x = text.indexOf('\n', f);
          nextLF = x === -1 ? Infinity : x;
        }
        if (nextCR < f) {
          const x = text.indexOf('\r', f);
          nextCR = x === -1 ? Infinity : x;
        }
        needRefresh = false;
      }

      if (text.charCodeAt(f) === QUOTE) {
        parseQuoted(text, n, f, recStartLine, rowIdx, errors);
        if (!S.unterminated) {
          line += S.lineDelta;
          stray += S.strayAdded;
          fields.push(S.value);
          if (S.kind === 0) {
            f = S.nextF;
            needRefresh = true;
            continue;
          }
          contentEnd = S.contentEnd;
          nextPos = S.nextPos;
          ended = true;
          continue;
        }
        // Unterminated: fall through and re-read the field as unquoted.
      }

      // ---------- unquoted field ----------
      const c = text.indexOf(',', f);
      let end = c === -1 ? Infinity : c;
      let term; // 0 = comma, 1 = line break, 2 = EOF
      if (nextLF < end) {
        end = nextLF; term = 1;
      } else if (end === Infinity) {
        end = n; term = 2;
      } else {
        term = 0;
      }
      // A CR just before the LF is the CRLF line break, not field content.
      let fend = end;
      if (term === 1 && end > f && text.charCodeAt(end - 1) === CR) fend = end - 1;

      if (nextCR < fend) {
        // Stray CR inside this field: slow path, dropping each stray CR.
        parseSlowUnquoted(text, n, f, recStartLine, rowIdx, errors);
        line += S.lineDelta;
        stray += S.strayAdded;
        fields.push(S.value);
        if (S.kind === 0) {
          f = S.nextF;
          needRefresh = true;
          continue;
        }
        contentEnd = S.contentEnd;
        nextPos = S.nextPos;
        ended = true;
        continue;
      }

      // Clean unquoted field: a slice, nothing more.
      fields.push(text.slice(f, fend));
      if (term === 0) {
        f = end + 1;
        continue;
      }
      contentEnd = fend;
      nextPos = term === 1 ? end + 1 : n;
      if (term === 1) line++;
      ended = true;
    }

    i = nextPos;
    // A record left with no characters (e.g. a line of only stray CRs) is no record.
    if (contentEnd - recStart - stray === 0) {
      errors.length = errMark;
      continue;
    }
    if (width === -1) {
      width = fields.length;
      if (header) columns = fields;
      else rows.push(fields);
    } else {
      if (fields.length < width) {
        const nf = fields.length;
        for (let k = nf; k < width; k++) fields.push('');
        errors.push({ code: 'short_row', line: recStartLine, row: rowIdx, fields: nf });
      } else if (fields.length > width) {
        const extra = fields.slice(width);
        fields.length = width;
        errors.push({ code: 'long_row', line: recStartLine, row: rowIdx, extra });
      }
      rows.push(fields);
    }
    recIndex++;
  }

  return { columns, rows, errors };
}
