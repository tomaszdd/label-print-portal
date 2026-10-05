// Label Designer — renders the label at the printer's native resolution
// (180 dpi, tape height in dots) as a pure black/white bitmap. The preview IS
// the bitmap that gets printed, so what you see is what you get.
"use strict";

const DPI = 180, PX_PER_MM = DPI / 25.4;
const TAPES = { 6: 32, 9: 52, 12: 76 };   // tape mm -> printable dots (PT-1230PC)
const FONTS = [
  ["Roboto", "Roboto"], ["Roboto Condensed", "Condensed"], ["Roboto Mono", "Mono"],
  ["Oswald", "Oswald"], ["Bebas Neue", "Bebas Neue"], ["Lora", "Lora (serif)"],
  ["Permanent Marker", "Marker"],
];
const NO_BOLD = new Set(["Bebas Neue", "Permanent Marker"]);
const ICONS = ["bolt", "power", "power_settings_new", "electrical_services", "cable", "usb", "router",
  "wifi", "lan", "dns", "storage", "memory", "computer", "tv", "speaker", "videocam", "camera_alt",
  "phone", "print", "lightbulb", "thermostat", "water_drop", "local_fire_department", "ac_unit",
  "warning", "info", "error", "check_circle", "cancel", "block", "home", "key", "lock", "inventory_2",
  "label", "build", "handyman", "settings", "kitchen", "restaurant", "local_cafe", "liquor",
  "medication", "pets", "eco", "yard", "garage", "bed", "bathroom", "checkroom", "folder",
  "description", "book", "mail", "music_note", "sports_esports", "battery_full", "sd_card",
  "qr_code_2", "star", "favorite", "recycling", "delete", "schedule", "calendar_today",
  "arrow_forward", "arrow_back", "arrow_upward", "arrow_downward", "north", "south",
  "person", "family_restroom", "child_care", "luggage", "flight", "directions_car", "pedal_bike"];

// ---------------------------------------------------------------- state ----
const $ = (id) => document.getElementById(id);
const view = $("view"), vctx = view.getContext("2d");
const bmp = document.createElement("canvas"), bctx = bmp.getContext("2d", { willReadFrequently: true });

let tapePx = 76, tapeMm = 12, tapeLive = false;
let D, sel = 0, zoom = null, lastLayout = null;
const undoStack = [], redoStack = [];
const imgCache = new Map();

const T = (o) => Object.assign({ type: "text", text: "Label", font: "Roboto", bold: true, italic: false,
  fit: true, size: 40, lh: 1.05, first: 1, align: "c", invert: false, yOff: 0 }, o);
const MAKE = {
  text: () => T({ text: "Text" }),
  icon: () => ({ type: "icon", name: "bolt", fit: true, size: 60, invert: false, yOff: 0 }),
  qr: () => ({ type: "qr", data: "https://", ecc: "M", yOff: 0 }),
  image: (src) => ({ type: "image", src, fit: true, size: 60, dither: true, threshold: 128, invertImg: false, yOff: 0 }),
  divider: () => ({ type: "divider", thick: 2, len: 100, yOff: 0 }),
  spacer: () => ({ type: "spacer", w: 16 }),
};
const blank = (els) => ({ margin: 2, gap: 8, lengthMode: "auto", lengthMm: 50, halign: "c",
  border: "none", invert: false, elements: els || [T({ text: "Label" })] });

const TEMPLATES = [
  ["Simple", () => blank([T({ text: "Label" })])],
  ["Two lines", () => blank([T({ text: "Main line\nsecond line" })])],
  ["Title + subtitle", () => blank([T({ text: "TITLE\nsmaller detail line", first: 1.6 })])],
  ["Three lines", () => blank([T({ text: "Line one\nLine two\nLine three", bold: false, font: "Roboto Condensed" })])],
  ["Icon + text", () => blank([MAKE.icon(), T({ text: "Power\nsupply", align: "l" })])],
  ["Asset tag", () => Object.assign(blank([MAKE.icon(), MAKE.divider(), T({ text: "ASSET 0001\nYour Name", align: "l", first: 1.3 }), { type: "qr", data: "ASSET-0001", ecc: "M", yOff: 0 }]), { border: "rounded", margin: 4 })],
  ["Warning", () => Object.assign(blank([{ type: "icon", name: "warning", fit: true, size: 60, invert: false, yOff: 0 }, T({ text: "DO NOT\nUNPLUG", font: "Oswald" }), { type: "icon", name: "warning", fit: true, size: 60, invert: false, yOff: 0 }]), { invert: true, margin: 4 })],
  ["Cable flag", () => blank([T({ text: "NAS .220", font: "Roboto Condensed" }), { type: "spacer", w: 180 }, T({ text: "NAS .220", font: "Roboto Condensed" })])],
  ["QR + text", () => blank([{ type: "qr", data: "https://example.com", ecc: "M", yOff: 0 }, T({ text: "Scan me", align: "l" })])],
];

// ------------------------------------------------------------- storage ----
const ls = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
};

// -------------------------------------------------------------- layout ----
function borderW() { return { none: 0, thin: 2, thick: 4, rounded: 2, double: 5 }[D.border] || 0; }

function fontStr(el, px) {
  const w = el.bold && !NO_BOLD.has(el.font) ? 700 : 400;
  return `${el.italic ? "italic " : ""}${w} ${px}px "${el.font}"`;
}

function measure(el, avail) {
  const c = bctx;
  if (el.type === "text") {
    const lines = el.text.split("\n");
    const units = (el.first + (lines.length - 1)) * el.lh;
    const s = el.fit ? Math.max(4, Math.floor(avail / units)) : el.size;
    const sizes = lines.map((_, i) => (i === 0 ? Math.round(s * el.first) : s));
    let w = 0;
    sizes.forEach((px, i) => { c.font = fontStr(el, px); w = Math.max(w, c.measureText(lines[i] || " ").width); });
    const pad = el.invert ? 4 : 0;
    const h = Math.round(sizes.reduce((a, px) => a + px * el.lh, 0));
    return { w: Math.ceil(w) + pad * 2, h, pad, lines, sizes, minPx: Math.min(...sizes) };
  }
  if (el.type === "icon") {
    const s = el.fit ? avail : el.size;
    c.font = `${s}px "Material Icons"`;
    const m = c.measureText(el.name);
    const w = Math.ceil(m.actualBoundingBoxLeft + m.actualBoundingBoxRight) || s;
    const gh = Math.ceil(m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || s;
    const pad = el.invert ? 3 : 0;
    return { w: w + pad * 2, h: gh + pad * 2, s, m, pad };
  }
  if (el.type === "qr") {
    let q;
    try { q = qrcode(0, el.ecc); q.addData(el.data || " "); q.make(); }
    catch (e) { return { w: 0, h: 0, err: "Too much data for a QR code" }; }
    const n = q.getModuleCount(), mod = Math.floor(avail / n);
    if (mod < 1) return { w: 0, h: 0, err: `QR needs ${n}px but the tape only has ${avail}px. Shorten the data or use ECC L.` };
    return { w: n * mod, h: n * mod, q, n, mod };
  }
  if (el.type === "image") {
    const img = imgCache.get(el.src);
    if (!img || !img.complete || !img.naturalWidth) return { w: 0, h: 0 };
    const h = el.fit ? avail : Math.min(el.size, tapePx);
    return { w: Math.max(1, Math.round(img.naturalWidth * h / img.naturalHeight)), h, img };
  }
  if (el.type === "divider") return { w: el.thick, h: Math.round(avail * el.len / 100) };
  if (el.type === "spacer") return { w: el.w, h: 0 };
  return { w: 0, h: 0 };
}

function layout() {
  const H = tapePx, b = borderW(), inset = b ? b + 2 : 0;
  const top = D.margin + inset, avail = Math.max(4, H - 2 * top);
  const items = D.elements.map((el, i) => Object.assign({ el, i }, measure(el, avail)));
  const contentW = items.reduce((a, it) => a + it.w, 0) + D.gap * Math.max(0, items.length - 1);
  const side = Math.max(D.margin, 2) + inset;
  const W = D.lengthMode === "fixed" ? Math.max(8, Math.round(D.lengthMm * PX_PER_MM)) : Math.max(8, contentW + side * 2);
  let x = side;
  if (D.lengthMode === "fixed") {
    const free = W - side * 2 - contentW;
    x += D.halign === "c" ? Math.floor(free / 2) : D.halign === "r" ? free : 0;
  }
  for (const it of items) {
    it.x = x; it.y = Math.round(top + (avail - it.h) / 2 + (it.el.yOff || 0));
    x += it.w + D.gap;
  }
  return { W, H, top, avail, items, contentW, side, inset };
}

// -------------------------------------------------------------- render ----
function drawItem(c, it, L) {
  const el = it.el;
  if (el.type === "text") {
    if (el.invert) { c.fillStyle = "#000"; c.fillRect(it.x, it.y - 1, it.w, it.h + 2); }
    c.fillStyle = el.invert ? "#fff" : "#000";
    let y = it.y;
    it.sizes.forEach((px, i) => {
      c.font = fontStr(el, px);
      const lineH = px * el.lh, line = it.lines[i];
      const capM = c.measureText("H"), cap = capM.actualBoundingBoxAscent || px * 0.7;
      const lw = c.measureText(line).width, inner = it.w - it.pad * 2;
      const lx = it.x + it.pad + (el.align === "c" ? (inner - lw) / 2 : el.align === "r" ? inner - lw : 0);
      c.textBaseline = "alphabetic";
      c.fillText(line, lx, Math.round(y + lineH / 2 + cap / 2));
      y += lineH;
    });
  } else if (el.type === "icon") {
    if (el.invert) { c.fillStyle = "#000"; c.fillRect(it.x, it.y, it.w, it.h); }
    c.fillStyle = el.invert ? "#fff" : "#000";
    c.font = `${it.s}px "Material Icons"`;
    c.textBaseline = "alphabetic";
    c.fillText(el.name, it.x + it.pad + it.m.actualBoundingBoxLeft, it.y + it.pad + it.m.actualBoundingBoxAscent);
  } else if (el.type === "qr" && it.q) {
    c.fillStyle = "#000";
    for (let r = 0; r < it.n; r++) for (let k = 0; k < it.n; k++)
      if (it.q.isDark(r, k)) c.fillRect(it.x + k * it.mod, it.y + r * it.mod, it.mod, it.mod);
  } else if (el.type === "image" && it.img) {
    const t = document.createElement("canvas"); t.width = it.w; t.height = it.h;
    const tc = t.getContext("2d");
    tc.fillStyle = "#fff"; tc.fillRect(0, 0, it.w, it.h);
    tc.drawImage(it.img, 0, 0, it.w, it.h);
    const id = tc.getImageData(0, 0, it.w, it.h);
    toMono(id, el.threshold, el.dither, el.invertImg);
    tc.putImageData(id, 0, 0);
    c.drawImage(t, it.x, it.y);
  } else if (el.type === "divider") {
    c.fillStyle = "#000"; c.fillRect(it.x, it.y, it.w, it.h);
  }
}

// Grayscale -> pure black/white in place (optional Floyd–Steinberg dithering).
function toMono(id, threshold, dither, invert) {
  const d = id.data, w = id.width, h = id.height, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255;
    g[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) * a + 255 * (1 - a);
    if (invert) g[i] = 255 - g[i];
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, old = g[i], v = old < threshold ? 0 : 255;
    g[i] = v;
    if (dither) {
      const e = old - v;
      if (x + 1 < w) g[i + 1] += e * 7 / 16;
      if (y + 1 < h) { if (x > 0) g[i + w - 1] += e * 3 / 16; g[i + w] += e * 5 / 16; if (x + 1 < w) g[i + w + 1] += e / 16; }
    }
  }
  for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g[i]; d[i * 4 + 3] = 255; }
}

function render() {
  const L = layout();
  lastLayout = L;
  bmp.width = L.W; bmp.height = L.H;
  const c = bctx;
  c.fillStyle = "#fff"; c.fillRect(0, 0, L.W, L.H);
  // border
  const b = borderW();
  if (b) {
    c.strokeStyle = "#000";
    const box = (o, lw, r) => {
      c.lineWidth = lw; c.beginPath();
      if (c.roundRect) c.roundRect(o + lw / 2, o + lw / 2, L.W - 2 * o - lw, L.H - 2 * o - lw, r);
      else c.rect(o + lw / 2, o + lw / 2, L.W - 2 * o - lw, L.H - 2 * o - lw);
      c.stroke();
    };
    if (D.border === "double") { box(0, 2, 0); box(4, 1, 0); }
    else box(0, b, D.border === "rounded" ? 10 : 0);
  }
  for (const it of L.items) drawItem(c, it, L);
  // Threshold everything to 1-bit, exactly as the printer will see it.
  const id = c.getImageData(0, 0, L.W, L.H), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 128 ? 0 : 255;
    if (D.invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  c.putImageData(id, 0, 0);
  paintView();
  report(L);
  ls.set("labeldesigner.current", D);
}

function autoZoom(W) {
  const room = $("tapeScroll").clientWidth - 24;
  return Math.max(2, Math.min(6, Math.floor(room / W)));
}

function paintView() {
  const L = lastLayout, Z = zoom || autoZoom(L.W);
  if (!zoom) $("zoom").value = Z;
  const edge = Math.round(((tapeMm * PX_PER_MM) - L.H) / 2);   // unprintable tape edge
  view.width = L.W * Z; view.height = L.H * Z;
  $("tape").style.padding = `${Math.max(0, edge) * Z}px 0`;
  vctx.imageSmoothingEnabled = false;
  vctx.drawImage(bmp, 0, 0, L.W * Z, L.H * Z);
  // overflow beyond printable area (red) and selection (blue)
  for (const it of L.items) {
    const out = it.err || it.y < 0 || it.y + it.h > L.H || it.x + it.w > L.W;
    const on = it.i === sel;
    if (!on && !out) continue;
    vctx.save();
    vctx.strokeStyle = out ? "#e5534b" : "#2f81f7";
    vctx.lineWidth = 2; vctx.setLineDash(on ? [6, 4] : []);
    vctx.strokeRect(it.x * Z - 2, it.y * Z - 2, Math.max(it.w, 2) * Z + 4, Math.max(it.h, 2) * Z + 4);
    vctx.restore();
  }
}

function report(L) {
  const mm = (L.W / PX_PER_MM).toFixed(1);
  $("dims").textContent = `${mm} mm × ${tapeMm} mm · ${L.W}×${L.H} dots`;
  const msgs = [];
  let level = "ok";
  for (const it of L.items) {
    const el = it.el, name = itemName(el);
    if (it.err) { msgs.push(it.err); level = "err"; }
    else if (el.type === "text" && it.h > L.avail + 1) {
      msgs.push(`"${name}" is ${it.h} dots tall but only ${L.avail} fit. Use fewer lines, a smaller size or Auto-fit.`); level = "err";
    } else if (it.y < 0 || it.y + it.h > L.H) { msgs.push(`"${name}" runs off the tape edge`); level = "err"; }
    else if (el.type === "text" && it.minPx < 12) {
      msgs.push(`"${name}" is ${it.minPx} dots (${(it.minPx / PX_PER_MM).toFixed(1)} mm), which may be hard to read`);
      if (level === "ok") level = "warn";
    }
  }
  if (D.lengthMode === "fixed" && L.contentW > L.W - 2 * L.side) {
    msgs.push(`Content is ${(L.contentW / PX_PER_MM).toFixed(0)} mm, longer than the ${D.lengthMm} mm label`); level = "err";
  }
  const f = $("fitMsg");
  f.className = level;
  f.textContent = msgs.length ? "⚠ " + msgs[0] + (msgs.length > 1 ? ` (+${msgs.length - 1} more)` : "") : "✓ Fits on the tape";
  f.title = msgs.join("\n");
}

function itemName(el) {
  if (el.type === "text") return el.text.split("\n")[0].slice(0, 24) || "(empty)";
  if (el.type === "icon") return el.name;
  if (el.type === "qr") return el.data.slice(0, 24);
  if (el.type === "divider") return "divider";
  if (el.type === "spacer") return `${el.w} dots`;
  return "image";
}

// ---------------------------------------------------------------- undo ----
function snapshot() {
  const s = JSON.stringify(D);
  if (undoStack[undoStack.length - 1] !== s) { undoStack.push(s); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
  syncUndo();
}
function syncUndo() { $("undoBtn").disabled = undoStack.length < 2; $("redoBtn").disabled = !redoStack.length; }
function undo() {
  if (undoStack.length < 2) return;
  redoStack.push(undoStack.pop());
  D = JSON.parse(undoStack[undoStack.length - 1]); sel = Math.min(sel, D.elements.length - 1); refresh();
}
function redo() {
  if (!redoStack.length) return;
  const s = redoStack.pop(); undoStack.push(s); D = JSON.parse(s); refresh();
}
function commit() { snapshot(); }       // call after a discrete change
function change() { render(); buildLayers(); }  // live update while editing
function refresh() { loadImages(); render(); buildLayers(); buildProps(); buildLabelProps(); syncUndo(); }

// ------------------------------------------------------------ controls ----
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v; else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k in n && k !== "list") n[k] = v; else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}
function field(label, input, cls) { return el("label", { class: cls || "" }, label, input); }
function num(obj, key, min, max, step, onlive) {
  return el("input", { type: "number", min, max, step: step || 1, value: obj[key],
    oninput: (e) => { const v = parseFloat(e.target.value); if (!isNaN(v)) { obj[key] = v; (onlive || change)(); } },
    onchange: commit });
}
function range(obj, key, min, max, step) {
  const out = el("span", {}, String(obj[key]));
  const r = el("input", { type: "range", min, max, step: step || 1, value: obj[key],
    oninput: (e) => { obj[key] = parseFloat(e.target.value); out.textContent = obj[key]; change(); }, onchange: commit });
  return [r, out];
}
function check(obj, key, label, after) {
  return el("label", { class: "check" }, el("input", { type: "checkbox", checked: !!obj[key],
    onchange: (e) => { obj[key] = e.target.checked; change(); commit(); if (after) after(); } }), label);
}
function seg(obj, key, opts, after) {
  const wrap = el("div", { class: "seg" });
  for (const [v, lab, title] of opts) {
    wrap.append(el("button", { type: "button", class: obj[key] === v ? "on" : "", title: title || "",
      onclick: () => { obj[key] = v; change(); commit(); (after || buildProps)(); } }, lab));
  }
  return wrap;
}
function select(obj, key, opts) {
  const s = el("select", { onchange: (e) => { obj[key] = e.target.value; change(); commit(); } });
  for (const [v, lab] of opts) s.append(el("option", { value: v, selected: obj[key] === v }, lab));
  return s;
}

function buildLayers() {
  const box = $("layers"); box.innerHTML = "";
  if (!D.elements.length) { box.append(el("p", { class: "empty" }, "Empty label. Add something above.")); return; }
  D.elements.forEach((e, i) => {
    box.append(el("div", { class: "layer" + (i === sel ? " on" : ""), onclick: () => { sel = i; render(); buildLayers(); buildProps(); } },
      el("span", { class: "kind" }, e.type),
      el("span", { class: "nm" }, itemName(e)),
      el("button", { title: "Move left", disabled: i === 0, onclick: (ev) => { ev.stopPropagation(); move(i, -1); } }, "←"),
      el("button", { title: "Move right", disabled: i === D.elements.length - 1, onclick: (ev) => { ev.stopPropagation(); move(i, 1); } }, "→"),
      el("button", { title: "Duplicate", onclick: (ev) => { ev.stopPropagation(); D.elements.splice(i + 1, 0, JSON.parse(JSON.stringify(e))); sel = i + 1; commit(); refresh(); } }, "⧉"),
      el("button", { title: "Remove", onclick: (ev) => { ev.stopPropagation(); D.elements.splice(i, 1); sel = Math.max(0, Math.min(sel, D.elements.length - 1)); commit(); refresh(); } }, "✕"),
    ));
  });
}
function move(i, dir) {
  const j = i + dir; if (j < 0 || j >= D.elements.length) return;
  [D.elements[i], D.elements[j]] = [D.elements[j], D.elements[i]];
  sel = j; commit(); refresh();
}

function buildProps() {
  const p = $("props"); p.innerHTML = "";
  const e = D.elements[sel];
  $("propsTitle").textContent = e ? `Selected: ${e.type}` : "Item";
  if (!e) { p.append(el("p", { class: "empty full" }, "Nothing selected.")); return; }
  const nudge = field("Nudge up/down (dots)", num(e, "yOff", -40, 40, 1));
  if (e.type === "text") {
    const ta = el("textarea", { id: "textInput", rows: Math.max(2, e.text.split("\n").length + 1), value: e.text,
      oninput: (ev) => { e.text = ev.target.value; ev.target.rows = Math.max(2, e.text.split("\n").length + 1); change(); },
      onchange: commit });
    p.append(field("Text (press Enter for a new line, as many lines as fit)", ta, "full"));
    p.append(field("Font", select(e, "font", FONTS)));
    p.append(field("Align lines", seg(e, "align", [["l", "Left"], ["c", "Centre"], ["r", "Right"]])));
    p.append(el("div", { class: "full", style: "display:flex;gap:1rem;flex-wrap:wrap" },
      check(e, "bold", "Bold"), check(e, "italic", "Italic"), check(e, "invert", "White on black"),
      check(e, "fit", "Auto-fit to tape height", buildProps)));
    if (!e.fit) p.append(field("Size (dots)", num(e, "size", 6, 120, 1)));
    const [fr, fo] = range(e, "first", 1, 2.5, 0.1);
    p.append(field(el("span", {}, "First line scale ×", fo), fr));
    const [lr, lo] = range(e, "lh", 0.8, 1.6, 0.05);
    p.append(field(el("span", {}, "Line spacing ×", lo), lr));
    p.append(nudge);
  } else if (e.type === "icon") {
    const grid = el("div", { class: "icon-grid" });
    for (const n of ICONS) grid.append(el("button", { type: "button", title: n, class: e.name === n ? "on" : "",
      onclick: () => { e.name = n; change(); commit(); buildProps(); } }, n));
    p.append(field("Icon", grid, "full"));
    p.append(field("Or any Material icon name", el("input", { type: "text", value: e.name,
      oninput: (ev) => { e.name = ev.target.value.trim().toLowerCase().replace(/\s+/g, "_"); change(); }, onchange: commit })));
    p.append(el("div", { style: "display:flex;flex-direction:column;gap:.4rem" },
      check(e, "fit", "Fit tape height", buildProps), check(e, "invert", "White on black")));
    if (!e.fit) p.append(field("Size (dots)", num(e, "size", 8, 120, 1)));
    p.append(nudge);
  } else if (e.type === "qr") {
    p.append(field("QR contents (URL, text, Wi-Fi string…)", el("textarea", { rows: 2, value: e.data,
      oninput: (ev) => { e.data = ev.target.value; change(); }, onchange: commit }), "full"));
    p.append(field("Error correction", seg(e, "ecc", [["L", "L"], ["M", "M"], ["Q", "Q"], ["H", "H"]])));
    p.append(el("p", { class: "empty" }, "L packs the most data. The QR scales to whole dots per module."));
    p.append(field("Wi-Fi helper", el("button", { type: "button", onclick: () => {
      const ssid = prompt("Wi-Fi name (SSID)"); if (!ssid) return;
      const pw = prompt("Password (blank for open network)") || "";
      const esc = (s) => s.replace(/([\\;,:"])/g, "\\$1");
      e.data = `WIFI:T:${pw ? "WPA" : "nopass"};S:${esc(ssid)};P:${esc(pw)};;`; change(); commit(); buildProps();
    } }, "Build Wi-Fi QR…")));
    p.append(nudge);
  } else if (e.type === "image") {
    p.append(el("div", { class: "full", style: "display:flex;gap:1rem;flex-wrap:wrap" },
      check(e, "dither", "Dither (photos)"), check(e, "invertImg", "Invert"), check(e, "fit", "Fit tape height", buildProps)));
    const [tr, to] = range(e, "threshold", 20, 235, 1);
    p.append(field(el("span", {}, "Threshold ", to), tr));
    if (!e.fit) p.append(field("Height (dots)", num(e, "size", 8, 120, 1)));
    p.append(field("Replace", el("button", { type: "button", onclick: () => pickImage(sel) }, "Choose image…")));
    p.append(nudge);
  } else if (e.type === "divider") {
    p.append(field("Thickness (dots)", num(e, "thick", 1, 10, 1)));
    p.append(field("Length (% of height)", num(e, "len", 10, 100, 5)));
  } else if (e.type === "spacer") {
    p.append(field("Width (dots, 7 ≈ 1 mm)", num(e, "w", 1, 400, 1)));
  }
}

function buildLabelProps() {
  const p = $("labelProps"); p.innerHTML = "";
  p.append(field("Length", seg(D, "lengthMode", [["auto", "Fit content"], ["fixed", "Fixed"]], buildLabelProps)));
  if (D.lengthMode === "fixed") {
    p.append(field("Length (mm)", num(D, "lengthMm", 5, 500, 1)));
    p.append(field("Position content", seg(D, "halign", [["l", "Left"], ["c", "Centre"], ["r", "Right"]], buildLabelProps)));
  }
  p.append(field("Border", select(D, "border", [["none", "None"], ["thin", "Thin"], ["thick", "Thick"], ["rounded", "Rounded"], ["double", "Double"]])));
  p.append(field("Edge margin (dots)", num(D, "margin", 0, 20, 1)));
  p.append(field("Gap between items (dots)", num(D, "gap", 0, 80, 1)));
  p.append(el("div", { style: "display:flex;align-items:end" }, check(D, "invert", "Invert whole label")));
  const tapeSel = el("select", { disabled: tapeLive, onchange: (ev) => { tapeMm = +ev.target.value; tapePx = TAPES[tapeMm]; render(); } });
  for (const mm of Object.keys(TAPES)) tapeSel.append(el("option", { value: mm, selected: +mm === tapeMm }, `${mm} mm (${TAPES[mm]} dots)`));
  p.append(field(tapeLive ? "Tape (read from printer)" : "Tape (printer offline, pick one)", tapeSel, "full"));
}

// -------------------------------------------------------- canvas input ----
let drag = null;
function hit(ev) {
  const r = view.getBoundingClientRect(), Z = view.width / lastLayout.W;
  const x = (ev.clientX - r.left) * (view.width / r.width) / Z, y = (ev.clientY - r.top) * (view.height / r.height) / Z;
  let best = null;
  for (const it of lastLayout.items) if (x >= it.x - 3 && x <= it.x + Math.max(it.w, 4) + 3) best = it;
  return { x, y, it: best };
}
view.addEventListener("pointerdown", (ev) => {
  const h = hit(ev);
  if (!h.it) return;
  sel = h.it.i; drag = { x0: h.x, y0: h.y, yOff0: h.it.el.yOff || 0, moved: false };
  view.setPointerCapture(ev.pointerId);
  render(); buildLayers(); buildProps();
});
view.addEventListener("pointermove", (ev) => {
  if (!drag) return;
  const h = hit(ev), e = D.elements[sel];
  if (!e) return;
  if (e.type !== "spacer") {
    const dy = Math.round(h.y - drag.y0);
    if (dy !== (e.yOff || 0) - drag.yOff0) { e.yOff = drag.yOff0 + dy; drag.moved = true; }
  }
  const items = lastLayout.items;
  const prev = items[sel - 1], next = items[sel + 1];
  if (prev && h.x < prev.x + prev.w / 2) { [D.elements[sel - 1], D.elements[sel]] = [D.elements[sel], D.elements[sel - 1]]; sel--; drag.moved = true; buildLayers(); }
  else if (next && h.x > next.x + next.w / 2) { [D.elements[sel + 1], D.elements[sel]] = [D.elements[sel], D.elements[sel + 1]]; sel++; drag.moved = true; buildLayers(); }
  render();
});
view.addEventListener("pointerup", () => { if (drag && drag.moved) { commit(); buildProps(); } drag = null; });
view.addEventListener("dblclick", () => { const t = $("textInput"); if (t) { t.focus(); t.select(); } });

// --------------------------------------------------------------- images ----
function loadImages() {
  for (const e of D.elements) if (e.type === "image" && !imgCache.has(e.src)) {
    const img = new Image(); img.onload = () => render(); img.src = e.src; imgCache.set(e.src, img);
  }
}
let pickTarget = null;
function pickImage(idx) { pickTarget = idx; $("imageFile").value = ""; $("imageFile").click(); }
$("imageFile").addEventListener("change", (ev) => {
  const f = ev.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Downscale once so saved designs stay small: 3x tape height is plenty.
      const h = Math.min(img.naturalHeight, 240), w = Math.round(img.naturalWidth * h / img.naturalHeight);
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const cx = c.getContext("2d"); cx.fillStyle = "#fff"; cx.fillRect(0, 0, w, h); cx.drawImage(img, 0, 0, w, h);
      const src = c.toDataURL("image/png");
      if (pickTarget != null && D.elements[pickTarget] && D.elements[pickTarget].type === "image") D.elements[pickTarget].src = src;
      else { D.elements.splice(sel + 1, 0, MAKE.image(src)); sel = Math.min(sel + 1, D.elements.length - 1); }
      commit(); refresh();
    };
    img.src = rd.result;
  };
  rd.readAsDataURL(f);
});

document.querySelectorAll("[data-add]").forEach((b) => b.addEventListener("click", () => {
  const t = b.dataset.add;
  if (t === "image") return pickImage(null);
  const at = D.elements.length ? sel + 1 : 0;
  D.elements.splice(at, 0, MAKE[t]()); sel = at; commit(); refresh();
  if (t === "text") { const ta = $("textInput"); if (ta) { ta.focus(); ta.select(); } }
}));

// -------------------------------------------------------------- printer ----
async function checkTape() {
  const pill = $("tapePill");
  try {
    const r = await fetch("/api/tape"), j = await r.json();
    if (j.busy) return;
    if (j.connected) {
      tapeLive = true; tapePx = j.height_px; tapeMm = j.width_mm || tapeMm;
      pill.className = "pill ok"; pill.textContent = `● ${j.width_mm} mm ${j.media || "tape"}`;
      if (j.error && j.error !== "0x0000") { pill.className = "pill err"; pill.textContent = `Printer error ${j.error}`; }
    } else {
      tapeLive = false; pill.className = "pill err"; pill.textContent = "Printer offline";
    }
  } catch (e) { tapeLive = false; pill.className = "pill err"; pill.textContent = "Portal unreachable"; }
  buildLabelProps(); render();
}
$("tapePill").addEventListener("click", checkTape);
$("tapePill").title = "Click to re-read the tape";

function labelName() {
  const t = D.elements.find((e) => e.type === "text");
  return t ? t.text.replace(/\n/g, " / ").slice(0, 60) : itemName(D.elements[0] || { type: "spacer", w: 0 });
}
function thumb() { return bmp.toDataURL("image/png"); }

$("printBtn").addEventListener("click", async () => {
  const btn = $("printBtn"), st = $("printStatus");
  if (!D.elements.length) return;
  if ($("fitMsg").className === "err" && !confirm("Some content doesn't fit on the tape. Print anyway?")) return;
  btn.disabled = true; st.hidden = false; st.className = "status";
  const t0 = Date.now();
  const tick = setInterval(() => { btn.textContent = `Printing… ${Math.floor((Date.now() - t0) / 1000)}s`; }, 500);
  try {
    const r = await fetch("/api/print", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ png: thumb(), copies: +$("copies").value || 1, cutmark: $("cutmark").checked,
        design: D, thumb: thumb(), name: labelName() }) });
    const j = await r.json();
    st.className = "status " + (j.ok ? (j.attempts > 1 ? "warn" : "ok") : "err");
    st.textContent = j.message;
    if (j.tape_px) checkTape();
    if (j.ok) loadLibrary();
  } catch (e) { st.className = "status err"; st.textContent = "Couldn't reach the portal: " + e; }
  clearInterval(tick); btn.disabled = false; btn.textContent = "Print label";
});

// -------------------------------------------------------------- library ----
let tab = "templates", lib = { saved: [], history: [] };
async function loadLibrary() {
  try { lib = await (await fetch("/api/designs")).json(); } catch (e) { /* offline */ }
  showLibrary();
}
function useDesign(d) { D = JSON.parse(JSON.stringify(d)); sel = 0; commit(); refresh(); window.scrollTo({ top: 0, behavior: "smooth" }); }
function showLibrary() {
  const box = $("library"); box.innerHTML = "";
  $("saveRow").style.display = tab === "saved" ? "" : "none";
  document.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  if (tab === "templates") {
    for (const [name, make] of TEMPLATES) box.append(el("div", { class: "lib-item", onclick: () => useDesign(make()) },
      el("div", { class: "meta" }, el("b", {}, name))));
    return;
  }
  const list = lib[tab] || [];
  if (!list.length) box.append(el("p", { class: "empty" }, tab === "saved" ? "No saved designs yet." : "Nothing printed from the designer yet."));
  for (const it of list) {
    const when = new Date(it.ts * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    box.append(el("div", { class: "lib-item", onclick: () => useDesign(it.design) },
      el("div", { class: "th" }, it.thumb ? el("img", { src: it.thumb, alt: "" }) : null),
      el("div", { class: "meta" }, el("b", {}, it.name), el("span", {}, when + (it.copies > 1 ? ` · ${it.copies} copies` : ""))),
      el("button", { class: "del", title: "Remove", onclick: async (ev) => {
        ev.stopPropagation();
        if (!confirm(`Remove "${it.name}"?`)) return;
        lib = await (await fetch(`/api/designs/${tab}/${it.id}`, { method: "DELETE" })).json(); showLibrary();
      } }, "✕")));
  }
}
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; showLibrary(); }));
$("saveBtn").addEventListener("click", async () => {
  const name = $("saveName").value.trim() || labelName();
  lib = await (await fetch("/api/designs", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, design: D, thumb: thumb() }) })).json();
  $("saveName").value = ""; showLibrary();
});

// ----------------------------------------------------------------- misc ----
$("undoBtn").addEventListener("click", undo);
$("redoBtn").addEventListener("click", redo);
$("newBtn").addEventListener("click", () => useDesign(blank()));
$("zoom").addEventListener("input", (e) => { zoom = +e.target.value; paintView(); });
window.addEventListener("resize", () => { if (!zoom) paintView(); });
document.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.key === "Delete" || e.key === "Backspace") && !typing && D.elements[sel]) { D.elements.splice(sel, 1); sel = Math.max(0, sel - 1); commit(); refresh(); }
});

// ----------------------------------------------------------------- boot ----
D = ls.get("labeldesigner.current") || blank([T({ text: "Main line\nsecond line" })]);
const fontLoads = FONTS.flatMap(([f]) => [`400 20px "${f}"`, `700 20px "${f}"`, `italic 400 20px "${f}"`])
  .concat(['20px "Material Icons"']).map((f) => document.fonts.load(f, "Hg bolt").catch(() => null));
refresh(); snapshot(); showLibrary();
Promise.all(fontLoads).then(() => render());
checkTape(); loadLibrary();
