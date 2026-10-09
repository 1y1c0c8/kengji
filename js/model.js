// 資料模型與坑位幾何
// 單位約定：
//  - 世界座標 E/N：公尺（TWD97 TM2），存在 pit.corners
//  - 高程 z：整數毫米，「相對遺址基準點 BM」（BM＝0；往上為正）。海拔＝ datum.H + z/1000
//  - 坑內局部座標 x/y：毫米；x＝距西壁、y＝距南壁（四角順序：西南、東南、東北、西北）
import { uid, clamp, lerp, munsellRGB } from './util.js?v=0.1.0';

export const CORNER_NAMES = ['西南', '東南', '東北', '西北'];
// 剖面：站在坑內面向該壁時，左手邊 → 右手邊的兩個角
export const WALLS = {
  N: { name: '北壁', l: 3, r: 2 },
  E: { name: '東壁', l: 2, r: 1 },
  S: { name: '南壁', l: 1, r: 0 },
  W: { name: '西壁', l: 0, r: 3 },
};

export const DEFAULT_TYPES = [
  { id: 'pottery', name: '陶片', color: '#d2691e', cat: '文化遺物' },
  { id: 'porcelain', name: '瓷片', color: '#2f6fd0', cat: '文化遺物' },
  { id: 'stone', name: '石器', color: '#6e6e6e', cat: '文化遺物' },
  { id: 'bone', name: '骨角器', color: '#c9a227', cat: '文化遺物' },
  { id: 'metal', name: '金屬器', color: '#2a9d8f', cat: '文化遺物' },
  { id: 'shell', name: '貝類', color: '#d65f9b', cat: '生態遺物' },
  { id: 'fauna', name: '動物骨骼', color: '#a0522d', cat: '生態遺物' },
  { id: 'sample', name: '炭／土樣', color: '#222222', cat: '樣本' },
  { id: 'other', name: '其他', color: '#8e6cc0', cat: '其他' },
];
export const SEASON_COLORS = ['#2f7d76', '#c4572a', '#5b6bd0', '#b08a1e', '#a0479a', '#3b8f3b'];
export const FEATURE_TYPES = ['柱洞', '灰坑', '墓葬', '灶址', '石牆', '溝', '其他'];

export function newProject(name = '新遺址') {
  const s = { id: uid(), code: String(new Date().getFullYear() - 1911), year: new Date().getFullYear(), color: SEASON_COLORS[0] };
  return {
    id: uid(), name, code: 'XX', created: Date.now(), updated: Date.now(),
    datum: { name: 'BM1', E: 250000, N: 2650000, H: 10 },
    grid: { E0: 250000, N0: 2650000, size: 2000, rot: 0 },
    layerMode: 'arbitrary', spit: 100,
    seasons: [s], strata: [], types: DEFAULT_TYPES.map(t => ({ ...t })), pits: [],
    notes: '',
  };
}
export function newPit(proj, seasonId, gx = 0, gy = 0) {
  const g = proj.grid, w = g.size, d = g.size;
  const c = gridCellCorners(proj, gx, gy);
  return {
    id: uid(), season: seasonId, code: 'P' + (proj.pits.length + 1), gx, gy, w, d,
    corners: c.map(q => ({ E: q.E, N: q.N })), top: [0, 0, 0, 0],
    levels: [], strata: [], finds: [], features: [], photos: [], notes: '',
  };
}

// 網格格子 (gx, gy) 的四角世界座標（西南、東南、東北、西北）
export function gridCellCorners(proj, gx, gy) {
  const g = proj.grid, s = g.size / 1000, r = (g.rot || 0) * Math.PI / 180;
  const pt = (i, j) => {
    const x = (gx + i) * s, y = (gy + j) * s; // 網格座標（東、北）
    return { E: g.E0 + x * Math.cos(r) + y * Math.sin(r), N: g.N0 - x * Math.sin(r) + y * Math.cos(r) };
  };
  return [pt(0, 0), pt(1, 0), pt(1, 1), pt(0, 1)];
}

// ---------- 雙線性內插 ----------
export const bil = (a, u, v) => a[0] * (1 - u) * (1 - v) + a[1] * u * (1 - v) + a[2] * u * v + a[3] * (1 - u) * v;
export const uvOf = (p, x, y) => ({ u: x / p.w, v: y / p.d });
export const cornerLocal = p => [{ x: 0, y: 0 }, { x: p.w, y: 0 }, { x: p.w, y: p.d }, { x: 0, y: p.d }];
export function worldOf(p, x, y) {
  const u = x / p.w, v = y / p.d;
  return { E: bil(p.corners.map(c => c.E), u, v), N: bil(p.corners.map(c => c.N), u, v) };
}
export const topAt = (p, x, y) => bil(p.top, x / p.w, y / p.d);
export const bottomCorners = p => (p.levels.length ? p.levels[p.levels.length - 1].bot : p.top);
export const bottomAt = (p, x, y) => bil(bottomCorners(p), x / p.w, y / p.d);
export const pitCenter = p => worldOf(p, p.w / 2, p.d / 2);

// 坑的實際邊長與角度（檢查是否真的 2×2、有沒有歪）
export function pitQA(p) {
  const c = p.corners, d = (a, b) => Math.hypot(c[a].E - c[b].E, c[a].N - c[b].N) * 1000;
  const sides = [d(0, 1), d(1, 2), d(2, 3), d(3, 0)];
  const diag = [d(0, 2), d(1, 3)];
  const az = Math.atan2(c[1].E - c[0].E, c[1].N - c[0].N) * 180 / Math.PI - 90; // 南壁相對正東的偏轉
  return { sides, diag, rot: az, area: (sides[0] + sides[2]) / 2 * (sides[1] + sides[3]) / 2 / 1e6 };
}

// ---------- 層位 ----------
// 回傳由上而下的層 [{ key, kind, idx, name, short, color, top[4], bot[4], ref }]
export function layersOf(proj, p, mode = proj.layerMode) {
  const out = [];
  const pb = bottomCorners(p);
  if (mode === 'arbitrary') {
    let top = p.top;
    p.levels.forEach((lv, i) => {
      const st = proj.strata.find(s => s.id === lv.stratum);
      out.push({
        key: lv.id, kind: 'level', idx: i, name: `L${lv.no}`, short: `L${lv.no}`,
        color: munsellRGB(lv.munsell) || st?.color || munsellRGB(st?.munsell) || '#9b8670',
        top, bot: lv.bot, ref: lv,
      });
      top = lv.bot;
    });
  } else {
    // 自然層界線可能低於坑底（還沒挖到）→ 截在坑底；也不能高於上一層的底
    let top = p.top.slice();
    for (const sb of p.strata) {
      const st = proj.strata.find(s => s.id === sb.stratum);
      if (!st) continue;
      const bot = sb.bot.map((z, i) => clamp(z, pb[i], top[i]));
      if (top.some((z, i) => z - bot[i] > 1)) {
        out.push({ key: st.id, kind: 'stratum', idx: out.length, name: st.name, short: st.short || st.name, color: munsellRGB(st.munsell) || '#9b8670', top, bot, ref: st, sb });
      }
      top = bot;
      if (top.every((z, i) => z <= pb[i] + 1)) break;
    }
  }
  return out;
}
// 某一點的高程落在哪一層
export function layerAt(layers, p, x, y, z) {
  const u = clamp(x / p.w, 0, 1), v = clamp(y / p.d, 0, 1);
  for (const L of layers) if (z <= bil(L.top, u, v) + 0.5 && z >= bil(L.bot, u, v) - 0.5) return L;
  return null;
}
// 遺物的層位：人工層一律依深度；自然層以記錄者指定為準（指定的與深度不符時標示）
export function findLayer(proj, p, f, mode = proj.layerMode) {
  const layers = layersOf(proj, p, mode);
  const byDepth = layerAt(layers, p, f.x, f.y, f.z);
  if (mode === 'natural' && f.stratum) {
    const L = layers.find(l => l.key === f.stratum) || null;
    return { layer: L || byDepth, mismatch: !!(L && byDepth && L !== byDepth) || (!L && !!f.stratum) };
  }
  return { layer: byDepth, mismatch: false };
}

// ---------- 高程顯示與輸入 ----------
// 顯示：abs 海拔（m）、rel 相對基準點（cm）、depth 距坑口深度（cm）
export function fmtZ(proj, z, mode, ctx) {
  if (!Number.isFinite(z)) return '—';
  if (mode === 'abs') return (proj.datum.H + z / 1000).toFixed(3) + ' m';
  if (mode === 'depth' && ctx?.pit) {
    const d = topAt(ctx.pit, ctx.x ?? ctx.pit.w / 2, ctx.y ?? ctx.pit.d / 2) - z;
    return '深 ' + (d / 10).toFixed(1) + ' cm';
  }
  return (z >= 0 ? '+' : '') + (z / 10).toFixed(1) + ' cm';
}
export const Z_DISP = { abs: '海拔', rel: '相對 BM', depth: '距坑口' };
export const Z_IN = { abs: '海拔（m）', rel: '相對 BM（cm）', level: '水準儀前視（cm）', depth: '距坑口深（cm）' };
// 把輸入框的值轉成 z（mm）；level：z = 後視 − 前視；depth 需要坑與位置
export function parseZ(proj, str, mode, ctx = {}) {
  const n = parseFloat(String(str ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return NaN;
  if (mode === 'abs') return Math.round((n - proj.datum.H) * 1000);
  if (mode === 'level') return Math.round(((ctx.bs ?? 0) - n) * 10);
  if (mode === 'depth' && ctx.pit) return Math.round(topAt(ctx.pit, ctx.x ?? ctx.pit.w / 2, ctx.y ?? ctx.pit.d / 2) - n * 10);
  return Math.round(n * 10);
}
export function zToInput(proj, z, mode, ctx = {}) {
  if (!Number.isFinite(z)) return '';
  if (mode === 'abs') return (proj.datum.H + z / 1000).toFixed(3);
  if (mode === 'level') return ((ctx.bs ?? 0) - z / 10).toFixed(1);
  if (mode === 'depth' && ctx.pit) return ((topAt(ctx.pit, ctx.x ?? ctx.pit.w / 2, ctx.y ?? ctx.pit.d / 2) - z) / 10).toFixed(1);
  return (z / 10).toFixed(1);
}

// ---------- 名稱 ----------
export const seasonOf = (proj, p) => proj.seasons.find(s => s.id === p.season);
export const typeOf = (proj, id) => proj.types.find(t => t.id === id) || proj.types.find(t => t.id === 'other') || { name: id, color: '#888' };
export const pitLabel = (proj, p) => `${proj.code}-${seasonOf(proj, p)?.code ?? '?'}/${p.code}`;

// 修補舊資料或匯入資料缺的欄位
export function sanitize(proj) {
  proj.seasons ||= []; proj.strata ||= []; proj.pits ||= [];
  proj.types ||= DEFAULT_TYPES.map(t => ({ ...t }));
  proj.layerMode ||= 'arbitrary'; proj.spit ||= 100;
  proj.grid ||= { E0: proj.datum?.E ?? 0, N0: proj.datum?.N ?? 0, size: 2000, rot: 0 };
  for (const p of proj.pits) {
    p.levels ||= []; p.strata ||= []; p.finds ||= []; p.features ||= []; p.photos ||= [];
    p.w ||= 2000; p.d ||= 2000; p.top ||= [0, 0, 0, 0];
  }
  return proj;
}

export { lerp };
