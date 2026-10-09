// 3D：只留坑位本身——挖掉的土柱依層位上色、遺物點浮在實際深度，可透視、可垂直誇張、可逐層剝除
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { S, P, emit } from './state.js?v=0.1.0';
import { layersOf, worldOf, bil, typeOf, seasonOf, bottomCorners } from './model.js?v=0.1.0';

const SUB = 6; // 層面細分（雙線性曲面）

export class View3D {
  constructor(el, ui) {
    this.el = el; this.ui = ui;
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true }));
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.domElement.style.touchAction = 'none';
    el.appendChild(r.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    el.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#e7e3dc');
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7b68, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-30, 60, 40);
    this.scene.add(sun);

    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.pickables = [];
    this.dirty = true; this.active = false; this.framed = false;
    new ResizeObserver(() => this.resize()).observe(el);

    // 點選（沒拖曳才算）
    let down = null;
    r.domElement.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    r.domElement.addEventListener('pointerup', e => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
      const hit = this.pick(e);
      S.sel = hit ? { ...hit } : null;
      emit('selection');
    });
    r.domElement.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' || e.buttons) return;
      r.domElement.style.cursor = this.pick(e) ? 'pointer' : 'grab';
    });
  }

  show(on) {
    this.active = on;
    if (!on) return;
    this.resize();
    if (this.dirty) this.rebuild();
    requestAnimationFrame(this.loop);
  }
  markDirty() { this.dirty = true; if (this.active) this.rebuild(); }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  loop = () => {
    if (!this.active) return;
    requestAnimationFrame(this.loop);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  };

  pick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const m = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(m, this.camera);
    const hits = ray.intersectObjects(this.pickables, false);
    // 透視模式下遺物畫在最上層，所以遺物優先
    const h = hits.find(x => x.object.userData.kind === 'find') || hits[0];
    return h ? h.object.userData.sel : null;
  }

  clear() {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.traverse(n => {
        n.geometry?.dispose();
        if (n.material) [].concat(n.material).forEach(m => m.dispose());
        if (n.isCSS2DObject) n.element.remove();
      });
    }
    this.pickables = [];
  }

  rebuild() {
    this.dirty = false;
    this.clear();
    const p = P(); if (!p) return;
    const st = S.settings, ex = st.exag || 1;
    const op = st.opacity ?? 0.8, peel = st.peel || 0, xray = st.xray !== false;
    const toV = (pt, x, y, z) => { const w = worldOf(pt, x, y); return new THREE.Vector3(w.E - p.datum.E, (z / 1000) * ex, -(w.N - p.datum.N)); };
    const box = new THREE.Box3();
    const sphere = new THREE.SphereGeometry(1, 14, 10);
    this.disposeShared = sphere;

    for (const pt of p.pits) {
      if (st.hideSeasons.includes(pt.season)) continue;
      const se = seasonOf(p, pt);
      const layers = layersOf(p, pt);
      layers.forEach((L, i) => {
        if (i < peel) return;
        const geo = layerGeometry(pt, L, toV);
        const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(L.color), transparent: op < 1, opacity: op, side: THREE.DoubleSide, depthWrite: op >= 1 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData = { kind: 'pit', sel: { kind: 'pit', id: pt.id } };
        this.group.add(mesh);
        this.pickables.push(mesh);
        // 層界線
        const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x2b2420, transparent: true, opacity: .35 }));
        this.group.add(edge);
        box.expandByObject(mesh);
      });
      // 坑口框（季次顏色）
      const rim = [0, 1, 2, 3, 0].map(i => { const c = [[0, 0], [pt.w, 0], [pt.w, pt.d], [0, pt.d]][i]; return toV(pt, c[0], c[1], pt.top[i]); });
      this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rim), new THREE.LineBasicMaterial({ color: new THREE.Color(se?.color || '#2f7d76') })));
      const bc = bottomCorners(pt);
      for (let i = 0; i < 4; i++) { const c = [[0, 0], [pt.w, 0], [pt.w, pt.d], [0, pt.d]][i]; box.expandByPoint(toV(pt, c[0], c[1], pt.top[i])); box.expandByPoint(toV(pt, c[0], c[1], bc[i])); }
      // 標籤
      const div = document.createElement('div');
      div.className = 'lbl3d'; div.textContent = pt.code; div.style.borderColor = se?.color || '#2f7d76';
      const lab = new CSS2DObject(div);
      lab.position.copy(toV(pt, pt.w / 2, pt.d / 2, Math.max(...pt.top) + 250 / ex));
      this.group.add(lab);
      // 遺物
      for (const f of pt.finds) {
        if (st.hideTypes.includes(f.type)) continue;
        if (peel && layers[peel - 1] && f.z > bil(layers[peel - 1].bot, f.x / pt.w, f.y / pt.d) + 1) continue; // 已剝除的層裡的遺物
        const sel = S.sel?.kind === 'find' && S.sel.id === f.id;
        const mat = new THREE.MeshLambertMaterial({ color: new THREE.Color(sel ? '#ff3b1f' : typeOf(p, f.type).color), depthTest: !xray, transparent: xray });
        const m = new THREE.Mesh(sphere, mat);
        const r = (f.key ? 0.06 : 0.04) * (sel ? 1.6 : 1);
        m.scale.setScalar(r);
        m.position.copy(toV(pt, f.x, f.y, f.z));
        m.renderOrder = 10;
        m.userData = { kind: 'find', sel: { kind: 'find', id: f.id, pitId: pt.id } };
        this.group.add(m); this.pickables.push(m);
      }
      // 遺構
      for (const fe of pt.features) {
        const h = Math.max(10, fe.top - fe.bot) / 1000 * ex;
        const geo = fe.shape === 'circle' ? new THREE.CylinderGeometry(fe.r / 1000, fe.r / 1000, h, 24) : new THREE.BoxGeometry(fe.w / 1000, h, fe.h / 1000);
        const mat = new THREE.MeshLambertMaterial({ color: 0x2a211b, transparent: true, opacity: .55, depthWrite: false });
        const m = new THREE.Mesh(geo, mat);
        const c = toV(pt, fe.x, fe.y, (fe.top + fe.bot) / 2);
        m.position.copy(c);
        const a = Math.atan2(pt.corners[1].N - pt.corners[0].N, pt.corners[1].E - pt.corners[0].E);
        m.rotation.y = a;
        m.renderOrder = 5;
        m.userData = { kind: 'feature', sel: { kind: 'feature', id: fe.id, pitId: pt.id } };
        this.group.add(m); this.pickables.push(m);
      }
    }
    if (box.isEmpty()) box.set(new THREE.Vector3(-5, -1, -5), new THREE.Vector3(5, 1, 5));
    this.bbox = box;
    // 地面格線（2 m，放在最深處下方）與基準點
    const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
    const span = Math.ceil(Math.max(size.x, size.z) / 4 + 2) * 4;
    const gs = p.grid.size / 1000;
    const grid = new THREE.GridHelper(span, Math.round(span / gs), 0xb9ad9b, 0xd6cdbf);
    const gE = p.grid.E0 - p.datum.E, gN = p.grid.N0 - p.datum.N;
    grid.position.set(gE + Math.round((ctr.x - gE) / gs) * gs, box.min.y - 0.15, -(gN + Math.round((-ctr.z - gN) / gs) * gs));
    grid.rotation.y = (p.grid.rot || 0) * Math.PI / 180;
    this.group.add(grid);
    const bm = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 16), new THREE.MeshLambertMaterial({ color: 0xd0612a }));
    bm.position.set(0, 0.15, 0); bm.rotation.x = Math.PI;
    this.group.add(bm);
    const div = document.createElement('div'); div.className = 'lbl3d bm'; div.textContent = p.datum.name || 'BM';
    const lab = new CSS2DObject(div); lab.position.set(0, 0.45, 0); this.group.add(lab);
    if (!this.framed) this.frame();
  }

  frame() {
    const b = this.bbox; if (!b) return;
    const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
    const rad = Math.max(s.length() / 2, 2);
    const vf = this.camera.fov * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect); // 直式螢幕要看水平視角
    const dist = rad / Math.sin(Math.min(vf, hf) / 2) * (this.camera.aspect < 1 ? 1.05 : 0.78);
    this.controls.target.copy(c);
    this.camera.position.copy(c).add(new THREE.Vector3(-0.35, 0.62, 0.7).normalize().multiplyScalar(dist));
    this.camera.near = dist / 300; this.camera.far = dist * 20; this.camera.updateProjectionMatrix();
    this.controls.update();
    this.framed = true;
  }
  focus(sel) {
    const o = this.pickables.find(m => m.userData.sel?.id === sel?.id);
    if (!o) return;
    const pos = o.getWorldPosition(new THREE.Vector3());
    const off = this.camera.position.clone().sub(this.controls.target).setLength(sel.kind === 'find' ? 3.5 : 6);
    this.controls.target.copy(pos);
    this.camera.position.copy(pos).add(off);
  }
}

// 一層的實體：上下兩個雙線性曲面＋四個側面
function layerGeometry(pt, L, toV) {
  const pos = [], idx = [];
  const grid = (zs) => {
    const base = pos.length / 3;
    for (let j = 0; j <= SUB; j++) for (let i = 0; i <= SUB; i++) {
      const u = i / SUB, v = j / SUB;
      const p = toV(pt, u * pt.w, v * pt.d, bil(zs, u, v));
      pos.push(p.x, p.y, p.z);
    }
    return base;
  };
  const t = grid(L.top), b = grid(L.bot);
  const at = (base, i, j) => base + j * (SUB + 1) + i;
  for (let j = 0; j < SUB; j++) for (let i = 0; i < SUB; i++) {
    idx.push(at(t, i, j), at(t, i + 1, j), at(t, i + 1, j + 1), at(t, i, j), at(t, i + 1, j + 1), at(t, i, j + 1));
    idx.push(at(b, i, j), at(b, i + 1, j + 1), at(b, i + 1, j), at(b, i, j), at(b, i, j + 1), at(b, i + 1, j + 1));
  }
  // 側面：沿四邊走
  const edges = [];
  for (let i = 0; i < SUB; i++) edges.push([[i, 0], [i + 1, 0]]);
  for (let j = 0; j < SUB; j++) edges.push([[SUB, j], [SUB, j + 1]]);
  for (let i = SUB; i > 0; i--) edges.push([[i, SUB], [i - 1, SUB]]);
  for (let j = SUB; j > 0; j--) edges.push([[0, j], [0, j - 1]]);
  for (const [[i0, j0], [i1, j1]] of edges) {
    const a = at(t, i0, j0), bb = at(t, i1, j1), c = at(b, i1, j1), d = at(b, i0, j0);
    idx.push(a, d, c, a, c, bb);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
