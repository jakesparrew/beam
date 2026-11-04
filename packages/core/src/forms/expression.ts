/**
 * The safe formula evaluator of rule S3: a tokenizer plus a Pratt parser that builds a small AST,
 * and a tree-walking evaluator over it. No `eval`, no `Function`, no property access, no loops.
 *
 * Grammar: numbers, `dim.<key>`, `answer.<key>`, `total`, `true`, `false`, operators
 * `+ - * / %`, comparisons `== != < <= > >=`, `and`, `or`, `not`, parentheses and the functions
 * `min`, `max`, `abs`, `round(x, digits)`, `clamp(x, lo, hi)`, `if(cond, a, b)` and
 * `contains(answer.<key>, '<option>')`. Limits: 500 characters, AST depth 32, 200 nodes.
 * Division by zero or a missing operand yields `null`.
 */
import type { Answers } from "./types";

export const EXPRESSION_MAX_LENGTH = 500;
export const EXPRESSION_MAX_DEPTH = 32;
export const EXPRESSION_MAX_NODES = 200;

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "and" | "or";
export type FunctionName = "min" | "max" | "abs" | "round" | "clamp" | "if" | "contains";

export type Expr =
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "str"; v: string }
  | { t: "dim"; key: string }
  | { t: "answer"; key: string }
  | { t: "total" }
  | { t: "unary"; op: "-" | "not"; arg: Expr }
  | { t: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { t: "call"; fn: FunctionName; args: Expr[] };

/** What a formula reads. `answers` are raw answers; numbers, ratings, yes/no as 1/0, multiple choice as a count. */
export type ExprEnv = { dims?: Record<string, number | null>; answers?: Answers; total?: number | null };

export type ParseResult = { ok: true; ast: Expr } | { ok: false; error: { pos: number; message: string } };

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Names that could reach an object prototype; refused even where the key regex would allow them. */
const RESERVED = new Set(["constructor", "prototype", "__proto__", "hasownproperty", "tostring", "valueof", "isprototypeof", "propertyisenumerable", "tolocalestring", "__definegetter__", "__definesetter__", "__lookupgetter__", "__lookupsetter__"]);

const ARITY: Record<FunctionName, [number, number]> = {
  min: [1, 20],
  max: [1, 20],
  abs: [1, 1],
  round: [1, 2],
  clamp: [3, 3],
  if: [3, 3],
  contains: [2, 2],
};

type Tok =
  | { k: "num"; v: number; pos: number }
  | { k: "str"; v: string; pos: number }
  | { k: "name"; v: string; pos: number }
  | { k: "op"; v: string; pos: number }
  | { k: "eof"; pos: number };

class ExprError extends Error {
  constructor(
    readonly pos: number,
    message: string,
  ) {
    super(message);
  }
}

const OPS = ["==", "!=", "<=", ">=", "<", ">", "+", "-", "*", "/", "%", "(", ")", ","];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    const num = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ k: "num", v: Number(num[0]), pos: i });
      i += num[0].length;
      continue;
    }
    const name = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*/.exec(src.slice(i));
    if (name) {
      out.push({ k: "name", v: name[0], pos: i });
      i += name[0].length;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError(i, "unterminated string");
      out.push({ k: "str", v: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(i, `unexpected character '${c}'`);
    out.push({ k: "op", v: op, pos: i });
    i += op.length;
  }
  out.push({ k: "eof", pos: src.length });
  return out;
}

const BP: Record<string, number> = { or: 10, and: 20, "==": 40, "!=": 40, "<": 40, "<=": 40, ">": 40, ">=": 40, "+": 50, "-": 50, "*": 60, "/": 60, "%": 60 };
const PARSE_RECURSION_LIMIT = 64;

class Parser {
  private i = 0;
  private level = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i]!;
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private opOf(t: Tok): string | null {
    if (t.k === "op") return t.v;
    if (t.k === "name" && (t.v === "and" || t.v === "or")) return t.v;
    return null;
  }
  private expectOp(v: string): Tok {
    const t = this.next();
    if (t.k !== "op" || t.v !== v) throw new ExprError(t.pos, `expected '${v}'`);
    return t;
  }

  parseAll(): Expr {
    const e = this.parse(0);
    const t = this.peek();
    if (t.k !== "eof") throw new ExprError(t.pos, "unexpected token");
    return e;
  }

  parse(rbp: number): Expr {
    if (++this.level > PARSE_RECURSION_LIMIT) throw new ExprError(this.peek().pos, "expression nested too deeply");
    let left = this.nud(this.next());
    for (;;) {
      const op = this.opOf(this.peek());
      const bp = op ? BP[op] : undefined;
      if (bp === undefined || bp <= rbp) break;
      this.next();
      const right = this.parse(bp);
      left = { t: "binary", op: op as BinaryOp, left, right };
    }
    this.level--;
    return left;
  }

  private nud(t: Tok): Expr {
    if (t.k === "num") return { t: "num", v: t.v };
    if (t.k === "str") throw new ExprError(t.pos, "strings are only allowed as the second argument of contains()");
    if (t.k === "eof") throw new ExprError(t.pos, "unexpected end of formula");
    if (t.k === "op") {
      if (t.v === "(") {
        const e = this.parse(0);
        this.expectOp(")");
        return e;
      }
      if (t.v === "-") return { t: "unary", op: "-", arg: this.parse(70) };
      if (t.v === "+") return this.parse(70);
      throw new ExprError(t.pos, `unexpected '${t.v}'`);
    }
    return this.name(t);
  }

  private name(t: Extract<Tok, { k: "name" }>): Expr {
    const parts = t.v.split(".");
    for (const p of parts) if (RESERVED.has(p.toLowerCase())) throw new ExprError(t.pos, `'${p}' is not allowed`);
    if (parts.length === 1) {
      const n = parts[0]!;
      if (n === "not") return { t: "unary", op: "not", arg: this.parse(30) };
      if (n === "total") return { t: "total" };
      if (n === "true" || n === "false") return { t: "bool", v: n === "true" };
      if (Object.hasOwn(ARITY, n)) return this.call(n as FunctionName, t.pos);
      throw new ExprError(t.pos, `unknown name '${n}'`);
    }
    const [root, key] = parts as [string, string];
    if (root !== "dim" && root !== "answer") throw new ExprError(t.pos, `unknown name '${root}'; use dim.<key>, answer.<key> or total`);
    if (parts.length > 2) throw new ExprError(t.pos, `'${t.v}' goes beyond ${root}.<key>`);
    if (!KEY_RE.test(key)) throw new ExprError(t.pos, `invalid key '${key}'`);
    return root === "dim" ? { t: "dim", key } : { t: "answer", key };
  }

  private call(fn: FunctionName, pos: number): Expr {
    this.expectOp("(");
    const args: Expr[] = [];
    if (!(this.peek().k === "op" && (this.peek() as { v: string }).v === ")")) {
      for (;;) {
        if (fn === "contains" && args.length === 1) {
          const s = this.next();
          if (s.k !== "str") throw new ExprError(s.pos, "contains() needs a quoted option key as its second argument");
          args.push({ t: "str", v: s.v });
        } else {
          args.push(this.parse(0));
        }
        const sep = this.peek();
        if (sep.k === "op" && sep.v === ",") {
          this.next();
          continue;
        }
        break;
      }
    }
    this.expectOp(")");
    const [lo, hi] = ARITY[fn];
    if (args.length < lo || args.length > hi) throw new ExprError(pos, `${fn}() takes ${lo === hi ? lo : `${lo} to ${hi}`} argument${hi === 1 ? "" : "s"}`);
    if (fn === "contains" && args[0]!.t !== "answer") throw new ExprError(pos, "contains() needs answer.<key> as its first argument");
    return { t: "call", fn, args };
  }
}

/** AST depth (a leaf has depth 1). */
export function exprDepth(e: Expr): number {
  switch (e.t) {
    case "unary":
      return 1 + exprDepth(e.arg);
    case "binary":
      return 1 + Math.max(exprDepth(e.left), exprDepth(e.right));
    case "call":
      return 1 + Math.max(0, ...e.args.map(exprDepth));
    default:
      return 1;
  }
}

/** Number of AST nodes. */
export function exprNodes(e: Expr): number {
  switch (e.t) {
    case "unary":
      return 1 + exprNodes(e.arg);
    case "binary":
      return 1 + exprNodes(e.left) + exprNodes(e.right);
    case "call":
      return 1 + e.args.reduce((n, a) => n + exprNodes(a), 0);
    default:
      return 1;
  }
}

export function parseExpression(src: string): ParseResult {
  if (typeof src !== "string") return { ok: false, error: { pos: 0, message: "formula must be a string" } };
  if (src.length > EXPRESSION_MAX_LENGTH) return { ok: false, error: { pos: EXPRESSION_MAX_LENGTH, message: `formula longer than ${EXPRESSION_MAX_LENGTH} characters` } };
  try {
    const ast = new Parser(tokenize(src)).parseAll();
    if (exprDepth(ast) > EXPRESSION_MAX_DEPTH) return { ok: false, error: { pos: 0, message: `formula nested deeper than ${EXPRESSION_MAX_DEPTH}` } };
    if (exprNodes(ast) > EXPRESSION_MAX_NODES) return { ok: false, error: { pos: 0, message: `formula has more than ${EXPRESSION_MAX_NODES} parts` } };
    return { ok: true, ast };
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: { pos: e.pos, message: e.message } };
    throw e;
  }
}

/** The dimensions, answers and total a formula reads (dependency order S5, sensitivity S6, L4). */
export function expressionRefs(e: Expr): { dims: string[]; answers: string[]; total: boolean } {
  const dims = new Set<string>();
  const answers = new Set<string>();
  let total = false;
  const walk = (x: Expr): void => {
    if (x.t === "dim") dims.add(x.key);
    else if (x.t === "answer") answers.add(x.key);
    else if (x.t === "total") total = true;
    else if (x.t === "unary") walk(x.arg);
    else if (x.t === "binary") {
      walk(x.left);
      walk(x.right);
    } else if (x.t === "call") x.args.forEach(walk);
  };
  walk(e);
  return { dims: [...dims], answers: [...answers], total };
}

type Val = number | boolean | null;

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

function num(v: Val): number | null {
  if (v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return Number.isFinite(v) ? v : null;
}

function truthy(v: Val): boolean | null {
  if (v === null) return null;
  return typeof v === "boolean" ? v : v !== 0;
}

function answerNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  return null;
}

const finite = (n: number): number | null => (Number.isFinite(n) ? n : null);

export function evaluate(ast: Expr, env: ExprEnv): number | boolean | null {
  const ev = (e: Expr): Val => {
    switch (e.t) {
      case "num":
      case "bool":
        return e.v;
      case "str":
        return null;
      case "dim": {
        const v = own(env.dims, e.key);
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      }
      case "answer":
        return answerNumber(own(env.answers, e.key));
      case "total":
        return typeof env.total === "number" && Number.isFinite(env.total) ? env.total : null;
      case "unary": {
        const v = ev(e.arg);
        if (e.op === "-") {
          const n = num(v);
          return n === null ? null : -n;
        }
        const b = truthy(v);
        return b === null ? null : !b;
      }
      case "binary":
        return binary(e.op, e.left, e.right);
      case "call":
        return call(e.fn, e.args);
    }
  };

  const binary = (op: BinaryOp, l: Expr, r: Expr): Val => {
    if (op === "and" || op === "or") {
      const a = truthy(ev(l));
      const b = truthy(ev(r));
      if (op === "and") return a === false || b === false ? false : a === null || b === null ? null : true;
      return a === true || b === true ? true : a === null || b === null ? null : false;
    }
    const a = num(ev(l));
    const b = num(ev(r));
    if (a === null || b === null) return null;
    switch (op) {
      case "+":
        return finite(a + b);
      case "-":
        return finite(a - b);
      case "*":
        return finite(a * b);
      case "/":
        return b === 0 ? null : finite(a / b);
      case "%":
        return b === 0 ? null : finite(a % b);
      case "==":
        return a === b;
      case "!=":
        return a !== b;
      case "<":
        return a < b;
      case "<=":
        return a <= b;
      case ">":
        return a > b;
      case ">=":
        return a >= b;
    }
  };

  const call = (fn: FunctionName, args: Expr[]): Val => {
    if (fn === "if") {
      const c = truthy(ev(args[0]!));
      if (c === null) return null;
      return ev(c ? args[1]! : args[2]!);
    }
    if (fn === "contains") {
      const a = args[0]!;
      const opt = (args[1] as { v: string }).v;
      const v = a.t === "answer" ? own(env.answers, a.key) : undefined;
      if (Array.isArray(v)) return v.includes(opt);
      return typeof v === "string" ? v === opt : false;
    }
    const xs = args.map((a) => num(ev(a)));
    if (xs.some((x) => x === null)) return null;
    const n = xs as number[];
    switch (fn) {
      case "min":
        return Math.min(...n);
      case "max":
        return Math.max(...n);
      case "abs":
        return Math.abs(n[0]!);
      case "round": {
        const digits = Math.max(0, Math.min(10, Math.trunc(n[1] ?? 0)));
        const f = 10 ** digits;
        return finite(Math.round(n[0]! * f) / f);
      }
      case "clamp":
        return Math.min(Math.max(n[0]!, n[1]!), n[2]!);
    }
  };

  return ev(ast);
}

/** Evaluates a formula to a number (booleans as 1/0) or `null`. */
export function evaluateNumber(ast: Expr, env: ExprEnv): number | null {
  return num(evaluate(ast, env));
}
