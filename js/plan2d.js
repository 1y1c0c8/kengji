// 2D 視圖（同一張 canvas）：遺址平面、坑位平面、坑壁剖面
// 三種視圖的螢幕座標都是 sx = ox + a·s、sy = oy − b·s（往上為正：北方或高程）
import { S, P, pit, emit, checkpoint, changed } from './state.js?v=0.1.0';
import { V, clamp, pointInPoly, segDist } from './util.js?v=0.1.0';
import {
  WALLS, CORNER_NAMES, layersOf, layerAt, findLayer, fmtZ, typeOf, seasonOf, pitCenter, worldOf,
  bil, bottomCorners, cornerLocal, topAt,
} from './model.js?v=0.1.0';

const C = {
  bg: '#f4f1ec', grid: 'rgba(70,55,40,.07)', gridMaj: 'rgba(70,55,40,.16)', ink: '#2b2824', mute: '#7a7268',
  accent: '#2f7d76', hot: '#d0612a', measure: '#7a4fb0', paper: '#fffdf9',
};
const FONT = '-apple-system, BlinkMacSystemFont, "PingFang TC", "Noto Sans TC", sans-serif';
const font = (px, w = 400) => `${w} ${px}px ${FONT}`;
const alpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

export class Plan2D {
  constructor(canvas, ui) {
    this.c = canvas; this.ctx = canvas.getContext('2d'); this.ui = ui;
    this.cams = {}; this.dpr = 1; this.w = 0; this.h = 0;
    this.tool = 'select';   // 'select' | 'measure' | 'add'
    this.meas = [];         // 遺址：量距離選到的坑 id
    this.hits = [];         // 可點的標籤（剖面入口等）
    this.pointers = new Map(); this.drag = null; this.pinch = null; this.hover = null;
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e, false));
    canvas.addEventListener('pointercancel', e => this.up(e, true));
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    canvas.addEventListener('dblclick', e => this.dbl(e));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
  }

  get kind() { return S.view === 'site' ? 'site' : S.wall ? 'profile' : 'pit'; }
  camKey() { return this.kind === 'site' ? 'site' : `${this.kind}:${S.pitId}:${S.wall || ''}`; }
  get cam() { return this.cams[this.camKey()]; }

  resize() {
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.c.width = Math.round(r.width * this.dpr);
    this.c.height = Math.round(r.height * this.dpr);
    this.draw();
  }

  // ---------- 視圖範圍 ----------
  bounds() {
    const p = P(); if (!p) return null;
    if (this.kind === 'site') {
      const pts = [];
      for (const pt of p.pits) if (!S.settings.hideSeasons.includes(pt.season)) for (const c of pt.corners) pts.push({ x: c.E - p.datum.E, y: c.N - p.datum.N });
      pts.push({ x: 0, y: 0 });
      return box(pts, 2);
    }
    const pt = pit(); if (!pt) return null;
    if (this.kind === 'pit') return { x0: 0, y0: 0, x1: pt.w, y1: pt.d };
    const wl = WALLS[S.wall], len = this.wallLen(pt);
    const zs = [...pt.top, ...bottomCorners(pt)];
    return { x0: 0, x1: len, y0: Math.min(...zs), y1: Math.max(...zs) };
  }
  fit() {
    const b = this.bounds();
    if (!b || !this.w) return;
    const k = this.kind, narrow = this.w < 600, m = k === 'site' ? (narrow ? 30 : 60) : k === 'pit' ? (narrow ? 64 : 120) : (narrow ? 70 : 96);
    const right = this.w > 760 ? 300 : 0;
    const top = k === 'pit' ? 96 : 60, bottom = k === 'pit' ? 64 : this.w > 760 ? 30 : 64;
    const aw = this.w - right - 2 * m, ah = this.h - top - bottom - 2 * (k === 'profile' ? 30 : 10);
    const s = Math.min(aw / (b.x1 - b.x0 || 1), ah / (b.y1 - b.y0 || 1));
    this.cams[this.camKey()] = {
      s, ox: m + aw / 2 + (this.w > 760 ? 0 : 0) - ((b.x0 + b.x1) / 2) * s + (k === 'profile' ? 20 : 0),
      oy: top + 10 + (k === 'profile' ? 30 : 0) + ah / 2 + ((b.y0 + b.y1) / 2) * s,
    };
    this.draw();
  }
  ensureCam() { if (!this.cam) this.fit(); return this.cam; }
  toS(a, b) { const c = this.cam; return { x: c.ox + a * c.s, y: c.oy - b * c.s }; }
  toW(x, y) { const c = this.cam; return { x: (x - c.ox) / c.s, y: (c.oy - y) / c.s }; }
  zoomAt(px, py, k) {
    const c = this.cam; if (!c) return;
    const w = this.toW(px, py);
    c.s = clamp(c.s * k, 1e-4, 1e4);
    c.ox = px - w.x * c.s; c.oy = py + w.y * c.s;
    this.draw();
  }
  wallLen(pt) { return S.wall === 'N' || S.wall === 'S' ? pt.w : pt.d; }

  // ---------- 繪圖 ----------
  draw() {
    if (!this.w || S.view === '3d') return;
    const ctx = this.ctx, p = P();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, this.w, this.h);
    this.hits = [];
    if (!p) return;
    if (!this.ensureCam()) return;
    if (this.kind === 'site') this.drawSite(p);
    else if (!pit()) return;
    else if (this.kind === 'pit') this.drawPit(p, pit());
    else this.drawProfile(p, pit());
  }

  // 等距格線＋比例尺
  scaleBar(unitMM) {
    const ctx = this.ctx, s = this.cam.s * unitMM; // px per mm
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const len = nice.find(n => n * s > 70) || nice[nice.length - 1];
    const x = 16, y = this.h - 22, px = len * s;
    ctx.strokeStyle = C.ink; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5); ctx.stroke();
    ctx.fillStyle = C.ink; ctx.font = font(11.5, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(len >= 1000 ? `${len / 1000} m` : `${len / 10} cm`, x + px / 2, y - 3);
  }
  northArrow(rotDeg = 0) {
    const ctx = this.ctx, x = this.w - (this.w > 760 ? 330 : 30), y = this.h - 44;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rotDeg * Math.PI / 180);
    ctx.fillStyle = C.ink; ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(7, 8); ctx.lineTo(0, 3); ctx.lineTo(-7, 8); ctx.closePath(); ctx.fill();
    ctx.font = font(12, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('N', 0, -17);
    ctx.restore();
  }
  label(text, x, y, { bg = C.paper, fg = C.ink, size = 12, weight = 600, align = 'center', border = 'rgba(0,0,0,.12)' } = {}) {
    const ctx = this.ctx;
    ctx.font = font(size, weight);
    const w = ctx.measureText(text).width + 12, h = size + 9;
    const x0 = align === 'center' ? x - w / 2 : align === 'left' ? x : x - w;
    ctx.fillStyle = bg; ctx.strokeStyle = border; ctx.lineWidth = 1;
    rr(ctx, x0, y - h / 2, w, h, 6); ctx.fill(); ctx.stroke();
    ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(text, x0 + 6, y + .5);
    return { x: x0, y: y - h / 2, w, h };
  }

  drawSite(p) {
    const ctx = this.ctx, X = c => c.E - p.datum.E, Y = c => c.N - p.datum.N;
    const hide = S.settings.hideSeasons;
    const vis = p.pits.filter(pt => !hide.includes(pt.season));
    // 網格（2 m）
    const g = p.grid, gs = g.size / 1000, r = (g.rot || 0) * Math.PI / 180;
    const tl = this.toW(0, 0), br = this.toW(this.w, this.h);
    const ext = Math.max(Math.abs(tl.x), Math.abs(tl.y), Math.abs(br.x), Math.abs(br.y)) + 50;
    const gE = g.E0 - p.datum.E, gN = g.N0 - p.datum.N;
    const n0 = Math.floor(-ext / gs) - Math.ceil(Math.hypot(gE, gN) / gs), n1 = -n0;
    if (gs * this.cam.s > 6) {
      ctx.lineWidth = 1;
      for (let i = n0; i <= n1; i++) {
        ctx.strokeStyle = i % 5 === 0 ? C.gridMaj : C.grid;
        const line = (ax, ay, bx, by) => {
          const a = this.toS(gE + ax * Math.cos(r) + ay * Math.sin(r), gN - ax * Math.sin(r) + ay * Math.cos(r));
          const b = this.toS(gE + bx * Math.cos(r) + by * Math.sin(r), gN - bx * Math.sin(r) + by * Math.cos(r));
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        };
        line(i * gs, n0 * gs, i * gs, n1 * gs);
        line(n0 * gs, i * gs, n1 * gs, i * gs);
      }
    }
    // 坑
    for (const pt of vis) {
      const se = seasonOf(p, pt), col = se?.color || C.accent;
      const poly = pt.corners.map(c => this.toS(X(c), Y(c)));
      const sel = S.sel?.kind === 'pit' && S.sel.id === pt.id, meas = this.meas.includes(pt.id);
      ctx.beginPath(); poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
      ctx.fillStyle = alpha(col, sel || meas ? .32 : this.hover === pt.id ? .26 : .17); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = sel || meas ? 3 : 1.6; ctx.stroke();
    }
    // 遺物點
    if (S.settings.siteFinds) {
      for (const pt of vis) for (const f of pt.finds) {
        if (S.settings.hideTypes.includes(f.type)) continue;
        const w = worldOf(pt, f.x, f.y), q = this.toS(w.E - p.datum.E, w.N - p.datum.N);
        ctx.fillStyle = typeOf(p, f.type).color;
        ctx.beginPath(); ctx.arc(q.x, q.y, clamp(this.cam.s * 0.03, 1.5, 4), 0, 7); ctx.fill();
      }
    }
    // 遺構
    for (const pt of vis) for (const fe of pt.features) this.featurePath(pt, fe, (x, y) => { const w = worldOf(pt, x, y); return this.toS(w.E - p.datum.E, w.N - p.datum.N); }, .5);
    // 坑號
    for (const pt of vis) {
      const c = pitCenter(pt), q = this.toS(c.E - p.datum.E, c.N - p.datum.N);
      const se = seasonOf(p, pt);
      if (2 * this.cam.s > 34) {
        ctx.fillStyle = C.ink; ctx.font = font(clamp(this.cam.s * 0.28, 11, 18), 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(pt.code, q.x, q.y - (2 * this.cam.s > 70 ? 8 : 0));
        if (2 * this.cam.s > 70) { ctx.font = font(11); ctx.fillStyle = C.mute; ctx.fillText(se?.code ? `${se.code} 季` : '', q.x, q.y + 10); }
      }
    }
    // 基準點
    const b = this.toS(0, 0);
    ctx.fillStyle = C.hot; ctx.beginPath(); ctx.moveTo(b.x, b.y - 9); ctx.lineTo(b.x + 7, b.y + 5); ctx.lineTo(b.x - 7, b.y + 5); ctx.closePath(); ctx.fill();
    ctx.font = font(11.5, 700); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(p.datum.name || 'BM', b.x + 9, b.y);
    // 量距離
    if (this.meas.length === 2) this.drawMeasure(p);
    this.northArrow(0);
    this.scaleBar(0.001);
  }
  drawMeasure(p) {
    const [a, b] = this.meas.map(id => p.pits.find(x => x.id === id));
    if (!a || !b) return;
    const ctx = this.ctx, ca = pitCenter(a), cb = pitCenter(b);
    const A = this.toS(ca.E - p.datum.E, ca.N - p.datum.N), B = this.toS(cb.E - p.datum.E, cb.N - p.datum.N);
    ctx.strokeStyle = C.measure; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); ctx.setLineDash([]);
    const m = measurePits(p, a, b);
    this.label(`${m.dist.toFixed(2)} m`, (A.x + B.x) / 2, (A.y + B.y) / 2, { bg: C.measure, fg: '#fff', border: C.measure });
  }

  featurePath(pt, fe, map, a = 1, fill = true) {
    const ctx = this.ctx;
    const pts = fe.shape === 'circle'
      ? Array.from({ length: 28 }, (_, i) => ({ x: fe.x + Math.cos(i / 28 * Math.PI * 2) * fe.r, y: fe.y + Math.sin(i / 28 * Math.PI * 2) * fe.r }))
      : [{ x: fe.x - fe.w / 2, y: fe.y - fe.h / 2 }, { x: fe.x + fe.w / 2, y: fe.y - fe.h / 2 }, { x: fe.x + fe.w / 2, y: fe.y + fe.h / 2 }, { x: fe.x - fe.w / 2, y: fe.y + fe.h / 2 }];
    const s = pts.map(q => map(q.x, q.y));
    ctx.beginPath(); s.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
    if (fill) { ctx.fillStyle = `rgba(40,30,25,${.22 * a})`; ctx.fill(); }
    ctx.strokeStyle = `rgba(40,30,25,${.85 * a})`; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
    return s;
  }

  drawPit(p, pt) {
    const ctx = this.ctx, layers = layersOf(p, pt);
    const L = S.level >= 0 ? layers[S.level] : null;
    const o = this.toS(0, 0), e = this.toS(pt.w, pt.d);
    // 坑底色：目前層的土色
    ctx.fillStyle = L ? L.color : '#e9e1d4';
    ctx.fillRect(o.x, e.y, e.x - o.x, o.y - e.y);
    // 10 cm 格線
    const s = this.cam.s;
    ctx.lineWidth = 1;
    for (let v = 100; v < Math.max(pt.w, pt.d); v += 100) {
      ctx.strokeStyle = L ? (v % 500 ? 'rgba(255,255,255,.10)' : 'rgba(255,255,255,.28)') : (v % 500 ? C.grid : C.gridMaj);
      if (v < pt.w) { const a = this.toS(v, 0), b = this.toS(v, pt.d); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      if (v < pt.d) { const a = this.toS(0, v), b = this.toS(pt.w, v); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5; ctx.strokeRect(o.x, e.y, e.x - o.x, o.y - e.y);
    // 邊緣刻度（每 50 cm）
    ctx.fillStyle = C.mute; ctx.font = font(10.5); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let v = 0; v <= pt.w; v += 500) { const q = this.toS(v, 0); ctx.fillText(`${v / 10}`, q.x, q.y + 4); }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let v = 0; v <= pt.d; v += 500) { const q = this.toS(0, v); ctx.fillText(`${v / 10}`, q.x - 5, q.y); }
    // 遺構
    for (const fe of pt.features) {
      const on = !L || (fe.top >= bil(L.bot, .5, .5) && fe.bot <= bil(L.top, .5, .5));
      const sel = S.sel?.kind === 'feature' && S.sel.id === fe.id;
      this.featurePath(pt, fe, (x, y) => this.toS(x, y), on ? 1 : .35);
      if (sel) { ctx.strokeStyle = C.hot; ctx.lineWidth = 2.5; ctx.stroke(); }
      if (s * 300 > 40) { const q = this.toS(fe.x, fe.y); ctx.fillStyle = on ? '#fff' : 'rgba(255,255,255,.6)'; ctx.font = font(11, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(fe.type, q.x, q.y); }
    }
    // 遺物
    const sel = S.sel?.kind === 'find' ? S.sel.id : null;
    const onlyLv = S.settings.onlyLevel;
    const drawn = [];
    for (const f of pt.finds) {
      if (S.settings.hideTypes.includes(f.type)) continue;
      const inL = !L || layerAt(layers, pt, f.x, f.y, f.z) === L;
      if (!inL && onlyLv) continue;
      drawn.push([f, inL]);
    }
    drawn.sort((a, b) => a[1] - b[1]);
    for (const [f, inL] of drawn) {
      const q = this.toS(f.x, f.y), t = typeOf(p, f.type);
      const r = inL ? 6.5 : 4;
      ctx.globalAlpha = inL ? 1 : .5;
      ctx.fillStyle = t.color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (f.key) { ctx.moveTo(q.x, q.y - r - 2); ctx.lineTo(q.x + r + 2, q.y); ctx.lineTo(q.x, q.y + r + 2); ctx.lineTo(q.x - r - 2, q.y); ctx.closePath(); }
      else ctx.arc(q.x, q.y, r, 0, 7);
      ctx.fill(); ctx.stroke();
      ctx.globalAlpha = 1;
      if (inL && s * 2000 > 520) { ctx.fillStyle = L ? '#fff' : C.ink; ctx.font = font(10.5, 600); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(f.no.replace(/^.*-/, ''), q.x + 9, q.y); }
    }
    // 選到的遺物：到西壁、南壁的距離
    const f = sel && pt.finds.find(x => x.id === sel);
    if (f) {
      const q = this.toS(f.x, f.y), w = this.toS(0, f.y), so = this.toS(f.x, 0);
      ctx.strokeStyle = C.hot; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(w.x, w.y); ctx.lineTo(q.x, q.y); ctx.lineTo(so.x, so.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, 7); ctx.lineWidth = 2.5; ctx.stroke();
      this.label(`距西壁 ${(f.x / 10).toFixed(1)}`, (w.x + q.x) / 2, q.y - 14, { bg: C.hot, fg: '#fff', border: C.hot, size: 11 });
      this.label(`距南壁 ${(f.y / 10).toFixed(1)}`, so.x + 6, (so.y + q.y) / 2, { bg: C.hot, fg: '#fff', border: C.hot, size: 11, align: 'left' });
    }
    // 四角高程
    const zs = L ? L.bot : pt.top;
    const zm = S.settings.zDisp;
    cornerLocal(pt).forEach((c, i) => {
      const q = this.toS(c.x, c.y), dx = i === 0 || i === 3 ? -1 : 1, dy = i < 2 ? 1 : -1;
      const txt = `${CORNER_NAMES[i]} ${fmtZ(p, zs[i], zm, { pit: pt, x: c.x, y: c.y })}`;
      if (this.w < 600) this.label(txt, q.x - dx * 22, q.y + dy * 34, { size: 10.5, weight: 500 }); // 手機：放在角的上下方，不超出畫面
      else this.label(txt, q.x + dx * 8, q.y + dy * 16, { align: dx < 0 ? 'right' : 'left', size: 11, weight: 500 });
    });
    // 剖面入口
    const mid = { N: [pt.w / 2, pt.d], S: [pt.w / 2, 0], E: [pt.w, pt.d / 2], W: [0, pt.d / 2] };
    for (const k of ['N', 'E', 'S', 'W']) {
      const q = this.toS(...mid[k]);
      const narrow = this.w < 600;
      const off = { N: [0, -36], S: [0, 40], E: [narrow ? 32 : 52, 0], W: [narrow ? -32 : -52, 0] }[k];
      const h = this.label(narrow ? `${WALLS[k].name} ›` : `${WALLS[k].name}剖面 ›`, q.x + off[0], q.y + off[1], { bg: C.accent, fg: '#fff', border: C.accent, size: 12 });
      this.hits.push({ ...h, kind: 'wall', wall: k });
    }
    this.northArrow(pitRot(pt));
    this.scaleBar(1);
  }

  drawProfile(p, pt) {
    const ctx = this.ctx, wl = WALLS[S.wall], len = this.wallLen(pt);
    const cl = cornerLocal(pt), A = cl[wl.l], B = cl[wl.r];
    const zAt = (arr, t) => arr[wl.l] + (arr[wl.r] - arr[wl.l]) * (t / len);
    const primary = layersOf(p, pt), other = layersOf(p, pt, p.layerMode === 'arbitrary' ? 'natural' : 'arbitrary');
    // 層
    for (const L of primary) {
      const a = this.toS(0, L.top[wl.l]), b = this.toS(len, L.top[wl.r]), c = this.toS(len, L.bot[wl.r]), d = this.toS(0, L.bot[wl.l]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath();
      ctx.fillStyle = L.color; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1; ctx.stroke();
      if (S.level === L.idx) { ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 3; ctx.stroke(); }
      const hl = (a.y + d.y) / 2;
      if (d.y - a.y > 13) { ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.font = font(11.5, 650); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(L.name, a.x + 8, hl); }
    }
    // 另一種層位的界線（虛線）
    ctx.setLineDash([7, 4]); ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(255,248,225,.9)';
    for (const L of other) {
      const a = this.toS(0, L.bot[wl.l]), b = this.toS(len, L.bot[wl.r]);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]);
    const rightLbl = this.toS(len, 0).x + 8;
    ctx.font = font(10.5); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    let lastY = -1e9;
    for (const L of other) {
      const b = this.toS(len, L.bot[wl.r]);
      if (b.y - lastY < 13) continue; // 太擠就略過
      ctx.fillStyle = C.mute; ctx.fillText(`┄ ${L.short} 底`, rightLbl, b.y); lastY = b.y;
    }
    // 地表線與外框
    const t0 = this.toS(0, pt.top[wl.l]), t1 = this.toS(len, pt.top[wl.r]);
    const bc = bottomCorners(pt), b0 = this.toS(0, bc[wl.l]), b1 = this.toS(len, bc[wl.r]);
    ctx.strokeStyle = C.ink; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(t0.x, t0.y); ctx.lineTo(b0.x, b0.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(t1.x, t1.y); ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#3b8f3b'; ctx.beginPath(); ctx.moveTo(t0.x - 20, t0.y); ctx.lineTo(t0.x, t0.y); ctx.lineTo(t1.x, t1.y); ctx.lineTo(t1.x + 20, t1.y); ctx.stroke();
    // 遺構（投影到壁面）
    const dirV = V.sub(B, A), dl = V.len(dirV) || 1, dir = V.scale(dirV, 1 / dl), nrm = { x: -dir.y, y: dir.x };
    const proj = (x, y) => { const d = V.sub({ x, y }, A); return { t: V.dot(d, dir), dist: Math.abs(V.dot(d, nrm)) }; };
    for (const fe of pt.features) {
      const ext = fe.shape === 'circle' ? [fe.r, fe.r] : [fe.w / 2, fe.h / 2];
      const c = proj(fe.x, fe.y), half = Math.abs(dir.x) > .5 ? ext[0] : ext[1];
      const a = this.toS(c.t - half, fe.top), b = this.toS(c.t + half, fe.bot);
      const near = clamp(1 - (c.dist - half) / 1200, .3, 1);
      ctx.strokeStyle = `rgba(30,20,15,${near})`; ctx.setLineDash([5, 3]); ctx.lineWidth = 1.5;
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y); ctx.setLineDash([]);
      ctx.fillStyle = `rgba(255,255,255,${near})`; ctx.font = font(11, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(fe.type, (a.x + b.x) / 2, a.y + 3);
    }
    // 遺物（依離壁面距離變淡）
    const sel = S.sel?.kind === 'find' ? S.sel.id : null;
    this.profFinds = [];
    const list = pt.finds.filter(f => !S.settings.hideTypes.includes(f.type)).map(f => ({ f, ...proj(f.x, f.y) })).sort((a, b) => b.dist - a.dist);
    for (const { f, t, dist } of list) {
      const q = this.toS(t, f.z), a = clamp(1 - dist / 1600, .15, 1), r = 3 + 3.5 * a;
      ctx.globalAlpha = a; ctx.fillStyle = typeOf(p, f.type).color; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, 7); ctx.fill(); ctx.stroke(); ctx.globalAlpha = 1;
      if (f.id === sel) { ctx.strokeStyle = C.hot; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, 7); ctx.stroke(); }
      this.profFinds.push({ f, x: q.x, y: q.y });
    }
    // 高程尺（左）
    const zm = S.settings.zDisp, ctxL = { pit: pt, x: A.x, y: A.y };
    const zs = [...pt.top, ...bc], z0 = Math.min(...zs), z1 = Math.max(...zs);
    const axX = this.toS(0, 0).x - 14;
    ctx.strokeStyle = C.ink; ctx.lineWidth = 1; ctx.fillStyle = C.ink; ctx.font = font(10.5); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    const step = this.cam.s * 100 > 26 ? 100 : 200;
    for (let z = Math.ceil(z0 / step) * step; z <= z1 + 1; z += step) {
      const q = this.toS(0, z);
      ctx.beginPath(); ctx.moveTo(axX, q.y); ctx.lineTo(axX + 6, q.y); ctx.stroke();
      ctx.fillText(fmtZ(p, z, zm, ctxL), axX - 3, q.y);
    }
    // 角名
    const h0 = this.toS(0, Math.max(...pt.top)).y - 24;
    this.label(`${CORNER_NAMES[wl.l]}角`, t0.x, h0, { size: 11.5 });
    this.label(`${CORNER_NAMES[wl.r]}角`, t1.x, h0, { size: 11.5 });
    this.scaleBar(1);
  }

  // ---------- 互動 ----------
  pos(e) { const r = this.c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  hitTest(q) {
    const p = P(); if (!p) return null;
    for (const h of this.hits) if (q.x >= h.x && q.x <= h.x + h.w && q.y >= h.y && q.y <= h.y + h.h) return h;
    if (this.kind === 'site') {
      for (const pt of [...p.pits].reverse()) {
        if (S.settings.hideSeasons.includes(pt.season)) continue;
        const poly = pt.corners.map(c => this.toS(c.E - p.datum.E, c.N - p.datum.N));
        if (pointInPoly(q, poly)) return { kind: 'pit', id: pt.id };
      }
      return null;
    }
    const pt = pit(); if (!pt) return null;
    if (this.kind === 'profile') {
      let best = null, bd = 12;
      for (const h of this.profFinds || []) { const d = Math.hypot(h.x - q.x, h.y - q.y); if (d < bd) { bd = d; best = h; } }
      return best ? { kind: 'find', id: best.f.id } : null;
    }
    const layers = layersOf(p, pt), L = S.level >= 0 ? layers[S.level] : null;
    let best = null, bd = 13;
    for (const f of pt.finds) {
      if (S.settings.hideTypes.includes(f.type)) continue;
      if (L && S.settings.onlyLevel && layerAt(layers, pt, f.x, f.y, f.z) !== L) continue;
      const s = this.toS(f.x, f.y), d = Math.hypot(s.x - q.x, s.y - q.y) - (L && layerAt(layers, pt, f.x, f.y, f.z) === L ? 3 : 0);
      if (d < bd) { bd = d; best = f; }
    }
    if (best) return { kind: 'find', id: best.id };
    const w = this.toW(q.x, q.y);
    for (const fe of pt.features) {
      const inside = fe.shape === 'circle' ? Math.hypot(w.x - fe.x, w.y - fe.y) <= fe.r : Math.abs(w.x - fe.x) <= fe.w / 2 && Math.abs(w.y - fe.y) <= fe.h / 2;
      if (inside) return { kind: 'feature', id: fe.id };
    }
    return null;
  }
  down(e) {
    this.c.setPointerCapture(e.pointerId);
    const q = this.pos(e);
    this.pointers.set(e.pointerId, q);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), m: V.lerp(a, b, .5) };
      this.drag = null;
      return;
    }
    const cam = this.cam; if (!cam) return;
    const hit = this.hitTest(q);
    this.drag = { start: q, last: q, moved: false, hit };
    // 拖曳已選取的遺物
    if (this.kind === 'pit' && hit?.kind === 'find' && S.sel?.id === hit.id && this.tool === 'select') this.drag.find = hit.id;
  }
  move(e) {
    const q = this.pos(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, q);
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), m = V.lerp(a, b, .5);
      const c = this.cam;
      c.ox += m.x - this.pinch.m.x; c.oy += m.y - this.pinch.m.y;
      this.zoomAt(m.x, m.y, d / this.pinch.d);
      this.pinch = { d, m };
      return;
    }
    const dr = this.drag;
    if (!dr) {
      if (e.pointerType === 'mouse') {
        const h = this.hitTest(q);
        const id = h ? h.id || h.wall : null;
        this.c.style.cursor = h ? 'pointer' : this.tool === 'add' ? 'crosshair' : 'default';
        if (id !== this.hover) { this.hover = id; this.draw(); }
      }
      return;
    }
    if (!dr.moved && Math.hypot(q.x - dr.start.x, q.y - dr.start.y) < 5) return;
    if (!dr.moved && dr.find) checkpoint();
    dr.moved = true;
    if (dr.find) {
      const pt = pit(), f = pt.finds.find(x => x.id === dr.find), w = this.toW(q.x, q.y);
      f.x = clamp(Math.round(w.x / 10) * 10, 0, pt.w); f.y = clamp(Math.round(w.y / 10) * 10, 0, pt.d);
      changed('find');
    } else {
      const c = this.cam;
      c.ox += q.x - dr.last.x; c.oy += q.y - dr.last.y;
      this.draw();
    }
    dr.last = q;
  }
  up(e, cancel) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    const dr = this.drag; this.drag = null;
    if (!dr || cancel || dr.moved) return;
    this.click(dr.start, dr.hit, e);
  }
  click(q, hit) {
    const p = P();
    if (hit?.kind === 'wall') return this.ui.openProfile(hit.wall);
    if (this.kind === 'site') {
      if (this.tool === 'measure') {
        if (!hit) { this.meas = []; }
        else if (this.meas.length >= 2 || this.meas.includes(hit.id)) this.meas = [hit.id];
        else this.meas.push(hit.id);
        this.ui.onMeasure(this.meas);
        return this.draw();
      }
      S.sel = hit ? { kind: 'pit', id: hit.id } : null;
      return emit('selection');
    }
    if (this.kind === 'pit' && this.tool === 'add' && !hit) {
      const w = this.toW(q.x, q.y), pt = pit();
      if (w.x < 0 || w.y < 0 || w.x > pt.w || w.y > pt.d) return;
      return this.ui.addFindAt(Math.round(w.x / 10) * 10, Math.round(w.y / 10) * 10);
    }
    S.sel = hit ? { kind: hit.kind, id: hit.id, pitId: S.pitId } : null;
    emit('selection');
  }
  dbl(e) {
    if (this.kind !== 'site') return;
    const h = this.hitTest(this.pos(e));
    if (h?.kind === 'pit') this.ui.openPit(h.id);
  }
  wheel(e) {
    e.preventDefault();
    const q = this.pos(e);
    if (e.ctrlKey || e.deltaMode === 1 || Math.abs(e.deltaY) > 40 && !e.deltaX && Number.isInteger(e.deltaY)) this.zoomAt(q.x, q.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0018)));
    else { const c = this.cam; if (!c) return; c.ox -= e.deltaX; c.oy -= e.deltaY; this.draw(); }
  }
}

// 坑相對網格的轉角（度，逆時針為正）：用於坑位視圖的指北針
export function pitRot(pt) {
  const c = pt.corners;
  return Math.atan2(c[1].N - c[0].N, c[1].E - c[0].E) * 180 / Math.PI;
}
export function measurePits(p, a, b) {
  const ca = pitCenter(a), cb = pitCenter(b);
  const dist = Math.hypot(ca.E - cb.E, ca.N - cb.N);
  const az = (Math.atan2(cb.E - ca.E, cb.N - ca.N) * 180 / Math.PI + 360) % 360;
  // 最近邊緣距離（相連的坑 = 0）
  let edge = Infinity;
  const pa = a.corners.map(c => ({ x: c.E, y: c.N })), pb = b.corners.map(c => ({ x: c.E, y: c.N }));
  for (const q of pa) for (let i = 0; i < 4; i++) edge = Math.min(edge, segDist(q, pb[i], pb[(i + 1) % 4]));
  for (const q of pb) for (let i = 0; i < 4; i++) edge = Math.min(edge, segDist(q, pa[i], pa[(i + 1) % 4]));
  const topA = topAt(a, a.w / 2, a.d / 2), topB = topAt(b, b.w / 2, b.d / 2);
  const botA = bil(bottomCorners(a), .5, .5), botB = bil(bottomCorners(b), .5, .5);
  return { dist, az, edge: edge < 0.03 ? 0 : edge, dTop: topB - topA, dBot: botB - botA };
}

function box(pts, pad) {
  const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
  return { x0: Math.min(...xs) - pad, x1: Math.max(...xs) + pad, y0: Math.min(...ys) - pad, y1: Math.max(...ys) + pad };
}
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
