// 共用小工具：id、字串、向量、亂數、座標轉換（TWD97 TM2）、Munsell 土色 → 螢幕顏色
export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const numOr = (v, fb = NaN) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : fb; };
export const fix = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');

export const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y,
  len: a => Math.hypot(a.x, a.y),
  lerp: (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }),
};

export function pointInPoly(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
export function segDist(p, a, b) {
  const ab = V.sub(b, a);
  const t = clamp(V.dot(V.sub(p, a), ab) / (V.dot(ab, ab) || 1), 0, 1);
  return V.len(V.sub(p, V.lerp(a, b, t)));
}

// 可重現的亂數（示範資料用）
export function rng(seed) {
  let a = seed >>> 0;
  const f = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  f.range = (a, b) => a + (b - a) * f();
  f.int = (a, b) => Math.floor(a + (b - a + 1) * f());
  f.pick = arr => arr[Math.floor(f() * arr.length)];
  f.weighted = obj => { const e = Object.entries(obj); let s = e.reduce((t, [, w]) => t + w, 0) * f(); for (const [k, w] of e) if ((s -= w) <= 0) return k; return e[0][0]; };
  return f;
}

// ---------- TWD97 / TM2（EPSG:3826，中央經線 121°）----------
// 橫麥卡托級數公式（GRS80 橢球）。TWD97 與 WGS84 相差在公尺以下，展示與 QGIS 對位足夠。
const A = 6378137, F = 1 / 298.257222101, K0 = 0.9999, LON0 = 121 * Math.PI / 180, FE = 250000;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const M1 = 1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256;
const M2 = 3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024;
const M3 = 15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024;
const M4 = 35 * E2 ** 3 / 3072;
const meridian = p => A * (M1 * p - M2 * Math.sin(2 * p) + M3 * Math.sin(4 * p) - M4 * Math.sin(6 * p));

export function ll2tm(lat, lng) {
  const p = lat * Math.PI / 180, l = lng * Math.PI / 180;
  const s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
  const N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, Aa = (l - LON0) * c;
  const E = FE + K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120);
  const Nn = K0 * (meridian(p) + N * t * (Aa ** 2 / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
  return { E, N: Nn };
}
export function tm2ll(E, Nn) {
  const mu = Nn / K0 / (A * M1);
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const C1 = EP2 * c * c, T1 = t * t, N1 = A / Math.sqrt(1 - E2 * s * s), R1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5;
  const D = (E - FE) / (N1 * K0);
  const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
  const lng = LON0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return { lat: lat * 180 / Math.PI, lng: lng * 180 / Math.PI };
}

// ---------- Munsell 土色 ----------
// 近似換算：明度用 ASTM D1535 多項式 → L*；色相用代表點對應 CIELAB 色相角；彩度 ×5 ≈ C*。
// 只用來在螢幕上「大致像」，不能取代現場比色卡。
const FAM = ['R', 'YR', 'Y', 'GY', 'G', 'BG', 'B', 'PB', 'P', 'RP'];
const HUE_ANG = [8, 24, 38, 55, 72, 86, 97, 110, 128, 155, 172, 188, 205, 225, 245, 268, 292, 312, 330, 348, 368]; // H = 0,5,10,…,100
export function parseMunsell(str) {
  const s = String(str || '').toUpperCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let m = s.match(/^(?:GLEY ?[12] )?N ?(\d+(?:\.\d+)?) ?\/ ?0?$/);
  if (m) return { H: 0, v: +m[1], c: 0 };
  m = s.match(/^GLEY ?[12] (\d+(?:\.\d+)?) ?\/ ?(\d+(?:\.\d+)?)(R|YR|Y|GY|G|BG|B|PB|P|RP)$/);
  if (m) return { H: FAM.indexOf(m[3]) * 10 + +m[2], v: +m[1], c: 1 };
  m = s.match(/^(\d+(?:\.\d+)?) ?(R|YR|Y|GY|G|BG|B|PB|P|RP) ?(\d+(?:\.\d+)?) ?\/ ?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const h = +m[1];
  if (h <= 0 || h > 10) return null;
  return { H: FAM.indexOf(m[2]) * 10 + h, v: +m[3], c: +m[4] };
}
export function munsellRGB(str) {
  const q = parseMunsell(str);
  if (!q) return null;
  const v = clamp(q.v, 0, 10);
  const Y = 1.1914 * v - 0.22533 * v ** 2 + 0.23352 * v ** 3 - 0.020484 * v ** 4 + 0.00081939 * v ** 5;
  const L = 116 * Math.cbrt(Y / 100) - 16;
  const H = ((q.H % 100) + 100) % 100, i = Math.floor(H / 5);
  const ang = lerp(HUE_ANG[i], HUE_ANG[i + 1], (H - i * 5) / 5) * Math.PI / 180;
  const Cs = q.c * 5.5;
  const a = Cs * Math.cos(ang), b = Cs * Math.sin(ang);
  // Lab (D65) → XYZ → sRGB
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const fi = t => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  const X = 0.95047 * fi(fx), Yy = fi(fy), Z = 1.08883 * fi(fz);
  const lin = [3.2406 * X - 1.5372 * Yy - 0.4986 * Z, -0.9689 * X + 1.8758 * Yy + 0.0415 * Z, 0.0557 * X - 0.204 * Yy + 1.057 * Z];
  const g = u => Math.round(255 * clamp(u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055, 0, 1));
  return '#' + lin.map(g).map(n => n.toString(16).padStart(2, '0')).join('');
}
// 常見土壤色相的中文描述（只給近似名稱，正式名稱以色卡為準）
export function munsellName(str) {
  const q = parseMunsell(str);
  if (!q) return '';
  const { v, c } = q;
  const dark = v <= 3 ? '暗' : v >= 6 ? '淺' : '';
  if (c <= 1) return v <= 2.5 ? '黑' : v <= 4 ? '暗灰' : v <= 6 ? '灰' : '淺灰';
  const fam = Math.floor(((q.H - 0.001) % 100) / 10);
  const base = fam === 0 ? (c >= 4 ? '紅' : '紅褐') : fam === 1 ? (c >= 6 ? '橙褐' : '褐') : fam === 2 ? (c >= 4 ? '黃' : '黃褐') : '灰綠';
  return dark + base;
}
