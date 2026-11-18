// 读取 3D 模型文件，并整理成"渲染用的对象 + 物理用的顶点数据"。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const SUPPORTED = ['glb', 'gltf', 'obj', 'stl', 'ply'];

/** 按扩展名解析模型数据，返回 three.js 的 Object3D。 */
export async function parseModel(ext, buffer) {
  switch (ext) {
    case 'glb':
    case 'gltf': {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const data = ext === 'gltf' ? new TextDecoder().decode(buffer) : buffer;
      const gltf = await new Promise((resolve, reject) => loader.parse(data, '', resolve, reject));
      return gltf.scene;
    }
    case 'obj':
      return new OBJLoader().parse(new TextDecoder().decode(buffer));
    case 'stl':
      return new THREE.Mesh(new STLLoader().parse(buffer));
    case 'ply':
      return new THREE.Mesh(new PLYLoader().parse(buffer));
    default:
      throw new Error(`不支持的格式 .${ext}（支持 ${SUPPORTED.join(' / ')}）`);
  }
}

export async function loadModelFromUrl(url, options) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`加载失败: ${url}`);
  const ext = url.split('.').pop().toLowerCase();
  return buildModel(await parseModel(ext, await res.arrayBuffer()), { ext, ...options });
}

export async function loadModelFromFile(file, options) {
  const ext = file.name.split('.').pop().toLowerCase();
  return buildModel(await parseModel(ext, await file.arrayBuffer()), { ext, name: file.name, ...options });
}

/**
 * 把加载出来的对象整理成模型记录：
 * - template: 用来渲染的对象（已居中并缩放到 targetSize），每次投放时克隆一份
 * - parts:    每个子网格在同一坐标系下的顶点（points）和三角面索引（indices），给物理引擎用
 */
export function buildModel(root, { name = 'model', ext = '', targetSize = 1, onGround = false } = {}) {
  root.updateMatrixWorld(true);

  const meshes = [];
  root.traverse((o) => {
    if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o);
  });
  if (meshes.length === 0) throw new Error('模型里没有找到网格');

  // 先在模型原始坐标系下取出所有顶点
  const v = new THREE.Vector3();
  const box = new THREE.Box3();
  const raw = meshes.map((mesh) => {
    const pos = mesh.geometry.attributes.position;
    const pts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      pts[i * 3] = v.x; pts[i * 3 + 1] = v.y; pts[i * 3 + 2] = v.z;
      box.expandByPoint(v);
    }
    const index = mesh.geometry.index;
    let indices;
    if (index) {
      indices = new Uint32Array(index.count - (index.count % 3));
      for (let i = 0; i < indices.length; i++) indices[i] = index.getX(i);
    } else {
      indices = new Uint32Array(pos.count - (pos.count % 3));
      for (let i = 0; i < indices.length; i++) indices[i] = i;
    }
    return { name: mesh.name, points: pts, indices };
  });

  // 居中 + 统一缩放；onGround 时让模型底部落在 y = 0
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!(maxDim > 0) || !Number.isFinite(maxDim)) throw new Error('模型尺寸异常');
  const s = targetSize / maxDim;
  const offset = new THREE.Vector3(-center.x * s, -center.y * s + (onGround ? (size.y * s) / 2 : 0), -center.z * s);

  let triangles = 0;
  const parts = raw.map((p) => {
    const pts = p.points;
    for (let i = 0; i < pts.length; i += 3) {
      pts[i] = pts[i] * s + offset.x;
      pts[i + 1] = pts[i + 1] * s + offset.y;
      pts[i + 2] = pts[i + 2] * s + offset.z;
    }
    triangles += p.indices.length / 3;
    return p;
  });

  // 渲染模板：外面套一层，带上同样的缩放和平移
  const holder = new THREE.Group();
  holder.add(root);
  holder.scale.setScalar(s);
  holder.position.copy(offset);
  const template = new THREE.Group();
  template.add(holder);

  const plain = ext !== 'glb' && ext !== 'gltf'; // 这些格式通常不带材质，由我们上色
  for (const mesh of meshes) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!mesh.geometry.attributes.normal) mesh.geometry.computeVertexNormals();
  }

  return {
    name,
    template,
    parts,
    plain,
    triangles,
    size: size.multiplyScalar(s),
    cooked: {},
  };
}

/** 合并所有部件的顶点；点太多时等间隔抽样，凸包只需要外轮廓上的点。 */
export function mergedPoints(parts, limit = 6000) {
  let total = 0;
  for (const p of parts) total += p.points.length / 3;
  const stride = Math.max(1, Math.ceil(total / limit));
  const out = [];
  for (const p of parts) {
    for (let i = 0; i < p.points.length; i += 3 * stride) out.push(p.points[i], p.points[i + 1], p.points[i + 2]);
  }
  return new Float32Array(out);
}

/** 合并所有部件成一个大的三角网格（静态碰撞体用）。 */
export function mergedTriangles(parts) {
  let vCount = 0, iCount = 0;
  for (const p of parts) { vCount += p.points.length; iCount += p.indices.length; }
  const positions = new Float32Array(vCount);
  const indices = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const p of parts) {
    positions.set(p.points, vo);
    const base = vo / 3;
    for (let i = 0; i < p.indices.length; i++) indices[io + i] = p.indices[i] + base;
    vo += p.points.length;
    io += p.indices.length;
  }
  return { positions, indices };
}
