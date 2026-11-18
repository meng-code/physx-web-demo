# PhysX 碰撞演示

在浏览器里运行 NVIDIA PhysX 5.12（WebAssembly 版，纯 CPU），导入 3D 模型并模拟下落和碰撞。
画面由 three.js 绘制，物理计算全部由 PhysX 完成。

在线演示：https://meng-code.github.io/physx-web-demo/

## 运行

```bash
npm install
```

```bash
npm run dev
```

然后打开 http://localhost:5173

## 能做什么

- 投放示例模型（杯子、椅子、桌子、箱子、圆环），观察下落、碰撞、堆叠
- 导入自己的模型：`.glb` `.gltf` `.obj` `.stl` `.ply`，拖进窗口即可
  - 作为动态物体：碰撞体是凸包
  - 作为静态场景：碰撞体是模型原样的三角网格
- 切换动态物体的碰撞体：单个凸包 / 每个部件一个凸包
- 勾选"显示碰撞体线框"，查看 PhysX 实际用来计算碰撞的形状
- 点击场景发射小球

## 文件

- `src/physics.js` — PhysX 的封装：生成凸包和三角网格碰撞体、创建刚体、推进模拟
- `src/models.js` — 读取模型文件，取出顶点和三角面
- `src/main.js` — 画面、界面和主循环
- `scripts/make-models.mjs` — 生成 `public/models/` 下的示例模型（`npm run models`）

## 限制

- 浏览器版只能用 CPU，没有 GPU 加速，也没有 SDF 碰撞和自动凸分解
- 动态物体不能直接用三角网格碰撞，这是 PhysX 本身的规则
- "每个部件一个凸包"依赖模型本身分成了多个子网格；整个模型只有一个网格时等同于单个凸包
- 不支持 Draco 压缩的 glTF
