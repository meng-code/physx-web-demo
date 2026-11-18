// 生成演示用的示例 3D 模型（OBJ 文件），输出到 public/models/。
// 每个模型由若干"部件"（OBJ 里的 o 分组）组成，网页会像导入任何外部模型一样加载它们。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'models');
mkdirSync(outDir, { recursive: true });

// ---------- 基础几何 ----------

/** 把一圈圈截面（rings）连成一个封闭的实体，两端封口。 */
function loft(name, rings) {
  const verts = [];
  const tris = [];
  const n = rings[0].length;
  for (const ring of rings) verts.push(...ring);
  for (let k = 0; k < rings.length - 1; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = k * n + i, b = k * n + j, c = (k + 1) * n + j, d = (k + 1) * n + i;
      tris.push([a, b, c], [a, c, d]);
    }
  }
  const last = (rings.length - 1) * n;
  for (let i = 1; i < n - 1; i++) {
    tris.push([0, i, i + 1]);
    tris.push([last, last + i, last + i + 1]);
  }
  return orientOutward({ name, verts, tris });
}

function box(name, cx, cy, cz, sx, sy, sz) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const ring = (y) => [
    [cx - hx, y, cz - hz], [cx + hx, y, cz - hz], [cx + hx, y, cz + hz], [cx - hx, y, cz + hz],
  ];
  return loft(name, [ring(cy - hy), ring(cy + hy)]);
}

/** 让每个三角面的法线朝外（部件都是凸的或接近凸的，用质心判断即可）。 */
function orientOutward(part) {
  const c = [0, 0, 0];
  for (const v of part.verts) { c[0] += v[0]; c[1] += v[1]; c[2] += v[2]; }
  c[0] /= part.verts.length; c[1] /= part.verts.length; c[2] /= part.verts.length;
  for (const t of part.tris) {
    const [p, q, r] = t.map((i) => part.verts[i]);
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
    const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const mx = (p[0] + q[0] + r[0]) / 3 - c[0];
    const my = (p[1] + q[1] + r[1]) / 3 - c[1];
    const mz = (p[2] + q[2] + r[2]) / 3 - c[2];
    if (nx * mx + ny * my + nz * mz < 0) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; }
  }
  return part;
}

function writeObj(file, title, parts) {
  const lines = [`# ${title}`, '# 由 scripts/make-models.mjs 生成'];
  let vOffset = 1;
  let nOffset = 1;
  let triCount = 0;
  for (const part of parts) {
    lines.push(`o ${part.name}`);
    for (const v of part.verts) lines.push(`v ${v.map((x) => x.toFixed(5)).join(' ')}`);
    if (part.normals) for (const n of part.normals) lines.push(`vn ${n.map((x) => x.toFixed(4)).join(' ')}`);
    for (const t of part.tris) {
      lines.push(part.normals
        ? `f ${t.map((i) => `${i + vOffset}//${i + nOffset}`).join(' ')}`
        : `f ${t.map((i) => i + vOffset).join(' ')}`);
    }
    vOffset += part.verts.length;
    if (part.normals) nOffset += part.normals.length;
    triCount += part.tris.length;
  }
  writeFileSync(join(outDir, file), lines.join('\n') + '\n');
  console.log(`${file}: ${parts.length} 个部件, ${triCount} 个三角面`);
}

// ---------- 杯子：16 块杯壁 + 杯底 + 8 段把手 ----------
function mug() {
  const parts = [];
  const ro = 0.42, ri = 0.35, y0 = 0.07, y1 = 0.95, N = 16;
  const disc = (y) => Array.from({ length: N }, (_, i) => {
    const a = (i / N) * Math.PI * 2;
    return [ro * Math.cos(a), y, ro * Math.sin(a)];
  });
  parts.push(loft('bottom', [disc(0), disc(y0)]));
  for (let i = 0; i < N; i++) {
    const section = (a) => [
      [ri * Math.cos(a), y0, ri * Math.sin(a)], [ro * Math.cos(a), y0, ro * Math.sin(a)],
      [ro * Math.cos(a), y1, ro * Math.sin(a)], [ri * Math.cos(a), y1, ri * Math.sin(a)],
    ];
    parts.push(loft(`wall_${i}`, [section((i / N) * Math.PI * 2), section(((i + 1) / N) * Math.PI * 2)]));
  }
  const cx = ro - 0.03, cy = 0.51, R = 0.27, rt = 0.05, S = 8, M = 8;
  const ring = (th) => Array.from({ length: M }, (_, k) => {
    const ph = (k / M) * Math.PI * 2;
    const r = R + rt * Math.cos(ph);
    return [cx + r * Math.cos(th), cy + r * Math.sin(th), rt * Math.sin(ph)];
  });
  const a0 = (-80 * Math.PI) / 180, a1 = (80 * Math.PI) / 180;
  for (let s = 0; s < S; s++) {
    parts.push(loft(`handle_${s}`, [ring(a0 + ((a1 - a0) * s) / S), ring(a0 + ((a1 - a0) * (s + 1)) / S)]));
  }
  return parts;
}

// ---------- 椅子 ----------
function chair() {
  const parts = [box('seat', 0, 0.5, 0, 0.9, 0.08, 0.9)];
  for (const [i, [x, z]] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]].entries()) {
    parts.push(box(`leg_${i}`, x, 0.23, z, 0.08, 0.46, 0.08));
  }
  parts.push(box('post_l', -0.4, 0.86, -0.4, 0.08, 0.64, 0.08));
  parts.push(box('post_r', 0.4, 0.86, -0.4, 0.08, 0.64, 0.08));
  parts.push(box('slat_0', 0, 0.78, -0.4, 0.72, 0.1, 0.05));
  parts.push(box('slat_1', 0, 0.98, -0.4, 0.72, 0.1, 0.05));
  parts.push(box('rail', 0, 1.2, -0.4, 0.9, 0.08, 0.08));
  return parts;
}

// ---------- 桌子 ----------
function table() {
  const parts = [box('top', 0, 0.74, 0, 1.5, 0.08, 0.9)];
  for (const [i, [x, z]] of [[-0.67, -0.37], [0.67, -0.37], [-0.67, 0.37], [0.67, 0.37]].entries()) {
    parts.push(box(`leg_${i}`, x, 0.35, z, 0.08, 0.7, 0.08));
  }
  return parts;
}

// ---------- 开口箱子 ----------
function crate() {
  const w = 1.0, h = 0.6, t = 0.06;
  return [
    box('bottom', 0, t / 2, 0, w, t, w),
    box('wall_px', w / 2 - t / 2, h / 2 + t / 2, 0, t, h, w),
    box('wall_nx', -w / 2 + t / 2, h / 2 + t / 2, 0, t, h, w),
    box('wall_pz', 0, h / 2 + t / 2, w / 2 - t / 2, w - 2 * t, h, t),
    box('wall_nz', 0, h / 2 + t / 2, -w / 2 + t / 2, w - 2 * t, h, t),
  ];
}

// ---------- 圆环：12 段 ----------
function torus() {
  const R = 0.5, r = 0.17, SEG = 12, SUB = 2, M = 10;
  const ring = (th) => Array.from({ length: M }, (_, k) => {
    const ph = (k / M) * Math.PI * 2;
    const rr = R + r * Math.cos(ph);
    return [rr * Math.cos(th), r * Math.sin(ph), rr * Math.sin(th)];
  });
  const parts = [];
  for (let s = 0; s < SEG; s++) {
    const rings = [];
    for (let k = 0; k <= SUB; k++) rings.push(ring(((s + k / SUB) / SEG) * Math.PI * 2));
    parts.push(loft(`seg_${s}`, rings));
  }
  return parts;
}

// ---------- 场地：中间平、四周隆起的碗形地形，带两个小土包 ----------
function arena() {
  const HALF = 7, N = 56;
  const smooth = (t) => { const c = Math.min(1, Math.max(0, t)); return c * c * (3 - 2 * c); };
  const bump = (x, z, bx, bz, hgt, sigma) => hgt * Math.exp(-((x - bx) ** 2 + (z - bz) ** 2) / (2 * sigma * sigma));
  const height = (x, z) => {
    const r = Math.hypot(x, z);
    return 2.2 * smooth((r - 4.2) / 2.8) + bump(x, z, -2.3, -1.7, 0.6, 0.65) + bump(x, z, 2.4, 1.6, 0.4, 0.8);
  };
  const verts = [], normals = [], tris = [];
  const e = 0.01;
  for (let iz = 0; iz <= N; iz++) {
    for (let ix = 0; ix <= N; ix++) {
      const x = -HALF + (2 * HALF * ix) / N, z = -HALF + (2 * HALF * iz) / N;
      verts.push([x, height(x, z), z]);
      const dx = (height(x + e, z) - height(x - e, z)) / (2 * e);
      const dz = (height(x, z + e) - height(x, z - e)) / (2 * e);
      const len = Math.hypot(dx, 1, dz);
      normals.push([-dx / len, 1 / len, -dz / len]);
    }
  }
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const a = iz * (N + 1) + ix, b = a + 1, c = a + N + 1, d = c + 1;
      tris.push([a, c, b], [b, c, d]);
    }
  }
  return [{ name: 'terrain', verts, normals, tris }];
}

writeObj('mug.obj', '杯子（空心，带把手）', mug());
writeObj('chair.obj', '椅子', chair());
writeObj('table.obj', '桌子', table());
writeObj('crate.obj', '开口箱子', crate());
writeObj('torus.obj', '圆环', torus());
writeObj('arena.obj', '场地地形（静态）', arena());
