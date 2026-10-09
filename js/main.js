// 介面：頂列、側欄（依視圖切換內容）、浮動工具列、檢視卡、表單
import {
  S, P, pit, selObj, on, emit, checkpoint, changed, undo, redo, canUndo, canRedo, loadAll, addProject, openProject,
  deleteProject, putImage, imgURL, exportBackup, importBackup, saveSettings, flushSaves,
} from './state.js?v=0.1.0';
import { esc, uid, clamp, numOr, ll2tm, tm2ll, munsellRGB, munsellName } from './util.js?v=0.1.0';
import {
  newProject, newPit, gridCellCorners, layersOf, layerAt, findLayer, fmtZ, parseZ, zToInput, Z_DISP, Z_IN, CORNER_NAMES,
  WALLS, seasonOf, typeOf, pitLabel, pitQA, bil, topAt, bottomCorners, cornerLocal, SEASON_COLORS, FEATURE_TYPES, DEFAULT_TYPES,
} from './model.js?v=0.1.0';
import { Plan2D, measurePits } from './plan2d.js?v=0.1.0';
import { buildDemo } from './demo.js?v=0.1.0';
import { geojson, findsCSV, levelsCSV, archeoVizCSV, download } from './export.js?v=0.1.0';

const APP_VERSION = '0.1.0';
const $ = s => document.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const isMobile = () => matchMedia('(max-width: 760px)').matches;
let plan, v3d = null;

// ---------- 小元件 ----------
let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
function modal(title, html, { wide } = {}) {
  const m = $('#modal');
  m.innerHTML = `<div class="mbox ${wide ? 'wide' : ''}"><div class="mhead"><b>${esc(title)}</b><button class="ghost x" data-close>✕</button></div><div class="mbody">${html}</div></div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  m.querySelector('[data-close]').onclick = close;
  m.onclick = e => { if (e.target === m) close(); };
  return { el: m.querySelector('.mbody'), close };
}
const swatch = c => `<span class="sw" style="background:${esc(c)}"></span>`;
const zd = (z, ctx) => fmtZ(P(), z, S.settings.zDisp, ctx);
const cmv = mm => (mm / 10).toFixed(1);
function askFile(accept, multiple = false) {
  return new Promise(res => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = accept; i.multiple = multiple;
    i.onchange = () => res(multiple ? [...i.files] : i.files[0]);
    i.click();
  });
}
const dateTag = d => String(d || '').replace(/-/g, '');
const today = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); // 本地日期

// ---------- 高程輸入（一組欄位共用一個輸入方式） ----------
// html：zModeBar(...) ＋ 多個 <input data-z="key">；之後 bindZ(root, ctxOf) 讀寫
function zModeBar(allowDepth) {
  const modes = Object.entries(Z_IN).filter(([k]) => allowDepth || k !== 'depth');
  const cur = S.settings.zIn === 'depth' && !allowDepth ? 'rel' : S.settings.zIn;
  return `<div class="zbar"><span class="mute small">高程輸入</span><div class="seg small" data-zmode>${modes.map(([k, v]) => `<button type="button" data-m="${k}" class="${k === cur ? 'on' : ''}">${v}</button>`).join('')}</div>
    <label class="bs" ${cur === 'level' ? '' : 'hidden'}>後視（看 BM）<input data-bs type="number" step="0.1" value="${S.settings.bs}"> cm</label></div>`;
}
function bindZ(root, values, ctxOf = () => ({})) {
  const p = P();
  let mode = root.querySelector('[data-zmode] .on')?.dataset.m || 'rel';
  const bsIn = root.querySelector('[data-bs]');
  const ctx = k => ({ ...ctxOf(k), bs: numOr(bsIn?.value, S.settings.bs) });
  const fill = () => { for (const i of $$('[data-z]', root)) i.value = zToInput(p, values[i.dataset.z], mode, ctx(i.dataset.z)); };
  const read = () => { for (const i of $$('[data-z]', root)) { const z = parseZ(p, i.value, mode, ctx(i.dataset.z)); if (Number.isFinite(z)) values[i.dataset.z] = z; } return values; };
  fill();
  for (const b of $$('[data-zmode] button', root)) b.onclick = () => {
    read();
    mode = b.dataset.m; S.settings.zIn = mode; saveSettings();
    $$('[data-zmode] button', root).forEach(x => x.classList.toggle('on', x === b));
    root.querySelector('.bs').hidden = mode !== 'level';
    fill();
  };
  if (bsIn) bsIn.onchange = () => { S.settings.bs = numOr(bsIn.value, 150); saveSettings(); };
  for (const i of $$('[data-z]', root)) i.placeholder = { abs: 'm', rel: 'cm', level: '前視 cm', depth: 'cm' }[mode];
  return { read };
}

// ---------- 版面 ----------
function setView(v) {
  if (v === 'pit' && !pit()) {
    const p = P(), cand = (S.sel?.kind === 'pit' && S.sel.id) || p?.pits.find(x => !S.settings.hideSeasons.includes(x.season))?.id;
    if (!cand) return toast('還沒有探坑，先在「遺址」新增一個');
    S.pitId = cand;
  }
  S.view = v;
  if (v !== 'pit') S.wall = null;
  if (v === 'site' && S.sel && S.sel.kind !== 'pit') S.sel = null;
  if (plan) plan.tool = 'select';
  emit('view');
}
function openPit(id) {
  S.pitId = id; S.wall = null; S.level = -1; S.view = 'pit';
  S.sel = null;
  plan.tool = 'select';
  emit('view');
}
function openProfile(w) { S.wall = w; S.view = 'pit'; plan.tool = 'select'; emit('view'); }

function renderAll() {
  const p = P();
  $('#projName').textContent = p ? p.name : '—';
  $$('#viewSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === S.view));
  $('#zDisp').value = S.settings.zDisp;
  const is3d = S.view === '3d';
  $('#c2d').hidden = is3d; $('#v3d').hidden = !is3d;
  if (is3d) ensure3D().then(v => v.show(true)); else { v3d?.show(false); plan.resize(); }
  renderTools(); renderPanel(); renderInspector(); renderHint();
  plan.draw();
}

async function ensure3D() {
  if (v3d) return v3d;
  $('#v3d').innerHTML = '<div class="loading">載入 3D…</div>';
  const { View3D } = await import('./view3d.js?v=0.1.0');
  $('#v3d').innerHTML = '';
  v3d = new View3D($('#v3d'), ui);
  return v3d;
}

// ---------- 浮動工具列 ----------
function renderTools() {
  const t = $('#tools'), p = P();
  if (!p) { t.innerHTML = ''; return; }
  if (S.view === 'site') {
    t.innerHTML = `<div class="seg"><button data-tool="select" class="${plan.tool === 'select' ? 'on' : ''}">選取</button><button data-tool="measure" class="${plan.tool === 'measure' ? 'on' : ''}">量距離</button></div>
      <button data-fit>全覽</button>`;
  } else if (S.view === 'pit' && !S.wall) {
    const layers = layersOf(p, pit());
    t.innerHTML = `<button class="ghostcard" data-back>‹ 遺址</button>
      <div class="seg"><button data-tool="select" class="${plan.tool === 'select' ? 'on' : ''}">選取</button><button data-tool="add" class="${plan.tool === 'add' ? 'on' : ''}">＋遺物</button></div>
      <span class="lvstep"><button data-lv="-1" title="上一層">▲</button><select data-lvsel><option value="-1">全部層</option>${layers.map((L, i) => `<option value="${i}" ${i === S.level ? 'selected' : ''}>${esc(L.name)}</option>`).join('')}</select><button data-lv="1" title="下一層">▼</button></span>
      <button data-fit>全覽</button>`;
  } else if (S.view === 'pit') {
    t.innerHTML = `<button class="primary" data-plan>‹ 坑位平面</button>
      <div class="seg">${['N', 'E', 'S', 'W'].map(k => `<button data-wall="${k}" class="${S.wall === k ? 'on' : ''}">${WALLS[k].name}</button>`).join('')}</div>
      <button data-fit>全覽</button>`;
  } else {
    t.innerHTML = `<button data-frame>重設視角</button>`;
  }
  t.onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.tool) { plan.tool = b.dataset.tool; plan.meas = []; renderTools(); renderHint(); renderInspector(); plan.draw(); }
    if (b.dataset.fit !== undefined) plan.fit();
    if (b.dataset.back !== undefined) setView('site');
    if (b.dataset.plan !== undefined) { S.wall = null; emit('view'); }
    if (b.dataset.wall) openProfile(b.dataset.wall);
    if (b.dataset.lv) stepLevel(+b.dataset.lv);
    if (b.dataset.frame !== undefined) v3d?.frame();
  };
  const sel = t.querySelector('[data-lvsel]');
  if (sel) sel.onchange = () => { S.level = +sel.value; emit('level'); };
}
function stepLevel(d) {
  const n = layersOf(P(), pit()).length;
  S.level = clamp(S.level + d, -1, n - 1);
  emit('level');
}

function renderHint() {
  const h = $('#hint'), coarse = matchMedia('(pointer: coarse)').matches;
  let t = '';
  if (S.view === 'site') t = plan.tool === 'measure' ? '依序點兩個坑：中心距離、最近邊距、高差' : (coarse ? '點坑看摘要・雙指縮放' : '點坑看摘要・雙擊開啟坑位・觸控板／滾輪縮放、拖曳平移');
  else if (S.view === 'pit' && !S.wall) t = plan.tool === 'add' ? '在坑內點一下放遺物，之後可輸入精確距離與高程' : '▲▼ 切換層位・點遺物看詳細・拖曳已選的遺物可移動・點「剖面」看坑壁';
  else if (S.view === 'pit') t = '站在坑內面向這面坑壁・實線＝主要層位、虛線＝另一種層位・離壁面越遠的遺物越淡';
  else t = coarse ? '單指旋轉・雙指縮放平移・點遺物看詳細' : '左鍵旋轉・右鍵平移・滾輪縮放・點遺物看詳細';
  h.textContent = t;
  h.hidden = !t || !!S.sel && isMobile();
}

// ---------- 側欄 ----------
function typeToggles(p) {
  return `<div class="chips">${p.types.map(t => `<button class="chip ${S.settings.hideTypes.includes(t.id) ? 'off' : ''}" data-type="${t.id}">${swatch(t.color)}${esc(t.name)}</button>`).join('')}</div>`;
}
function seasonToggles(p) {
  return `<div class="chips">${p.seasons.map(s => `<button class="chip ${S.settings.hideSeasons.includes(s.id) ? 'off' : ''}" data-season="${s.id}">${swatch(s.color)}${esc(p.code)}-${esc(s.code)}<small>${s.year || ''}</small></button>`).join('')}</div>`;
}
function bindToggles(el) {
  for (const b of $$('[data-type]', el)) b.onclick = () => { toggleIn(S.settings.hideTypes, b.dataset.type); saveSettings(); emit('filter'); };
  for (const b of $$('[data-season]', el)) b.onclick = () => { toggleIn(S.settings.hideSeasons, b.dataset.season); saveSettings(); emit('filter'); };
}
const toggleIn = (arr, v) => { const i = arr.indexOf(v); i >= 0 ? arr.splice(i, 1) : arr.push(v); };

function renderPanel() {
  const el = $('#panel'), p = P();
  if (!p) { el.innerHTML = `<div class="empty">還沒有遺址<br><br><button class="primary" id="mkFirst">建立示範遺址</button></div>`; $('#mkFirst').onclick = makeDemo; return; }
  const keep = el.scrollTop;
  if (S.view === 'site') sitePanel(el, p);
  else if (S.view === 'pit') pitPanel(el, p, pit());
  else panel3d(el, p);
  bindToggles(el);
  el.scrollTop = keep;
}

function sitePanel(el, p) {
  const d = p.datum, ll = tm2ll(d.E, d.N);
  el.innerHTML = `
    <section class="sec">
      <div class="sechead"><b>${esc(p.name)}</b><button class="x" data-edit-proj>設定</button></div>
      <div class="kv"><span>代號</span><b>${esc(p.code)}</b><span>層位</span><b>${p.layerMode === 'arbitrary' ? `人工層（每 ${cmv(p.spit)} cm）` : '自然層'}</b>
      <span>基準點</span><b>${esc(d.name)}・海拔 ${d.H.toFixed(3)} m</b><span>TWD97</span><b class="mono">${d.E.toFixed(3)}, ${d.N.toFixed(3)}</b>
      <span>經緯度</span><b class="mono">${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}</b></div>
      ${p.notes ? `<p class="tip">${esc(p.notes)}</p>` : ''}
    </section>
    <section class="sec"><div class="sechead"><b>季次</b><span class="mute small">點一下隱藏／顯示</span></div>${seasonToggles(p)}</section>
    <section class="sec">
      <div class="sechead"><b>探坑</b><button class="x" data-add-pit>＋ 新增</button></div>
      ${p.seasons.map(s => {
        const list = p.pits.filter(x => x.season === s.id);
        if (!list.length) return '';
        return `<div class="grp">${swatch(s.color)} ${esc(p.code)}-${esc(s.code)}</div>` + list.map(pt => `
          <div class="row2 ${S.sel?.id === pt.id ? 'on' : ''}" data-pit="${pt.id}">
            <span class="rmain"><b>${esc(pt.code)}</b><small>${pt.levels.length} 層・${pt.finds.length} 件遺物${pt.features.length ? `・${pt.features.length} 遺構` : ''}</small></span>
            <button class="x" data-open="${pt.id}">開啟 ›</button></div>`).join('');
      }).join('')}
      ${p.pits.length ? '' : '<p class="empty">還沒有探坑</p>'}
    </section>
    <section class="sec"><div class="sechead"><b>遺物類別</b><label class="chk"><input type="checkbox" id="siteFinds" ${S.settings.siteFinds ? 'checked' : ''}>在平面圖顯示</label></div>${typeToggles(p)}</section>`;
  el.querySelector('[data-edit-proj]').onclick = editProject;
  el.querySelector('[data-add-pit]').onclick = () => editPit(null);
  el.querySelector('#siteFinds').onchange = e => { S.settings.siteFinds = e.target.checked; saveSettings(); plan.draw(); };
  for (const r of $$('[data-pit]', el)) r.onclick = e => {
    if (e.target.closest('[data-open]')) return openPit(e.target.closest('[data-open]').dataset.open);
    S.sel = { kind: 'pit', id: r.dataset.pit }; emit('selection');
  };
}

function pitPanel(el, p, pt) {
  if (!pt) { el.innerHTML = ''; return; }
  const layers = layersOf(p, pt), L = S.level >= 0 ? layers[S.level] : null;
  const se = seasonOf(p, pt);
  const finds = pt.finds.filter(f => !L || layerAt(layers, pt, f.x, f.y, f.z) === L);
  const nat = p.layerMode === 'natural';
  el.innerHTML = `
    <section class="sec">
      <div class="sechead"><select class="pitsel" data-pitsel>${p.pits.map(x => `<option value="${x.id}" ${x.id === pt.id ? 'selected' : ''}>${esc(pitLabel(p, x))}</option>`).join('')}</select><button class="x" data-edit-pit>編輯</button></div>
      <div class="kv"><span>季次</span><b>${swatch(se?.color || '#999')} ${esc(se?.code)}（${se?.year || ''}）</b>
      <span>坑口中心</span><b>${zd(topAt(pt, pt.w / 2, pt.d / 2), { pit: pt })}</b><span>目前坑底</span><b>${zd(bil(bottomCorners(pt), .5, .5), { pit: pt })}</b></div>
    </section>
    <section class="sec">
      <div class="sechead"><b>${nat ? '自然層' : '人工層'}</b><button class="x" data-add-level>${nat ? '編輯層界' : '＋ 下一層'}</button></div>
      <div class="row2 ${S.level < 0 ? 'on' : ''}" data-level="-1"><span class="rmain"><b>全部層</b><small>${layers.length} 層</small></span></div>
      ${layers.map((Ly, i) => {
        const th = bil(Ly.top, .5, .5) - bil(Ly.bot, .5, .5);
        const n = pt.finds.filter(f => layerAt(layers, pt, f.x, f.y, f.z) === Ly).length;
        const sub = Ly.kind === 'level' ? [Ly.ref.date, Ly.ref.munsell, p.strata.find(s => s.id === Ly.ref.stratum)?.short].filter(Boolean).join('・') : Ly.ref.munsell;
        return `<div class="row2 ${S.level === i ? 'on' : ''}" data-level="${i}">${swatch(Ly.color)}<span class="rmain"><b>${esc(Ly.name)}</b><small>厚 ${cmv(th)} cm・${n} 件・${esc(sub || '')}</small></span>${Ly.kind === 'level' ? `<button class="x" data-edit-level="${Ly.key}">✎</button>` : ''}</div>`;
      }).join('')}
    </section>
    <section class="sec">
      <div class="sechead"><b>遺物 ${L ? `<small class="mute">（${esc(L.name)}）</small>` : ''}</b><button class="x" data-add-find>＋ 新增</button></div>
      ${L ? `<label class="chk"><input type="checkbox" id="onlyLv" ${S.settings.onlyLevel ? 'checked' : ''}>平面圖只顯示這一層</label>` : ''}
      <div class="flist">${finds.map(f => { const t = typeOf(p, f.type); return `<div class="row2 ${S.sel?.id === f.id ? 'on' : ''}" data-find="${f.id}">${swatch(t.color)}<span class="rmain"><b>${esc(f.no)}${f.key ? ' ◆' : ''}</b><small>${esc(t.name)}・${esc(f.desc || '')}</small></span><small class="mute">${zd(f.z, { pit: pt, x: f.x, y: f.y })}</small></div>`; }).join('') || '<p class="empty">這一層沒有遺物</p>'}</div>
    </section>
    <section class="sec">
      <div class="sechead"><b>遺構</b><button class="x" data-add-feature>＋ 新增</button></div>
      ${pt.features.map(fe => `<div class="row2 ${S.sel?.id === fe.id ? 'on' : ''}" data-feature="${fe.id}"><span class="rmain"><b>${esc(fe.type)}</b><small>${fe.shape === 'circle' ? `直徑 ${cmv(fe.r * 2)} cm` : `${cmv(fe.w)}×${cmv(fe.h)} cm`}・深 ${cmv(fe.top - fe.bot)} cm</small></span></div>`).join('') || '<p class="mute small">無</p>'}
    </section>
    <section class="sec">
      <div class="sechead"><b>照片</b><button class="x" data-add-photo>＋ 上傳</button></div>
      <div class="photos">${pt.photos.map(ph => `<button class="ph" data-photo="${ph.id}"><img data-img="${ph.img}" alt=""><small>${esc(ph.card || '')}</small></button>`).join('') || '<p class="mute small">尚無照片</p>'}</div>
    </section>
    <section class="sec"><div class="sechead"><b>遺物類別</b></div>${typeToggles(p)}</section>`;
  loadImgs(el);
  el.querySelector('[data-pitsel]').onchange = e => openPit(e.target.value);
  el.querySelector('[data-edit-pit]').onclick = () => editPit(pt);
  el.querySelector('[data-add-level]').onclick = () => (nat ? editBounds(pt) : editLevel(pt, null));
  el.querySelector('[data-add-find]').onclick = () => { if (S.wall) { S.wall = null; } plan.tool = 'add'; emit('view'); toast('在坑內點一下放遺物'); };
  el.querySelector('[data-add-feature]').onclick = () => editFeature(pt, null);
  el.querySelector('[data-add-photo]').onclick = () => addPhotos(pt);
  const ol = el.querySelector('#onlyLv'); if (ol) ol.onchange = () => { S.settings.onlyLevel = ol.checked; saveSettings(); plan.draw(); };
  for (const r of $$('[data-level]', el)) r.onclick = e => {
    const ed = e.target.closest('[data-edit-level]');
    if (ed) return editLevel(pt, pt.levels.find(l => l.id === ed.dataset.editLevel));
    S.level = +r.dataset.level; emit('level');
  };
  for (const r of $$('[data-find]', el)) r.onclick = () => { S.sel = { kind: 'find', id: r.dataset.find, pitId: pt.id }; emit('selection'); };
  for (const r of $$('[data-feature]', el)) r.onclick = () => { S.sel = { kind: 'feature', id: r.dataset.feature, pitId: pt.id }; emit('selection'); };
  for (const b of $$('[data-photo]', el)) b.onclick = () => viewPhoto(pt, pt.photos.find(x => x.id === b.dataset.photo));
}

function panel3d(el, p) {
  const st = S.settings, maxPeel = Math.max(0, ...p.pits.map(pt => layersOf(p, pt).length)) - 1;
  el.innerHTML = `
    <section class="sec"><div class="sechead"><b>季次</b></div>${seasonToggles(p)}</section>
    <section class="sec"><div class="sechead"><b>遺物類別</b></div>${typeToggles(p)}</section>
    <section class="sec form">
      <div class="sechead"><b>顯示</b></div>
      <label><span>垂直誇張 <b>${(st.exag || 1).toFixed(1)}×</b></span><input type="range" min="1" max="5" step="0.5" value="${st.exag || 1}" data-set="exag"></label>
      <label><span>土層不透明度 <b>${Math.round((st.opacity ?? .8) * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value="${st.opacity ?? .8}" data-set="opacity"></label>
      <label><span>剝除上方 <b>${st.peel || 0}</b> 層（看下面的遺物）</span><input type="range" min="0" max="${maxPeel}" step="1" value="${Math.min(st.peel || 0, maxPeel)}" data-set="peel"></label>
      <label class="chk"><input type="checkbox" data-xray ${st.xray !== false ? 'checked' : ''}>透視遺物（隔著土層也看得到）</label>
      <p class="tip">土柱＝已挖掉的範圍，依${p.layerMode === 'arbitrary' ? '人工層' : '自然層'}上色（Munsell 近似色）。坑與坑之間的位置與高低都是真實比例，只有垂直方向可以誇張。</p>
    </section>`;
  for (const r of $$('[data-set]', el)) r.oninput = () => {
    st[r.dataset.set] = +r.value; saveSettings();
    r.parentElement.querySelector('b').textContent = r.dataset.set === 'exag' ? `${(+r.value).toFixed(1)}×` : r.dataset.set === 'opacity' ? `${Math.round(r.value * 100)}%` : r.value;
    v3d?.markDirty();
  };
  el.querySelector('[data-xray]').onchange = e => { st.xray = e.target.checked; saveSettings(); v3d?.markDirty(); };
}

async function loadImgs(el) {
  for (const im of $$('img[data-img]', el)) { const u = await imgURL(im.dataset.img); if (u) im.src = u; }
}

// ---------- 檢視卡 ----------
function renderInspector() {
  const box = $('#inspector'), p = P();
  const o = selObj();
  if (S.view === 'site' && plan.tool === 'measure') return measureCard(box, p);
  if (!p || !o) { box.hidden = true; renderHint(); return; }
  box.hidden = false;
  const k = S.sel.kind;
  if (k === 'pit') {
    const pt = o, qa = pitQA(pt), se = seasonOf(p, pt);
    const counts = {};
    for (const f of pt.finds) counts[f.type] = (counts[f.type] || 0) + (f.count || 1);
    const max = Math.max(1, ...Object.values(counts));
    box.innerHTML = `<div class="ihead"><b>${esc(pitLabel(p, pt))}</b><button class="ghost x" data-close>✕</button></div>
      <div class="kv"><span>季次</span><b>${swatch(se?.color || '#999')} ${esc(se?.code)}</b>
      <span>邊長</span><b>${qa.sides.map(s => cmv(s)).join(' / ')} cm</b>
      <span>對角線差</span><b>${cmv(Math.abs(qa.diag[0] - qa.diag[1]))} cm</b>
      <span>坑口</span><b>${zd(topAt(pt, pt.w / 2, pt.d / 2), { pit: pt })}</b>
      <span>坑底</span><b>${zd(bil(bottomCorners(pt), .5, .5), { pit: pt })}</b>
      <span>層數</span><b>${pt.levels.length}</b></div>
      <div class="bars">${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<div class="bar"><span>${esc(typeOf(p, t).name)}</span><i style="width:${(n / max) * 100}%;background:${typeOf(p, t).color}"></i><b>${n}</b></div>`).join('')}</div>
      <div class="btns"><button class="primary" data-open>開啟坑位</button><button data-3d>在 3D 看</button></div>`;
    box.querySelector('[data-open]').onclick = () => openPit(pt.id);
    box.querySelector('[data-3d]').onclick = () => { setView('3d'); setTimeout(() => v3d?.focus(S.sel), 60); };
  } else if (k === 'find') {
    const pt = p.pits.find(x => x.id === S.sel.pitId), f = o, t = typeOf(p, f.type);
    const ctx = { pit: pt, x: f.x, y: f.y };
    const lv = findLayer(p, pt, f, 'arbitrary').layer, nr = findLayer(p, pt, f, 'natural');
    box.innerHTML = `<div class="ihead"><b>${esc(f.no)}${f.key ? ' <span class="keyb">特物</span>' : ''}</b><button class="ghost x" data-close>✕</button></div>
      <div class="chipline">${swatch(t.color)} ${esc(t.name)} <span class="mute small">${esc(t.cat)}</span>${f.count > 1 ? `<span class="mute small">×${f.count}</span>` : ''}</div>
      ${f.desc ? `<p class="desc">${esc(f.desc)}</p>` : ''}
      <div class="kv"><span>探坑</span><b>${esc(pitLabel(p, pt))}</b>
      <span>位置</span><b>距西壁 ${cmv(f.x)}・距南壁 ${cmv(f.y)} cm</b>
      <span>海拔</span><b>${fmtZ(p, f.z, 'abs')}</b><span>相對 BM</span><b>${fmtZ(p, f.z, 'rel')}</b><span>距坑口</span><b>${fmtZ(p, f.z, 'depth', ctx)}</b>
      <span>人工層</span><b>${esc(lv?.name || '—')}</b><span>自然層</span><b>${esc(nr.layer?.name || '—')}${nr.mismatch ? ' <span class="warn">⚠ 與深度不符</span>' : ''}</b>
      ${f.date ? `<span>日期</span><b>${esc(f.date)}</b>` : ''}</div>
      ${f.drawing ? `<button class="drawing" data-zoom><img data-img="${f.drawing}" alt="手繪圖"></button>` : '<p class="mute small">無手繪圖</p>'}
      ${f.notes ? `<p class="tip">${esc(f.notes)}</p>` : ''}
      <div class="btns"><button class="primary" data-edit>編輯</button>${S.view === '3d' ? '<button data-goto>在坑位看</button>' : '<button data-3d>在 3D 看</button>'}<span class="sp"></span><button class="danger" data-del>刪除</button></div>`;
    loadImgs(box);
    box.querySelector('[data-edit]').onclick = () => editFind(pt, f);
    box.querySelector('[data-del]').onclick = () => { if (!confirm(`刪除 ${f.no}？`)) return; checkpoint(); pt.finds = pt.finds.filter(x => x !== f); S.sel = null; changed(); };
    box.querySelector('[data-3d]')?.addEventListener('click', () => { setView('3d'); setTimeout(() => v3d?.focus(S.sel), 60); });
    box.querySelector('[data-goto]')?.addEventListener('click', () => { const s = S.sel; openPit(pt.id); S.sel = s; S.level = layersOf(p, pt).indexOf(findLayer(p, pt, f).layer); emit('selection'); emit('level'); });
    box.querySelector('[data-zoom]')?.addEventListener('click', async () => { const u = await imgURL(f.drawing); modal(`${f.no} 手繪圖`, `<img class="big" src="${u}">`, { wide: true }); });
  } else {
    const pt = p.pits.find(x => x.id === S.sel.pitId), fe = o;
    box.innerHTML = `<div class="ihead"><b>${esc(fe.type)}</b><button class="ghost x" data-close>✕</button></div>
      <div class="kv"><span>探坑</span><b>${esc(pitLabel(p, pt))}</b><span>範圍</span><b>${fe.shape === 'circle' ? `圓形 直徑 ${cmv(fe.r * 2)} cm` : `方形 ${cmv(fe.w)}×${cmv(fe.h)} cm`}</b>
      <span>頂面</span><b>${zd(fe.top, { pit: pt, x: fe.x, y: fe.y })}</b><span>底面</span><b>${zd(fe.bot, { pit: pt, x: fe.x, y: fe.y })}</b></div>
      ${fe.notes ? `<p class="tip">${esc(fe.notes)}</p>` : ''}
      <div class="btns"><button class="primary" data-edit>編輯</button><span class="sp"></span><button class="danger" data-del>刪除</button></div>`;
    box.querySelector('[data-edit]').onclick = () => editFeature(pt, fe);
    box.querySelector('[data-del]').onclick = () => { if (!confirm(`刪除這個${fe.type}？`)) return; checkpoint(); pt.features = pt.features.filter(x => x !== fe); S.sel = null; changed(); };
  }
  box.querySelector('[data-close]').onclick = () => { S.sel = null; emit('selection'); };
  renderHint();
}
function measureCard(box, p) {
  const [a, b] = plan.meas.map(id => p.pits.find(x => x.id === id));
  box.hidden = false;
  if (!a || !b) {
    box.innerHTML = `<div class="ihead"><b>量距離</b></div><p class="mute">${a ? `已選 ${esc(pitLabel(p, a))}，再點另一個坑` : '點第一個坑'}</p>`;
    return;
  }
  const m = measurePits(p, a, b);
  const sgn = v => `${v >= 0 ? '高' : '低'} ${cmv(Math.abs(v))} cm`;
  box.innerHTML = `<div class="ihead"><b>${esc(a.code)} → ${esc(b.code)}</b><button class="ghost x" data-clear>✕</button></div>
    <div class="kv"><span>中心距離</span><b>${m.dist.toFixed(2)} m</b><span>最近邊距</span><b>${m.edge === 0 ? '相連' : m.edge.toFixed(2) + ' m'}</b>
    <span>方位角</span><b>${m.az.toFixed(0)}°</b>
    <span>坑口高差</span><b>${esc(b.code)} ${sgn(m.dTop)}</b><span>坑底高差</span><b>${esc(b.code)} ${sgn(m.dBot)}</b></div>
    <p class="tip">${esc(pitLabel(p, a))}・${esc(pitLabel(p, b))}（坑口、坑底取坑中心內插值）</p>`;
  box.querySelector('[data-clear]').onclick = () => { plan.meas = []; renderInspector(); plan.draw(); };
}

// ---------- 表單：遺址設定 ----------
function editProject() {
  const p = P(), d = p.datum, g = p.grid;
  const ll = tm2ll(d.E, d.N);
  const m = modal('遺址設定', `<div class="form">
    <div class="grid2"><label>遺址名稱<input data-k="name" value="${esc(p.name)}"></label><label>代號（字卡上的縮寫）<input data-k="code" value="${esc(p.code)}"></label></div>
    <div class="lbl">層位模式</div>
    <div class="seg" data-mode><button type="button" data-m="arbitrary" class="${p.layerMode === 'arbitrary' ? 'on' : ''}">人工層</button><button type="button" data-m="natural" class="${p.layerMode === 'natural' ? 'on' : ''}">自然層</button></div>
    <p class="tip">兩種資料都會保存，這裡只決定「以哪一種為主」：層位清單、平面圖底色、遺物歸層與 3D 上色。<br>・人工層：依深度切（例如每 10 cm），遺物自動依深度歸層。<br>・自然層：依土色土質分，層界可起伏；遺物以記錄者指定為準，與深度不符時會提醒。</p>
    <label>人工層厚度（cm）<input data-k="spit" type="number" step="0.5" value="${cmv(p.spit)}"></label>
    <div class="lbl">基準點（BM）</div>
    <div class="grid3"><label>名稱<input data-k="dname" value="${esc(d.name)}"></label><label>E（TWD97, m）<input data-k="E" type="number" step="0.001" value="${d.E.toFixed(3)}"></label><label>N（TWD97, m）<input data-k="N" type="number" step="0.001" value="${d.N.toFixed(3)}"></label></div>
    <div class="grid3"><label>海拔（m）<input data-k="H" type="number" step="0.001" value="${d.H}"></label><label>緯度<input data-k="lat" type="number" step="0.0000001" value="${ll.lat.toFixed(7)}"></label><label>經度<input data-k="lng" type="number" step="0.0000001" value="${ll.lng.toFixed(7)}"></label></div>
    <p class="mute small">RTK 給的是經緯度也可以：改經緯度會自動換算 TWD97（反之亦然）。</p>
    <div class="lbl">網格（探坑以此為單位）</div>
    <div class="grid2"><label>原點 E（m）<input data-k="gE" type="number" step="0.001" value="${g.E0.toFixed(3)}"></label><label>原點 N（m）<input data-k="gN" type="number" step="0.001" value="${g.N0.toFixed(3)}"></label>
    <label>格距（cm）<input data-k="gs" type="number" step="1" value="${cmv(g.size)}"></label><label>網格偏轉（度，順時針）<input data-k="grot" type="number" step="0.1" value="${g.rot || 0}"></label></div>
    <div class="lbl">季次</div>
    <div class="list" data-seasons></div><button type="button" class="block" data-add-season>＋ 季次</button>
    <div class="lbl">自然層（全遺址共用，用來對應不同坑的同一層）</div>
    <div class="list" data-strata></div><button type="button" class="block" data-add-stratum>＋ 自然層</button>
    <div class="lbl">遺物類別</div>
    <div class="list" data-types></div><button type="button" class="block" data-add-type>＋ 類別</button>
    <label>備註<textarea data-k="notes" rows="2">${esc(p.notes)}</textarea></label>
    <div class="btns end"><button type="button" data-close2>取消</button><button class="primary" data-save>儲存</button></div></div>`, { wide: true });
  const el = m.el, v = k => el.querySelector(`[data-k="${k}"]`);
  let mode = p.layerMode;
  for (const b of $$('[data-mode] button', el)) b.onclick = () => { mode = b.dataset.m; $$('[data-mode] button', el).forEach(x => x.classList.toggle('on', x === b)); };
  const syncLL = () => { const q = tm2ll(numOr(v('E').value), numOr(v('N').value)); if (Number.isFinite(q.lat)) { v('lat').value = q.lat.toFixed(7); v('lng').value = q.lng.toFixed(7); } };
  const syncTM = () => { const q = ll2tm(numOr(v('lat').value), numOr(v('lng').value)); if (Number.isFinite(q.E)) { v('E').value = q.E.toFixed(3); v('N').value = q.N.toFixed(3); } };
  v('E').oninput = v('N').oninput = syncLL; v('lat').oninput = v('lng').oninput = syncTM;

  const seasons = p.seasons.map(s => ({ ...s })), strata = p.strata.map(s => ({ ...s })), types = p.types.map(t => ({ ...t }));
  const drawLists = () => {
    el.querySelector('[data-seasons]').innerHTML = seasons.map((s, i) => `<div class="lrow s" data-i="${i}"><input type="color" data-f="color" value="${s.color}"><input data-f="code" value="${esc(s.code)}" placeholder="代碼（如 114）"><input data-f="year" type="number" value="${s.year || ''}" placeholder="年"><input data-f="start" type="date" value="${s.start || ''}"><button type="button" class="x danger" data-del>✕</button></div>`).join('');
    el.querySelector('[data-strata]').innerHTML = strata.map((s, i) => `<div class="lrow t" data-i="${i}"><span class="sw big" style="background:${munsellRGB(s.munsell) || '#ccc'}"></span><input data-f="name" value="${esc(s.name)}" placeholder="名稱"><input data-f="short" value="${esc(s.short || '')}" placeholder="簡稱"><input data-f="munsell" value="${esc(s.munsell || '')}" placeholder="10YR 3/4"><input data-f="texture" value="${esc(s.texture || '')}" placeholder="土質"><span class="ud"><button type="button" class="x" data-up>↑</button><button type="button" class="x danger" data-del>✕</button></span></div>`).join('') || '<p class="mute small">尚未定義（由上往下排）</p>';
    el.querySelector('[data-types]').innerHTML = types.map((t, i) => `<div class="lrow y" data-i="${i}"><input type="color" data-f="color" value="${t.color}"><input data-f="name" value="${esc(t.name)}"><select data-f="cat">${['文化遺物', '生態遺物', '樣本', '其他'].map(c => `<option ${c === t.cat ? 'selected' : ''}>${c}</option>`).join('')}</select><button type="button" class="x danger" data-del ${['other'].includes(t.id) ? 'disabled' : ''}>✕</button></div>`).join('');
  };
  drawLists();
  const listOf = { seasons, strata, types };
  for (const [key, arr] of Object.entries(listOf)) {
    const box = el.querySelector(`[data-${key}]`);
    box.oninput = e => {
      const row = e.target.closest('[data-i]'), f = e.target.dataset.f; if (!row || !f) return;
      arr[+row.dataset.i][f] = f === 'year' ? +e.target.value : e.target.value;
      if (f === 'munsell') row.querySelector('.sw').style.background = munsellRGB(e.target.value) || '#ccc';
    };
    box.onchange = box.oninput;
    box.onclick = e => {
      const row = e.target.closest('[data-i]'); if (!row) return;
      const i = +row.dataset.i;
      if (e.target.closest('[data-del]')) {
        if (key === 'seasons' && p.pits.some(x => x.season === arr[i].id)) return toast('這個季次還有探坑，不能刪');
        if (key === 'seasons' && arr.length === 1) return;
        arr.splice(i, 1); drawLists();
      }
      if (e.target.closest('[data-up]') && i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; drawLists(); }
    };
  }
  el.querySelector('[data-add-season]').onclick = () => { const y = new Date().getFullYear(); seasons.push({ id: uid(), code: String(y - 1911), year: y, start: '', color: SEASON_COLORS[seasons.length % SEASON_COLORS.length] }); drawLists(); };
  el.querySelector('[data-add-stratum]').onclick = () => { strata.push({ id: uid(), name: `第 ${strata.length + 1} 層`, short: '', munsell: '', texture: '', compact: '', incl: '' }); drawLists(); };
  el.querySelector('[data-add-type]').onclick = () => { types.splice(types.length - 1, 0, { id: uid(), name: '新類別', color: '#888888', cat: '文化遺物' }); drawLists(); };
  el.querySelector('[data-close2]').onclick = m.close;
  el.querySelector('[data-save]').onclick = () => {
    checkpoint();
    p.name = v('name').value.trim() || p.name; p.code = v('code').value.trim() || p.code;
    p.layerMode = mode; p.spit = Math.max(10, Math.round(numOr(v('spit').value, 10) * 10));
    p.datum = { name: v('dname').value.trim() || 'BM', E: numOr(v('E').value, d.E), N: numOr(v('N').value, d.N), H: numOr(v('H').value, d.H) };
    p.grid = { E0: numOr(v('gE').value, g.E0), N0: numOr(v('gN').value, g.N0), size: Math.max(100, Math.round(numOr(v('gs').value, 200) * 10)), rot: numOr(v('grot').value, 0) };
    p.seasons = seasons; p.strata = strata; p.types = types;
    // 新的自然層補進每個坑的層界（預設不存在＝厚度 0）
    for (const pt of p.pits) {
      pt.strata = strata.map(st => pt.strata.find(sb => sb.stratum === st.id) || { stratum: st.id, bot: bottomCorners(pt).map(z => z - 5000) })
        .map((sb, i, a) => sb);
    }
    p.notes = v('notes').value;
    S.level = -1;
    m.close(); changed(); plan.cams = {}; plan.fit();
  };
}

// ---------- 表單：探坑 ----------
function editPit(pt) {
  const p = P(), isNew = !pt;
  if (isNew) {
    pt = newPit(p, p.seasons[p.seasons.length - 1].id, 0, 0);
    // 預設放在已有探坑的東邊
    const used = new Set(p.pits.map(x => `${x.gx},${x.gy}`));
    let gx = 0; while (used.has(`${gx},0`)) gx++;
    Object.assign(pt, newPit(p, pt.season, gx, 0), { code: 'P' + (Math.max(0, ...p.pits.filter(x => x.season === pt.season).map(x => parseInt(x.code.replace(/\D/g, '')) || 0)) + 1) });
  }
  const vals = { t0: pt.top[0], t1: pt.top[1], t2: pt.top[2], t3: pt.top[3] };
  const onGrid = pt.gx !== null && pt.gx !== undefined;
  const m = modal(isNew ? '新增探坑' : `編輯 ${pitLabel(p, pt)}`, `<div class="form">
    <div class="grid3"><label>季次<select data-k="season">${p.seasons.map(s => `<option value="${s.id}" ${s.id === pt.season ? 'selected' : ''}>${esc(p.code)}-${esc(s.code)}</option>`).join('')}</select></label>
    <label>坑號<input data-k="code" value="${esc(pt.code)}"></label><span></span></div>
    <div class="lbl">位置</div>
    <div class="seg" data-pos><button type="button" data-m="grid" class="${onGrid ? 'on' : ''}">依網格</button><button type="button" data-m="free" class="${onGrid ? '' : 'on'}">實測四角</button></div>
    <div data-grid ${onGrid ? '' : 'hidden'} class="grid2"><label>網格 X（往東第幾格）<input data-k="gx" type="number" step="1" value="${pt.gx ?? 0}"></label><label>網格 Y（往北第幾格）<input data-k="gy" type="number" step="1" value="${pt.gy ?? 0}"></label></div>
    <div data-free ${onGrid ? 'hidden' : ''}>${pt.corners.map((c, i) => `<div class="grid3 crow"><span class="cn">${CORNER_NAMES[i]}角</span><label>E（m）<input data-c="${i}E" type="number" step="0.001" value="${c.E.toFixed(3)}"></label><label>N（m）<input data-c="${i}N" type="number" step="0.001" value="${c.N.toFixed(3)}"></label></div>`).join('')}</div>
    <div class="grid2"><label>東西寬（cm，標稱）<input data-k="w" type="number" step="0.1" value="${cmv(pt.w)}"></label><label>南北長（cm，標稱）<input data-k="d" type="number" step="0.1" value="${cmv(pt.d)}"></label></div>
    <div class="lbl">開挖前坑口四角高程</div>
    ${zModeBar(false)}
    <div class="grid4">${[0, 1, 2, 3].map(i => `<label>${CORNER_NAMES[i]}<input data-z="t${i}" inputmode="decimal"></label>`).join('')}</div>
    <label>備註<textarea data-k="notes" rows="2">${esc(pt.notes || '')}</textarea></label>
    <div class="btns end">${isNew ? '' : '<button type="button" class="danger" data-del>刪除探坑</button><span class="sp"></span>'}<button type="button" data-close2>取消</button><button class="primary" data-save>${isNew ? '新增' : '儲存'}</button></div></div>`, { wide: true });
  const el = m.el, v = k => el.querySelector(`[data-k="${k}"]`);
  const z = bindZ(el, vals);
  let pos = onGrid ? 'grid' : 'free';
  for (const b of $$('[data-pos] button', el)) b.onclick = () => {
    pos = b.dataset.m; $$('[data-pos] button', el).forEach(x => x.classList.toggle('on', x === b));
    el.querySelector('[data-grid]').hidden = pos !== 'grid'; el.querySelector('[data-free]').hidden = pos !== 'free';
    if (pos === 'free') { const c = gridCellCorners(p, numOr(v('gx').value, 0), numOr(v('gy').value, 0)); c.forEach((q, i) => { el.querySelector(`[data-c="${i}E"]`).value = q.E.toFixed(3); el.querySelector(`[data-c="${i}N"]`).value = q.N.toFixed(3); }); }
  };
  el.querySelector('[data-close2]').onclick = m.close;
  el.querySelector('[data-del]')?.addEventListener('click', () => {
    if (!confirm(`刪除 ${pitLabel(p, pt)}？坑內 ${pt.finds.length} 件遺物與所有層位紀錄都會刪除（可用復原救回）。`)) return;
    checkpoint(); p.pits = p.pits.filter(x => x !== pt); S.sel = null; if (S.pitId === pt.id) { S.pitId = null; S.view = 'site'; }
    m.close(); changed(); emit('view');
  });
  el.querySelector('[data-save]').onclick = () => {
    z.read();
    checkpoint();
    pt.season = v('season').value; pt.code = v('code').value.trim() || pt.code;
    pt.w = Math.max(100, Math.round(numOr(v('w').value, 200) * 10)); pt.d = Math.max(100, Math.round(numOr(v('d').value, 200) * 10));
    if (pos === 'grid') { pt.gx = Math.round(numOr(v('gx').value, 0)); pt.gy = Math.round(numOr(v('gy').value, 0)); pt.corners = gridCellCorners(p, pt.gx, pt.gy).map(c => ({ E: +c.E.toFixed(3), N: +c.N.toFixed(3) })); }
    else { pt.gx = null; pt.gy = null; pt.corners = [0, 1, 2, 3].map(i => ({ E: numOr(el.querySelector(`[data-c="${i}E"]`).value, pt.corners[i].E), N: numOr(el.querySelector(`[data-c="${i}N"]`).value, pt.corners[i].N) })); }
    const oldTop = pt.top.slice();
    pt.top = [0, 1, 2, 3].map(i => vals['t' + i]);
    if (isNew) { pt.strata = p.strata.map(st => ({ stratum: st.id, bot: pt.top.map(t => t - 5000) })); p.pits.push(pt); }
    else if (pt.levels.length === 0) pt.strata.forEach(sb => sb.bot = sb.bot.map((b, i) => b + pt.top[i] - oldTop[i]));
    pt.notes = v('notes').value;
    m.close();
    S.sel = { kind: 'pit', id: pt.id };
    changed(); plan.cams = {}; emit('view');
  };
}

// ---------- 表單：人工層 ----------
function editLevel(pt, lv) {
  const p = P(), isNew = !lv, idx = isNew ? pt.levels.length : pt.levels.indexOf(lv);
  const prevBot = idx > 0 ? pt.levels[idx - 1].bot : pt.top;
  if (isNew) {
    const last = pt.levels[pt.levels.length - 1];
    lv = {
      id: uid(), no: last ? last.no + 1 : 0, bot: prevBot.map(z => z - p.spit), date: last?.date || today(),
      recorder: last?.recorder || '', stratum: last?.stratum || p.strata[0]?.id || '', munsell: last?.munsell || '', colorName: last?.colorName || '',
      texture: last?.texture || '', compact: last?.compact || '', incl: '', photos: '', notes: '',
    };
  }
  const vals = { b0: lv.bot[0], b1: lv.bot[1], b2: lv.bot[2], b3: lv.bot[3] };
  const se = seasonOf(p, pt);
  const m = modal(isNew ? `新增 L${lv.no}` : `編輯 L${lv.no}`, `<div class="form">
    <div class="grid3"><label>層號<input data-k="no" type="number" value="${lv.no}"></label><label>日期<input data-k="date" type="date" value="${esc(lv.date)}"></label><label>記錄者<input data-k="recorder" value="${esc(lv.recorder)}"></label></div>
    <div class="lbl">本層底部四角高程</div>
    ${zModeBar(true)}
    <div class="grid4">${[0, 1, 2, 3].map(i => `<label>${CORNER_NAMES[i]}<input data-z="b${i}" inputmode="decimal"></label>`).join('')}</div>
    <p class="mute small" data-thick></p>
    <div class="lbl">土層與土質</div>
    <div class="grid2"><label>屬於哪個自然層<select data-k="stratum"><option value="">（未指定）</option>${p.strata.map(s => `<option value="${s.id}" ${s.id === lv.stratum ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label>Munsell 土色<span class="munrow"><span class="sw big" data-msw></span><input data-k="munsell" value="${esc(lv.munsell)}" placeholder="例：10YR 3/4"></span></label>
    <label>土色名稱<input data-k="colorName" value="${esc(lv.colorName)}" placeholder="例：暗褐色"></label>
    <label>土質<input data-k="texture" value="${esc(lv.texture)}" placeholder="砂土、黏土、淤泥…"></label>
    <label>緊實度<input data-k="compact" value="${esc(lv.compact)}" placeholder="鬆散、中等、堅硬"></label>
    <label>包含物<input data-k="incl" value="${esc(lv.incl)}" placeholder="炭粒、貝殼碎屑、小礫石…"></label></div>
    <div class="grid2"><label>照片編號<input data-k="photos" value="${esc(lv.photos)}"></label><label>字卡<input readonly data-card></label></div>
    <label>備註<textarea data-k="notes" rows="2">${esc(lv.notes)}</textarea></label>
    <div class="btns end">${isNew ? '' : '<button type="button" class="danger" data-del>刪除此層</button><span class="sp"></span>'}<button type="button" data-close2>取消</button><button class="primary" data-save>${isNew ? '新增' : '儲存'}</button></div></div>`, { wide: true });
  const el = m.el, v = k => el.querySelector(`[data-k="${k}"]`);
  const z = bindZ(el, vals, k => { const c = cornerLocal(pt)[+k.slice(1)]; return { pit: pt, x: c.x, y: c.y }; });
  const upd = () => {
    el.querySelector('[data-msw]').style.background = munsellRGB(v('munsell').value) || 'transparent';
    el.querySelector('[data-card]').value = `${p.code}-${se?.code} / ${pt.code} / L${v('no').value} / ${dateTag(v('date').value)}`;
    const t = { ...vals }; z.read();
    el.querySelector('[data-thick]').textContent = '厚度（各角）：' + [0, 1, 2, 3].map(i => `${cmv(prevBot[i] - vals['b' + i])}`).join(' / ') + ' cm';
    Object.assign(vals, t);
  };
  el.oninput = upd; upd();
  v('munsell').onchange = () => { if (!v('colorName').value) v('colorName').value = munsellName(v('munsell').value) + (munsellName(v('munsell').value) ? '色' : ''); upd(); };
  v('stratum').onchange = () => { const st = p.strata.find(s => s.id === v('stratum').value); if (st && !v('munsell').value) { v('munsell').value = st.munsell || ''; v('texture').value ||= st.texture || ''; } upd(); };
  el.querySelector('[data-close2]').onclick = m.close;
  el.querySelector('[data-del]')?.addEventListener('click', () => {
    if (idx !== pt.levels.length - 1 && !confirm('刪除中間的層，下一層會往上接到這一層的頂面。確定刪除？')) return;
    checkpoint(); pt.levels.splice(idx, 1); S.level = -1; m.close(); changed();
  });
  el.querySelector('[data-save]').onclick = () => {
    z.read();
    const bot = [0, 1, 2, 3].map(i => vals['b' + i]);
    if (bot.some((b, i) => b > prevBot[i])) { if (!confirm('有角的底部比頂部還高，確定嗎？')) return; }
    checkpoint();
    Object.assign(lv, { no: Math.round(numOr(v('no').value, lv.no)), date: v('date').value, recorder: v('recorder').value, bot, stratum: v('stratum').value, munsell: v('munsell').value.trim(), colorName: v('colorName').value, texture: v('texture').value, compact: v('compact').value, incl: v('incl').value, photos: v('photos').value, notes: v('notes').value });
    if (isNew) pt.levels.push(lv);
    m.close(); changed();
    if (isNew && p.layerMode === 'arbitrary') { S.level = pt.levels.length - 1; emit('level'); }
  };
}

// ---------- 表單：自然層層界 ----------
function editBounds(pt) {
  const p = P();
  if (!p.strata.length) return toast('先在「遺址設定」定義自然層');
  const vals = {};
  pt.strata.forEach((sb, j) => sb.bot.forEach((z, i) => (vals[`${j}_${i}`] = z)));
  const m = modal(`${pitLabel(p, pt)} 自然層層界`, `<div class="form">
    <p class="tip">每一層填「底部」在四個角的高程。某一層在某個角不存在（尖滅）就填和上一層底部一樣的值；還沒挖到的部分會自動截在目前坑底。</p>
    ${zModeBar(true)}
    <div class="btable"><div class="bh"><span></span>${CORNER_NAMES.map(n => `<b>${n}</b>`).join('')}</div>
    ${pt.strata.map((sb, j) => { const st = p.strata.find(s => s.id === sb.stratum); return `<div class="br"><span>${swatch(munsellRGB(st?.munsell) || '#ccc')} ${esc(st?.name || '?')} 底</span>${[0, 1, 2, 3].map(i => `<input data-z="${j}_${i}" inputmode="decimal">`).join('')}</div>`; }).join('')}</div>
    <div class="btns end"><button type="button" data-close2>取消</button><button class="primary" data-save>儲存</button></div></div>`, { wide: true });
  const z = bindZ(m.el, vals, k => { const c = cornerLocal(pt)[+k.split('_')[1]]; return { pit: pt, x: c.x, y: c.y }; });
  m.el.querySelector('[data-close2]').onclick = m.close;
  m.el.querySelector('[data-save]').onclick = () => {
    z.read(); checkpoint();
    pt.strata.forEach((sb, j) => (sb.bot = [0, 1, 2, 3].map(i => vals[`${j}_${i}`])));
    m.close(); changed();
  };
}

// ---------- 表單：遺物 ----------
function nextFindNo(pt) {
  const n = Math.max(0, ...pt.finds.map(f => parseInt(String(f.no).split('-').pop()) || 0)) + 1;
  return `${pt.code}-${String(n).padStart(3, '0')}`;
}
function addFindAt(x, y) {
  const p = P(), pt = pit(), layers = layersOf(p, pt), L = S.level >= 0 ? layers[S.level] : layers[layers.length - 1];
  const u = x / pt.w, v = y / pt.d;
  const z = L ? Math.round((bil(L.top, u, v) + bil(L.bot, u, v)) / 2) : Math.round(topAt(pt, x, y) - 50);
  editFind(pt, null, { x, y, z });
}
function editFind(pt, f, init) {
  const p = P(), isNew = !f;
  const nat = p.layerMode === 'natural';
  if (isNew) {
    const last = pt.finds[pt.finds.length - 1];
    f = { id: uid(), no: nextFindNo(pt), type: last?.type || 'pottery', count: 1, key: false, desc: '', date: pt.levels[pt.levels.length - 1]?.date || today(), stratum: '', drawing: null, notes: '', ...init };
  }
  const vals = { z: f.z };
  let drawing = f.drawing;
  const m = modal(isNew ? '新增遺物' : `編輯 ${f.no}`, `<div class="form">
    <div class="grid3"><label>編號<input data-k="no" value="${esc(f.no)}"></label>
    <label>類別<select data-k="type">${p.types.map(t => `<option value="${t.id}" ${t.id === f.type ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <label>數量<input data-k="count" type="number" min="1" value="${f.count || 1}"></label></div>
    <label class="chk"><input type="checkbox" data-k="key" ${f.key ? 'checked' : ''}>特物（重要遺物，獨立編號）</label>
    <label>描述<input data-k="desc" value="${esc(f.desc)}" placeholder="例：夾砂紅陶口緣"></label>
    <div class="lbl">位置</div>
    <div class="grid2"><label>距西壁（cm）<input data-k="x" type="number" step="0.1" value="${cmv(f.x)}"></label><label>距南壁（cm）<input data-k="y" type="number" step="0.1" value="${cmv(f.y)}"></label></div>
    ${zModeBar(true)}
    <div class="grid2"><label>高程<input data-z="z" inputmode="decimal"></label><label>落在${nat ? '自然層（依深度）' : '人工層'}<input readonly data-autolv></label></div>
    ${nat || p.strata.length ? `<label>記錄者指定的自然層<select data-k="stratum"><option value="">（依深度自動判斷）</option>${p.strata.map(s => `<option value="${s.id}" ${s.id === f.stratum ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
    <div class="grid2"><label>日期<input data-k="date" type="date" value="${esc(f.date || '')}"></label><span></span></div>
    <div class="lbl">手繪圖</div>
    <div class="drawrow"><img data-prev alt="" ${drawing ? '' : 'hidden'}><div class="col"><button type="button" data-up>${drawing ? '更換' : '上傳'}手繪圖／照片</button><button type="button" class="danger" data-rm ${drawing ? '' : 'hidden'}>移除</button></div></div>
    <label>備註<textarea data-k="notes" rows="2">${esc(f.notes || '')}</textarea></label>
    <div class="btns end"><button type="button" data-close2>取消</button><button class="primary" data-save>${isNew ? '新增' : '儲存'}</button></div></div>`, { wide: true });
  const el = m.el, v = k => el.querySelector(`[data-k="${k}"]`);
  const pos = () => ({ x: clamp(Math.round(numOr(v('x').value, 0) * 10), 0, pt.w), y: clamp(Math.round(numOr(v('y').value, 0) * 10), 0, pt.d) });
  const z = bindZ(el, vals, () => ({ pit: pt, ...pos() }));
  const upd = () => {
    const t = vals.z; z.read();
    const q = pos(), L = layerAt(layersOf(p, pt), pt, q.x, q.y, vals.z);
    el.querySelector('[data-autolv]').value = L ? L.name : '（不在任何已記錄的層內）';
    vals.z = t;
  };
  el.oninput = upd; upd();
  const showImg = async () => { const im = el.querySelector('[data-prev]'); if (drawing) { im.src = await imgURL(drawing); im.hidden = false; } else im.hidden = true; el.querySelector('[data-rm]').hidden = !drawing; };
  showImg();
  el.querySelector('[data-up]').onclick = async () => { const file = await askFile('image/*'); if (!file) return; drawing = await putImage(file); showImg(); };
  el.querySelector('[data-rm]').onclick = () => { drawing = null; showImg(); };
  el.querySelector('[data-close2]').onclick = m.close;
  el.querySelector('[data-save]').onclick = () => {
    z.read(); checkpoint();
    Object.assign(f, { no: v('no').value.trim() || f.no, type: v('type').value, count: Math.max(1, Math.round(numOr(v('count').value, 1))), key: v('key').checked, desc: v('desc').value, ...pos(), z: vals.z, stratum: v('stratum')?.value || '', date: v('date').value, drawing, notes: v('notes').value });
    if (isNew) pt.finds.push(f);
    S.sel = { kind: 'find', id: f.id, pitId: pt.id };
    m.close(); changed(); emit('selection');
  };
}

// ---------- 表單：遺構 ----------
function editFeature(pt, fe) {
  const p = P(), isNew = !fe;
  if (isNew) { const t = topAt(pt, pt.w / 2, pt.d / 2); fe = { id: uid(), type: '柱洞', shape: 'circle', x: pt.w / 2, y: pt.d / 2, r: 150, w: 600, h: 400, top: Math.round(t - 300), bot: Math.round(t - 700), notes: '' }; }
  const vals = { top: fe.top, bot: fe.bot };
  const m = modal(isNew ? '新增遺構' : `編輯${fe.type}`, `<div class="form">
    <div class="grid2"><label>類型<select data-k="type">${FEATURE_TYPES.map(t => `<option ${t === fe.type ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label>平面形狀<select data-k="shape"><option value="circle" ${fe.shape === 'circle' ? 'selected' : ''}>圓形</option><option value="rect" ${fe.shape === 'rect' ? 'selected' : ''}>方形</option></select></label></div>
    <div class="grid2"><label>中心距西壁（cm）<input data-k="x" type="number" step="0.1" value="${cmv(fe.x)}"></label><label>中心距南壁（cm）<input data-k="y" type="number" step="0.1" value="${cmv(fe.y)}"></label></div>
    <div class="grid2" data-circ><label>直徑（cm）<input data-k="dia" type="number" step="0.1" value="${cmv(fe.r * 2)}"></label><span></span></div>
    <div class="grid2" data-rect><label>東西長（cm）<input data-k="w" type="number" step="0.1" value="${cmv(fe.w)}"></label><label>南北長（cm）<input data-k="h" type="number" step="0.1" value="${cmv(fe.h)}"></label></div>
    ${zModeBar(true)}
    <div class="grid2"><label>頂面高程<input data-z="top" inputmode="decimal"></label><label>底面高程<input data-z="bot" inputmode="decimal"></label></div>
    <label>出土狀態／切壓關係<textarea data-k="notes" rows="3" placeholder="例：自文化層 II 頂面下挖，打破砂層">${esc(fe.notes)}</textarea></label>
    <div class="btns end"><button type="button" data-close2>取消</button><button class="primary" data-save>${isNew ? '新增' : '儲存'}</button></div></div>`, { wide: true });
  const el = m.el, v = k => el.querySelector(`[data-k="${k}"]`);
  const shp = () => { el.querySelector('[data-circ]').hidden = v('shape').value !== 'circle'; el.querySelector('[data-rect]').hidden = v('shape').value !== 'rect'; };
  v('shape').onchange = shp; shp();
  const z = bindZ(el, vals, () => ({ pit: pt, x: numOr(v('x').value, 0) * 10, y: numOr(v('y').value, 0) * 10 }));
  el.querySelector('[data-close2]').onclick = m.close;
  el.querySelector('[data-save]').onclick = () => {
    z.read(); checkpoint();
    Object.assign(fe, { type: v('type').value, shape: v('shape').value, x: Math.round(numOr(v('x').value, 0) * 10), y: Math.round(numOr(v('y').value, 0) * 10), r: Math.round(numOr(v('dia').value, 30) * 5), w: Math.round(numOr(v('w').value, 60) * 10), h: Math.round(numOr(v('h').value, 40) * 10), top: Math.max(vals.top, vals.bot), bot: Math.min(vals.top, vals.bot), notes: v('notes').value });
    if (isNew) pt.features.push(fe);
    S.sel = { kind: 'feature', id: fe.id, pitId: pt.id };
    m.close(); changed(); emit('selection');
  };
}

// ---------- 照片 ----------
async function addPhotos(pt) {
  const files = await askFile('image/*', true);
  if (!files?.length) return;
  const p = P(), se = seasonOf(p, pt), layers = layersOf(p, pt, 'arbitrary');
  const lvNo = S.level >= 0 && p.layerMode === 'arbitrary' ? layers[S.level]?.ref.no : pt.levels[pt.levels.length - 1]?.no ?? 0;
  checkpoint();
  for (const file of files) {
    const img = await putImage(file);
    const date = today(new Date(file.lastModified || Date.now()));
    pt.photos.push({ id: uid(), img, level: lvNo, date, kind: '平面', card: `${p.code}-${se?.code}/${pt.code}/L${lvNo}/${dateTag(date)}`, caption: file.name });
  }
  changed();
  toast(`已加入 ${files.length} 張照片`);
}
async function viewPhoto(pt, ph) {
  const u = await imgURL(ph.img);
  const m = modal(ph.card || '照片', `<img class="big" src="${u}"><div class="form">
    <div class="grid3"><label>層號<input data-k="level" type="number" value="${ph.level}"></label><label>日期<input data-k="date" type="date" value="${esc(ph.date)}"></label>
    <label>類型<select data-k="kind">${['平面', '剖面', '遺物特寫', '工作照'].map(k => `<option ${k === ph.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label></div>
    <label>說明<input data-k="caption" value="${esc(ph.caption || '')}"></label>
    <div class="btns end"><button type="button" class="danger" data-del>刪除</button><span class="sp"></span><button class="primary" data-save>儲存</button></div></div>`, { wide: true });
  const v = k => m.el.querySelector(`[data-k="${k}"]`);
  m.el.querySelector('[data-del]').onclick = () => { checkpoint(); pt.photos = pt.photos.filter(x => x !== ph); m.close(); changed(); };
  m.el.querySelector('[data-save]').onclick = () => {
    checkpoint();
    const p = P(), se = seasonOf(p, pt);
    Object.assign(ph, { level: Math.round(numOr(v('level').value, 0)), date: v('date').value, kind: v('kind').value, caption: v('caption').value });
    ph.card = `${p.code}-${se?.code}/${pt.code}/L${ph.level}/${dateTag(ph.date)}`;
    m.close(); changed();
  };
}

// ---------- 遺址清單、選單 ----------
async function makeDemo() {
  toast('建立示範遺址中…');
  const p = await buildDemo();
  addProject(p);
  toast('已建立「海角示範遺址（虛構）」');
}
function projectList() {
  const m = modal('我的遺址', `<div class="list">${S.projects.map(p => `<div class="row2 ${p.id === S.projectId ? 'on' : ''}" data-p="${p.id}"><span class="rmain"><b>${esc(p.name)}</b><small>${esc(p.code)}・${p.seasons.length} 季・${p.pits.length} 坑・${new Date(p.updated).toLocaleDateString()}</small></span><button class="x danger" data-del="${p.id}">刪除</button></div>`).join('') || '<p class="empty">沒有遺址</p>'}</div>
    <div class="btns"><button class="primary" data-new>＋ 新遺址</button><button data-demo>＋ 示範遺址</button><button data-imp>匯入備份</button></div>`);
  m.el.onclick = async e => {
    const del = e.target.closest('[data-del]');
    if (del) { const p = S.projects.find(x => x.id === del.dataset.del); if (confirm(`刪除「${p.name}」？此動作無法復原（建議先匯出備份）。`)) { await deleteProject(p.id); m.close(); projectList(); } return; }
    const row = e.target.closest('[data-p]');
    if (row) { await flushSaves(); openProject(row.dataset.p); m.close(); return; }
    if (e.target.closest('[data-new]')) {
      const name = prompt('遺址名稱', '新遺址'); if (!name) return;
      m.close(); addProject(newProject(name)); editProject();
    }
    if (e.target.closest('[data-demo]')) { m.close(); makeDemo(); }
    if (e.target.closest('[data-imp]')) { m.close(); importFile(); }
  };
}
async function importFile() {
  const file = await askFile('.json,application/json');
  if (!file) return;
  try { const p = await importBackup(JSON.parse(await file.text())); toast(`已匯入「${p.name}」`); }
  catch (err) { toast('匯入失敗：' + err.message); }
}
function menu() {
  const p = P();
  const fn = s => `${p.code}_${p.name}_${s}`.replace(/[\\/:*?"<>|（）]/g, '');
  const m = modal('選單', `
    <div class="lbl">匯出（給 QGIS、Excel 或其他工具）</div>
    <div class="menu">
      <button data-x="gj">GeoJSON（TWD97 / EPSG:3826）<small>探坑、遺物點（含高程）、遺構、基準點</small></button>
      <button data-x="gjw">GeoJSON（WGS84 經緯度）<small>網頁地圖、Google Earth 轉檔用</small></button>
      <button data-x="finds">遺物清冊 CSV<small>Excel 可直接開；坑層號、座標、三種高程</small></button>
      <button data-x="levels">層位紀錄 CSV<small>每坑每層：四角高程、Munsell、土質、包含物</small></button>
      <button data-x="av">archeoViz CSV<small>丟進 archeoViz 做分布統計（核密度、凸包）</small></button>
    </div>
    <div class="lbl">備份（在裝置間搬移，用 AirDrop 傳檔即可）</div>
    <div class="menu"><button data-x="bak">匯出備份檔<small>含手繪圖與照片</small></button><button data-x="imp">匯入備份檔</button></div>
    <div class="lbl">關於</div>
    <p class="mute small">坑記 v${APP_VERSION}・資料只存在這台裝置的瀏覽器裡。Munsell 色為螢幕近似色，請以色卡為準。<br>高程：內部以「相對基準點」記錄，可隨時切換顯示為海拔、相對 BM 或距坑口深度。</p>`);
  m.el.onclick = async e => {
    const b = e.target.closest('[data-x]'); if (!b || !p) return;
    const x = b.dataset.x;
    if (x === 'gj') download(fn('TWD97.geojson'), geojson(p, 'tm2'), 'application/geo+json');
    if (x === 'gjw') download(fn('WGS84.geojson'), geojson(p, 'wgs84'), 'application/geo+json');
    if (x === 'finds') download(fn('遺物清冊.csv'), findsCSV(p), 'text/csv');
    if (x === 'levels') download(fn('層位紀錄.csv'), levelsCSV(p), 'text/csv');
    if (x === 'av') download(fn('archeoViz.csv'), archeoVizCSV(p), 'text/csv');
    if (x === 'bak') { await flushSaves(); download(fn(`備份_${today()}.json`), JSON.stringify(await exportBackup(p)), 'application/json'); }
    if (x === 'imp') { m.close(); importFile(); }
  };
}

// ---------- 事件 ----------
const ui = { toast, openPit, openProfile, addFindAt, onMeasure: () => renderInspector() };

on(what => {
  if (what === 'project') { plan.cams = {}; plan.meas = []; if (v3d) v3d.framed = false; v3d?.markDirty(); renderAll(); return; }
  if (what === 'view') { renderAll(); if (S.view === '3d') v3d?.markDirty(); return; }
  if (what === 'history') { $('#btnUndo').disabled = !canUndo(); $('#btnRedo').disabled = !canRedo(); return; }
  if (what === 'selection') {
    renderInspector(); plan.draw();
    if (S.view !== '3d') renderPanel(); else v3d?.markDirty();
    if (isMobile() && S.sel) $('#side').classList.remove('open');
    return;
  }
  if (what === 'level') { renderTools(); renderPanel(); plan.draw(); return; }
  if (what === 'filter') { renderPanel(); plan.draw(); v3d?.markDirty(); return; }
  // 資料改變
  renderPanel(); renderInspector(); renderTools(); plan.draw(); v3d?.markDirty();
});

function bind() {
  $('#btnProj').onclick = projectList;
  $('#btnMenu').onclick = menu;
  $('#btnUndo').onclick = undo; $('#btnRedo').onclick = redo;
  $('#zDisp').onchange = e => { S.settings.zDisp = e.target.value; saveSettings(); renderPanel(); renderInspector(); plan.draw(); };
  for (const b of $$('#viewSeg button')) b.onclick = () => setView(b.dataset.v);
  $('#btnSheet').onclick = () => $('#side').classList.toggle('open');
  $('#sheetClose').onclick = () => $('#side').classList.remove('open');
  addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) return;
    if (!$('#modal').hidden) { if (e.key === 'Escape') $('#modal [data-close]')?.click(); return; }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (e.key === 'Escape') {
      if (plan.tool !== 'select') { plan.tool = 'select'; plan.meas = []; renderTools(); renderHint(); renderInspector(); plan.draw(); }
      else if (S.sel) { S.sel = null; emit('selection'); }
      else if (S.wall) { S.wall = null; emit('view'); }
      else if (S.view === 'pit') setView('site');
    }
    if (S.view === 'pit' && !S.wall && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); stepLevel(e.key === 'ArrowUp' ? -1 : 1); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel?.kind === 'find') $('#inspector [data-del]')?.click();
  });
}

async function checkUpdate() {
  try {
    const j = await (await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    if (!j.v || j.v === APP_VERSION) return;
    const u = new URL(location.href);
    if (u.searchParams.get('r') === j.v) return; // 已經試過一次，避免無限重新整理
    u.searchParams.set('r', j.v);
    location.replace(u.toString());
  } catch { /* 離線時略過 */ }
}

async function init() {
  plan = new Plan2D($('#c2d'), ui);
  bind();
  await loadAll();
  if (!S.projects.length) { const p = await buildDemo(); addProject(p); }
  else openProject(S.projectId);
  window.__kj = { S, P, pit, plan, get v3d() { return v3d; } };
  checkUpdate();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
}
init();
