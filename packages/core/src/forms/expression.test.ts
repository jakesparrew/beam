import { describe, expect, it } from "vitest";
import { evaluate, evaluateNumber, exprDepth, exprNodes, expressionRefs, parseExpression, type Expr, type ExprEnv } from "./expression";

function run(src: string, env: ExprEnv = {}): number | boolean | null {
  const p = parseExpression(src);
  if (!p.ok) throw new Error(`${p.error.message} at ${p.error.pos}`);
  return evaluate(p.ast, env);
}

function fails(src: string): { pos: number; message: string } {
  const p = parseExpression(src);
  if (p.ok) throw new Error(`expected ${src} to fail`);
  return p.error;
}

describe("S3: safe expression evaluator", () => {
  it("precedence and associativity", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("(1 + 2) * 3")).toBe(9);
    expect(run("10 - 4 - 3")).toBe(3);
    expect(run("12 / 3 / 2")).toBe(2);
    expect(run("7 % 4 + 1")).toBe(4);
    expect(run("-2 * 3")).toBe(-6);
    expect(run("+2 - -3")).toBe(5);
    expect(run("1 + 2 > 2 and 3 < 2 or 1 == 1")).toBe(true);
    expect(run("not 1 > 2")).toBe(true);
    expect(run("not 1 > 2 and false")).toBe(false);
    expect(run("1 + 1 == 2")).toBe(true);
    expect(run("2 != 2")).toBe(false);
    expect(run("3 >= 3 and 3 <= 3")).toBe(true);
    expect(run(".5 + 0.25")).toBe(0.75);
  });

  it("dim, answer and total references", () => {
    const env: ExprEnv = { dims: { sleep: 4, stress: null }, answers: { hours: 7, ok: true, no: false, many: ["a", "b"], one: "a" }, total: 12 };
    expect(run("dim.sleep * 2", env)).toBe(8);
    expect(run("dim.stress + 1", env)).toBeNull();
    expect(run("dim.unknown", env)).toBeNull();
    expect(run("answer.hours + answer.ok + answer.no + answer.many", env)).toBe(10);
    expect(run("answer.one", env)).toBeNull();
    expect(run("total / 4", env)).toBe(3);
    expect(run("total", {})).toBeNull();
  });

  it("functions", () => {
    expect(run("min(3, 1, 2)")).toBe(1);
    expect(run("max(3, 1, 2)")).toBe(3);
    expect(run("abs(-4)")).toBe(4);
    expect(run("round(2.345, 2)")).toBe(2.35);
    expect(run("round(2.5)")).toBe(3);
    expect(run("clamp(15, 0, 10)")).toBe(10);
    expect(run("clamp(-1, 0, 10)")).toBe(0);
    expect(run("if(1 > 0, 5, 6)")).toBe(5);
    expect(run("if(false, 5, 6)")).toBe(6);
    expect(run("if(dim.x > 1, 5, 6)", { dims: { x: null } })).toBeNull();
    expect(run("if(true, 1, dim.missing)")).toBe(1);
    expect(run("min(1, dim.missing)")).toBeNull();
  });

  it("contains() on multiple choice and single choice", () => {
    const env: ExprEnv = { answers: { practices: ["sauna", "cold"], one: "sauna", n: 3 } };
    expect(run("contains(answer.practices, 'sauna')", env)).toBe(true);
    expect(run('contains(answer.practices, "yoga")', env)).toBe(false);
    expect(run("contains(answer.one, 'sauna')", env)).toBe(true);
    expect(run("contains(answer.n, 'sauna')", env)).toBe(false);
    expect(run("contains(answer.missing, 'sauna')", env)).toBe(false);
    expect(run("if(contains(answer.practices, 'cold'), 2, 0) + 1", env)).toBe(3);
    expect(fails("contains(dim.a, 'x')").message).toMatch(/answer/);
    expect(fails("contains(answer.a, 3)").message).toMatch(/quoted/);
    expect(fails("'x' + 1").message).toMatch(/contains/);
  });

  it("division by zero or a missing operand yields null", () => {
    expect(run("1 / 0")).toBeNull();
    expect(run("1 % 0")).toBeNull();
    expect(run("dim.a / dim.b", { dims: { a: 1, b: 0 } })).toBeNull();
    expect(run("answer.x * 2", { answers: {} })).toBeNull();
    expect(run("dim.a > 1", {})).toBeNull();
    expect(run("dim.a > 1 and false", {})).toBe(false);
    expect(run("dim.a > 1 or true", {})).toBe(true);
    expect(run("dim.a > 1 or false", {})).toBeNull();
    expect(run("not dim.a", {})).toBeNull();
    expect(run("-dim.a", {})).toBeNull();
    expect(evaluateNumber(parseOk("1 / 0"), {})).toBeNull();
    expect(evaluateNumber(parseOk("2 > 1"), {})).toBe(1);
  });

  it("rejects constructor, __proto__ and paths beyond the allowed roots", () => {
    expect(fails("constructor").message).toMatch(/not allowed/);
    expect(fails("dim.constructor").message).toMatch(/not allowed/);
    expect(fails("answer.__proto__").message).toMatch(/not allowed/);
    expect(fails("__proto__").message).toMatch(/not allowed/);
    expect(fails("dim.prototype").message).toMatch(/not allowed/);
    expect(fails("a.b.c").message).toMatch(/unknown name/);
    expect(fails("dim.a.b").message).toMatch(/beyond/);
    expect(fails("answer.a.toString").message).toMatch(/not allowed/);
    expect(fails("Math.max(1)").message).toMatch(/unknown name/);
    expect(fails("x").message).toMatch(/unknown name/);
    expect(fails("dim.Bad").message).toMatch(/invalid key/);
    expect(fails("eval(1)").message).toMatch(/unknown name/);
    // Even an environment with prototype tricks never leaks: lookups are own-property only.
    expect(run("dim.tostr", { dims: Object.create({ tostr: 5 }) as Record<string, number> })).toBeNull();
  });

  it("syntax errors carry a position", () => {
    expect(fails("1 +")).toEqual({ pos: 3, message: "unexpected end of formula" });
    expect(fails("(1 + 2").message).toMatch(/expected '\)'/);
    expect(fails("1 2").pos).toBe(2);
    expect(fails("1 # 2").pos).toBe(2);
    expect(fails("'open").message).toMatch(/unterminated/);
    expect(fails("min()").message).toMatch(/takes/);
    expect(fails("abs(1, 2)").message).toMatch(/takes/);
    expect(fails("clamp(1, 2)").message).toMatch(/takes/);
    expect(fails(")").message).toMatch(/unexpected/);
  });

  it("rejects 501-character input and accepts 500", () => {
    const five = "1 + 2".padEnd(500, " ");
    expect(five.length).toBe(500);
    expect(parseExpression(five).ok).toBe(true);
    expect(fails(`${five} `).message).toMatch(/longer than 500/);
  });

  it("rejects AST depth 33 and accepts 32", () => {
    const nest = (n: number) => `${"-".repeat(n - 1)}1`;
    const ok = parseOk(nest(32));
    expect(exprDepth(ok)).toBe(32);
    expect(evaluate(ok, {})).toBe(-1);
    expect(fails(nest(33)).message).toMatch(/deeper than 32/);
    expect(fails(`${"(".repeat(70)}1${")".repeat(70)}`).message).toMatch(/nested too deeply/);
  });

  it("rejects more than 200 nodes", () => {
    const flat = (n: number): string => (n === 1 ? "1" : `(${flat(Math.floor(n / 2))}+${flat(Math.ceil(n / 2))})`);
    expect(exprNodes(parseOk(flat(100)))).toBe(199);
    expect(fails(flat(101)).message).toMatch(/more than 200/);
  });

  it("expressionRefs lists dims, answers and total", () => {
    expect(expressionRefs(parseOk("dim.a + max(answer.b, total) + if(contains(answer.c, 'x'), dim.a, 0)"))).toEqual({ dims: ["a"], answers: ["b", "c"], total: true });
  });

  it("non-string input fails cleanly", () => {
    expect(parseExpression(42 as unknown as string).ok).toBe(false);
  });
});

function parseOk(src: string): Expr {
  const p = parseExpression(src);
  if (!p.ok) throw new Error(p.error.message);
  return p.ast;
}
