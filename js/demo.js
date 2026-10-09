// 虛構示範遺址：兩個季次、七個坑（有相連、有分開、有一個不在網格上且歪斜）
// 位置、數據、人名全部是虛構的，只用來展示功能。
import { uid, rng, munsellName } from './util.js?v=0.1.0';
import { newProject, gridCellCorners, layersOf, layerAt, bil, SEASON_COLORS } from './model.js?v=0.1.0';
import { putImage } from './state.js?v=0.1.0';

const STRATA = [
  { short: '表土', name: '表土層', munsell: '10YR 3/2', texture: '壤土', compact: '鬆散', incl: '植物根系、現代磚瓦碎片' },
  { short: 'I', name: '文化層 I', munsell: '7.5YR 3/2', texture: '砂質壤土', compact: '中等', incl: '炭粒、陶片、少量貝殼' },
  { short: '砂', name: '間歇砂層', munsell: '10YR 6/4', texture: '細砂', compact: '鬆散', incl: '幾乎無包含物' },
  { short: 'II', name: '文化層 II', munsell: '5YR 3/3', texture: '黏質壤土', compact: '緊實', incl: '貝殼碎屑、炭粒、燒土塊' },
  { short: '生土', name: '生土層', munsell: '2.5Y 6/3', texture: '黏土', compact: '堅硬', incl: '無' },
];
// 地表與層界（X、Y：相對基準點的公尺；回傳毫米）
const surf = (X, Y) => 450 - 22 * X + 10 * Y + 50 * Math.sin(X / 6 + Y / 9);
function depths(X, Y) {
  const d1 = 140 + 30 * Math.sin(X / 2.5) + 20 * Math.cos(Y / 3);
  const d2 = d1 + 260 + 70 * Math.cos(Y / 4 + X / 8);
  const d3 = d2 + Math.max(0, 60 + 110 * Math.sin(X / 4 - Y / 5));
  const d4 = d3 + 300 + 60 * Math.sin(X / 3 + 1);
  return [d1, d2, d3, d4, d4 + 3000];
}
const FIND_W = [
  { porcelain: 5, pottery: 2, metal: 1, other: 1 },
  { pottery: 10, porcelain: 2, shell: 4, metal: 1, fauna: 2, sample: 1, stone: 1 },
  { pottery: 1, shell: 1 },
  { pottery: 8, stone: 4, bone: 2, shell: 6, fauna: 3, sample: 1 },
  {},
];
const DESC = {
  pottery: ['夾砂紅褐陶身片', '素面灰黑陶口緣', '繩紋陶片', '紅陶圈足', '夾砂陶把手', '彩繪陶片'],
  porcelain: ['青花瓷碗底', '白瓷口緣', '褐釉硬陶片', '安平壺殘片'],
  stone: ['打製石斧', '磨製石錛', '網墜', '石片器', '砥石'],
  bone: ['骨錐', '鹿角器殘件', '骨簪'],
  metal: ['鐵器殘件', '銅錢（字跡不清）', '鐵釘'],
  shell: ['牡蠣殼', '蠑螺殼', '貝環殘件', '文蛤'],
  fauna: ['魚椎骨', '鹿趾骨', '豬下顎骨殘件'],
  sample: ['炭樣（定年用）', '土樣（浮選用）'],
  other: ['玻璃珠', '紅磚殘塊'],
};
const PEOPLE = ['記錄員 A', '記錄員 B', '記錄員 C', '記錄員 D'];

// ---------- 假手繪圖（SVG，線條風格） ----------
function sketch(r, type, no) {
  const W = 320, H = 230, cx = 110, cy = 112;
  let body = '';
  if (type === 'stone') {
    const w = r.range(42, 58), h = r.range(75, 95);
    body = `<path d="M${cx - w * .7},${cy - h / 2} L${cx + w * .7},${cy - h / 2} Q${cx + w},${cy + h * .2} ${cx + w * .8},${cy + h / 2} Q${cx},${cy + h * .62} ${cx - w * .8},${cy + h / 2} Q${cx - w},${cy + h * .2} ${cx - w * .7},${cy - h / 2}Z" fill="none" stroke="#222" stroke-width="2"/>`;
    for (let i = 0; i < 7; i++) {
      const x = cx + r.range(-w * .6, w * .6), y = cy + r.range(-h * .4, h * .35), s = r.range(8, 16);
      body += `<path d="M${x - s},${y} Q${x},${y - s * .8} ${x + s},${y}" fill="none" stroke="#444" stroke-width="1"/>`;
    }
    body += `<rect x="232" y="${cy - h / 2}" width="18" height="${h}" rx="7" fill="none" stroke="#222" stroke-width="2"/>`;
  } else {
    const pts = [];
    const n = 9, R = r.range(52, 70);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, rr = R * r.range(.72, 1.1);
      pts.push([cx + Math.cos(a) * rr * 1.15, cy + Math.sin(a) * rr * .85]);
    }
    body = `<polygon points="${pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#222" stroke-width="2" stroke-linejoin="round"/>`;
    if (type === 'pottery') for (let i = -3; i <= 3; i++) body += `<line x1="${cx - 55}" y1="${cy + i * 13}" x2="${cx + 55}" y2="${cy + i * 13 + 8}" stroke="#555" stroke-width=".8" stroke-dasharray="3 3"/>`;
    // 剖面（塗黑）
    body += `<path d="M236,${cy - 60} q14,4 12,22 q-3,40 -2,96 l-9,0 q-1,-56 2,-96 q1,-14 -8,-18z" fill="#222"/>`;
    body += `<line x1="226" y1="${cy - 66}" x2="268" y2="${cy - 66}" stroke="#222" stroke-width="1"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#fbf8f1"/>${body}
<g stroke="#222" stroke-width="1.5"><line x1="20" y1="212" x2="110" y2="212"/><line x1="20" y1="207" x2="20" y2="217"/><line x1="65" y1="209" x2="65" y2="215"/><line x1="110" y1="207" x2="110" y2="217"/></g>
<text x="20" y="202" font-size="11" font-family="sans-serif" fill="#222">0</text><text x="104" y="202" font-size="11" font-family="sans-serif" fill="#222">3 cm</text>
<text x="300" y="22" font-size="13" text-anchor="end" font-family="sans-serif" fill="#222">${no}</text>
<text x="300" y="40" font-size="10" text-anchor="end" font-family="sans-serif" fill="#888">示範手繪圖（虛構）</text></svg>`;
  return new Blob([svg], { type: 'image/svg+xml' });
}

export async function buildDemo() {
  const r = rng(20251010);
  const p = newProject('海角示範遺址（虛構）');
  p.code = 'HJ';
  p.notes = '這是虛構的示範資料：遺址名稱、座標、高程、人員與遺物皆非真實，只用來展示坑記的功能。';
  p.datum = { name: 'BM1', E: 210000, N: 2620000, H: 8 };
  p.grid = { E0: 210000 - 1, N0: 2620000 - 3, size: 2000, rot: 0 };
  p.strata = STRATA.map(s => ({ id: uid(), ...s }));
  p.seasons = [
    { id: uid(), code: '113', year: 2024, start: '2024-07-15', color: SEASON_COLORS[0], note: '第一次發掘' },
    { id: uid(), code: '114', year: 2025, start: '2025-07-20', color: SEASON_COLORS[1], note: '第二次發掘' },
  ];
  const [s1, s2] = p.seasons;
  const defs = [
    [s1, 'P1', 2, 3, 9], [s1, 'P2', 3, 3, 8], [s1, 'P3', 7, 5, 10],
    [s2, 'P4', 2, 4, 10], [s2, 'P5', 8, 0, 7], [s2, 'P6', 9, 0, 8], [s2, 'P7', null, null, 11],
  ];
  const sterile = p.strata[4].id;
  for (const [season, code, gx, gy, nLv] of defs) {
    let corners;
    if (gx === null) { // 不在網格上的探坑（例如另一個區域、地形限制）
      const a = 12 * Math.PI / 180, oE = p.datum.E + 17, oN = p.datum.N + 12;
      corners = [[0, 0], [2, 0], [2, 2], [0, 2]].map(([x, y]) => ({ E: oE + x * Math.cos(a) + y * Math.sin(a), N: oN - x * Math.sin(a) + y * Math.cos(a) }));
    } else corners = gridCellCorners(p, gx, gy);
    corners = corners.map(c => ({ E: +(c.E + r.range(-0.012, 0.012)).toFixed(3), N: +(c.N + r.range(-0.012, 0.012)).toFixed(3) }));
    const XY = corners.map(c => ({ X: c.E - p.datum.E, Y: c.N - p.datum.N }));
    const pt = {
      id: uid(), season: season.id, code, gx, gy, w: 2000, d: 2000, corners,
      top: XY.map(q => Math.round(surf(q.X, q.Y) + r.range(-8, 8))),
      levels: [], strata: [], finds: [], features: [], photos: [],
      notes: gx === null ? '受地形限制未對齊網格，四角另以 RTK 實測。' : '',
    };
    // 自然層界線
    const D = XY.map(q => depths(q.X, q.Y));
    pt.strata = p.strata.map((st, k) => ({ stratum: st.id, bot: pt.top.map((t, i) => Math.round(t - D[i][k])) }));
    // 人工層：每 10 cm，與地表平行
    const day0 = new Date(season.start + 'T12:00:00');
    for (let k = 0; k < nLv; k++) {
      const bot = pt.top.map(t => Math.round(t - (k + 1) * p.spit + r.range(-6, 6)));
      const mid = { x: 1000, y: 1000 };
      const zMid = bil(pt.top, .5, .5) - (k + .5) * p.spit;
      const nat = layerAt(layersOf(p, { ...pt, levels: [{ bot: pt.top.map(t => t - 5000) }] }, 'natural'), pt, mid.x, mid.y, zMid);
      const st = nat?.ref || p.strata[0];
      const date = new Date(day0.getTime() + Math.floor(k * 5 / nLv) * 864e5).toISOString().slice(0, 10);
      pt.levels.push({
        id: uid(), no: k, bot, date, recorder: r.pick(PEOPLE), stratum: st.id,
        munsell: st.munsell, colorName: munsellName(st.munsell), texture: st.texture, compact: st.compact, incl: st.incl,
        photos: k % 5 === 0 || k === nLv - 1 ? `${p.code}${season.code}-${code}-L${k}-01～04` : '', notes: '',
      });
    }
    // 遺物
    const nat = layersOf(p, pt, 'natural');
    const want = r.int(18, 30);
    let n = 0;
    for (let tries = 0; n < want && tries < 400; tries++) {
      const x = Math.round(r.range(60, 1940)), y = Math.round(r.range(60, 1940));
      const u = x / 2000, v = y / 2000;
      const zt = bil(pt.top, u, v), zb = bil(pt.levels[pt.levels.length - 1].bot, u, v);
      const z = Math.round(r.range(zb + 10, zt - 10));
      const L = layerAt(nat, pt, x, y, z);
      if (!L || L.key === sterile) continue;
      const w = FIND_W[p.strata.findIndex(s => s.id === L.key)];
      if (!Object.keys(w).length || (L.ref.short === '砂' && r() < .7)) continue;
      const type = r.weighted(w);
      n++;
      const no = `${code}-${String(n).padStart(3, '0')}`;
      const lvIdx = pt.levels.findIndex((lv, i) => z <= bil(i ? pt.levels[i - 1].bot : pt.top, u, v) && z >= bil(lv.bot, u, v));
      const f = {
        id: uid(), no, type, x, y, z, stratum: L.key,
        count: type === 'shell' ? r.int(1, 12) : type === 'pottery' ? r.int(1, 4) : 1,
        desc: r.pick(DESC[type] || DESC.other), date: pt.levels[Math.max(0, lvIdx)]?.date || season.start,
        key: false, drawing: null, notes: '',
      };
      if (['pottery', 'stone', 'bone', 'porcelain'].includes(type) && r() < .22) {
        f.key = true;
        f.drawing = await putImage(sketch(r, type, `${p.code}-${season.code}/${no}`));
      }
      pt.finds.push(f);
    }
    p.pits.push(pt);
  }
  // 遺構
  const byCode = c => p.pits.find(x => x.code === c);
  const cut = (pt, x, y, k) => Math.round(bil(pt.strata[k].bot, x / 2000, y / 2000));
  const floor = (pt, x, y, z) => Math.max(z, Math.round(bil(pt.levels[pt.levels.length - 1].bot, x / 2000, y / 2000)) + 15); // 遺構底不低於坑底
  { const pt = byCode('P2'), t = cut(pt, 1450, 650, 2); pt.features.push({ id: uid(), type: '柱洞', shape: 'circle', x: 1450, y: 650, r: 140, w: 0, h: 0, top: t, bot: floor(pt, 1450, 650, t - 420), notes: '自文化層 II 頂面下挖，填土含炭屑。' }); }
  { const pt = byCode('P4'), t = cut(pt, 520, 1320, 2); pt.features.push({ id: uid(), type: '柱洞', shape: 'circle', x: 520, y: 1320, r: 120, w: 0, h: 0, top: t, bot: floor(pt, 520, 1320, t - 380), notes: '與 P2 柱洞可能同屬一組建築。' }); }
  { const pt = byCode('P6'), t = cut(pt, 700, 900, 0); pt.features.push({ id: uid(), type: '灰坑', shape: 'rect', x: 700, y: 900, r: 0, w: 900, h: 700, top: t, bot: floor(pt, 700, 900, t - 360), notes: '打破文化層 I，填土灰黑、含大量貝殼。' }); }
  return p;
}
