// 匯出：GeoJSON（QGIS）、遺物清冊 CSV、層位紀錄 CSV、archeoViz CSV
import { tm2ll } from './util.js?v=0.1.0';
import { worldOf, layersOf, findLayer, typeOf, seasonOf, pitLabel, bil, pitQA, bottomCorners } from './model.js?v=0.1.0';

const H = (p, z) => +(p.datum.H + z / 1000).toFixed(3);

// crs: 'tm2'（EPSG:3826，附舊式 crs 宣告，QGIS 讀得懂）或 'wgs84'（RFC 7946 標準）
export function geojson(p, crs = 'tm2') {
  const xy = (E, N) => (crs === 'tm2' ? [+E.toFixed(3), +N.toFixed(3)] : (q => [+q.lng.toFixed(8), +q.lat.toFixed(8)])(tm2ll(E, N)));
  const feats = [];
  for (const pt of p.pits) {
    const se = seasonOf(p, pt), qa = pitQA(pt), bc = bottomCorners(pt);
    feats.push({
      type: 'Feature',
      properties: {
        layer: 'pit', id: pitLabel(p, pt), season: se?.code, pit: pt.code,
        top_H: H(p, bil(pt.top, .5, .5)), bottom_H: H(p, bil(bc, .5, .5)), levels: pt.levels.length,
        finds: pt.finds.length, area_m2: +qa.area.toFixed(3), notes: pt.notes || '',
      },
      geometry: { type: 'Polygon', coordinates: [[...pt.corners, pt.corners[0]].map(c => xy(c.E, c.N))] },
    });
    for (const f of pt.finds) {
      const w = worldOf(pt, f.x, f.y), { layer } = findLayer(p, pt, f);
      const lv = findLayer(p, pt, f, 'arbitrary').layer, nat = findLayer(p, pt, f, 'natural').layer;
      feats.push({
        type: 'Feature',
        properties: {
          layer: 'find', id: `${pitLabel(p, pt)}/${f.no}`, no: f.no, pit: pitLabel(p, pt), type: typeOf(p, f.type).name,
          category: typeOf(p, f.type).cat, count: f.count, key: !!f.key, H: H(p, f.z),
          x_cm: f.x / 10, y_cm: f.y / 10, level: lv?.name || '', stratum: nat?.name || '', desc: f.desc || '', date: f.date || '',
        },
        geometry: { type: 'Point', coordinates: [...xy(w.E, w.N), H(p, f.z)] },
      });
    }
    for (const fe of pt.features) {
      const ring = fe.shape === 'circle'
        ? Array.from({ length: 33 }, (_, i) => ({ x: fe.x + Math.cos(i / 32 * Math.PI * 2) * fe.r, y: fe.y + Math.sin(i / 32 * Math.PI * 2) * fe.r }))
        : [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => ({ x: fe.x + a * fe.w / 2, y: fe.y + b * fe.h / 2 }));
      feats.push({
        type: 'Feature',
        properties: { layer: 'feature', pit: pitLabel(p, pt), type: fe.type, top_H: H(p, fe.top), bottom_H: H(p, fe.bot), notes: fe.notes || '' },
        geometry: { type: 'Polygon', coordinates: [ring.map(q => { const w = worldOf(pt, q.x, q.y); return xy(w.E, w.N); })] },
      });
    }
  }
  feats.push({ type: 'Feature', properties: { layer: 'datum', id: p.datum.name, H: p.datum.H }, geometry: { type: 'Point', coordinates: xy(p.datum.E, p.datum.N) } });
  const out = { type: 'FeatureCollection', name: `${p.code} ${p.name}`, features: feats };
  if (crs === 'tm2') out.crs = { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3826' } };
  return JSON.stringify(out, null, 1);
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = rows => '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\n'); // BOM：Excel 開中文不亂碼

export function findsCSV(p) {
  const rows = [['季次', '坑號', '遺物編號', '類別', '大類', '數量', '特物', '距西壁(cm)', '距南壁(cm)', 'E(TWD97)', 'N(TWD97)', '海拔(m)', '相對BM(cm)', '距坑口(cm)', '人工層', '自然層', '描述', '日期', '有手繪圖']];
  for (const pt of p.pits) for (const f of pt.finds) {
    const w = worldOf(pt, f.x, f.y), t = typeOf(p, f.type);
    const lv = findLayer(p, pt, f, 'arbitrary').layer, nat = findLayer(p, pt, f, 'natural').layer;
    const depth = bil(pt.top, f.x / pt.w, f.y / pt.d) - f.z;
    rows.push([seasonOf(p, pt)?.code, pt.code, f.no, t.name, t.cat, f.count, f.key ? '是' : '', f.x / 10, f.y / 10, w.E.toFixed(3), w.N.toFixed(3), H(p, f.z), (f.z / 10).toFixed(1), (depth / 10).toFixed(1), lv?.name || '', nat?.name || '', f.desc, f.date, f.drawing ? '是' : '']);
  }
  return csv(rows);
}

export function levelsCSV(p) {
  const rows = [['季次', '坑號', '層號', '日期', '記錄者', '底部高程 西南(m)', '東南', '東北', '西北', '自然層', 'Munsell', '土色', '土質', '緊實度', '包含物', '照片編號', '備註']];
  for (const pt of p.pits) for (const lv of pt.levels) {
    rows.push([seasonOf(p, pt)?.code, pt.code, `L${lv.no}`, lv.date, lv.recorder, ...lv.bot.map(z => H(p, z)), p.strata.find(s => s.id === lv.stratum)?.name || '', lv.munsell, lv.colorName, lv.texture, lv.compact, lv.incl, lv.photos, lv.notes]);
  }
  return csv(rows);
}

// archeoViz（Plutniak 2023）的物件表格式：座標以網格原點為 0、單位 cm；深度為正，以全遺址最高的坑口為 0
export function archeoVizCSV(p) {
  const z0 = Math.max(0, ...p.pits.flatMap(pt => pt.top));
  const rows = [['id', 'xmin', 'ymin', 'zmin', 'layer', 'object_type', 'square_x', 'square_y', 'year', 'object_pit', 'object_count', 'object_desc']];
  const r = (p.grid.rot || 0) * Math.PI / 180;
  for (const pt of p.pits) for (const f of pt.finds) {
    const w = worldOf(pt, f.x, f.y), dE = w.E - p.grid.E0, dN = w.N - p.grid.N0;
    const gx = dE * Math.cos(r) - dN * Math.sin(r), gy = dE * Math.sin(r) + dN * Math.cos(r);
    const { layer } = findLayer(p, pt, f);
    rows.push([`${pitLabel(p, pt)}/${f.no}`, (gx * 100).toFixed(1), (gy * 100).toFixed(1), ((z0 - f.z) / 10).toFixed(1), layer?.name || '?', typeOf(p, f.type).name,
      Math.floor(gx / (p.grid.size / 1000)), Math.floor(gy / (p.grid.size / 1000)), seasonOf(p, pt)?.year || '', pitLabel(p, pt), f.count, f.desc]);
  }
  return csv(rows);
}

export function download(name, text, type = 'text/plain') {
  const blob = text instanceof Blob ? text : new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
