import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createWorld } from './physics.js';
import { loadModelFromUrl, loadModelFromFile, mergedPoints, mergedTriangles, SUPPORTED } from './models.js';

const $ = (id) => document.getElementById(id);
const fmt = (n) => Math.round(n).toLocaleString('zh-CN');

const SAMPLE_NAMES = { mug: '杯子', chair: '椅子', table: '桌子', crate: '箱子', torus: '圆环' };
const SAMPLE_SIZES = { mug: 1.0, chair: 1.25, table: 1.5, crate: 1.0, torus: 1.3 };
const PALETTE = [0xe4572e, 0x17a2a0, 0xf2b705, 0x6aa84f, 0x4f79c7, 0xa56cc1, 0xef8354, 0x3d9bd1];
const MAX_INSTANCES = 220; // 超过后自动移除最早的物体
const MAX_PARTS = 48;      // 部件再多就不逐个生成凸包了
const FIXED_DT = 1 / 120;  // 物理步长固定为 1/120 秒
const BALL_RADIUS = 0.14;

// ---------- 画面（three.js 只负责显示，物理全部由 PhysX 计算） ----------

const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8edf1);
scene.fog = new THREE.Fog(0xe8edf1, 26, 60);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
camera.position.set(5.2, 4.6, 8.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-1.4, 0.9, 0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 2;
controls.maxDistance = 40;

scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa7b3, 1.9));
const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.position.set(7, 14, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 40 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

function resize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ---------- 状态 ----------

const world = await createWorld();
$('engine').textContent = `NVIDIA PhysX ${world.versionText} · WebAssembly · CPU`;

const samples = {};        // 示例模型
const instances = [];      // 场景里所有会动的物体 { kind, model, object, body, materials }
let colliderMode = 'hull'; // 'hull' = 单个凸包, 'parts' = 每个部件一个凸包
let importMode = 'dynamic';
let importedStatic = null;
let paused = false;
let colorIndex = 0;

function status(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

/** 给不带材质的模型上色。返回新建的材质，移除物体时要释放。 */
function tint(object, color) {
  const made = [];
  object.traverse((o) => {
    if (!o.isMesh) return;
    o.material = new THREE.MeshStandardMaterial({
      color, roughness: 0.62, metalness: 0.04,
      vertexColors: !!o.geometry.attributes.color,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, // 让线框不和表面闪烁
    });
    made.push(o.material);
  });
  return made;
}

// ---------- 静态物体：三角网格碰撞 ----------

function addStatic(model, color) {
  const { positions, indices } = mergedTriangles(model.parts);
  const handle = world.addStaticTriangleMesh(positions, indices, {
    doubleSided: true,
    visualize: indices.length / 3 <= 40000,
  });
  if (!handle) throw new Error('PhysX 无法为这个模型生成三角网格碰撞体');
  const object = model.template;
  const materials = model.plain ? tint(object, color) : null;
  scene.add(object);
  return { model, object, handle, materials };
}

function removeStaticEntry(entry) {
  world.removeStatic(entry.handle);
  scene.remove(entry.object);
  entry.materials?.forEach((m) => m.dispose());
}

// ---------- 动态物体：凸包碰撞 ----------

/** 取得（并缓存）某个模型在当前模式下的碰撞形状。 */
function shapesFor(model, mode) {
  const canSplit = model.parts.length > 1 && model.parts.length <= MAX_PARTS;
  const key = mode === 'parts' && canSplit ? 'parts' : 'hull';
  if (!model.cooked[key]) {
    const groups = key === 'parts'
      ? model.parts.map((p) => mergedPoints([p], 3000)).filter((pts) => pts.length >= 3)
      : [mergedPoints(model.parts, 6000)];
    model.cooked[key] = groups.map((pts) => world.cookShape(pts));
  }
  return { key, shapes: model.cooked[key] };
}

function describeCollider(model, mode) {
  const { key, shapes } = shapesFor(model, mode);
  const verts = shapes.reduce((sum, s) => sum + s.vertices, 0);
  let text = `${model.name}：模型 ${fmt(model.triangles)} 个三角面 → 碰撞体 ${shapes.length} 个凸包，共 ${fmt(verts)} 个顶点`;
  if (mode === 'parts' && key === 'hull') {
    text += model.parts.length > 1 ? '（部件太多，仍用单个凸包）' : '（模型只有一个部件，仍是单个凸包）';
  }
  return text;
}

let dropIndex = 0;
/** 投放位置：水平方向随机，高度逐个错开，避免连续投放的物体生成时互相重叠。 */
function randomDrop() {
  const a = Math.random() * Math.PI * 2, r = Math.random() * 1.7;
  return new THREE.Vector3(Math.cos(a) * r, 4 + (dropIndex++ % 5) * 1.6, Math.sin(a) * r);
}

function randomQuat() {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2),
  );
}

function spawn(model, position = randomDrop(), quaternion = randomQuat()) {
  const object = model.template.clone(true);
  const materials = model.plain ? tint(object, PALETTE[colorIndex++ % PALETTE.length]) : null;
  object.position.copy(position);
  object.quaternion.copy(quaternion);
  scene.add(object);
  const body = world.addDynamic(shapesFor(model, colliderMode).shapes, position, quaternion);
  instances.push({ kind: 'model', model, object, body, materials });
  trimInstances();
}

const ballGeometry = new THREE.SphereGeometry(BALL_RADIUS, 24, 16);
const ballMaterial = new THREE.MeshStandardMaterial({ color: 0x2b3440, roughness: 0.35, metalness: 0.2 });

function shootBall(origin, direction) {
  const object = new THREE.Mesh(ballGeometry, ballMaterial);
  object.castShadow = true;
  object.position.copy(origin);
  scene.add(object);
  const body = world.addBall(BALL_RADIUS, origin, direction.clone().multiplyScalar(18));
  instances.push({ kind: 'ball', object, body });
  trimInstances();
}

function removeInstance(inst) {
  world.removeBody(inst.body);
  scene.remove(inst.object);
  inst.materials?.forEach((m) => m.dispose());
}

function trimInstances() {
  while (instances.length > MAX_INSTANCES) removeInstance(instances.shift());
}

/** 切换碰撞体模式：在原位置用新的碰撞体重建所有模型刚体。 */
function rebuildBodies() {
  for (const inst of instances) {
    if (inst.kind !== 'model') continue;
    world.readPose(inst.body, inst.object);
    world.removeBody(inst.body);
    inst.body = world.addDynamic(shapesFor(inst.model, colliderMode).shapes, inst.object.position, inst.object.quaternion);
  }
}

// ---------- 载入场地和示例模型 ----------

const MODELS_URL = `${import.meta.env.BASE_URL}models/`; // 相对路径，部署到子目录也能找到
const arenaModel = await loadModelFromUrl(`${MODELS_URL}arena.obj`, { name: '场地', targetSize: 14, onGround: true });
const arena = addStatic(arenaModel, 0xc3ccd4);
arena.object.traverse((o) => { if (o.isMesh) o.castShadow = false; });

await Promise.all(Object.keys(SAMPLE_NAMES).map(async (key) => {
  samples[key] = await loadModelFromUrl(`${MODELS_URL}${key}.obj`, { name: SAMPLE_NAMES[key], targetSize: SAMPLE_SIZES[key] });
}));

function dropRandom(count, interval = 130) {
  const keys = Object.keys(samples);
  for (let i = 0; i < count; i++) {
    setTimeout(() => spawn(samples[keys[Math.floor(Math.random() * keys.length)]]), i * interval);
  }
}

function resetScene() {
  while (instances.length) removeInstance(instances.pop());
  if (importedStatic) { removeStaticEntry(importedStatic); importedStatic = null; }
  Object.keys(samples).forEach((key, i) => setTimeout(() => spawn(samples[key]), i * 250));
  status(`场地地形：${fmt(arena.handle.triangles)} 个三角面，按原样做静态三角网格碰撞`);
}

// ---------- 导入外部模型 ----------

async function importFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!SUPPORTED.includes(ext)) {
    status(`不支持 .${ext} 格式（支持 ${SUPPORTED.map((e) => '.' + e).join(' ')}）`, true);
    return;
  }
  status(`正在导入 ${file.name}…`);
  try {
    if (importMode === 'static') {
      const model = await loadModelFromFile(file, { targetSize: 3.5, onGround: true });
      const entry = addStatic(model, 0x8fa3b5);
      if (importedStatic) removeStaticEntry(importedStatic);
      importedStatic = entry;
      status(`已导入 ${file.name} 作为静态场景：${fmt(entry.handle.triangles)} 个三角面，按原样做三角网格碰撞`);
    } else {
      const model = await loadModelFromFile(file, { targetSize: 1.3 });
      spawn(model, new THREE.Vector3(0, 4.5, 0));
      const button = document.createElement('button');
      button.textContent = `再投放：${file.name}`;
      button.addEventListener('click', () => { spawn(model); status(describeCollider(model, colliderMode)); });
      $('imported').replaceChildren(button);
      status(`已导入 ${describeCollider(model, colliderMode)}`);
    }
  } catch (err) {
    console.error(err);
    status(`导入失败：${err.message || err}`, true);
  }
}

// ---------- 界面事件 ----------

$('samples').addEventListener('click', (e) => {
  const key = e.target.dataset?.model;
  if (!key) return;
  spawn(samples[key]);
  status(describeCollider(samples[key], colliderMode));
});
$('rain').addEventListener('click', () => dropRandom(10));
$('reset').addEventListener('click', resetScene);
$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').textContent = paused ? '继续' : '暂停';
});
$('file').addEventListener('change', (e) => {
  if (e.target.files[0]) importFile(e.target.files[0]);
  e.target.value = '';
});
document.querySelectorAll('input[name="importMode"]').forEach((el) =>
  el.addEventListener('change', () => { importMode = el.value; }));
document.querySelectorAll('input[name="collider"]').forEach((el) =>
  el.addEventListener('change', () => {
    colliderMode = el.value;
    rebuildBodies();
    const last = instances.findLast((i) => i.kind === 'model');
    if (last) status(describeCollider(last.model, colliderMode));
  }));
$('debug').addEventListener('change', (e) => {
  world.setDebugDraw(e.target.checked);
  debugLines.visible = e.target.checked;
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').classList.add('on'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.remove('on'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').classList.remove('on');
  if (e.dataTransfer.files[0]) importFile(e.dataTransfer.files[0]);
});

// 点击（不是拖动）场景：从镜头朝点击方向发射小球
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { if (e.button === 0) downAt = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 5) return;
  const ndc = new THREE.Vector2((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const dir = raycaster.ray.direction;
  shootBall(camera.position.clone().addScaledVector(dir, 0.8), dir);
});

// ---------- 碰撞体线框 ----------

let debugArray = new Float32Array(6 * 32768);
const debugGeometry = new THREE.BufferGeometry();
debugGeometry.setAttribute('position', new THREE.BufferAttribute(debugArray, 3).setUsage(THREE.DynamicDrawUsage));
debugGeometry.setDrawRange(0, 0);
const debugLines = new THREE.LineSegments(debugGeometry, new THREE.LineBasicMaterial({ color: 0x00a651 }));
debugLines.frustumCulled = false;
debugLines.visible = false;
scene.add(debugLines);

function updateDebugLines() {
  if (!debugLines.visible) return;
  const { count, target } = world.readDebugLines(debugArray);
  if (target !== debugArray) {
    debugArray = target;
    debugGeometry.setAttribute('position', new THREE.BufferAttribute(debugArray, 3).setUsage(THREE.DynamicDrawUsage));
  }
  debugGeometry.attributes.position.needsUpdate = true;
  debugGeometry.setDrawRange(0, count * 2);
}

// ---------- 主循环 ----------

let last = performance.now();
let accumulator = 0;
let stepMs = 0;
let fps = 60;
let statsAt = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.05;

  if (!paused) {
    accumulator += dt;
    const t0 = performance.now();
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 6) {
      world.step(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 6) accumulator = 0; // 算不过来时丢弃积压的时间，避免越积越多
    if (steps > 0) stepMs += (performance.now() - t0 - stepMs) * 0.1;
  }

  // 把 PhysX 算出的位置和朝向同步到画面；掉出场地的物体直接移除
  for (let i = instances.length - 1; i >= 0; i--) {
    const inst = instances[i];
    world.readPose(inst.body, inst.object);
    if (inst.object.position.y < -15) {
      removeInstance(inst);
      instances.splice(i, 1);
    }
  }
  updateDebugLines();

  if (now - statsAt > 300) {
    statsAt = now;
    let balls = 0;
    for (const inst of instances) if (inst.kind === 'ball') balls++;
    $('s-bodies').textContent = instances.length - balls;
    $('s-balls').textContent = balls;
    $('s-step').textContent = `${stepMs.toFixed(2)} 毫秒/帧`;
    $('s-fps').textContent = `${Math.round(fps)} 帧/秒`;
  }

  controls.update();
  renderer.render(scene, camera);
}

$('loading').remove();
resetScene();
requestAnimationFrame(frame);

// 方便在浏览器控制台里查看内部状态
window.demo = { world, instances, samples, spawn, shootBall, dropRandom, camera };
