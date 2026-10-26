/* Fraction Calc — exact rational arithmetic with BigInt; nothing is ever rounded. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var KEY = "fc.v1";

  // ---------- rationals ----------
  function babs(a) { return a < 0n ? -a : a; }
  function gcd(a, b) { a = babs(a); b = babs(b); while (b) { var t = a % b; a = b; b = t; } return a; }
  function lcm(a, b) { return a / gcd(a, b) * b; }
  function R(n, d) {
    n = BigInt(n); d = d === undefined ? 1n : BigInt(d);
    if (d === 0n) throw err("Division by zero");
    if (d < 0n) { n = -n; d = -d; }
    var g = gcd(n, d) || 1n;
    return { n: n / g, d: d / g };
  }
  function raw(n, d) { return { n: BigInt(n), d: BigInt(d), raw: true }; } // unsimplified, for showing steps
  function add(a, b) { return R(a.n * b.d + b.n * a.d, a.d * b.d); }
  function sub(a, b) { return R(a.n * b.d - b.n * a.d, a.d * b.d); }
  function mul(a, b) { return R(a.n * b.n, a.d * b.d); }
  function div(a, b) { if (b.n === 0n) throw err("Division by zero"); return R(a.n * b.d, a.d * b.n); }
  function pow(a, e) {
    if (e.d !== 1n) throw err("Only whole-number powers keep a fraction exact");
    var k = e.n < 0n ? -e.n : e.n;
    if (k > 4096n) throw err("Power too large");
    var r = R(a.n ** k, a.d ** k);
    return e.n < 0n ? div(R(1), r) : r;
  }
  function cmp(a, b) { var x = a.n * b.d, y = b.n * a.d; return x < y ? -1 : x > y ? 1 : 0; }
  function eq(a, b) { return a.n === b.n && a.d === b.d; }
  function err(m) { var e = new Error(m); e.fc = true; return e; }
  function str(a) { return a.d === 1n ? String(a.n) : a.n + "/" + a.d; }
  function mixed(a) {
    if (a.d === 1n || babs(a.n) < a.d) return null;
    var neg = a.n < 0n, n = babs(a.n);
    return { neg: neg, w: n / a.d, n: n % a.d, d: a.d };
  }
  function mixedStr(a) { var m = mixed(a); return m ? (m.neg ? "-" : "") + m.w + (m.n ? " " + m.n + "/" + m.d : "") : str(a); }

  // Exact decimal expansion with the repeating block in brackets: 1/7 → 0.(142857).
  function decimal(a, maxDigits) {
    maxDigits = maxDigits || 2000;
    var neg = a.n < 0n, n = babs(a.n), d = a.d, ip = n / d, r = n % d, digits = "", seen = new Map(), rep = -1;
    while (r !== 0n && digits.length < maxDigits) {
      if (seen.has(r)) { rep = seen.get(r); break; }
      seen.set(r, digits.length);
      r *= 10n; digits += String(r / d); r %= d;
    }
    var s = (neg && (ip || digits) ? "-" : "") + ip;
    if (digits) s += "." + (rep >= 0 ? digits.slice(0, rep) + "(" + digits.slice(rep) + ")" : digits + (r !== 0n ? "…" : ""));
    return { text: s, repeating: rep >= 0, cut: rep < 0 && r !== 0n };
  }
  function approx(a, places) { // rounded decimal for display: 0.333333
    var neg = a.n < 0n, scale = 10n ** BigInt(places), n = babs(a.n) * scale * 2n + a.d, q = n / (2n * a.d);
    var s = q.toString().padStart(places + 1, "0");
    var out = s.slice(0, s.length - places) + (places ? "." + s.slice(-places) : "");
    out = out.replace(/\.?0+$/, "") || "0";
    return (neg && out !== "0" ? "-" : "") + out;
  }

  // Parse a decimal like "-1.2(34)", "0.(3)", "12.5", "3".
  function parseDecimal(s) {
    var m = /^\s*([+-]?)(\d*)(?:\.(\d*)(?:\((\d+)\))?)?\s*$/.exec(String(s).replace(/[٠-٩]/g, function (c) { return c.charCodeAt(0) - 0x660; }).replace(/٫/g, ".").replace(/,/g, ""));
    if (!m || (!m[2] && !m[3] && !m[4])) return null;
    var sign = m[1] === "-" ? -1n : 1n, ip = m[2] || "0", fp = m[3] || "", rp = m[4] || "";
    var val, info = { ip: ip, fp: fp, rp: rp };
    if (!rp) val = R(BigInt(ip + fp), 10n ** BigInt(fp.length));
    else {
      var all = BigInt(ip + fp + rp), head = BigInt(ip + fp);
      val = R(all - head, 10n ** BigInt(fp.length) * (10n ** BigInt(rp.length) - 1n));
      info.all = all; info.head = head;
    }
    return { v: R(val.n * sign, val.d), info: info, neg: sign < 0n };
  }

  // ---------- expression parser over rationals ----------
  // Literals: 3, 3/4 (a fraction, binds tighter than ÷), 2 3/4 (mixed), 0.25, 0.(3).  Operators: + − × ÷ * / : ^ and brackets.
  function tokenize(src) {
    var s = String(src).replace(/[−–]/g, "-").replace(/[×·]/g, "*").replace(/[÷:]/g, "÷").replace(/[٠-٩]/g, function (c) { return c.charCodeAt(0) - 0x660; }).replace(/٫/g, ".");
    var out = [], i = 0, m;
    while (i < s.length) {
      var rest = s.slice(i);
      if (/^\s/.test(rest)) { i++; continue; }
      if ((m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)/.exec(rest))) { // mixed number
        var w = BigInt(m[1]), fn = BigInt(m[2]), fd = BigInt(m[3]);
        if (fd === 0n) throw err("A fraction can't have 0 as its denominator");
        out.push({ t: "num", v: R(w * fd + fn, fd), lit: { kind: "mixed", w: w, n: fn, d: fd } }); i += m[0].length; continue;
      }
      if ((m = /^(\d+)\s*\/\s*(\d+)/.exec(rest))) {
        if (BigInt(m[2]) === 0n) throw err("A fraction can't have 0 as its denominator");
        out.push({ t: "num", v: R(m[1], m[2]), lit: { kind: "frac", n: BigInt(m[1]), d: BigInt(m[2]) } }); i += m[0].length; continue;
      }
      if ((m = /^(\d*\.\d*(?:\(\d+\))?|\d+)/.exec(rest)) && m[0] !== ".") {
        var p = parseDecimal(m[0]); if (!p) throw err("Can't read “" + m[0] + "”");
        out.push({ t: "num", v: p.v, lit: { kind: /\./.test(m[0]) ? "dec" : "int", text: m[0] } }); i += m[0].length; continue;
      }
      if ("+-*/÷^()".indexOf(s[i]) >= 0) { out.push({ t: "op", v: s[i] }); i++; continue; }
      throw err("Unexpected “" + s[i] + "”");
    }
    return out;
  }
  function evaluate(src) {
    var toks = tokenize(src), k = 0, steps = [];
    if (!toks.length) throw err("Type an expression");
    function is(v) { return toks[k] && toks[k].t === "op" && toks[k].v === v; }
    function expr() { var a = term(); while (is("+") || is("-")) { var op = toks[k++].v; a = binop(op, a, term()); } return a; }
    function term() { var a = unary(); while (is("*") || is("/") || is("÷")) { var op = toks[k++].v; a = binop(op === "*" ? "×" : "÷", a, unary()); } return a; }
    function unary() { if (is("-")) { k++; var v = unary(); return R(-v.n, v.d); } if (is("+")) { k++; return unary(); } return power(); }
    function power() { var b = primary(); if (is("^")) { k++; var e = unary(); var r = pow(b, e); steps.push({ op: "^", a: b, b: e, r: r }); return r; } return b; }
    function primary() {
      var t = toks[k];
      if (!t) throw err("The expression ends too early");
      if (t.t === "num") {
        k++;
        if (t.lit.kind === "mixed") steps.push({ op: "mixed", lit: t.lit, r: t.v });
        else if (t.lit.kind === "frac" && (t.lit.n !== t.v.n || t.lit.d !== t.v.d)) steps.push({ op: "simp", a: raw(t.lit.n, t.lit.d), r: t.v });
        else if (t.lit.kind === "dec") steps.push({ op: "dec", text: t.lit.text, r: t.v });
        return t.v;
      }
      if (t.t === "op" && t.v === "(") { k++; var v = expr(); if (!is(")")) throw err("Missing “)”"); k++; return v; }
      throw err("Unexpected “" + t.v + "”");
    }
    function binop(op, a, b) {
      var r = op === "+" ? add(a, b) : op === "-" ? sub(a, b) : op === "×" ? mul(a, b) : div(a, b);
      steps.push({ op: op, a: a, b: b, r: r });
      return r;
    }
    var v = expr();
    if (k < toks.length) throw err("Unexpected “" + toks[k].v + "”");
    return { v: v, steps: steps };
  }

  // ---------- math rendering (DOM only, never innerHTML with input) ----------
  function F(a) { // stacked fraction element
    if (a.d === 1n && !a.raw) return S3.h("span", { "class": "fc-int", text: fmtInt(a.n) });
    var neg = a.n < 0n;
    return S3.h("span", { "class": "fc-f" }, [neg ? S3.h("span", { "class": "fc-sign", text: "−" }) : null,
      S3.h("span", { "class": "fc-fr" }, [S3.h("span", { "class": "fc-n", text: fmtInt(babs(a.n)) }), S3.h("span", { "class": "fc-d", text: fmtInt(a.d) })])]);
  }
  function M(a) { // mixed form element
    var m = mixed(a);
    if (!m || !m.n) return F(a);
    return S3.h("span", { "class": "fc-f" }, [S3.h("span", { "class": "fc-int", text: (m.neg ? "−" : "") + fmtInt(m.w) }), F({ n: m.n, d: m.d })]);
  }
  function fmtInt(n) { return String(n).replace("-", "−"); }
  function line() { return S3.h("span", { "class": "fc-line" }, Array.prototype.slice.call(arguments).map(function (x) { return typeof x === "string" ? S3.h("span", { "class": "fc-op", text: x }) : x; })); }
  function par(a) { return a.n < 0n ? line("(", F(a), ")") : F(a); }

  function stepEls(s) {
    var items = [];
    if (s.op === "mixed") {
      var L = s.lit;
      items.push([S3.h("span", { text: "Mixed number to improper fraction" }), line(S3.h("span", { "class": "fc-f" }, [S3.h("span", { "class": "fc-int", text: String(L.w) }), F(raw(L.n, L.d))]), "=",
        F(raw(L.w * L.d + L.n, L.d)), S3.h("span", { "class": "fc-note", text: "(" + L.w + " × " + L.d + " + " + L.n + ")" })) ]);
      if (!eq(s.r, R(L.w * L.d + L.n, L.d)) || L.d !== s.r.d) items.push([S3.h("span", { text: "Simplify" }), line(F(raw(L.w * L.d + L.n, L.d)), "=", F(s.r))]);
    } else if (s.op === "simp") {
      var g = s.a.n === 0n ? s.a.d : gcd(s.a.n, s.a.d);
      items.push([S3.h("span", { text: "Simplify (divide by " + g + ")" }), line(F(s.a), "=", F(s.r))]);
    } else if (s.op === "dec") {
      items.push([S3.h("span", { text: "Decimal to fraction" }), line(S3.h("span", { "class": "fc-int", text: s.text }), "=", F(s.r))]);
    } else if (s.op === "+" || s.op === "-") {
      var a = s.a, b = s.b, sym = s.op === "+" ? "+" : "−";
      if (a.d === b.d) {
        var top = s.op === "+" ? a.n + b.n : a.n - b.n;
        items.push([S3.h("span", { text: "Same denominator: " + (s.op === "+" ? "add" : "subtract") + " the numerators" }), line(F(a), sym, par(b), "=", F(raw(top, a.d)))]);
        if (top !== s.r.n || a.d !== s.r.d) items.push([S3.h("span", { text: "Simplify" + gcdNote(top, a.d) }), line(F(raw(top, a.d)), "=", F(s.r))]);
      } else {
        var Lc = lcm(a.d, b.d), an = a.n * (Lc / a.d), bn = b.n * (Lc / b.d), t2 = s.op === "+" ? an + bn : an - bn;
        items.push([S3.h("span", { text: "Lowest common denominator of " + a.d + " and " + b.d + " is " + Lc }),
          line(F(a), sym, par(b), "=", F(raw(an, Lc)), sym, par(raw(bn, Lc)))]);
        items.push([S3.h("span", { text: (s.op === "+" ? "Add" : "Subtract") + " the numerators" }), line("=", F(raw(t2, Lc)))]);
        if (t2 !== s.r.n || Lc !== s.r.d) items.push([S3.h("span", { text: "Simplify" + gcdNote(t2, Lc) }), line("=", F(s.r))]);
      }
    } else if (s.op === "×") {
      var pn = s.a.n * s.b.n, pd = s.a.d * s.b.d;
      items.push([S3.h("span", { text: "Multiply tops and bottoms" }), line(par(s.a), "×", par(s.b), "=", F(raw(pn, pd)))]);
      if (pn !== s.r.n || pd !== s.r.d) items.push([S3.h("span", { text: "Simplify" + gcdNote(pn, pd) }), line("=", F(s.r))]);
    } else if (s.op === "÷") {
      var recip = R(s.b.d, s.b.n);
      items.push([S3.h("span", { text: "Dividing is multiplying by the reciprocal" }), line(par(s.a), "÷", par(s.b), "=", par(s.a), "×", par(recip))]);
      var qn = s.a.n * recip.n, qd = s.a.d * recip.d;
      items.push([S3.h("span", { text: "Multiply" }), line("=", F(raw(qn, qd)))]);
      if (qn !== s.r.n || qd !== s.r.d) items.push([S3.h("span", { text: "Simplify" + gcdNote(qn, qd) }), line("=", F(s.r))]);
    } else if (s.op === "^") {
      items.push([S3.h("span", { text: "Raise top and bottom to the power " + s.b.n }), line(par(s.a), S3.h("sup", { text: String(s.b.n) }), "=", F(s.r))]);
    }
    return items;
  }
  function gcdNote(n, d) { var g = gcd(n, d); return g > 1n ? " (divide by " + g + ")" : ""; }

  function resultBlock(v, extra) {
    var box = S3.h("div", { "class": "fc-main" });
    box.appendChild(S3.h("div", { "class": "fc-big" }, [M(v)]));
    var dec = decimal(v), forms = [["Fraction", str(v)], ["Mixed number", mixedStr(v)], ["Decimal", dec.text], ["Percent", percent(v)]];
    if (dec.repeating || dec.cut) forms.splice(3, 0, ["Rounded", approx(v, 6)]);
    var tbl = S3.h("dl", { "class": "fc-forms" });
    forms.forEach(function (f) { if (f[0] === "Mixed number" && !mixed(v)) return; tbl.appendChild(S3.h("dt", { text: f[0] })); tbl.appendChild(S3.h("dd", { "class": "mono", text: f[1] })); });
    box.appendChild(tbl);
    if (extra) box.appendChild(extra);
    lastCopy = str(v);
    return box;
  }
  function percent(v) { var p = mul(v, R(100)), d = decimal(p); return d.text + "%"; }

  // ---------- modes ----------
  var lastCopy = "";
  var mode = (S3.store(KEY) || {}).mode || "calc";
  var inputs = { calc: $("#calcIn"), d2f: $("#decIn"), f2d: $("#fracIn"), cmp: $("#cmpIn") };
  function showErr(msg) {
    $("#result").textContent = ""; $("#steps").textContent = "";
    $("#result").appendChild(S3.h("div", { "class": "fc-err", text: msg }));
  }
  function empty(msg) {
    lastCopy = "";
    $("#result").textContent = ""; $("#steps").textContent = "";
    $("#result").appendChild(S3.h("div", { "class": "empty" }, [S3.h("b", { text: "Nothing yet" }), msg]));
  }
  function putSteps(list) {
    var ol = $("#steps"); ol.textContent = "";
    if (!list.length) { ol.appendChild(S3.h("li", { "class": "faint", text: "Nothing to work out: the input is already in lowest terms." })); return; }
    list.forEach(function (it) { ol.appendChild(S3.h("li", {}, it)); });
  }

  function run() {
    var v = inputs[mode].value.trim();
    var st = S3.store(KEY) || {}; st.mode = mode; st[mode] = inputs[mode].value; S3.store(KEY, st);
    try {
      if (mode === "calc") {
        if (!v) return empty("Type fractions with + − × ÷, like 1 1/2 + 3/4.");
        var r = evaluate(v), items = [];
        r.steps.forEach(function (s) { items = items.concat(stepEls(s)); });
        $("#result").textContent = ""; $("#result").appendChild(resultBlock(r.v));
        putSteps(items);
      } else if (mode === "d2f") {
        if (!v) return empty("Type a decimal. Brackets mark the repeating part: 0.(3) = 0.333…");
        var p = parseDecimal(v);
        if (!p) throw err("Type a decimal like 0.75, 2.5 or 0.1(6)");
        $("#result").textContent = ""; $("#result").appendChild(resultBlock(p.v, approxList(p)));
        putSteps(decSteps(p));
      } else if (mode === "f2d") {
        if (!v) return empty("Type a fraction like 5/7 or a mixed number like 2 3/8.");
        var q = evaluate(v);
        $("#result").textContent = ""; $("#result").appendChild(resultBlock(q.v));
        putSteps(divSteps(q.v));
      } else {
        if (!v) return empty("Type two or more fractions to put them in order.");
        compare(v);
      }
    } catch (e) {
      lastCopy = "";
      if (e.fc) showErr(e.message); else showErr("That doesn't look like a number (" + e.message + ")");
    }
  }

  function decSteps(p) {
    var I = p.info, s = [];
    if (!I.rp) {
      var den = 10n ** BigInt(I.fp.length), num = BigInt(I.ip + I.fp);
      s.push([S3.h("span", { text: I.fp.length + " decimal place" + (I.fp.length === 1 ? "" : "s") + ", so put it over " + den }), line(S3.h("span", { "class": "fc-int", text: (p.neg ? "−" : "") + I.ip + (I.fp ? "." + I.fp : "") }), "=", F(raw(p.neg ? -num : num, den)))]);
      if (num !== babs(p.v.n) || den !== p.v.d) s.push([S3.h("span", { text: "Simplify" + gcdNote(num, den) }), line("=", F(p.v))]);
      return s;
    }
    var k = I.fp.length, r = I.rp.length, x = (p.neg ? "−" : "") + I.ip + "." + I.fp + "(" + I.rp + ")";
    var A = 10n ** BigInt(k + r), B = 10n ** BigInt(k);
    s.push([S3.h("span", { text: "Let x = " + x + ". The block “" + I.rp + "” repeats every " + r + " digit" + (r === 1 ? "" : "s") + "." }), null]);
    s.push([S3.h("span", { text: "Multiply by " + A + " and by " + B + " so the repeating tails line up" }),
      line(S3.h("span", { "class": "fc-int", text: A + "x = " + shift(I, k + r) }), S3.h("span", { "class": "fc-int", text: B + "x = " + shift(I, k) }))]);
    s.push([S3.h("span", { text: "Subtract: the repeating parts cancel" }), line(S3.h("span", { "class": "fc-int", text: (A - B) + "x = " + (I.all - I.head) }))]);
    s.push([S3.h("span", { text: "Divide" }), line("x =", F(raw(p.neg ? -(I.all - I.head) : I.all - I.head, A - B)))]);
    if ((I.all - I.head) !== babs(p.v.n) || (A - B) !== p.v.d) s.push([S3.h("span", { text: "Simplify" + gcdNote(I.all - I.head, A - B) }), line("x =", F(p.v))]);
    return s.map(function (it) { return it.filter(Boolean); });
  }
  function shift(I, places) { // the number with the point moved right, as text with its repeating tail
    var digits = I.fp + I.rp, ext = digits;
    while (ext.length < places) ext += I.rp;
    var ip = (I.ip + ext.slice(0, places)).replace(/^0+(?=\d)/, "");
    var restStart = places - I.fp.length, rot = I.rp.slice(((restStart % I.rp.length) + I.rp.length) % I.rp.length) + I.rp.slice(0, ((restStart % I.rp.length) + I.rp.length) % I.rp.length);
    return ip + ".(" + rot + ")";
  }
  // Close fractions with small denominators (continued fractions): 3.14159 → 22/7, 355/113.
  function convergents(v, maxDen) {
    var out = [], n = v.n, d = v.d, h0 = 0n, h1 = 1n, k0 = 1n, k1 = 0n;
    for (var i = 0; i < 40 && d !== 0n; i++) {
      var a = n / d; if (n < 0n && n % d !== 0n) a -= 1n;
      var h2 = a * h1 + h0, k2 = a * k1 + k0;
      if (k2 > maxDen) break;
      out.push(R(h2, k2));
      h0 = h1; h1 = h2; k0 = k1; k1 = k2;
      var r = n - a * d; n = d; d = r;
    }
    return out;
  }
  function approxList(p) {
    if (p.v.d <= 1000n) return null;
    var all = convergents(p.v, 100000n).filter(function (c) { return c.d > 1n; }), list = [];
    [10n, 100n, 1000n, 10000n, 100000n].forEach(function (cap) { // the best one under each denominator size
      var best = all.filter(function (c) { return c.d <= cap; }).pop();
      if (best && !list.some(function (x) { return eq(x, best); })) list.push(best);
    });
    if (!list.length) return null;
    var box = S3.h("div", { "class": "fc-approx" }, [S3.h("span", { "class": "faint", text: "Close fractions with smaller denominators:" })]);
    list.forEach(function (c) { box.appendChild(S3.h("span", { "class": "chip mono", text: str(c) + " ≈ " + approx(c, 8) })); });
    return box;
  }
  function divSteps(v) {
    var s = [], m = mixed(v);
    if (m && m.n) s.push([S3.h("span", { text: "Whole part " + m.w + ", remainder " + m.n + "/" + m.d }), line(F(v), "=", M(v))]);
    var dec = decimal(v);
    s.push([S3.h("span", { text: "Divide " + babs(v.n) + " by " + v.d + (dec.repeating ? ". A remainder comes back, so the digits repeat" : "") }), line(F(v), "=", S3.h("span", { "class": "fc-int", text: dec.text }))]);
    var d = v.d; while (d % 2n === 0n) d /= 2n; while (d % 5n === 0n) d /= 5n;
    s.push([S3.h("span", { text: d === 1n ? "The denominator has only the prime factors 2 and 5, so the decimal ends." : "The denominator has a prime factor other than 2 and 5, so the decimal repeats forever." }), null]);
    s.push([S3.h("span", { text: "Percent: multiply by 100" }), line(S3.h("span", { "class": "fc-int", text: percent(v) }))]);
    return s.map(function (it) { return it.filter(Boolean); });
  }
  function compare(v) {
    var parts = v.split(/\s*[,;]\s*|\s{2,}/).filter(Boolean);
    if (parts.length === 1) parts = v.split(/\s+(?![\d]+\s*\/)/).filter(Boolean); // "2/3 3/5" (but keep "1 1/2" together)
    var vals = parts.map(function (p) { var r = evaluate(p); return { src: p.trim(), v: r.v }; });
    if (vals.length < 2) throw err("Type at least two fractions, separated by commas");
    var L = vals.reduce(function (acc, x) { return lcm(acc, x.v.d); }, 1n);
    var sorted = vals.slice().sort(function (a, b) { return cmp(a.v, b.v); });
    var box = S3.h("div", { "class": "fc-main" });
    var chain = S3.h("div", { "class": "fc-big fc-chain" });
    sorted.forEach(function (x, i) {
      if (i) chain.appendChild(S3.h("span", { "class": "fc-op", text: cmp(sorted[i - 1].v, x.v) === 0 ? "=" : "<" }));
      chain.appendChild(M(x.v));
    });
    box.appendChild(chain);
    box.appendChild(S3.h("p", { "class": "faint", text: "Smallest to largest. Largest: " + sorted[sorted.length - 1].src + " (" + approx(sorted[sorted.length - 1].v, 6) + ")" }));
    $("#result").textContent = ""; $("#result").appendChild(box);
    lastCopy = sorted.map(function (x) { return str(x.v); }).join(" < ").replace(/ < (?=[^<]*$)/, " < ");
    lastCopy = sorted.map(function (x, i) { return (i ? (cmp(sorted[i - 1].v, x.v) === 0 ? " = " : " < ") : "") + str(x.v); }).join("");
    var steps = [[S3.h("span", { text: "Lowest common denominator: " + L }), null]];
    vals.forEach(function (x) { steps.push([S3.h("span", { text: x.src }), line(F(x.v), "=", F(raw(x.v.n * (L / x.v.d), L)))]); });
    steps.push([S3.h("span", { text: "With the same denominator, compare the numerators" }), null]);
    putSteps(steps.map(function (it) { return it.filter(Boolean); }));
  }

  // ---------- wiring ----------
  function setMode(m) {
    mode = m;
    $$("#tabs button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.v === m)); });
    $$(".fc-panel").forEach(function (p) { p.hidden = p.dataset.panel !== m; });
    run();
  }
  $$("#tabs button").forEach(function (b) { b.addEventListener("click", function () { setMode(b.dataset.v); inputs[mode].focus(); }); });
  Object.keys(inputs).forEach(function (k) {
    inputs[k].addEventListener("input", S3.debounce(run, 150));
    inputs[k].addEventListener("keydown", function (e) { if (e.key === "Enter") { run(); S3.done(); } });
  });
  $$("#calcKeys [data-ins]").forEach(function (b) {
    b.addEventListener("click", function () {
      var el = inputs.calc, s = el.selectionStart, e = el.selectionEnd, t = b.dataset.ins;
      el.value = el.value.slice(0, s) + t + el.value.slice(e); el.focus(); el.setSelectionRange(s + t.length, s + t.length); run();
    });
  });
  $("#copy").addEventListener("click", function () { if (!lastCopy) return S3.toast("Nothing to copy yet", "error"); S3.copy(lastCopy); S3.done(); });
  var st0 = S3.store(KEY) || {};
  inputs.calc.value = st0.calc != null ? st0.calc : "1 1/2 + 3/4 × 2/5";
  inputs.d2f.value = st0.d2f != null ? st0.d2f : "0.1(6)";
  inputs.f2d.value = st0.f2d != null ? st0.f2d : "5/7";
  inputs.cmp.value = st0.cmp != null ? st0.cmp : "2/3, 3/5, 7/10";
  setMode(["calc", "d2f", "f2d", "cmp"].indexOf(mode) >= 0 ? mode : "calc");

  window.S3_DEMO = function () { inputs.calc.value = "1/3 + 1/6 × 2 1/4"; setMode("calc"); };

  // ---------- self-test ----------
  window.S3_SELFTEST = function () {
    var f = [];
    function ok(n, c) { if (!c) f.push(n); }
    function E(s) { return str(evaluate(s).v); }
    ok("1/3+1/6", E("1/3 + 1/6") === "1/2");
    ok("0.(3)", str(parseDecimal("0.(3)").v) === "1/3" && E("0.(3)") === "1/3");
    ok("0.1(6)", str(parseDecimal("0.1(6)").v) === "1/6");
    ok("1.2(34)", str(parseDecimal("1.2(34)").v) === "611/495");
    ok("0.(9) = 1", str(parseDecimal("0.(9)").v) === "1");
    ok("-0.25", str(parseDecimal("-0.25").v) === "-1/4");
    ok("mixed", E("1 1/2 + 3/4") === "9/4" && mixedStr(evaluate("1 1/2 + 3/4").v) === "2 1/4" && E("-1 1/2") === "-3/2");
    ok("fraction ÷", E("1/2 ÷ 3/4") === "2/3" && E("2/3 × 9/4") === "3/2" && E("3/4 - 5/6") === "-1/12");
    ok("precedence", E("1/2 + 1/3 × 3") === "3/2" && E("(1/2 + 1/3) × 3") === "5/2" && E("(2/3)^2") === "4/9" && E("2^-2") === "1/4");
    var h = "0"; for (var i = 1; i <= 10; i++) h += " + 1/" + i;
    ok("harmonic 10", E(h) === "7381/2520");
    var big = evaluate("1/3^40 + 1/3^40").v;
    ok("bigint exact", big.n === 2n && big.d === 12157665459056928801n);
    ok("decimal 1/7", decimal(R(1, 7)).text === "0.(142857)");
    ok("decimal 1/8", decimal(R(1, 8)).text === "0.125" && percent(R(1, 8)) === "12.5%");
    ok("decimal 1/6", decimal(R(1, 6)).text === "0.1(6)" && decimal(R(-7, 3)).text === "-2.(3)");
    ok("percent 2/3", percent(R(2, 3)) === "66.(6)%");
    ok("approx", approx(R(2, 3), 6) === "0.666667" && approx(R(-1, 8), 2) === "-0.13");
    ok("compare", cmp(R(2, 3), R(3, 5)) === 1 && cmp(R(1, 2), R(2, 4)) === 0);
    var cv = convergents(parseDecimal("3.14159265").v, 1000n).map(str);
    ok("convergents", cv.indexOf("22/7") >= 0 && cv.indexOf("355/113") >= 0);
    ok("shift", shift({ ip: "0", fp: "1", rp: "6" }, 2) === "16.(6)" && shift({ ip: "0", fp: "1", rp: "6" }, 1) === "1.(6)");
    function bad(s) { try { evaluate(s); return false; } catch (e) { return e.fc === true; } }
    ok("errors", bad("1/0") && bad("1 ÷ 0") && bad("2 +") && bad("x") && bad("(1"));
    return f.length ? f : true;
  };
})();
