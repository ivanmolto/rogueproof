// The matcher behind the tool policy. Deterministic string work, no model.
//
// A file path (read_file, write_file) is a literal: it is split on "/" and each
// segment is compared with the protected globs, case-insensitively (the
// workspace is a bind mount and may sit on a case-insensitive file system).
//
// A command (run_command) is text that a shell will rewrite before anything
// runs, so it is not compared as a string. It is reduced to patterns: quotes
// and escaping backslashes are dropped, and every part the shell would expand
// (glob, brace group, variable, command substitution) becomes a wildcard. A
// rule matches when a pattern COULD expand to a protected name. That errs on
// the side of denying: `cat $F` is refused because nothing here can know $F.
//
// Not covered, by design (see policies/README.md): names assembled inside
// another program (`python3 -c "open('.e'+'nv')"`), and reads that never name
// a file (`grep -r KEY .`).

/**
 * `nodot` marks a glob (`*`, `?`, `[…]`) at the start of a name: the shell never
 * lets it match a leading dot, so `*.md` cannot expand to `.env.md`. Wildcards
 * that stand for a variable, a substitution or a brace group carry no such limit.
 */
export type Tok = { k: "lit"; c: string } | { k: "any"; nodot?: true } | { k: "star"; nodot?: true };

const STAR: Tok = { k: "star" };
const ANY: Tok = { k: "any" };

/** Literal text as tokens, lower-cased. */
export function literal(s: string): Tok[] {
  return [...s.toLowerCase()].map((c) => ({ k: "lit", c }));
}

/** A rule glob: `*` any run of characters, `?` one character, everything else literal. */
export function parseGlob(glob: string): Tok[] {
  const out: Tok[] = [];
  for (const c of glob.toLowerCase()) {
    if (c === "*") {
      if (out.at(-1)?.k !== "star") out.push(STAR);
    } else if (c === "?") out.push(ANY);
    else out.push({ k: "lit", c });
  }
  return out;
}

const compatible = (x: Tok, y: Tok): boolean => x.k !== "lit" || y.k !== "lit" || x.c === y.c;

/** True when some string matches both patterns. */
export function intersects(a: readonly Tok[], b: readonly Tok[]): boolean {
  const n = a.length;
  const m = b.length;
  let next = new Uint8Array(m + 1);
  let cur = new Uint8Array(m + 1);
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      const x = a[i];
      const y = b[j];
      let v: number;
      if (x === undefined && y === undefined) v = 1;
      else if (x?.k === "star") v = next[j]! | (y !== undefined ? cur[j + 1]! : 0);
      else if (y?.k === "star") v = cur[j + 1]! | (x !== undefined ? next[j]! : 0);
      else if (x === undefined || y === undefined) v = 0;
      else v = compatible(x, y) ? next[j + 1]! : 0;
      cur[j] = v;
    }
    [next, cur] = [cur, next];
  }
  return next[0] === 1;
}

/** Path segments of a literal path, as tokens. Empty segments are dropped. */
export function pathSegments(path: string): Tok[][] {
  return path.split("/").filter((s) => s.length > 0).map(literal);
}

/** Ends a shell word whatever the quoting; a glob, brace or `${…}` group never spans one. */
const HARD_SEP = /[\s|&;<>()]/;
/** Also split here, so `--file=.env`, `a,.env`, `PATH=x:.env` and `@.env` expose the name. */
const SOFT_SEP = /[=:,@]/;
const HEX = /[0-9a-fA-F]/;
const OCT = /[0-7]/;
const ALNUM = /[0-9A-Za-z]/;

function lex(cmd: string, ansi: boolean): Tok[][] {
  const segments: Tok[][] = [];
  let cur: Tok[] = [];
  const end = (): void => {
    if (cur.length > 0) segments.push(cur);
    cur = [];
  };
  const star = (): void => {
    if (cur.at(-1)?.k !== "star") cur.push(STAR);
  };
  /** A glob character: at the start of a name it cannot stand for a dot. */
  const glob = (k: "star" | "any"): void => {
    if (cur.length === 0) cur.push({ k, nodot: true });
    else if (k === "any") cur.push(ANY);
    else star();
  };
  /** Index of the first hard separator at or after `from`. */
  const wordEnd = (from: number): number => {
    let j = from;
    while (j < cmd.length && !HARD_SEP.test(cmd[j]!)) j++;
    return j;
  };

  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i]!;
    const n = cmd[i + 1];
    if (c === "'" || c === '"') {
      // Quotes are dropped and never trusted: `sh -c 'cat .e*'` expands in the inner shell.
      i++;
    } else if (c === "\\") {
      if (n === "\n") i += 2;
      else if (ansi && n !== undefined && ALNUM.test(n)) {
        // $'…' and printf/echo -e escapes: \x2e, \056, \u002e, \n … decode to a character we do not compute.
        let j = i + 2;
        const take = (re: RegExp, max: number): void => {
          for (let k = 0; k < max && j < cmd.length && re.test(cmd[j]!); k++) j++;
        };
        if (n === "x") take(HEX, 2);
        else if (n === "u") take(HEX, 4);
        else if (n === "U") take(HEX, 8);
        else if (OCT.test(n)) take(OCT, 3);
        else if (n === "c") j = Math.min(j + 1, cmd.length);
        star();
        i = j;
      } else i++; // the backslash goes; the next character is read as usual
    } else if (HARD_SEP.test(c) || SOFT_SEP.test(c)) {
      end();
      i++;
    } else if (c === "/") {
      end();
      i++;
    } else if (c === "`") {
      // Command substitution: the word so far continues with unknown text, and what follows starts with it.
      star();
      end();
      star();
      i++;
    } else if (c === "$") {
      star();
      if (n === "{") {
        const close = cmd.indexOf("}", i + 2);
        i = close !== -1 && close < wordEnd(i) ? close + 1 : i + 2;
      } else if (n !== undefined && /[A-Za-z_]/.test(n)) {
        let j = i + 2;
        while (j < cmd.length && /[A-Za-z0-9_]/.test(cmd[j]!)) j++;
        i = j;
      } else if (n !== undefined && /[0-9@*#?!$-]/.test(n)) i += 2;
      else i++; // `$(` — the `(` ends the word; `$'…'`, `$"…"`, a bare `$`
    } else if (c === "{" || c === "[") {
      // A brace group or a bracket class, up to the last closer in the word: unknown text.
      const close = cmd.lastIndexOf(c === "{" ? "}" : "]", wordEnd(i) - 1);
      if (close > i) {
        if (c === "[") glob("star");
        else star();
        i = close + 1;
      } else {
        if (c === "{") star();
        else cur.push({ k: "lit", c });
        i++;
      }
    } else if (c === "}") {
      star();
      i++;
    } else if (c === "*" || c === "?") {
      glob(c === "*" ? "star" : "any");
      i++;
    } else {
      for (const l of c.toLowerCase()) cur.push({ k: "lit", c: l });
      i++;
    }
  }
  end();
  return segments;
}

export interface CommandView {
  /** Every path segment of every word, as a pattern, under both readings of a backslash. */
  segments: Tok[][];
  /** The command with quotes and backslashes removed, lower-cased. For substring rules. */
  flat: string;
}

const isLit = (t: Tok | undefined, re: RegExp): boolean => t?.k === "lit" && re.test(t.c);

/** Reduce a command line to the patterns its words could expand to. */
export function viewCommand(cmd: string): CommandView {
  const flat = cmd.replace(/\\\n/g, "").replace(/['"\\]/g, "").toLowerCase();
  let segments = [...lex(cmd, false), ...lex(cmd, true)];
  // Where something other than a plain shell does the globbing (`find -name`, bash
  // with dotglob, a glob library), a leading wildcard does match a dot.
  if (/find|glob/.test(flat)) segments = segments.map((s) => s.map((t) => (t.k === "lit" ? t : { k: t.k })));
  // `-f.env`, `-I.env`: a short option with its value attached.
  for (const s of [...segments]) {
    if (s.length > 2 && isLit(s[0], /^-$/) && isLit(s[1], /^[a-z0-9]$/)) segments.push(s.slice(2));
  }
  return { segments, flat };
}

/** True when any segment could be a name matching any of the globs. */
export function anySegmentMatches(segments: readonly Tok[][], globs: readonly Tok[][]): boolean {
  return segments.some((s) => {
    const first = s[0];
    const nodot = first !== undefined && first.k !== "lit" && first.nodot === true;
    return globs.some((g) => !(nodot && g[0]?.k === "lit" && g[0].c === ".") && intersects(s, g));
  });
}

/** `python3.12` → `python`: trailing version digits and dots removed. */
export function stripVersion(seg: readonly Tok[]): Tok[] {
  let end = seg.length;
  while (end > 1 && isLit(seg[end - 1], /^[0-9.]$/)) end--;
  return seg.slice(0, end);
}
