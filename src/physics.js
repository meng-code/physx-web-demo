// 对 NVIDIA PhysX（WebAssembly 版）的一层薄封装。
// 这里的每个调用都对应 PhysX C++ SDK 里的同名接口。
import PhysXFactory from 'physx-js-webidl';
import wasmUrl from 'physx-js-webidl/physx-js-webidl.wasm?url';

const isNull = (obj) => !obj || obj.ptr === 0;
// 绑定里的静态方法有的挂在类上，有的挂在 prototype 上，两种都兼容
const callStatic = (cls, name, ...args) =>
  typeof cls[name] === 'function' ? cls[name](...args) : cls.prototype[name](...args);

export async function createWorld() {
  const P = await PhysXFactory({ locateFile: () => wasmUrl });
  return new World(P);
}

class World {
  constructor(P) {
    this.P = P;
    const v = P.PHYSICS_VERSION;
    this.versionText = `${v >>> 24}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}`;

    this.allocator = new P.PxDefaultAllocator();
    this.errorCallback = new P.PxDefaultErrorCallback();
    this.foundation = P.CreateFoundation(v, this.allocator, this.errorCallback);
    this.tolerances = new P.PxTolerancesScale();
    this.physics = P.CreatePhysics(v, this.foundation, this.tolerances);

    // 复用的临时对象
    this.vec = new P.PxVec3(0, 0, 0);
    this.quat = new P.PxQuat(0, 0, 0, 1);
    this.transform = new P.PxTransform(P.PxIDENTITYEnum.PxIdentity);

    const sceneDesc = new P.PxSceneDesc(this.tolerances);
    this.vec.x = 0; this.vec.y = -9.81; this.vec.z = 0;
    sceneDesc.gravity = this.vec;
    sceneDesc.cpuDispatcher = P.DefaultCpuDispatcherCreate(0);
    sceneDesc.filterShader = P.DefaultFilterShader();
    this.scene = this.physics.createScene(sceneDesc);
    P.destroy(sceneDesc);

    // 摩擦 0.6 / 0.5，弹性 0.2
    this.material = this.physics.createMaterial(0.6, 0.5, 0.2);
    this.shapeFlags = new P.PxShapeFlags(
      P.PxShapeFlagEnum.eSIMULATION_SHAPE | P.PxShapeFlagEnum.eSCENE_QUERY_SHAPE | P.PxShapeFlagEnum.eVISUALIZATION,
    );
    this.filterData = new P.PxFilterData(1, 1, 0, 0);
    this.unitScale = new P.PxMeshScale();
    this.convexGeomFlags = new P.PxConvexMeshGeometryFlags(P.PxConvexMeshGeometryFlagEnum.eTIGHT_BOUNDS);

    // "cooking"：把顶点数据预处理成 PhysX 的碰撞结构
    this.cookingParams = new P.PxCookingParams(this.tolerances);
    this.triCookingParams = new P.PxCookingParams(this.tolerances);
    this.triCookingParams.meshPreprocessParams.raise(P.PxMeshPreprocessingFlagEnum.eWELD_VERTICES);
    this.triCookingParams.meshWeldTolerance = 0.0005;

    this.debugEnabled = false;
  }

  /** WASM 内存的 float 视图（这个构建只导出了 HEAPU8/HEAPU32；内存增长后要重新取）。 */
  _f32() {
    const buffer = this.P.HEAPU8.buffer;
    if (!this._f32View || this._f32View.buffer !== buffer) this._f32View = new Float32Array(buffer);
    return this._f32View;
  }

  // ---------- 生成碰撞体 ----------

  /** 把一堆点交给 PhysX 生成凸包（PxConvexMesh）。失败返回 null。 */
  cookConvex(points) {
    const P = this.P;
    const count = points.length / 3;
    if (count < 4) return null;
    const ptr = P._webidl_malloc(points.length * 4);
    this._f32().set(points, ptr >> 2);
    const desc = new P.PxConvexMeshDesc();
    desc.points.count = count;
    desc.points.stride = 12;
    desc.points.data = ptr;
    const flags = new P.PxConvexFlags(P.PxConvexFlagEnum.eCOMPUTE_CONVEX);
    desc.flags = flags;
    const mesh = P.CreateConvexMesh(this.cookingParams, desc);
    P.destroy(flags);
    P.destroy(desc);
    P._webidl_free(ptr);
    return isNull(mesh) ? null : mesh;
  }

  /**
   * 为一组点生成一个碰撞形状描述：优先凸包；
   * 凸包生成失败（例如所有点共面）时退回到包围盒。
   */
  cookShape(points) {
    const mesh = this.cookConvex(points);
    if (mesh) {
      return { type: 'convex', mesh, vertices: mesh.getNbVertices(), polygons: mesh.getNbPolygons() };
    }
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < points.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (points[i + k] < min[k]) min[k] = points[i + k];
        if (points[i + k] > max[k]) max[k] = points[i + k];
      }
    }
    return {
      type: 'box',
      center: min.map((m, k) => (m + max[k]) / 2),
      half: min.map((m, k) => Math.max((max[k] - m) / 2, 0.01)),
      vertices: 8,
      polygons: 6,
    };
  }

  /** 把三角面原样交给 PhysX 生成三角网格碰撞体（PxTriangleMesh），只能用于静态物体。 */
  cookTriangleMesh(positions, indices) {
    const P = this.P;
    const vPtr = P._webidl_malloc(positions.length * 4);
    this._f32().set(positions, vPtr >> 2);
    const iPtr = P._webidl_malloc(indices.length * 4);
    P.HEAPU32.set(indices, iPtr >> 2);
    const desc = new P.PxTriangleMeshDesc();
    desc.points.count = positions.length / 3;
    desc.points.stride = 12;
    desc.points.data = vPtr;
    desc.triangles.count = indices.length / 3;
    desc.triangles.stride = 12;
    desc.triangles.data = iPtr;
    const mesh = P.CreateTriangleMesh(this.triCookingParams, desc);
    P.destroy(desc);
    P._webidl_free(vPtr);
    P._webidl_free(iPtr);
    return isNull(mesh) ? null : mesh;
  }

  // ---------- 创建 / 删除物体 ----------

  _setTransform(position, quaternion) {
    this.vec.x = position.x; this.vec.y = position.y; this.vec.z = position.z;
    this.transform.p = this.vec;
    if (quaternion) {
      this.quat.x = quaternion.x; this.quat.y = quaternion.y; this.quat.z = quaternion.z; this.quat.w = quaternion.w;
    } else {
      this.quat.x = 0; this.quat.y = 0; this.quat.z = 0; this.quat.w = 1;
    }
    this.transform.q = this.quat;
    return this.transform;
  }

  _attach(actor, geometry, localCenter) {
    const shape = this.physics.createShape(geometry, this.material, true, this.shapeFlags);
    shape.setSimulationFilterData(this.filterData);
    if (localCenter) {
      shape.setLocalPose(this._setTransform({ x: localCenter[0], y: localCenter[1], z: localCenter[2] }));
    }
    actor.attachShape(shape);
    shape.release(); // 形状现在归 actor 所有
    this.P.destroy(geometry);
    return shape;
  }

  /** 静态三角网格物体（地形、建筑这类不会动的东西）。 */
  addStaticTriangleMesh(positions, indices, { doubleSided = false, visualize = true } = {}) {
    const P = this.P;
    const triMesh = this.cookTriangleMesh(positions, indices);
    if (!triMesh) return null;
    const flags = new P.PxMeshGeometryFlags(doubleSided ? P.PxMeshGeometryFlagEnum.eDOUBLE_SIDED : 0);
    const geometry = new P.PxTriangleMeshGeometry(triMesh, this.unitScale, flags);
    const actor = this.physics.createRigidStatic(this._setTransform({ x: 0, y: 0, z: 0 }));
    const shape = this.physics.createShape(geometry, this.material, true, this.shapeFlags);
    shape.setSimulationFilterData(this.filterData);
    if (!visualize) shape.setFlag(P.PxShapeFlagEnum.eVISUALIZATION, false);
    actor.attachShape(shape);
    shape.release();
    P.destroy(geometry);
    P.destroy(flags);
    this.scene.addActor(actor);
    return { actor, triMesh, triangles: triMesh.getNbTriangles(), vertices: triMesh.getNbVertices() };
  }

  removeStatic(handle) {
    this.scene.removeActor(handle.actor);
    handle.actor.release();
    handle.triMesh.release();
  }

  /** 动态刚体，碰撞体由若干凸包（或包围盒）组成。 */
  addDynamic(shapes, position, quaternion, density = 600) {
    const P = this.P;
    const body = this.physics.createRigidDynamic(this._setTransform(position, quaternion));
    for (const s of shapes) {
      if (s.type === 'convex') {
        this._attach(body, new P.PxConvexMeshGeometry(s.mesh, this.unitScale, this.convexGeomFlags));
      } else {
        this._attach(body, new P.PxBoxGeometry(s.half[0], s.half[1], s.half[2]), s.center);
      }
    }
    // 按密度由碰撞体形状算出质量、质心和转动惯量
    callStatic(P.PxRigidBodyExt, 'updateMassAndInertia', body, density);
    // 物体生成时如果互相重叠，限制"挤开"的速度，免得被弹飞或穿过地形
    body.setMaxDepenetrationVelocity(3);
    this.scene.addActor(body);
    return body;
  }

  addBall(radius, position, velocity, density = 2500) {
    const P = this.P;
    const body = this.physics.createRigidDynamic(this._setTransform(position));
    this._attach(body, new P.PxSphereGeometry(radius));
    callStatic(P.PxRigidBodyExt, 'updateMassAndInertia', body, density);
    // 高速小球开启推测式连续碰撞检测，避免穿透薄壁
    body.setRigidBodyFlag(P.PxRigidBodyFlagEnum.eENABLE_SPECULATIVE_CCD, true);
    this.vec.x = velocity.x; this.vec.y = velocity.y; this.vec.z = velocity.z;
    body.setLinearVelocity(this.vec, true);
    this.scene.addActor(body);
    return body;
  }

  removeBody(body) {
    this.scene.removeActor(body);
    body.release();
  }

  // ---------- 模拟 ----------

  step(dt) {
    this.scene.simulate(dt);
    this.scene.fetchResults(true);
  }

  /** 把刚体当前的位置和朝向写进 three.js 对象。 */
  readPose(body, object3d) {
    const t = body.getGlobalPose();
    const p = t.p, q = t.q;
    object3d.position.set(p.x, p.y, p.z);
    object3d.quaternion.set(q.x, q.y, q.z, q.w);
  }

  getMass(body) {
    return body.getMass();
  }

  // ---------- 碰撞体可视化（PhysX 自带的调试绘制） ----------

  setDebugDraw(enabled) {
    const P = this.P;
    this.debugEnabled = enabled;
    this.scene.setVisualizationParameter(P.PxVisualizationParameterEnum.eSCALE, enabled ? 1 : 0);
    this.scene.setVisualizationParameter(P.PxVisualizationParameterEnum.eCOLLISION_SHAPES, enabled ? 1 : 0);
  }

  /**
   * 读取 PhysX 输出的调试线段，写入 target（每条线 6 个 float）。
   * 返回 { count, target }，target 不够大时会换成更大的数组。
   */
  readDebugLines(target) {
    if (!this.debugEnabled) return { count: 0, target };
    const rb = this.scene.getRenderBuffer();
    const count = rb.getNbLines();
    if (count === 0) return { count: 0, target };
    if (target.length < count * 6) target = new Float32Array(Math.ceil(count * 1.5) * 6);
    // PxDebugLine 的内存布局: pos0(3 float) color0(u32) pos1(3 float) color1(u32) = 32 字节
    const base = rb.getLines().ptr >> 2;
    const heap = this._f32();
    for (let i = 0, o = 0; i < count; i++) {
      const s = base + i * 8;
      target[o++] = heap[s]; target[o++] = heap[s + 1]; target[o++] = heap[s + 2];
      target[o++] = heap[s + 4]; target[o++] = heap[s + 5]; target[o++] = heap[s + 6];
    }
    return { count, target };
  }
}
