// 全域狀態、存檔、復原/重做、圖片、備份匯出入
import { db } from './db.js?v=0.1.0';
import { uid } from './util.js?v=0.1.0';
import { sanitize } from './model.js?v=0.1.0';

export const S = {
  projects: [],
  projectId: null,
  view: 'site',      // 'site' | 'pit' | '3d'
  pitId: null,       // 坑位視圖正在看的坑
  wall: null,        // 剖面：'N' | 'E' | 'S' | 'W'
  sel: null,         // { kind: 'pit' | 'find' | 'feature', id, pitId }
  level: -1,         // 坑位視圖目前的層（-1 = 全部）
  settings: { id: 'settings', zDisp: 'abs', zIn: 'rel', bs: 150, hideSeasons: [], hideTypes: [], exag: 1.5 },
};

const subs = new Set();
export const on = f => subs.add(f);
export const emit = what => { for (const f of subs) f(what); };

export const P = () => S.projects.find(p => p.id === S.projectId) || null;
export const pit = (id = S.pitId) => P()?.pits.find(p => p.id === id) || null;
export function selObj() {
  const s = S.sel, p = P();
  if (!s || !p) return null;
  if (s.kind === 'pit') return p.pits.find(x => x.id === s.id) || null;
  const pt = p.pits.find(x => x.id === s.pitId);
  if (!pt) return null;
  return (s.kind === 'find' ? pt.finds : pt.features).find(x => x.id === s.id) || null;
}

// ---------- 存檔（延遲寫入） ----------
const pending = new Map();
function scheduleSave(p) {
  clearTimeout(pending.get(p.id));
  pending.set(p.id, setTimeout(() => { pending.delete(p.id); db.put('projects', p).catch(console.error); }, 300));
}
export async function flushSaves() {
  for (const [id, t] of pending) {
    clearTimeout(t);
    const p = S.projects.find(x => x.id === id);
    if (p) await db.put('projects', p);
  }
  pending.clear();
}
window.addEventListener('pagehide', () => { flushSaves(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });

let settingsT;
export function saveSettings() {
  clearTimeout(settingsT);
  settingsT = setTimeout(() => db.put('kv', S.settings).catch(console.error), 300);
}

// ---------- 復原 / 重做 ----------
let undoStack = [], redoStack = [];
export function checkpoint() {
  const p = P();
  if (!p) return;
  undoStack.push(JSON.stringify(p));
  if (undoStack.length > 150) undoStack.shift();
  redoStack = [];
  emit('history');
}
export function changed(kind = 'data') {
  const p = P();
  if (!p) return;
  p.updated = Date.now();
  scheduleSave(p);
  emit(kind);
}
function restore(json) {
  const np = JSON.parse(json);
  const i = S.projects.findIndex(x => x.id === np.id);
  if (i < 0) return;
  S.projects[i] = np;
  if (S.sel && !selObj()) S.sel = null;
  if (S.pitId && !pit()) { S.pitId = null; if (S.view === 'pit') S.view = 'site'; }
  scheduleSave(np);
  emit('data');
  emit('history');
}
export function undo() { const p = P(); if (!p || !undoStack.length) return; redoStack.push(JSON.stringify(p)); restore(undoStack.pop()); }
export function redo() { const p = P(); if (!p || !redoStack.length) return; undoStack.push(JSON.stringify(p)); restore(redoStack.pop()); }
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export function resetHistory() { undoStack = []; redoStack = []; emit('history'); }

// ---------- 專案 ----------
export async function loadAll() {
  S.projects = ((await db.all('projects')) || []).map(sanitize);
  const st = await db.get('kv', 'settings');
  if (st) Object.assign(S.settings, st);
  S.projectId = S.settings.lastProject && S.projects.some(p => p.id === S.settings.lastProject) ? S.settings.lastProject : S.projects[0]?.id ?? null;
}
export function addProject(p) {
  sanitize(p);
  S.projects.push(p);
  db.put('projects', p);
  openProject(p.id);
}
export function openProject(id) {
  S.projectId = id;
  S.settings.lastProject = id;
  saveSettings();
  S.view = 'site'; S.pitId = null; S.wall = null; S.sel = null; S.level = -1;
  resetHistory();
  emit('project');
}
export async function deleteProject(id) {
  const p = S.projects.find(x => x.id === id);
  S.projects = S.projects.filter(x => x.id !== id);
  await db.del('projects', id);
  const still = new Set(S.projects.flatMap(imagesOf)); // 同一份備份匯入兩次時圖片是共用的
  for (const imgId of imagesOf(p)) if (!still.has(imgId)) await db.del('images', imgId);
  if (S.projectId === id) openProject(S.projects[0]?.id ?? null);
}

// ---------- 圖片（手繪圖、照片） ----------
const urlCache = new Map();
export async function putImage(blob) {
  const id = uid();
  await db.put('images', { id, blob });
  return id;
}
export async function imgURL(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  const r = await db.get('images', id);
  if (!r) return null;
  const u = URL.createObjectURL(r.blob);
  urlCache.set(id, u);
  return u;
}
function imagesOf(p) {
  const ids = [];
  for (const pt of p?.pits || []) {
    for (const f of pt.finds) if (f.drawing) ids.push(f.drawing);
    for (const ph of pt.photos) if (ph.img) ids.push(ph.img);
  }
  return ids;
}

// ---------- 備份 ----------
const toDataURL = blob => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
export async function exportBackup(p) {
  const images = {};
  for (const id of imagesOf(p)) {
    const r = await db.get('images', id);
    if (r) images[id] = await toDataURL(r.blob);
  }
  return { app: 'kengji', ver: 1, exported: new Date().toISOString(), project: p, images };
}
export async function importBackup(data) {
  if (data?.app !== 'kengji' || !data.project) throw new Error('不是坑記的備份檔');
  const p = sanitize(data.project);
  for (const [id, url] of Object.entries(data.images || {})) {
    const blob = await (await fetch(url)).blob();
    await db.put('images', { id, blob });
  }
  if (S.projects.some(x => x.id === p.id)) p.id = uid(), (p.name += '（匯入）');
  addProject(p);
  return p;
}
