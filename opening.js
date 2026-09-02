/* ================================================================
   THREEHALVES — 开场序列
   ----------------------------------------------------------------
   [1] 渲染器 / 场景 / 材质工具 / 火焰与烟雾
   [2] 室外：地形、远景火墙、树林
   [3] 建筑：5 层住宅外壳（板材拼装，5F 留出真实窗洞）+ 停用电梯井
   [4] 5F 房间：机器人所在的室内（窗外森林火灾，室内局部燃烧）
   [5] Threehalves：全身纯黑 + 羊头（盘羊卷角）
   [6] 玩家房间 503：睁眼后的第一人称场景
   [7] 音效（Web Audio 占位，★ 处可替换 Pixabay 素材）
   [8] 字幕打字机
   [9] 相机路径（Catmull-Rom，速度连续）
   [10] 时间轴事件
   [11] 状态机：intro → 等待点击 → 闭眼 → 睁眼 → 玩家视角
   [12] 玩家控制：Pointer Lock 鼠标视角 + ESC 暂停菜单

   调试：opening.html?t=40      定格开场第 40 秒
         opening.html?scene=play 直接跳到玩家视角
   ================================================================ */

/* ==================== [1] 基础 ==================== */
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
/* 像素比封到 1.5：高 DPI 屏上 2.0 意味着 4 倍像素量，是最贵的一项，
   而这个画面本身是暗场 + 低多边形，1.5 看不出差别 */
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.78;   // 夜间火场：整体压暗，靠火光局部提亮
if (THREE.sRGBEncoding) renderer.outputEncoding = THREE.sRGBEncoding;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x040406);
scene.fog = new THREE.FogExp2(0x090508, 0.011);

const cam = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.05, 400);

/* 材质缓存：原来每次调用都 new 一个 MeshStandardMaterial（全场 210 次），
   相同参数各自成一个 draw call 批次。按参数 key 复用后材质数降到几十个。
   注意：只缓存**非自发光**材质 —— 会在运行时被改的（压力罐、台灯、眼睛、
   手机屏幕这些 emissiveIntensity 动画）全都带 emissive，共享会互相串。 */
const _matCache = new Map();
function M(color, o) {
  o = o || {};
  const r = o.r != null ? o.r : 0.9;
  const m = o.m != null ? o.m : 0.05;
  const e = o.e != null ? o.e : 0x000000;
  const ei = o.ei != null ? o.ei : 1;
  const mk = function () {
    return new THREE.MeshStandardMaterial({
      color: color, roughness: r, metalness: m,
      flatShading: true, emissive: e, emissiveIntensity: ei
    });
  };
  if (e !== 0x000000) return mk();          // 自发光的一律独立实例
  const key = color + '|' + r + '|' + m;
  let hit = _matCache.get(key);
  if (!hit) { hit = mk(); _matCache.set(key, hit); }
  return hit;
}
/* 五楼：房间地板 y=0，层高 2.8m → 室外地面在 y ≈ -13.6。
   坠落序列和外立面都要用，所以放在最前面声明 */
const FALL_GROUND = -13.6;
const FALL_GROUND_Y = FALL_GROUND + 0.42;   // 侧脸躺地时镜头离地高度
/* 坠落分三段。延长总时长时只加长「翻出窗台的失重段」，
   加速段的重力和末速度保持原样，所以高速下坠的观感不变 */
const FALL_T_JUMP = 1.5;                     // 撑上窗台、身体前倾
const FALL_T_TIP = 2.3;                      // 翻过窗台的失重瞬间（这一段是新加的）
const FALL_T_LAND = 4.0;                     // 触地
const FALL_G_TIP = 2.0;                      // 失重段的微弱下坠
const FALL_G = 8.6;                          // 加速段重力（和之前一致）
const FALL_V_TIP = FALL_G_TIP * (FALL_T_TIP - FALL_T_JUMP);   // 进入加速段时的初速度

/* 几何缓存：全场 277 次 box() 各自 new 一个 BoxGeometry，尺寸重复率很高。
   按尺寸 key 复用后，GPU 缓冲区数量与显存占用明显下降。
   （几何被共享，所以不能再对单个 mesh 改 geometry —— 本工程没有这么做）*/
const _geoCache = new Map();
function box(w, h, d, mat) {
  const key = w + ',' + h + ',' + d;
  let g = _geoCache.get(key);
  if (!g) { g = new THREE.BoxGeometry(w, h, d); _geoCache.set(key, g); }
  return new THREE.Mesh(g, mat);
}
function put(m, x, y, z) { m.position.set(x, y, z); return m; }

/* ---- 火焰面片（替代大量粒子）---- */
const flames = [];
const outFireWalls = [];   // 玩家房间窗外那片火墙的材质，需要随时间推进
function flameMat(seed) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { t: { value: 0 }, seed: { value: seed }, fade: { value: 1 } },
    vertexShader:
      'varying vec2 vUv; void main(){ vUv=uv;' +
      ' gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: [
      'varying vec2 vUv; uniform float t; uniform float seed; uniform float fade;',
      'float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7))+seed)*43758.5453); }',
      'float n(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
      ' return mix(mix(h(i),h(i+vec2(1.0,0.0)),f.x), mix(h(i+vec2(0.0,1.0)),h(i+vec2(1.0,1.0)),f.x), f.y); }',
      'void main(){',
      ' vec2 uv=vUv;',
      ' float flow = n(vec2(uv.x*3.5, uv.y*2.2 - t*1.7))*0.6 + n(vec2(uv.x*7.0, uv.y*4.0 - t*2.9))*0.4;',
      ' float width = 1.0 - uv.y*0.72 + 0.06;',
      ' float body = smoothstep(1.0, 0.0, abs(uv.x-0.5)*2.0/width);',
      ' float fadeY = smoothstep(1.0, 0.10, uv.y) * smoothstep(0.0, 0.10, uv.y);',
      ' float a = body*fadeY*(0.3+0.8*flow);',
      ' vec3 col = mix(vec3(1.0,0.80,0.34), vec3(1.0,0.28,0.05), uv.y);',
      ' col = mix(col, vec3(0.38,0.06,0.02), smoothstep(0.5,1.0,uv.y));',
      ' gl_FragColor = vec4(col*0.95, a*0.6*fade);',
      '}'
    ].join('\n')
  });
}
function addFlame(parent, x, y, z, w, h) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), flameMat(Math.random() * 100));
  m.position.set(x, y + h * 0.5, z);
  parent.add(m); flames.push(m);
  /* 运行时新增的火焰（QTE 砸落的外机残骸等）也要有 billboard 补偿 */
  parent.updateWorldMatrix(true, false);
  m.userData.invQ = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  return m;
}

/* ---- 烟雾面片 ---- */
const smokeTex = (function () {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(70,62,58,0.55)');
  g.addColorStop(0.5, 'rgba(40,35,33,0.25)');
  g.addColorStop(1, 'rgba(20,18,17,0)');
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();
/* ---- 眼睛光晕贴图（加性混合，让黑暗里也能读出亮光）---- */
const glowTex = (function () {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.16, 'rgba(255,253,246,0.8)');
  g.addColorStop(0.42, 'rgba(255,240,214,0.24)');
  g.addColorStop(1, 'rgba(255,224,186,0)');
  c.fillStyle = g; c.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(cv);
})();

const smokes = [];
function addSmoke(parent, x, y, z, s) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s),
    new THREE.MeshBasicMaterial({ map: smokeTex, transparent: true, depthWrite: false, opacity: 0.5 }));
  m.position.set(x, y, z);
  m.userData = { ox: x, oy: y, oz: z, ph: Math.random() * 9, sp: 0.3 + Math.random() * 0.4 };
  parent.add(m); smokes.push(m);
  return m;
}

/* ---- 火星（大幅削减）---- */
function makeEmbers(n, b, color, size) {
  const geo = new THREE.BufferGeometry();
  const arr = new Float32Array(n * 3), vel = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = b.x0 + Math.random() * (b.x1 - b.x0);
    arr[i * 3 + 1] = b.y0 + Math.random() * (b.y1 - b.y0);
    arr[i * 3 + 2] = b.z0 + Math.random() * (b.z1 - b.z0);
    vel[i] = 0.3 + Math.random() * 0.9;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: color, size: size, transparent: true, opacity: 0.6,
    blending: THREE.AdditiveBlending, depthWrite: false
  }));
  pts.userData = { vel: vel, n: n, b: b };
  return pts;
}
function riseEmbers(pts, dt) {
  const p = pts.geometry.attributes.position, u = pts.userData, b = u.b;
  for (let i = 0; i < u.n; i++) {
    let y = p.getY(i) + u.vel[i] * dt;
    if (y > b.y1) {
      y = b.y0;
      p.setX(i, b.x0 + Math.random() * (b.x1 - b.x0));
      p.setZ(i, b.z0 + Math.random() * (b.z1 - b.z0));
    }
    p.setY(i, y);
  }
  p.needsUpdate = true;
}

/* ==================== [2] 室外 ==================== */
const worldSet = new THREE.Group();   // 室外 + 建筑 + 5F 房间（进入玩家视角后整体隐藏）
scene.add(worldSet);

const outLights = new THREE.Group();
worldSet.add(outLights);
outLights.add(new THREE.HemisphereLight(0x1a1319, 0x070506, 0.36));
const moon = new THREE.DirectionalLight(0x30405a, 0.26);
moon.position.set(-34, 62, 24); outLights.add(moon);
const fireGlow = new THREE.PointLight(0xff5518, 2.0, 150, 1.7);
fireGlow.position.set(-26, 10, -62); outLights.add(fireGlow);
const fireGlow2 = new THREE.PointLight(0xff7326, 1.3, 130, 1.7);
fireGlow2.position.set(40, 8, -58); outLights.add(fireGlow2);

/* 地面 */
{
  const g = new THREE.PlaneGeometry(280, 280, 40, 40);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setZ(i, Math.sin(p.getX(i) * 0.14) * Math.cos(p.getY(i) * 0.11) * 0.7 + Math.random() * 0.14);
  }
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, M(0x0c0a09));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
  worldSet.add(ground);
}

/* 远景火墙 */
const fireWallMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide,
  uniforms: { t: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv;' +
    ' gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: [
    'varying vec2 vUv; uniform float t;',
    'float h(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5); }',
    'void main(){',
    ' float n = h(floor(vUv*vec2(52.0,10.0)) + floor(t*2.6));',
    ' float hh = smoothstep(0.0,0.66,vUv.y);',
    ' vec3 col = mix(vec3(1.0,0.34,0.07), vec3(0.42,0.05,0.02), hh);',
    ' float a = (1.0-hh)*(0.45+0.55*n)*0.7;',
    ' gl_FragColor = vec4(col*1.5, a);',
    '}'
  ].join('\n')
});
{
  const w = new THREE.Mesh(new THREE.PlaneGeometry(340, 64), fireWallMat);
  w.position.set(0, 14, -102); worldSet.add(w);
}

/* 树林（无逐树粒子；少量树带火焰面片） */
const treeMatTrunk = M(0x100d0b), treeMatLeaf = M(0x0b110b), treeMatBurn = M(0x120c09);
function makeTree(x, z, burning) {
  const g = new THREE.Group();
  const th = 3 + Math.random() * 2.2;
  const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, th, 5), treeMatTrunk);
  tr.position.y = th / 2; g.add(tr);
  for (let i = 0; i < 3; i++) {
    const c = new THREE.Mesh(new THREE.ConeGeometry(1.55 - i * 0.36, 1.7, 6),
      burning ? treeMatBurn : treeMatLeaf);
    c.position.y = th + i * 1.05; g.add(c);
  }
  if (burning) addFlame(g, 0, th * 0.55, 0, 2.1, 3.4);
  g.position.set(x, 0, z);
  g.rotation.y = Math.random() * 6.28;
  g.scale.setScalar(0.85 + Math.random() * 0.5);
  worldSet.add(g);
}

/* ---- 低多边形汽车（地下车库）：车身 + 驾驶舱 + 四轮；burning 时带火焰和光 ---- */
function makeCar(x, z, rotY, color, burning) {
  const g = new THREE.Group();
  const bodyM = M(color, { r: 0.42, m: 0.5 });
  g.add(put(box(1.78, 0.55, 4.3, bodyM), 0, 0.62, 0));                 // 车身
  g.add(put(box(1.6, 0.5, 2.1, M(0x0a0e12, { r: 0.2, m: 0.6 })), 0, 1.12, -0.2));  // 驾驶舱
  const wheelM = M(0x0a0a0a, { r: 0.9 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.24, 10), wheelM);
    w.rotation.z = Math.PI / 2; w.position.set(sx * 0.82, 0.33, sz * 1.35); g.add(w);
  }
  if (burning) {
    addFlame(g, 0, 1.3, 0.3, 1.2, 1.7);
    addFlame(g, 0.3, 1.0, -0.9, 0.8, 1.1);
    g.add(put(new THREE.PointLight(0xff5a1c, 1.5, 6.5, 2), 0, 1.5, 0));
  }
  g.position.set(x, 0, z);
  g.rotation.y = rotY;
  return g;
}
for (let i = 0; i < 88; i++) {
  const a = (i / 88) * Math.PI * 2 + Math.random() * 0.16;
  const r = 29 + Math.random() * 30;
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  if (Math.abs(x) < 9 && z > 16) continue;      // 正面留出运镜视野
  makeTree(x, z, i % 9 === 0);
}
for (let i = 0; i < 10; i++) {                  // 倒木
  const a = Math.random() * 6.28, r = 24 + Math.random() * 10;
  const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 3 + Math.random() * 2, 5), M(0x100c08));
  log.position.set(Math.cos(a) * r, 0.24, Math.sin(a) * r);
  log.rotation.z = Math.PI / 2; log.rotation.y = Math.random() * 3.14;
  worldSet.add(log);
}
const outEmbers = makeEmbers(60, { x0: -70, x1: 70, y0: 0, y1: 26, z0: -80, z1: 30 }, 0xff6a26, 0.14);
worldSet.add(outEmbers);

/* ==================== [3] 建筑外壳 ==================== */
const BW = 16, BD = 12, FH = 3.2, FLOORS = 5, BH = FH * FLOORS, BZ = -8;
const FRONT_Z = BZ + BD / 2;                 // -2
const HOLE = { x0: -5.2, x1: -1.8, y0: 13.4, y1: 15.7 };   // 5F 目标窗洞
const bMat = M(0x15130f, { r: 0.97 });
const bDark = M(0x100e0c, { r: 0.97 });
const building = new THREE.Group();
worldSet.add(building);

const flickerWins = [];
let elevLight, elevPanelMat, bFire;
{
  const T = 0.35;
  building.add(put(box(BW, BH, T, bMat), 0, BH / 2, BZ - BD / 2));      // 后墙
  building.add(put(box(T, BH, BD, bMat), -BW / 2, BH / 2, BZ));          // 左墙
  building.add(put(box(T, BH, BD, bMat), BW / 2, BH / 2, BZ));           // 右墙
  building.add(put(box(BW + 1.4, 0.5, BD + 1.4, bDark), 0, BH + 0.25, BZ)); // 屋顶
  building.add(put(box(BW, 0.4, BD, bDark), 0, 0.2, BZ));                // 底板

  /* 建筑三面（非正面）的大火光面片：让整栋楼被火场包围 */
  const sideFireMat = fireWallMat.clone();
  outFireWalls.push(sideFireMat);
  // 后墙（-z）：面朝 +z 方向（朝建筑内部/玩家方向）
  const backFire = new THREE.Mesh(new THREE.PlaneGeometry(BW + 2, BH + 2), sideFireMat);
  backFire.position.set(0, BH / 2, BZ - BD / 2 - 0.16);
  building.add(backFire);
  // 左墙（-x）：面朝 +x 方向
  const leftFire = new THREE.Mesh(new THREE.PlaneGeometry(BD + 2, BH + 2), sideFireMat.clone());
  leftFire.position.set(-BW / 2 - 0.16, BH / 2, BZ);
  leftFire.rotation.y = Math.PI / 2;
  building.add(leftFire);
  outFireWalls.push(leftFire.material);
  // 右墙（+x）：面朝 -x 方向
  const rightFire = new THREE.Mesh(new THREE.PlaneGeometry(BD + 2, BH + 2), sideFireMat.clone());
  rightFire.position.set(BW / 2 + 0.16, BH / 2, BZ);
  rightFire.rotation.y = -Math.PI / 2;
  building.add(rightFire);
  outFireWalls.push(rightFire.material);

  // 前墙：分块拼装，给 5F 留出真实窗洞（相机从这里穿进去）
  const L = -BW / 2, R = BW / 2;
  building.add(put(box(HOLE.x0 - L, BH, T, bMat), (L + HOLE.x0) / 2, BH / 2, FRONT_Z));
  building.add(put(box(R - HOLE.x1, BH, T, bMat), (HOLE.x1 + R) / 2, BH / 2, FRONT_Z));
  building.add(put(box(HOLE.x1 - HOLE.x0, HOLE.y0, T, bMat),
    (HOLE.x0 + HOLE.x1) / 2, HOLE.y0 / 2, FRONT_Z));
  building.add(put(box(HOLE.x1 - HOLE.x0, BH - HOLE.y1, T, bMat),
    (HOLE.x0 + HOLE.x1) / 2, (HOLE.y1 + BH) / 2, FRONT_Z));

  for (let f = 1; f < FLOORS; f++) {   // 楼层分隔线
    building.add(put(box(BW + 0.5, 0.16, 0.5, bDark), 0, f * FH, FRONT_Z + 0.1));
  }

  // 其他窗户：部分透出火光
  for (let f = 0; f < FLOORS; f++) {
    for (let wx = 0; wx < 5; wx++) {
      const px = -BW / 2 + 2 + wx * (BW - 4) / 4;
      const py = f * FH + 1.75;
      if (px > HOLE.x0 - 1 && px < HOLE.x1 + 1 && py > HOLE.y0 - 1 && py < HOLE.y1 + 1) continue;
      const burn = Math.random() < 0.2;
      const mat = burn ? M(0x160a04, { e: 0xff7a1a, ei: 1.3 }) : M(0x07070a);
      building.add(put(box(1.75, 1.55, 0.12, mat), px, py, FRONT_Z + 0.2));
      building.add(put(box(1.95, 1.75, 0.1, bDark), px, py, FRONT_Z + 0.12));
      if (burn) flickerWins.push({ mat: mat, ph: Math.random() * 9, sp: 3.5 + Math.random() * 5 });
    }
  }

  building.add(put(box(3.6, 3.8, 0.22, M(0x1d1b17)), 0, 1.9, FRONT_Z + 0.14));   // 门框
  building.add(put(box(3.0, 3.4, 0.14, M(0x08080b)), 0, 1.7, FRONT_Z + 0.26));    // 门

  // 停用的外挂电梯井
  building.add(put(box(3, BH + 1.4, 3, M(0x110f0d)), BW / 2 + 1.7, (BH + 1.4) / 2, BZ + 1));
  elevLight = new THREE.PointLight(0xff1f11, 0.7, 6, 2);
  elevLight.position.set(BW / 2 + 3.4, 2.2, BZ + 2.5); building.add(elevLight);
  elevPanelMat = M(0x080808, { e: 0xff2211, ei: 1.3 });
  building.add(put(box(0.46, 0.76, 0.06, elevPanelMat), BW / 2 + 3.24, 2.2, BZ + 2.5));
  {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 128;
    const x = cv.getContext('2d');
    x.fillStyle = '#111111'; x.fillRect(0, 0, 256, 128);
    x.strokeStyle = '#4d0e0e'; x.lineWidth = 8; x.strokeRect(6, 6, 244, 116);
    x.fillStyle = '#e02a1a'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = 'bold 44px "Microsoft YaHei",sans-serif'; x.fillText('电梯停用', 128, 44);
    x.font = 'bold 19px sans-serif'; x.fillText('OUT OF SERVICE', 128, 92);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
    sign.position.set(BW / 2 + 1.7, 3.5, BZ + 2.55); building.add(sign);
  }

  bFire = new THREE.PointLight(0xff6a1a, 0.9, 24, 2);
  bFire.position.set(-BW / 2 + 1, BH * 0.35, FRONT_Z + 2); building.add(bFire);
}

/* ==================== [4] 5F 房间（终场：机器人所在的室内） ==================== */
const ROOM = { x0: -7.6, x1: 1.6, z0: -8.0, z1: FRONT_Z - 0.18, y0: 12.8, y1: 15.8 };
const roomGrp = new THREE.Group();
worldSet.add(roomGrp);
let roomFireA, roomFireB, roomRim, corridorFire;
{
  const wallMat = M(0x0e0d0c, { r: 0.98 });
  const wallBurn = M(0x090807, { r: 0.98 });
  const floorMat = M(0x0b0908, { r: 0.97 });
  const W = ROOM.x1 - ROOM.x0, D = ROOM.z1 - ROOM.z0;
  const cx = (ROOM.x0 + ROOM.x1) / 2, cz = (ROOM.z0 + ROOM.z1) / 2;

  // 地板 / 天花板 / 塌了一角的板
  roomGrp.add(put(box(W, 0.2, D, floorMat), cx, ROOM.y0 - 0.1, cz));
  roomGrp.add(put(box(W, 0.2, D, wallBurn), cx, ROOM.y1 + 0.1, cz));
  const slab = put(box(2.4, 0.16, 2.0, wallBurn), ROOM.x0 + 1.6, ROOM.y1 - 0.5, ROOM.z0 + 1.4);
  slab.rotation.z = 0.34; slab.rotation.x = -0.12; roomGrp.add(slab);

  // 左 / 右墙
  roomGrp.add(put(box(0.24, 3.0, D, wallMat), ROOM.x0, ROOM.y0 + 1.5, cz));
  roomGrp.add(put(box(0.24, 3.0, D, wallMat), ROOM.x1, ROOM.y0 + 1.5, cz));

  // 后隔墙（z0）——中间是它锯穿进来的洞
  const HX0 = -5.1, HX1 = -2.6, HY = 2.75;
  roomGrp.add(put(box(HX0 - ROOM.x0, 3.0, 0.24, wallMat), (ROOM.x0 + HX0) / 2, ROOM.y0 + 1.5, ROOM.z0));
  roomGrp.add(put(box(ROOM.x1 - HX1, 3.0, 0.24, wallMat), (HX1 + ROOM.x1) / 2, ROOM.y0 + 1.5, ROOM.z0));
  roomGrp.add(put(box(HX1 - HX0, 3.0 - HY, 0.24, wallMat),
    (HX0 + HX1) / 2, ROOM.y0 + HY + (3.0 - HY) / 2, ROOM.z0));
  for (let i = 0; i < 8; i++) {     // 锯口碎裂边缘：只留在洞的两侧竖边，不挡住头部剪影
    const side = i < 4 ? HX0 : HX1;
    const c = put(box(0.14 + Math.random() * 0.22, 0.16 + Math.random() * 0.3, 0.26, wallBurn),
      side + (Math.random() - 0.5) * 0.3,
      ROOM.y0 + 0.3 + Math.random() * 2.1, ROOM.z0);
    c.rotation.z = (Math.random() - 0.5) * 0.9; roomGrp.add(c);
  }
  for (let i = 0; i < 7; i++) {     // 地上碎块
    const r = put(box(0.2 + Math.random() * 0.4, 0.1, 0.2 + Math.random() * 0.3, wallBurn),
      HX0 - 0.4 + Math.random() * 3.2, ROOM.y0 + 0.05, ROOM.z0 + 0.4 + Math.random() * 1.2);
    r.rotation.y = Math.random() * 3.14; roomGrp.add(r);
  }

  // 窗（前墙洞口）：窗框 + 残余玻璃 + 烧焦的窗帘
  const fz = FRONT_Z - 0.02;
  roomGrp.add(put(box(HOLE.x1 - HOLE.x0 + 0.3, 0.14, 0.3, M(0x1c1a16)), (HOLE.x0 + HOLE.x1) / 2, HOLE.y0, fz));
  roomGrp.add(put(box(HOLE.x1 - HOLE.x0 + 0.3, 0.12, 0.3, M(0x1c1a16)), (HOLE.x0 + HOLE.x1) / 2, HOLE.y1, fz));
  roomGrp.add(put(box(0.14, HOLE.y1 - HOLE.y0, 0.3, M(0x1c1a16)), HOLE.x0, (HOLE.y0 + HOLE.y1) / 2, fz));
  roomGrp.add(put(box(0.14, HOLE.y1 - HOLE.y0, 0.3, M(0x1c1a16)), HOLE.x1, (HOLE.y0 + HOLE.y1) / 2, fz));
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x6f8f9e, transparent: true, opacity: 0.07, roughness: 0.2,
    metalness: 0.4, flatShading: true, side: THREE.DoubleSide, depthWrite: false
  });
  for (let i = 0; i < 6; i++) {
    const g = new THREE.Mesh(new THREE.ConeGeometry(0.1 + Math.random() * 0.1, 0.26 + Math.random() * 0.28, 3), glassMat);
    g.position.set(HOLE.x0 + 0.3 + Math.random() * 2.8, HOLE.y1 - 0.16, fz);
    g.rotation.x = Math.PI; g.rotation.z = (Math.random() - 0.5) * 0.5; roomGrp.add(g);
  }
  const curtain = put(box(0.9, 1.9, 0.06, M(0x120d09, { r: 1 })), HOLE.x0 + 0.55, HOLE.y0 + 1.1, fz - 0.22);
  curtain.rotation.z = 0.06; roomGrp.add(curtain);
  addFlame(roomGrp, HOLE.x0 + 0.55, HOLE.y0 + 0.5, fz - 0.3, 0.85, 1.5);   // 窗帘在烧

  // 家具（低多边形，局部燃烧）
  const woodMat = M(0x120e0a), fabMat = M(0x0e0c0c, { r: 1 }), charMat = M(0x070605, { r: 1 });
  const sofa = new THREE.Group(); sofa.position.set(-0.4, ROOM.y0, -3.7); roomGrp.add(sofa);
  sofa.add(put(box(2.1, 0.4, 0.9, fabMat), 0, 0.28, 0));
  sofa.add(put(box(2.1, 0.7, 0.24, charMat), 0, 0.65, -0.36));
  sofa.add(put(box(0.24, 0.55, 0.9, fabMat), -0.95, 0.55, 0));
  sofa.add(put(box(0.24, 0.55, 0.9, charMat), 0.95, 0.55, 0));
  addFlame(sofa, 0.35, 0.5, 0.05, 1.5, 2.2);
  addFlame(sofa, -0.55, 0.45, -0.1, 1.0, 1.5);

  roomGrp.add(put(box(1.1, 0.08, 0.6, woodMat), -0.4, ROOM.y0 + 0.42, -2.9));   // 茶几
  for (const sx of [-0.85, 0.05]) {
    roomGrp.add(put(box(0.08, 0.42, 0.08, woodMat), -0.4 + sx, ROOM.y0 + 0.21, -2.9));
  }
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.11, 6), M(0x272420));
  cup.position.set(-0.1, ROOM.y0 + 0.5, -2.85); cup.rotation.z = 1.5; roomGrp.add(cup);

  const shelf = put(box(1.6, 0.16, 0.4, woodMat), ROOM.x1 - 1.4, ROOM.y0 + 0.1, -5.4);
  shelf.rotation.y = 0.4; roomGrp.add(shelf);
  for (let i = 0; i < 8; i++) {
    const bk = put(box(0.16, 0.04, 0.22, i % 3 ? M(0x1a1510) : charMat),
      ROOM.x1 - 2.2 + Math.random() * 1.8, ROOM.y0 + 0.03, -6.1 + Math.random() * 1.4);
    bk.rotation.y = Math.random() * 3.14; roomGrp.add(bk);
  }
  addFlame(roomGrp, ROOM.x1 - 1.9, ROOM.y0 + 0.02, -5.9, 0.9, 1.3);

  roomGrp.add(put(box(1.5, 0.45, 0.4, woodMat), -0.4, ROOM.y0 + 0.22, ROOM.z1 - 0.5));   // 电视柜
  const tv = put(box(1.15, 0.66, 0.1, M(0x07070a)), -0.4, ROOM.y0 + 0.78, ROOM.z1 - 0.5);
  tv.rotation.y = -0.12; roomGrp.add(tv);
  roomGrp.add(put(box(2.6, 0.03, 1.7, charMat), -0.5, ROOM.y0 + 0.02, -3.4));            // 烧焦地毯
  const lamp = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.28, 6), M(0x131110));
  lamp.position.set(-1.4, ROOM.y1 - 0.5, -4.6); lamp.rotation.z = 0.5; roomGrp.add(lamp);
  roomGrp.add(put(box(0.03, 0.5, 0.03, M(0x0e0d0c)), -1.5, ROOM.y1 - 0.25, -4.6));

  // 室内火光
  roomFireA = new THREE.PointLight(0xff6a20, 0.95, 7.5, 2);
  roomFireA.position.set(0.1, ROOM.y0 + 0.85, -3.5); roomGrp.add(roomFireA);
  roomFireB = new THREE.PointLight(0xff7a30, 0.38, 5, 2);
  roomFireB.position.set(ROOM.x1 - 1.9, ROOM.y0 + 0.55, -5.9); roomGrp.add(roomFireB);
  roomRim = new THREE.PointLight(0xff8a3a, 0.42, 6, 2);
  roomRim.position.set(-3.6, ROOM.y0 + 1.9, ROOM.z1 - 0.3); roomGrp.add(roomRim);
  // 走廊背光：唯一投影光源，隔墙挡住光、只从锯开的洞漏出来 → 把它压成纯黑剪影
  corridorFire = new THREE.PointLight(0xff5a14, 1.7, 8, 2);
  corridorFire.position.set(-3.9, ROOM.y0 + 1.5, ROOM.z0 - 1.1);
  corridorFire.castShadow = true;
  corridorFire.shadow.mapSize.width = corridorFire.shadow.mapSize.height = 512;
  corridorFire.shadow.camera.near = 0.1; corridorFire.shadow.camera.far = 16;
  corridorFire.shadow.bias = -0.003;
  roomGrp.add(corridorFire);
  addFlame(roomGrp, -5.6, ROOM.y0, ROOM.z0 - 1.3, 1.4, 2.2);   // 走廊里的火

  addSmoke(roomGrp, -2.0, ROOM.y1 - 0.55, -4.2, 4.6);
  addSmoke(roomGrp, -5.0, ROOM.y1 - 0.7, -5.6, 4.0);
  addSmoke(roomGrp, 0.4, ROOM.y1 - 0.6, -3.0, 3.6);
  const inEm = makeEmbers(28, {
    x0: ROOM.x0 + 0.5, x1: ROOM.x1 - 0.5, y0: ROOM.y0, y1: ROOM.y1 - 0.2,
    z0: ROOM.z0 + 0.5, z1: ROOM.z1 - 0.5
  }, 0xff8836, 0.075);
  roomGrp.add(inEm);
  roomGrp.userData.embers = inEm;
}

/* ==================== [5] Threehalves（全身纯黑） ==================== */
const robot = new THREE.Group();
let tankMesh = null;                       // 身侧蓝色压力罐（弱点），构建时赋值
const chainsaw = new THREE.Group();
let headGrp, eyeMatL, eyeLight, eyeGlows = [], sawLight, tankMat, tankGlow, sawTeeth;
let robotPortraitSprite = null, robotPortraitMaterial = null;
let robotPortraitTexture = null, robotPortraitName = '企鹅形象';
let robotPortraitReady = false, robotPortraitId = '';
let robotBodyHidden = false;
{
  /* 纯黑材质组：只靠粗糙度差异区分层次 */
  const shell = M(0x070708, { r: 0.72, m: 0.28 });
  const deep = M(0x040405, { r: 0.85, m: 0.15 });
  const joint = M(0x0a0a0c, { r: 0.62, m: 0.32 });
  const blade = M(0x0c0c10, { r: 0.5, m: 0.6 });
  const soot = M(0x050505, { r: 0.98, m: 0.05 });

  /* ---- 四条高跷般的细长腿（腿约占全身一半高度）----
     参考照片：腿几乎是笔直的细杆，站姿收窄，膝部只有一个小球关节 */
  const LEGS = [[-0.21, 0.20], [0.21, 0.20], [-0.31, -0.80], [0.31, -0.80]];
  robot.userData.legs = [];                 // 每条腿一个髋部枢轴，走路时摆动
  for (let i = 0; i < LEGS.length; i++) {
    const lx = LEGS[i][0], lz = LEGS[i][1], fwd = lz > 0 ? 1 : -1;
    const hip = new THREE.Group();
    hip.position.set(lx, 1.36, lz - fwd * 0.04);
    robot.add(hip);
    robot.userData.legs.push(hip);
    // 蹄（坐标全部换成相对髋部）
    const hoof = new THREE.Mesh(new THREE.ConeGeometry(0.052, 0.12, 5), deep);
    hoof.rotation.x = Math.PI; hip.add(put(hoof, 0, -1.30, fwd * 0.07));
    // 小腿：极细长
    const lo = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.046, 0.86, 5), shell);
    lo.position.set(0, -0.87, fwd * 0.015);
    lo.rotation.x = -fwd * 0.035; hip.add(lo);
    // 膝
    hip.add(put(new THREE.Mesh(new THREE.SphereGeometry(0.062, 7, 5), joint), 0, -0.43, fwd * 0.04));
    // 大腿
    const up = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.058, 0.42, 5), shell);
    up.position.set(0, -0.22, fwd * 0.01);
    up.rotation.x = fwd * 0.09; hip.add(up);
    // 液压细杆（机械感）
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.52, 4), joint);
    rod.position.set(lx > 0 ? 0.048 : -0.048, -0.62, -fwd * 0.015);
    hip.add(rod);
  }

  /* ---- 圆润的后躯（马/羊臀）：明显向后延伸，撑起半人马构型 ---- */
  const haunch = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 9), shell);
  haunch.scale.set(0.46, 0.42, 1.12);
  robot.add(put(haunch, 0, 1.42, -0.34));
  const rump = new THREE.Mesh(new THREE.SphereGeometry(0.28, 9, 7), shell);
  rump.scale.set(0.9, 0.95, 0.8);
  robot.add(put(rump, 0, 1.40, -0.78));                              // 臀部收尾
  robot.add(put(box(0.3, 0.09, 0.86, soot), 0, 1.63, -0.42));        // 背脊覆板
  // 腰（细）
  robot.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.078, 0.1, 0.16, 7), joint), 0, 1.58, 0.06));

  /* ---- 蓝色气罐（唯一弱点，左侧腰胯；克制发光，别抢剪影）---- */
  // 压力罐不再常亮：只在被击中瘫痪时闪（玩法反馈），平时是一块暗金属，保留神秘感
  tankMat = M(0x0a0f16, { e: 0x000000, ei: 0, r: 0.55, m: 0.35 });
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.28, 8), tankMat);
  tank.rotation.z = 0.12; tankMesh = put(tank, -0.26, 1.42, -0.06); robot.add(tankMesh);
  robot.add(put(new THREE.Mesh(new THREE.TorusGeometry(0.086, 0.016, 4, 8),
    M(0x0d151d, { r: 0.6, m: 0.4 })), -0.26, 1.53, -0.06));
  tankGlow = new THREE.PointLight(0x2f86ff, 0.0, 1.1, 2);   // 常态全灭
  robot.add(put(tankGlow, -0.26, 1.42, 0.0));

  /* ---- 细长的人形上躯干（下窄上略宽，肩很窄）---- */
  robot.add(put(box(0.26, 0.34, 0.17, shell), 0, 1.74, -0.01));      // 腰腹
  robot.add(put(box(0.36, 0.32, 0.20, shell), 0, 2.00, -0.01));      // 胸廓 1.84~2.16
  robot.add(put(box(0.3, 0.2, 0.05, soot), 0, 2.0, 0.11));           // 胸前覆板
  for (const s of [-1, 1]) {                                          // 窄肩上的小斜角护板
    const pd = put(box(0.14, 0.1, 0.19, shell), s * 0.2, 2.1, -0.01);
    pd.rotation.z = -s * 0.42; robot.add(pd);
  }
  robot.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.058, 0.26, 6), joint), 0, 2.26, -0.02));

  /* 胸口纯黑：不要任何贴纸 */


  /* ---- 双臂：细长分段，共同握持电锯居中对准前方 ---- */
  for (const s of [-1, 1]) {
    robot.add(put(new THREE.Mesh(new THREE.SphereGeometry(0.072, 7, 6), joint), s * 0.21, 2.06, -0.01));
    const ua = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.05, 0.44, 5), shell);
    ua.position.set(s * 0.225, 1.86, 0.06);
    ua.rotation.x = -0.28; ua.rotation.z = s * 0.07; robot.add(ua);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.34, 4), joint);
    rod.position.set(s * 0.27, 1.88, 0.03); rod.rotation.x = -0.28; robot.add(rod);
    robot.add(put(new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), joint), s * 0.24, 1.65, 0.12));
    const fa = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.042, 0.4, 5), deep);
    fa.position.set(s * 0.17, 1.57, 0.26);
    fa.rotation.x = -1.0; fa.rotation.z = s * 0.34; robot.add(fa);
    robot.add(put(box(0.075, 0.09, 0.11, joint), s * 0.095, 1.51, 0.38));   // 手
  }

  /* ---- 电锯 ----
     导板压扁（扁而宽，像真实链锯导板），链齿加大成尖锐三角，
     加长到与人体躯干相当的比例（长 ≈ 1.0m），末端的尖头也做出来 */
  {
    // 主体（机身）
    chainsaw.add(put(box(0.34, 0.24, 0.26, shell), 0, 0, -0.10));      // 主壳
    chainsaw.add(put(box(0.22, 0.13, 0.14, deep), 0, 0.14, -0.16));   // 上把手
    chainsaw.add(put(box(0.085, 0.05, 0.16, joint), 0.10, 0.10, 0.02)); // 前把手基座
    chainsaw.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.16, 6), deep), 0.10, 0.10, 0.10)); // 前手把握杆
    // 散热鳃
    for (let i = 0; i < 5; i++) {
      const g = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.07, 0.02), M(0x07070a, { r: 1 }));
      g.position.set(-0.18 + i * 0.05, 0.08, -0.10); chainsaw.add(g);
    }
    // 导板：压扁成楔形，末端收尖
    const BLADE_LEN = 0.96;
    const board = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, BLADE_LEN, 6), blade);
    board.rotation.z = Math.PI / 2; board.rotation.y = Math.PI / 2;
    board.position.set(0, 0, 0.16 + BLADE_LEN / 2);
    chainsaw.add(board);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.06, 6), blade);
    tip.rotation.x = Math.PI / 2;
    tip.position.set(0, 0, 0.16 + BLADE_LEN + 0.03);
    chainsaw.add(tip);
    // 链齿：大三角齿，加大加粗让远处也能清晰看到
    sawTeeth = new THREE.Group();
    const TEETH = 22;
    const STEP = BLADE_LEN / TEETH;
    for (let i = 0; i < TEETH; i++) {
      const z = 0.16 + 0.04 + i * STEP;
      // 上齿：底面半径 0.028 → 0.042，高度 0.10 → 0.14
      const t1 = new THREE.Mesh(
        new THREE.ConeGeometry(0.042, 0.14, 3), M(0x14141a, { r: 0.35, m: 0.7 }));
      t1.position.set(0, 0.042, z);
      t1.rotation.x = Math.PI / 2; sawTeeth.add(t1);
      // 下齿
      const t2 = t1.clone(); t2.position.y = -0.042; t2.rotation.x = -Math.PI / 2; sawTeeth.add(t2);
    }
    chainsaw.add(sawTeeth);
    // 链齿底面的警示红条
    chainsaw.add(put(box(0.022, 0.028, BLADE_LEN - 0.04, M(0x22262a, { r: 0.45, m: 0.7 })), 0.024, 0, 0.16 + BLADE_LEN / 2));
    // 排屑口
    chainsaw.add(put(box(0.04, 0.07, 0.16, M(0x030305)), -0.10, 0.05, -0.10));
    sawLight = new THREE.PointLight(0xffab54, 0, 1.8, 2);
    chainsaw.add(put(sawLight, 0, 0, 0.16 + BLADE_LEN - 0.05));
    chainsaw.position.set(0, 1.50, 0.36);
    robot.add(chainsaw);
  }

  /* ---- 恶搞形象牌：始终挂在机器人身上，位置在电锯后方（局部负 Z） ----
     Sprite 会面向玩家，但仍参与深度测试；电锯和机器人身体能遮住它。 */
  robotPortraitMaterial = new THREE.SpriteMaterial({
    color: 0xffffff, transparent: true, opacity: 0.78,
    depthTest: true, depthWrite: false
  });
  robotPortraitSprite = new THREE.Sprite(robotPortraitMaterial);
  robotPortraitSprite.name = 'robotPortraitSprite';
  robotPortraitSprite.position.set(0, 1.35, -0.28);
  robotPortraitSprite.scale.set(1.18, 1.70, 1);
  robotPortraitSprite.visible = false;
  robot.add(robotPortraitSprite);

  /* ---- 羊头：保留照片的方形面罩，但缩短下半脸，避免吻部过长 ---- */
  headGrp = new THREE.Group();
  {
    const hornMat = M(0x080707, { r: 0.8, m: 0.2 });
    const ringMat = M(0x0b0a0a, { r: 0.7, m: 0.28 });

    // 颅盒：方正细长，羊的颅顶是方的
    headGrp.add(put(box(0.185, 0.19, 0.30, shell), 0, 0.035, -0.02));
    // 颅顶盖板：两只角根之间的一道平顶
    headGrp.add(put(box(0.2, 0.032, 0.24, soot), 0, 0.14, -0.03));
    // 面罩：底边上收，整体只缩短一点，不破坏羊头剪影
    headGrp.add(put(box(0.175, 0.30, 0.10, shell), 0, -0.01, 0.135));
    // 面罩下段收窄，过渡到吻部
    headGrp.add(put(box(0.132, 0.105, 0.105, shell), 0, -0.195, 0.13));
    // 面罩侧颊薄板：让方形轮廓的边缘更硬
    for (const s of [-1, 1]) {
      headGrp.add(put(box(0.016, 0.28, 0.085, soot), s * 0.0875, -0.01, 0.13));
    }
    // 长吻：向前下伸出
    const muz = put(box(0.115, 0.085, 0.18, shell), 0, -0.235, 0.19);
    muz.rotation.x = 0.3; headGrp.add(muz);
    headGrp.add(put(box(0.085, 0.055, 0.05, deep), 0, -0.272, 0.265));           // 鼻端/嘴部上移
    headGrp.add(put(box(0.07, 0.016, 0.022, M(0x020203)), 0, -0.272, 0.292));    // 鼻端传感缝

    /* 发光摄像头眼：加大 + 圆形凹座（不要眉状横条）+ 加性光晕 */
    for (const s of [-1, 1]) {
      const socket = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.022, 12), M(0x010102));
      socket.rotation.x = Math.PI / 2;
      headGrp.add(put(socket, s * 0.05, 0.03, 0.182));
    }
    // 眼睛是唯一的光：收敛一档，暗处只看见两点冷光
    eyeMatL = M(0xf2f6ff, { e: 0xdfe9ff, ei: 1.5, r: 0.18 });
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), eyeMatL);  // 0.022 → 0.030
      e.scale.set(1.12, 0.95, 0.55);
      headGrp.add(put(e, s * 0.05, 0.03, 0.196));
      const gl = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xfff4e2, transparent: true,
        blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85
      }));
      gl.scale.set(0.22, 0.22, 1);
      headGrp.add(put(gl, s * 0.05, 0.03, 0.215));
      eyeGlows.push(gl);
    }
    eyeLight = new THREE.PointLight(0xdfe9ff, 0.42, 3.2, 2);
    headGrp.add(put(eyeLight, 0, 0.03, 0.28));

    /* 宽弧盘羊角：从头顶两侧升起 → 大幅向外张开 → 下沉 → 向前内钩收尖。
       双角跨度约 0.8m，是头宽的 4 倍，正面剪影和照片一致 */
    function makeHorn(side) {
      const g = new THREE.Group();
      const raw = [
        [0.045, 0.09, -0.01], [0.11, 0.185, -0.03], [0.20, 0.245, -0.05],
        [0.30, 0.235, -0.05], [0.375, 0.17, -0.02], [0.40, 0.075, 0.04],
        [0.375, 0.00, 0.10], [0.32, -0.035, 0.145], [0.265, -0.028, 0.16]
      ].map(function (p) { return new THREE.Vector3(side * p[0], p[1], p[2]); });
      const pts = new THREE.CatmullRomCurve3(raw).getPoints(24);
      const up = new THREE.Vector3(0, 1, 0);
      const N = pts.length - 1;
      for (let i = 0; i < N; i++) {
        const a = pts[i], b = pts[i + 1], u = i / N;
        const r0 = 0.064 * (1 - 0.58 * u), r1 = 0.064 * (1 - 0.58 * (u + 1 / N));
        const seg = new THREE.Mesh(
          new THREE.CylinderGeometry(r1, r0, a.distanceTo(b) * 1.9, 6), hornMat);
        seg.position.copy(a).lerp(b, 0.5);
        seg.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
        g.add(seg);
        if (i === 7 || i === 15) {   // 只留两道生长环，保持角面光滑厚实
          const ring = new THREE.Mesh(new THREE.CylinderGeometry(r0 * 1.22, r0 * 1.22, 0.02, 6), ringMat);
          ring.position.copy(seg.position); ring.quaternion.copy(seg.quaternion);
          g.add(ring);
        }
      }
      return g;
    }
    headGrp.add(makeHorn(-1));
    headGrp.add(makeHorn(1));

    /* 头部高度：羊角顶点原来在 y≈2.735，而室内天花板底面在 RH=2.70 —— 角会扎穿天花板。
       把颈上的头下移 9cm（角顶 ≈2.645，留 5cm 余量），同时低头角度加大一点，
       读起来像"它在室内不得不佝着"。整机仍有 2.6m 高，远高于 2.02m 的门框。 */
    headGrp.position.set(0, 2.35, 0.02);
    headGrp.rotation.x = 0.12;            // 低头（室内佝身）
    robot.add(headGrp);
  }

  /* 玩家视角里机器人也在「房间里」：复用同一 robot，但位置搬过来 */
  robot.position.set(-3.9, ROOM.y0, -7.0);   // 站在锯穿的墙洞前
  robot.rotation.y = 0.2;                     // 略微侧转，让半人马的后躯和四足从正面能读出来
  roomGrp.add(robot);
}

/* 房间内所有实体参与投影，走廊背光才会被隔墙挡住、只从洞口漏出来 */
roomGrp.traverse(function (o) {
  if (o.isMesh && o.material && !o.material.transparent &&
    o.material.type !== 'ShaderMaterial') {
    o.castShadow = true; o.receiveShadow = true;
  }
});

/* ==================== [6] 玩家房间 503（睁眼后） ==================== */
const playerRoom = new THREE.Group();
playerRoom.position.set(92, 0, 92);
playerRoom.visible = false;
scene.add(playerRoom);
const prLights = new THREE.Group(); playerRoom.add(prLights);
let tvTex, tvCtx, tvLight, doorLight, prWinLight;
let doorPivot, corrLight, corrFireLight, lampLight, lampMat;
let bulletsObj, fire505Light, radioGrp, axeObj, door504 = null, door504Lintel = null;
/* 各楼层的几何组：切层时显隐（楼梯井本身常显，是共用的） */
let lvl5Grp = null, lvl4Grp = null, roofGrp = null;
let corrGrp = null, room505Grp = null;      // 5F 的走廊与 505（离开 5F 时整组剔除）
let roofBulletsObj = null, roofSignalDone = false, heliTimer = -1;
let heliShakeAmt = 0, roofNextBoomIn = -1, __hsBootLev = 0;   // 天台抖动 / 下次爆炸倒计时 / 进入天台楼层
let jolt4Amp = 0;      // 撬门的冲击式下坠+侧倾（力量感，非高频眩晕）；每帧快速衰减
let barricadeGrp = null, barricadePlanks = [], barricadeHits = 0, barricadeBroken = false;
let lvl4Barred = false;   // 四楼楼梯口被木梁封住，机器人被挡在井道里
/* 四楼电梯 / 工具箱 / 房间 的引用与状态 */
let elev4Doors = null, elev4Bent = null, elev4Shaft = null;   // 闭合门板/撬开后弯门/井道内部
let caseGlass4 = null, toolsObj = null, toolsHeldObj = null, acWindowGlass = null, acFireLights = [], glassShards4 = [];  // 工具箱玻璃板 / 镰刀锤子（世界）/ 手持专用模型
let case4Read = false, case4GlassBroken = false, case4FadeAt = 0;
let acWindowBroken = false;  // 旁白已读 / 玻璃已碎 / 旁白渐隐时刻
let pry4Busy = false, pry4Done = false;                       // 撬门演出进行中 / 已撬开
let lvl4RoomHint = false;                                     // 405房间窗洞旁白已触发
let robotStunT = 0, axeSwingT = 0, lastStepPh = 0;
let acClimbMode=0, acClimbIndex=0, acJumpT=0, acMountT=0, glassBreakT=0, acJumpFromX=0, acJumpToX=0;
let acQte=0, acQteProgress=0, acQteT=0, acQteCamYaw=0;
let acFloorY = null;                 // 外机交互CG接管垂直高度时非 null（floorYAt 直接返回它）
let fallExt = null, prWinBack = null;     // 5F 坠楼外立面 / 503 窗外山火背景板（4F 时必须隐藏，否则糊死 405 窗）
let acUnitMeshes = [], acUnitHome = [];   // 外机网格引用 / 原始位姿（断裂坠落与复位用）
let acFallVy = 0;                    // 断裂外机的下坠速度
let phoneObj, towelObj, phoneScreenMat;
let wardrobeDoors = [], pistolObj, pistolSlide = null;
/* 手枪状态：弹匣里的子弹数 / 是否已上膛 / 套筒是否后定 */
let magLoaded = 0, chambered = false, slideLocked = false;
let slideT = 0, reloadT = 0, reloadStep = 0;
const MAG_CAP = 7;
const shellPool = [];
{
  const RW = 5.2, RD = 4.6, RH = 2.7, T = 0.2;
  const wall = M(0x16130f, { r: 0.98 }), floorM = M(0x110e0b), wood = M(0x1a140d);
  playerRoom.add(put(box(RW, T, RD, floorM), 0, -T / 2, 0));
  playerRoom.add(put(box(RW, T, RD, M(0x0b0a09)), 0, RH + T / 2, 0));
  playerRoom.add(put(box(T, RH, RD, wall), -RW / 2, RH / 2, 0));
  playerRoom.add(put(box(T, RH, RD, wall), RW / 2, RH / 2, 0));

  // 窗墙（-z）：真正开洞
  const WX0 = -2.1, WX1 = -0.1, WY0 = 0.95, WY1 = 2.15;
  playerRoom.add(put(box(WX0 + RW / 2, RH, T, wall), (-RW / 2 + WX0) / 2, RH / 2, -RD / 2));
  playerRoom.add(put(box(RW / 2 - WX1, RH, T, wall), (WX1 + RW / 2) / 2, RH / 2, -RD / 2));
  playerRoom.add(put(box(WX1 - WX0, WY0, T, wall), (WX0 + WX1) / 2, WY0 / 2, -RD / 2));
  playerRoom.add(put(box(WX1 - WX0, RH - WY1, T, wall), (WX0 + WX1) / 2, (WY1 + RH) / 2, -RD / 2));

  // 门墙（+z）：正常木门，可开合，门外是一段短走廊
  const DOOR_W = 1.0, DOOR_H = 2.05;
  playerRoom.add(put(box((RW - DOOR_W) / 2, RH, T, wall), -(RW + DOOR_W) / 4, RH / 2, RD / 2));
  playerRoom.add(put(box((RW - DOOR_W) / 2, RH, T, wall), (RW + DOOR_W) / 4, RH / 2, RD / 2));
  playerRoom.add(put(box(DOOR_W, RH - DOOR_H, T, wall), 0, DOOR_H + (RH - DOOR_H) / 2, RD / 2));
  // 门框（木质包边）
  const jamb = M(0x231a10, { r: 0.9, m: 0.08 });
  playerRoom.add(put(box(0.07, DOOR_H, T + 0.04, jamb), -DOOR_W / 2, DOOR_H / 2, RD / 2));
  playerRoom.add(put(box(0.07, DOOR_H, T + 0.04, jamb), DOOR_W / 2, DOOR_H / 2, RD / 2));
  playerRoom.add(put(box(DOOR_W + 0.14, 0.07, T + 0.04, jamb), 0, DOOR_H, RD / 2));

  /* 木门：绕左侧门轴旋转，doorPivot.rotation.y 控制开合 */
  doorPivot = new THREE.Group();
  doorPivot.position.set(-DOOR_W / 2, 0, RD / 2);   // 铰链在左框
  playerRoom.add(doorPivot);
  {
    const panelMat = M(0x2a1e12, { r: 0.82, m: 0.1 });      // 木门板
    const panelIn  = M(0x1d150c, { r: 0.88, m: 0.08 });     // 门芯凹板
    const leaf = new THREE.Group();
    leaf.position.set(DOOR_W / 2, DOOR_H / 2, 0);            // 门板中心相对门轴
    doorPivot.add(leaf);
    leaf.add(put(box(DOOR_W - 0.03, DOOR_H - 0.03, 0.05, panelMat), 0, 0, 0));
    // 两块凹陷门芯，木门的标志性造型
    leaf.add(put(box(DOOR_W - 0.28, 0.72, 0.012, panelIn), 0, 0.44, 0.032));
    leaf.add(put(box(DOOR_W - 0.28, 0.72, 0.012, panelIn), 0, -0.42, 0.032));
    // 金属门把手：底座 + 横杆把手（房间一侧）
    const knobMat = M(0x8f8a80, { r: 0.28, m: 0.92 });
    leaf.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.022, 10), knobMat), DOOR_W / 2 - 0.13, -0.05, 0.04));
    const lever = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.13, 8), knobMat);
    lever.rotation.z = Math.PI / 2;
    leaf.add(put(lever, DOOR_W / 2 - 0.19, -0.05, 0.062));
    // 走廊一侧也要有把手
    leaf.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.022, 10), knobMat), DOOR_W / 2 - 0.13, -0.05, -0.04));
    const lever2 = lever.clone(); lever2.position.z = -0.062; leaf.add(lever2);
    // 铰链
    for (const hy of [0.72, -0.72]) {
      leaf.add(put(box(0.02, 0.1, 0.055, knobMat), -(DOOR_W / 2) + 0.02, hy, 0));
    }
  }
  doorPivot.rotation.y = -0.12;    // 初始虚掩

  /* ============ 5F 楼层走廊：把 503 接进 17 号楼 ============
     走廊沿 x 轴横贯（宽 2.0m），玩家从 503 门出来正对走廊。
     同侧门牌：501 · 503(玩家) · 505；对面：502 · 504。
     左端（-x）楼梯间——被浓烟和塌方封住，是后续的逃生方向；
     右端（+x）就是开场那个房间 505，机器人锯穿了走廊隔墙，火光从洞口打进来。 */
  {
    const corr = new THREE.Group();
    corrGrp = corr;                                // 供按楼层剔除用
    corr.position.set(0, 0, RD / 2 + T / 2);      // 贴着 503 门墙外侧
    playerRoom.add(corr);
    const CW = 2.0;                                // 走廊宽（z 方向）
    const CX0 = -7.0, CX1 = 7.0;                   // 走廊沿 x 的范围
    const cWall = M(0x2a2622, { r: 0.95 });   // 走廊墙：提亮，暗场里能读出转角和门洞
    const cFloor = M(0x201d1a, { r: 0.92 });
    const CLEN = CX1 - CX0;
    corr.add(put(box(CLEN, T, CW, cFloor), (CX0 + CX1) / 2, -T / 2, CW / 2));        // 地
    corr.add(put(box(CLEN, T, CW, M(0x090808)), (CX0 + CX1) / 2, RH + T / 2, CW / 2)); // 顶
    // 对面墙（z = CW），中间留 502 / 504 两个门洞
    const OPP = [-3.2, 3.2];                       // 对门中心 x
    const DW = 1.0;
    let segs = [[CX0, OPP[0] - DW / 2], [OPP[0] + DW / 2, OPP[1] - DW / 2], [OPP[1] + DW / 2, CX1]];
    for (const s of segs) {
      corr.add(put(box(s[1] - s[0], RH, T, cWall), (s[0] + s[1]) / 2, RH / 2, CW));
    }
    for (const ox of OPP) {                        // 门楣
      const lint = put(box(DW, RH - 2.05, T, cWall), ox, 2.05 + (RH - 2.05) / 2, CW);
      corr.add(lint);
      if (ox === OPP[1]) door504Lintel = lint;     // 504 的门楣：破门时被顶烂
    }
    // 玩家这一侧的墙：503 门洞已在房间那边开好，这里补 501 / 505 的门洞与墙体
    const SAME = [-4.4, 4.4];                      // 501 / 505 门中心 x
    segs = [[CX0, SAME[0] - DW / 2], [SAME[0] + DW / 2, -DW / 2 - 0.6],
            [DW / 2 + 0.6, SAME[1] - DW / 2], [SAME[1] + DW / 2, CX1]];
    for (const s of segs) {
      if (s[1] - s[0] <= 0.01) continue;
      corr.add(put(box(s[1] - s[0], RH, T, cWall), (s[0] + s[1]) / 2, RH / 2, 0));
    }
    for (const sx of SAME) {
      corr.add(put(box(DW, RH - 2.05, T, cWall), sx, 2.05 + (RH - 2.05) / 2, 0));
    }
    // 邻居家的门（关着的深色木门）+ 带号码的金属门牌
    // 邻居门：原来 0x241a10 在暗走廊里读成一块纯黑板（尤其 501 就在楼梯口旁边），
    // 提亮到能看出是木门
    const nDoor = M(0x6b5138, { r: 0.84, m: 0.08 });
    /* 门牌：用 canvas 画出号码，暗淡的黄铜底 + 阴刻数字，火光下能读出来 */
    function plateTex(label) {
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 64;
      const c = cv.getContext('2d');
      c.fillStyle = '#5b5347'; c.fillRect(0, 0, 128, 64);
      // 边框内凹感
      c.strokeStyle = '#3b352c'; c.lineWidth = 4; c.strokeRect(4, 4, 120, 56);
      c.strokeStyle = '#7a7263'; c.lineWidth = 1.5; c.strokeRect(7, 7, 114, 50);
      c.fillStyle = '#2a251d'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = 'bold 36px "Segoe UI", monospace';
      c.fillText(label, 64, 34);
      c.fillStyle = 'rgba(255,255,255,.16)';
      c.font = 'bold 36px "Segoe UI", monospace';
      c.fillText(label, 63, 32);                 // 高光偏移，做出刻字反光
      const tx = new THREE.CanvasTexture(cv);
      return tx;
    }
    function doorPlate(x, y, z, faceZ, label) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.17, 0.085),
        new THREE.MeshStandardMaterial({ map: plateTex(label), roughness: 0.55, metalness: 0.55 }));
      m.position.set(x, y, z);
      if (faceZ < 0) m.rotation.y = Math.PI;      // 朝走廊那一面
      corr.add(m);
    }
    function neighbourDoor(x, z, label, faceZ) {
      const d = put(box(DW - 0.04, 2.02, 0.05, nDoor), x, 1.01, z);
      if (label === '504') {                 // 504：机器人那户，门要能被撞开
        const pv504 = new THREE.Group(); pv504.position.set(x - DW / 2 + 0.04, 0, z);
        corr.add(pv504); d.position.set(DW / 2 - 0.04, 1.01, 0); pv504.add(d);
        door504 = pv504;
      } else corr.add(d);
      doorPlate(x + 0.31, 1.74, z + (faceZ > 0 ? 0.035 : -0.035), faceZ, label);
    }
    // 对面两户：门朝 -z（面向走廊内侧）
    neighbourDoor(OPP[0], CW - 0.03, '502', -1);
    neighbourDoor(OPP[1], CW - 0.03, '504', -1);
    // 同侧：501 正常门；503 是玩家自己家，门牌挂在门洞边
    neighbourDoor(SAME[0], 0.03, '501', 1);
    doorPlate(0.62, 1.74, 0.045, 1, '503');
    // 505：机器人锯穿的那户，整扇门被撕下来拍在门槛上（洞口敞开，一眼看出能进）
    {
      const bx = SAME[1];
      const brk = new THREE.Group();
      brk.position.set(bx, 0.028, 0.25);
      brk.rotation.set(Math.PI / 2, 0.06, 0.05);   // 平躺横在门洞里，一角翘在碎块上
      corr.add(brk);
      brk.add(put(box(DW - 0.04, 2.02, 0.05, nDoor), 0, 0, 0));       // 门板
      // 撕断的铰链还钉在门边
      const hingeM = M(0x6a6257, { r: 0.4, m: 0.6 });
      for (const hy of [-0.62, 0.66]) {
        brk.add(put(box(0.05, 0.1, 0.014, hingeM), -0.42, hy, 0.033));
      }
      // 门板上的焦痕
      brk.add(put(box(0.5, 0.6, 0.012, M(0x0a0808, { r: 0.99 })), 0.1, 0.3, 0.032));
      doorPlate(bx + 0.31, 1.74, 0.065, 1, '505');
      // 门框边缘的锯口碎块
      for (let i = 0; i < 5; i++) {
        const c = put(box(0.1 + Math.random() * 0.18, 0.12 + Math.random() * 0.2, 0.16,
          M(0x120f0d, { r: 0.99 })),
          bx - 0.5 + Math.random() * 1.0, 0.2 + Math.random() * 1.7, 0.02);
        c.rotation.z = (Math.random() - 0.5) * 1.1; corr.add(c);
      }
    }
    // 505 洞口里透出来的火光：这一版最强的光源，指明「它在那边」
    corrFireLight = new THREE.PointLight(0xff5a20, 1.25, 9.0, 2);
    prLights.add(put(corrFireLight, SAME[1], 1.5, RD / 2 + 0.35));

    // 停用的电梯厅（走廊中段偏右），两扇不锈钢门 + 停运告示
    {
      const ex = 1.9;
      corr.add(put(box(1.5, RH, T, M(0x191714, { r: 0.9 })), ex, RH / 2, CW - 0.001));
      const steel = M(0x3a3d41, { r: 0.38, m: 0.82 });
      for (const dx of [-0.34, 0.34]) {
        corr.add(put(box(0.66, 2.1, 0.04, steel), ex + dx, 1.05, CW - 0.05));
      }
      corr.add(put(box(1.42, 0.09, 0.05, M(0x2b2e31, { r: 0.5, m: 0.7 })), ex, 2.18, CW - 0.05));
      // 停运告示：暗红色小牌
      corr.add(put(box(0.22, 0.16, 0.012, M(0x2a120c, { e: 0x611c10, ei: 0.35 })), ex, 1.45, CW - 0.08));
    }

    // 楼梯间方向（左端）：应急出口牌 + 冷光，但被浓烟和塌方封住
    {
      const sx = CX0 + 0.9;
      corr.add(put(box(1.1, RH, T, M(0x171512, { r: 0.95 })), sx, RH / 2, CW - 0.001));
      corr.add(put(box(0.9, 2.05, 0.05, M(0x1d1a15, { r: 0.9 })), sx, 1.02, CW - 0.04));
      const exitSign = put(box(0.34, 0.14, 0.03, M(0x0a1a10, { e: 0x1f9b52, ei: 0.6 })), sx, 2.34, CW - 0.06);
      corr.add(exitSign);
      corrLight = new THREE.PointLight(0x36c06d, 0.42, 3.6, 2);
      prLights.add(put(corrLight, sx, RH - 0.42, RD / 2 + CW - 0.4));
      // 塌方：楼梯口的碎料只贴两侧墙脚散落，全部做成矮块。
      // 原来 8 块半人高的纯黑方块堆在走廊中央，劈梁后的抉择 CG
      // 要从楼梯口看向走廊深处的机器人，会被它们整个糊住视线；
      // 现在矮碎石仍交代"这里塌过"，但永远不会挡到那条视线。
      {
        const rubLow = M(0x262220, { r: 0.97 });
        for (let i = 0; i < 7; i++) {
          const side = (i % 2 === 0) ? 0.18 : CW - 0.18;   // 贴左墙 / 贴右墙
          const c = put(box(0.24 + Math.random() * 0.34, 0.08 + Math.random() * 0.2,
            0.2 + Math.random() * 0.28, rubLow),
            CX0 + 0.12 + Math.random() * 1.2, 0.05 + Math.random() * 0.08,
            side + (Math.random() - 0.5) * 0.12);
          c.rotation.set(Math.random() * 0.3, Math.random() * 3, Math.random() * 0.3);
          corr.add(c);
        }
      }
      addSmoke(corr, CX0 + 1.4, RH - 0.85, 1.0, 2.6);
    }
    // 走廊两端封头（越过可视范围就是黑）
    /* 走廊两端的端墙。左端（CX0）要给楼梯间留门洞——
       之前是整面实墙，所以劈开废料后正对的还是一堵黑墙，楼梯全被挡在后面。 */
    {
      const SDZ = 1.09, SDW = 0.75;                 // 门洞中心 / 半宽（与门框对齐）
      const SDH = 2.24;                             // 门洞高
      // 洞两侧
      corr.add(put(box(T, RH, SDZ - SDW, cWall), CX0, RH / 2, (SDZ - SDW) / 2));
      corr.add(put(box(T, RH, CW - (SDZ + SDW), cWall), CX0, RH / 2, (SDZ + SDW + CW) / 2));
      // 洞上方门楣
      corr.add(put(box(T, RH - SDH, SDW * 2, cWall), CX0, SDH + (RH - SDH) / 2, SDZ));
    }
    /* 右端墙：封死。上天台不能另开一个入口 ——
       否则玩家不用劈废料就能从这边上楼，消防斧那道门禁就白做了。
       天台入口改到左端同一个楼梯井里（见下方 4 跑道方案）。 */
    corr.add(put(box(T, RH, CW, cWall), CX1, RH / 2, CW / 2));
    // 走廊里飘的烟
    addSmoke(corr, 0.6, RH - 0.8, 1.0, 2.4);
    addSmoke(corr, 4.6, RH - 0.9, 0.9, 2.2);
  }

  /* ============ 楼梯间入口（走廊左端）============
     不是有人钉死的木板 —— 是灾害里塌下来的东西：
     一根从天花板落下的横梁斜插在门口，压着一堆碎料、断裂的墙筋和烧焦的杂物。
     消防斧劈三下把梁和碎料清开，路就通了。
     门后面是楼梯平台：左边上天台，右边下四楼。 */
  {
    barricadeGrp = new THREE.Group();
    barricadeGrp.position.set(0, 0, RD / 2 + T / 2);   // 与走廊同一坐标系
    playerRoom.add(barricadeGrp);
    const bkM = M(0x6b5136, { r: 0.88 });              // 木料：提亮，火光下能读出是木头
    const bkD = M(0x7d6244, { r: 0.85 });              // 门框：再提亮，暗场里不要读成黑柱子
    const rubM = M(0x6e6a64, { r: 0.95 });             // 混凝土碎块：偏灰白，看得见
    const rebar = M(0x7a6f60, { r: 0.55, m: 0.7 });    // 墙筋
    const DZ = 1.09;                                   // 门洞中心（走廊局部 z）

    /* ---- 门洞：真的开口，不放挡板 ---- */
    barricadeGrp.add(put(box(0.12, 2.3, 0.14, bkD), -6.86, 1.15, DZ - 0.75));   // 左门柱
    barricadeGrp.add(put(box(0.12, 2.3, 0.14, bkD), -6.86, 1.15, DZ + 0.75));   // 右门柱
    barricadeGrp.add(put(box(0.12, 0.16, 1.64, bkD), -6.86, 2.32, DZ));         // 门楣
    /* 原来这里挂了一扇转 81° 的门板，实际正好横在洞口，成了一块 2m 高的黑板 ——
       门洞就该是空的，删掉。门被撞飞的痕迹靠地上的房梁交代。 */

  /* ---- 楼梯间（门后）：4 条跑道的折返楼梯 ----
     B1 上行U1(往西上) / B2 下行D1(往西下) / B3 下行D2(往东下→4F) / B4 上行U2(往东上→天台)
     上天台和下四楼共用这一个入口，所以消防斧那道门禁管得住两条路。
     竖向高度由 floorYAt() 支撑。 */
  {
    /* 楼梯配色：暗场里要能读出台阶，井壁与踏面必须有明显明暗差。
       之前 0x232120/0x2a2724 太接近，整段楼梯糊成一块。 */
    const stW = M(0x312d29, { r: 0.92 });      // 井壁：中灰
    const stF = M(0x272421, { r: 0.9 });       // 平台
    const stStep = M(0x413c36, { r: 0.8 });    // 踏面：明显比井壁亮
    const stNose = M(0x6b6157, { r: 0.6 });    // 前缘包边：最亮，一眼数清每一级
    const railM = M(0x4a423a, { r: 0.55, m: 0.75 });
    const postM = M(0x3a342e, { r: 0.7, m: 0.5 });
    const RISE = 0.18125, TREAD = 0.26, NST = 8, DROP = RISE * NST;
    const XA = -7.86, XB = -9.94, XC = -10.86, XD = -11.78, XE = -12.70;
    /* 走廊局部 z = 世界 z - 2.34（barricadeGrp 与走廊同坐标系）*/
    const OZ = 2.34;
    const B = [[2.60, 3.50], [3.50, 4.40], [4.40, 5.30], [5.30, 6.20]].map(function (p) {
      return [p[0] - OZ, p[1] - OZ];
    });
    const ZC = function (i) { return (B[i][0] + B[i][1]) / 2; };
    const SZ0 = B[0][0] - 0.25, SZ1 = B[3][1] + 0.25;
    /* 井道外壳：底(4F 地面)、顶(天台之上)、后墙、两侧长墙 */
    barricadeGrp.add(put(box(XA - XE + 0.9, T, SZ1 - SZ0, M(0x141210)), (XA + XE) / 2 + 0.45, -2.90 - T / 2, (SZ0 + SZ1) / 2));
    barricadeGrp.add(put(box(XA - XE + 0.9, T, SZ1 - SZ0, M(0x0d0c0b)), (XA + XE) / 2 + 0.45, 2.90 + RH + T / 2, (SZ0 + SZ1) / 2));
    barricadeGrp.add(put(box(T, RH + 6.2, SZ1 - SZ0, stW), XE, RH / 2, (SZ0 + SZ1) / 2));
    barricadeGrp.add(put(box(XA - XE + 0.9, RH + 6.2, T, stW), (XA + XE) / 2 + 0.45, RH / 2, SZ0));
    barricadeGrp.add(put(box(XA - XE + 0.9, RH + 6.2, T, stW), (XA + XE) / 2 + 0.45, RH / 2, SZ1));
    /* 入口平台（5F）：只覆盖 B1+B2，门洞也开在这两条带上 */
    barricadeGrp.add(put(box(1.3, T, B[1][1] - B[0][0], stF), XA + 0.65, -T / 2, (B[0][0] + B[1][1]) / 2));
    /* 4F 出口条带（B3 东端）与天台出口条带（B4 东端）*/
    barricadeGrp.add(put(box(1.3, T, B[2][1] - B[2][0], stF), XA + 0.65, -2.90 - T / 2, ZC(2)));
    barricadeGrp.add(put(box(1.3, T, B[3][1] - B[3][0], stF), XA + 0.65, 2.90 - T / 2, ZC(3)));
    /* 台阶生成器：dir=-1 往西、+1 往东；sign=+1 上、-1 下 */
    function run(xStart, dir, sign, y0, bi) {
      const w = B[bi][1] - B[bi][0];   // 铺满跑道宽，相邻跑道的台阶严丝合缝
      for (let i = 0; i < NST; i++) {
        const y = y0 + sign * RISE * (i + 1);
        const x = xStart + dir * TREAD * (i + 0.5);
        barricadeGrp.add(put(box(TREAD, RISE, w, stStep), x, y - sign * RISE / 2, ZC(bi)));
        barricadeGrp.add(put(box(0.055, 0.045, w, stNose), x + dir * TREAD / 2, y, ZC(bi)));
      }
    }
    run(XA, -1, +1, 0, 0);              // U1：B1 往西上 0 → +1.45
    run(XA, -1, -1, 0, 1);              // D1：B2 往西下 0 → -1.45
    run(XB, +1, -1, -DROP, 2);          // D2：B3 往东下 -1.45 → -2.90
    run(XD, +1, +1, DROP, 3);           // U2：B4 往东上 +1.45 → +2.90
    /* 转角平台：下行(B2↔B3) 在 XC~XB，上行(B1↔B4) 在 XE~XD */
    barricadeGrp.add(put(box(XB - XC, T, B[2][1] - B[1][0], stF), (XB + XC) / 2, -DROP - T / 2, (B[1][0] + B[2][1]) / 2));
    barricadeGrp.add(put(box(XD - XE, T, B[3][1] - B[0][0], stF), (XD + XE) / 2, DROP - T / 2, (B[0][0] + B[3][1]) / 2));
    /* 跑道之间的斜扶手 + 自适应立柱（不浮空）*/
    function rail(x0, y0, x1, y1, z, footFn) {
      const len = Math.hypot(x1 - x0, y1 - y0);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 6), railM);
      bar.position.set((x0 + x1) / 2, (y0 + y1) / 2 + 0.92, z);
      bar.rotation.z = Math.PI / 2 - Math.atan2(y1 - y0, x1 - x0);
      barricadeGrp.add(bar);
      for (let i = 0; i <= 3; i++) {
        const k = i / 3, px = x0 + (x1 - x0) * k, topY = y0 + (y1 - y0) * k + 0.92;
        const footY = footFn(px), h = Math.max(0.25, topY - footY);
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, h, 5), postM);
        p.position.set(px, footY + h / 2, z); barricadeGrp.add(p);
      }
    }
    const stepUpW = function (px) { return RISE * Math.min(NST, Math.max(0, Math.floor((XA - px) / TREAD) + 1)); };
    const stepDnW = function (px) { return -stepUpW(px); };
    rail(XA, 0, XD, DROP, B[0][1], stepUpW);            // B1/B2 之间
    rail(XA, 0, XB, -DROP, B[1][1], stepDnW);           // B2/B3 之间
    rail(XB, -DROP, XA, -2 * DROP, B[2][1], function (px) {
      return -DROP - RISE * Math.min(NST, Math.max(0, Math.floor((px - XB) / TREAD) + 1));
    });                                                  // B3/B4 之间
    /* 各跑道东端的护栏：防止从入口平台一步踏进 ±2.90 的条带 */
    barricadeGrp.add(put(box(0.05, 0.92, B[2][1] - B[2][0], M(0x2a2724, { r: 0.9 })), XA - 0.02, -2.44, ZC(2)));
    barricadeGrp.add(put(box(0.05, 0.92, B[3][1] - B[3][0], M(0x2a2724, { r: 0.9 })), XA - 0.02, 3.36, ZC(3)));
    /* 楼层牌（5F / 4F / R）+ 照明：数量控制在 3 盏 */
    barricadeGrp.add(put(box(0.03, 0.22, 0.3, M(0x46523f, { e: 0x232f20, ei: 0.6 })), XE + 0.06, 1.8, ZC(0)));
    barricadeGrp.add(put(box(0.03, 0.22, 0.3, M(0x46523f, { e: 0x232f20, ei: 0.6 })), XE + 0.06, -1.1, ZC(2)));
    /* 照明：4 条跑道各一盏低强度导向灯，贴着跑道中段照踏面。
       强度都压得很低（0.3~0.45），只为看清脚下，不破坏暗场氛围。 */
    barricadeGrp.add(put(new THREE.PointLight(0x8a9c80, 0.42, 6.5, 2), (XA + XD) / 2, 1.5, ZC(0)));
    barricadeGrp.add(put(new THREE.PointLight(0x7d8f74, 0.42, 6.5, 2), (XA + XB) / 2, 0.4, ZC(1)));
    barricadeGrp.add(put(new THREE.PointLight(0x6d7f66, 0.38, 6.5, 2), (XA + XB) / 2, -2.0, ZC(2)));
    barricadeGrp.add(put(new THREE.PointLight(0x8a9c80, 0.38, 6.5, 2), (XA + XD) / 2, 3.0, ZC(3)));
  }

    /* ---- 挡路的废料：塌落的梁 + 碎块 + 断筋（劈三下清掉）---- */
    barricadePlanks = [];
    function addDebris(mesh, order) {
      barricadeGrp.add(mesh);
      barricadePlanks.push({
        mesh: mesh, fallen: false, t: 0, order: order,
        homePos: mesh.position.clone(), homeRot: mesh.rotation.clone(),
        // 清开后：推到门洞两侧贴地堆着（躺平，不浮空）
        landPos: new THREE.Vector3(
          -6.45 + (Math.random() - 0.5) * 0.5,
          0.07 + order * 0.02,
          DZ + (order % 2 === 0 ? -1 : 1) * (0.95 + Math.random() * 0.3)),
        landRot: new THREE.Vector3(Math.PI / 2, Math.random() * 3, 0)
      });
    }
    /* 挡路的只有两根断下来的房梁（棕色木料，身上带火）。
       混凝土碎块/钢筋/积灰全部去掉 —— 那些是深色的，堵在门口什么都看不见。
       劈砍时先断成两截再倒下（见 updateBarricade 的 snap 阶段）。 */
    // 主梁：斜插在门口下半部，上半部留空，站在走廊就能看见里面的楼梯
    const beamM = M(0x7a5c3c, { e: 0x2a1206, ei: 0.5, r: 0.85 });   // 被火烤过的木头，自带余烬红
    const beam = put(box(0.19, 0.24, 2.3, beamM), -6.66, 0.80, DZ - 0.15);
    beam.rotation.set(0.70, 0.06, 0.10);
    addDebris(beam, 0);
    // 副梁：横压在主梁下方
    const beam2 = put(box(0.16, 0.20, 1.7, beamM), -6.58, 0.40, DZ + 0.30);
    beam2.rotation.set(-0.32, 0.12, 0.05);
    addDebris(beam2, 1);
    // 梁上的火：两簇小火苗（复用 addFlame，不新建材质）
    addFlame(barricadeGrp, -6.62, 1.05, DZ - 0.55, 0.55, 0.7);
    addFlame(barricadeGrp, -6.58, 0.62, DZ + 0.75, 0.45, 0.6);
  }


  /* ============ 天台（+2.90）============
     楼梯井出来就是屋面：护栏、水塔、通风机组、管道、空调外机——
     障碍物多一些，方便绕着周旋。剧情内容不做，只放几何和刷子弹的台子。 */
  roofGrp = new THREE.Group();
  playerRoom.add(roofGrp);
  {
    const RY = 2.90;                                    // 天台标高
    const RX0 = -12.9, RX1 = 11.3, RZ0 = -2.8, RZ1 = 6.5;
    const deck = M(0x22201d, { r: 0.95 });              // 屋面（沥青/水泥）
    const para = M(0x2b2825, { r: 0.9 });               // 护栏压顶
    const metal = M(0x3c4044, { r: 0.5, m: 0.72 });
    const rust = M(0x4a3428, { r: 0.85, m: 0.3 });
    /* 屋面板 */
    roofGrp.add(put(box(RX1 - RX0, T, RZ1 - RZ0, deck), (RX0 + RX1) / 2, RY - T / 2, (RZ0 + RZ1) / 2));
    /* 女儿墙（四周护栏，1.05m 高）+ 压顶 */
    const PH = 1.05;
    [[RX0, RX1, RZ0, RZ0], [RX0, RX1, RZ1, RZ1]].forEach(function (s) {
      roofGrp.add(put(box(RX1 - RX0, PH, 0.22, M(0x262320, { r: 0.94 })), (RX0 + RX1) / 2, RY + PH / 2, s[2]));
      roofGrp.add(put(box(RX1 - RX0, 0.07, 0.3, para), (RX0 + RX1) / 2, RY + PH, s[2]));
    });
    [RX0, RX1].forEach(function (sx) {
      roofGrp.add(put(box(0.22, PH, RZ1 - RZ0, M(0x262320, { r: 0.94 })), sx, RY + PH / 2, (RZ0 + RZ1) / 2));
      roofGrp.add(put(box(0.3, 0.07, RZ1 - RZ0, para), sx, RY + PH, (RZ0 + RZ1) / 2));
    });
    /* 楼梯井出屋面的小屋（penthouse）：包住上行井顶 */
    roofGrp.add(put(box(5.6, 2.3, 4.1, M(0x2a2724, { r: 0.93 })), -10.0, RY + 1.15, 4.4));
    roofGrp.add(put(box(5.9, 0.12, 4.4, para), -10.0, RY + 2.3, 4.4));
    /* 天台出口的门：从 B4 跑道走上来后正对这道门。
       门框 + 一扇被顶开的铁门（斜挂在洞口一侧，不挡路），
       门洞落在 B4 出口条带的 z 上（5.30~6.20，中心 5.75）。 */
    {
      const dz = 5.75, dw = 1.0, dh = 2.05;
      const frameM = M(0x4a4640, { r: 0.7, m: 0.4 });
      const doorM = M(0x565049, { r: 0.6, m: 0.55 });
      // 门框两柱 + 门楣（贴在 penthouse 朝东那面墙 x=-7.2）
      roofGrp.add(put(box(0.12, dh + 0.1, 0.12, frameM), -7.2, RY + dh / 2, dz - dw / 2));
      roofGrp.add(put(box(0.12, dh + 0.1, 0.12, frameM), -7.2, RY + dh / 2, dz + dw / 2));
      roofGrp.add(put(box(0.12, 0.14, dw + 0.24, frameM), -7.2, RY + dh + 0.07, dz));
      // 被顶开的铁门：绕门柱转开 100°，贴着墙面不占门洞
      const rd = put(box(0.05, dh - 0.06, dw - 0.06, doorM), -6.72, RY + (dh - 0.06) / 2, dz + dw / 2 + 0.44);
      rd.rotation.y = -1.75; roofGrp.add(rd);
      // 门上的横推杆 + "天台 / ROOF" 指示牌
      roofGrp.add(put(box(0.04, 0.06, 0.62, M(0x8a8378, { r: 0.5, m: 0.6 })), -6.66, RY + 1.02, dz + dw / 2 + 0.44));
      roofGrp.add(put(box(0.03, 0.2, 0.34, M(0x46523f, { e: 0x232f20, ei: 0.55 })), -7.14, RY + dh + 0.3, dz));
      // 门口的一小片积水反光（屋面漏雨），暗示这里是室外
      const pud = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.1),
        new THREE.MeshStandardMaterial({ color: 0x101418, roughness: 0.18, metalness: 0.5 }));
      pud.rotation.x = -Math.PI / 2; pud.position.set(-6.2, RY + 0.012, dz - 0.2);
      roofGrp.add(pud);
    }
    /* 水塔：圆柱 + 四条支腿 + 爬梯 */
    {
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.15, 1.7, 12), rust);
      tank.position.set(-4.2, RY + 2.35, 0.6); roofGrp.add(tank);
      roofGrp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.1, 12), metal), -4.2, RY + 3.24, 0.6));
      for (const lx of [-0.78, 0.78]) for (const lz of [-0.78, 0.78]) {
        roofGrp.add(put(box(0.1, 1.5, 0.1, metal), -4.2 + lx, RY + 0.75, 0.6 + lz));
      }
      /* 爬梯：两根竖直立柱 + 短横档（原来是一排 0.5m 长的横板，
         看着像一段楼梯而不是爬梯）*/
      for (const rz of [0.48, 0.72]) {
        const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 2.1, 6), metal);
        rail.position.set(-3.05, RY + 1.05, rz);
        roofGrp.add(rail);
      }
      for (let i = 0; i < 7; i++) {
        const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.26, 5), metal);
        rung.rotation.x = Math.PI / 2;
        rung.position.set(-3.05, RY + 0.22 + i * 0.28, 0.6);
        roofGrp.add(rung);
      }
      roofGrp.add(put(new THREE.CylinderGeometry ? new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6), metal) : new THREE.Object3D(), -4.2, RY + 0.8, 1.85));
    }
    /* 通风机组（大方箱 + 圆罩）*/
    roofGrp.add(put(box(2.2, 1.15, 1.6, M(0x35322e, { r: 0.88 })), 1.6, RY + 0.58, -1.3));
    roofGrp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.5, 10), metal), 1.6, RY + 1.4, -1.3));
    roofGrp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.5, 0.18, 10), metal), 1.6, RY + 1.72, -1.3));
    /* 空调外机 ×4（一排，可以当掩体）*/
    for (let i = 0; i < 4; i++) {
      const ax = -1.4 + i * 1.35;
      roofGrp.add(put(box(0.95, 0.75, 0.42, M(0x4a4d50, { r: 0.6, m: 0.4 })), ax, RY + 0.38, 3.7));
      roofGrp.add(put(new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.02, 4, 10), metal), ax, RY + 0.42, 3.49));
    }
    /* 管道：贴地横穿 + 两个立管 */
    roofGrp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 9.0, 8), rust), -1.5, RY + 0.2, 1.9).rotateZ(Math.PI / 2));
    for (const px of [-6.0, 3.4]) {
      roofGrp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.5, 8), rust), px, RY + 0.75, 1.9));
      roofGrp.add(put(new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.05, 4, 10), metal), px, RY + 1.45, 1.9));
    }
    /* 电梯机房 + 几个通风竖井（更多遮挡）*/
    roofGrp.add(put(box(2.0, 1.9, 1.8, M(0x2d2a27, { r: 0.92 })), 5.4, RY + 0.95, -1.1));
    for (let i = 0; i < 3; i++) {
      roofGrp.add(put(box(0.6, 0.55, 0.6, M(0x33302c, { r: 0.9 })), -8.4 + i * 1.1, RY + 0.28, -1.7));
    }
    /* 刷子弹的台子（配电箱改的矮台）*/
    roofGrp.add(put(box(0.9, 0.62, 0.6, M(0x3b3f42, { r: 0.7, m: 0.35 })), -1.9, RY + 0.31, -0.9));
    roofGrp.add(put(box(0.95, 0.06, 0.66, metal), -1.9, RY + 0.64, -0.9));
    /* 天台补给点：不另建一件子弹（id 会和 505 那盒冲突，也没进 worldItems），
       进天台时把同一件 bulletsObj 搬到这个台子上，数量设为 6 —— 见 onLevelEnter */
    roofBulletsObj = new THREE.Object3D();
    roofBulletsObj.position.set(-1.9, RY + 0.70, -0.9);
    roofGrp.add(roofBulletsObj);
    /* 夜空下的火：远处山火墙 + 城市剪影 + 飘过的火星 */
    {
      const fw = new THREE.Mesh(new THREE.PlaneGeometry(90, 26), fireWallMat.clone());
      fw.position.set(0, RY + 6, RZ0 - 34); roofGrp.add(fw);
      outFireWalls.push(fw.material);
      for (let i = 0; i < 16; i++) {                 // 城市/山脊剪影
        const h = 2 + Math.random() * 7;
        roofGrp.add(put(box(2 + Math.random() * 3, h, 1.5, M(0x0a0908)),
          -34 + i * 4.4 + Math.random() * 2, RY + h / 2 - 1.2, RZ0 - 16 - Math.random() * 8));
      }
      /* 另外三面也点着——整条地平线都在烧，天台四周被火场包围 */
      const cx = (RX0 + RX1) / 2, cz = (RZ0 + RZ1) / 2;
      // 南（+z，玩家背后）
      const fwS = new THREE.Mesh(new THREE.PlaneGeometry(90, 22), fireWallMat.clone());
      fwS.position.set(cx, RY + 5, RZ1 + 34); fwS.rotation.y = Math.PI; roofGrp.add(fwS);
      outFireWalls.push(fwS.material);
      // 东（+x，右侧）
      const fwE = new THREE.Mesh(new THREE.PlaneGeometry(80, 22), fireWallMat.clone());
      fwE.position.set(RX1 + 34, RY + 5, cz); fwE.rotation.y = -Math.PI / 2; roofGrp.add(fwE);
      outFireWalls.push(fwE.material);
      // 西（-x，左侧）
      const fwW = new THREE.Mesh(new THREE.PlaneGeometry(80, 22), fireWallMat.clone());
      fwW.position.set(RX0 - 34, RY + 5, cz); fwW.rotation.y = Math.PI / 2; roofGrp.add(fwW);
      outFireWalls.push(fwW.material);
      // 三面各点一盏远火余光，避免另外三侧全黑
      roofGrp.add(put(new THREE.PointLight(0xff5a1e, 0.5, 40, 2), cx, RY + 5, RZ1 + 20));
      roofGrp.add(put(new THREE.PointLight(0xff5a1e, 0.45, 40, 2), RX1 + 20, RY + 5, cz));
      roofGrp.add(put(new THREE.PointLight(0xff5a1e, 0.45, 40, 2), RX0 - 20, RY + 5, cz));
    }
    /* 屋面照明：火光为主（天台没电） */
    roofGrp.add(put(new THREE.PointLight(0xff6a2a, 0.85, 26, 2), 0, RY + 4.5, RZ0 - 6));
    roofGrp.add(put(new THREE.PointLight(0xff8a4a, 0.35, 12, 2), -3.0, RY + 2.2, 1.2));
  }

  /* ============ 四楼（-2.90）：走廊与房间外壳 ============
     房间内部与门交互先不做，只把空间和门面立起来。 */
  lvl4Grp = new THREE.Group();
  playerRoom.add(lvl4Grp);
  {
    const FY = -2.90;                                  // 四楼标高
    const c4 = M(0x100e0c, { r: 0.96 });
    const f4 = M(0x0e0c0b, { r: 0.94 });
    const d4 = M(0x1f1610, { r: 0.9 });
    const CX0 = -7.0, CX1 = 7.0, CZ0 = 2.34, CZ1 = 4.34;
    /* 走廊地面 / 顶板 */
    lvl4Grp.add(put(box(CX1 - CX0, T, CZ1 - CZ0, f4), 0, FY - T / 2, (CZ0 + CZ1) / 2));
    lvl4Grp.add(put(box(CX1 - CX0, T, CZ1 - CZ0, M(0x090808)), 0, FY + RH + T / 2, (CZ0 + CZ1) / 2));
    /* 两侧墙 + 门洞（南侧：401 / 电梯门(原403位) / 405，北侧：402/404；门都关着，先不做交互）*/
    const DW = 1.0, SAME4 = [-4.4, 4.4], OPP4 = [-3.2, 3.2];
    function wall4(zPos, holes) {
      let segs = [], prev = CX0;
      holes.slice().sort(function (a, b) { return a - b; }).forEach(function (h) {
        segs.push([prev, h - DW / 2]); prev = h + DW / 2;
      });
      segs.push([prev, CX1]);
      segs.forEach(function (s) {
        if (s[1] - s[0] > 0.01) lvl4Grp.add(put(box(s[1] - s[0], RH, T, c4), (s[0] + s[1]) / 2, FY + RH / 2, zPos));
      });
      holes.forEach(function (h) {      // 门楣
        lvl4Grp.add(put(box(DW, RH - 2.05, T, c4), h, FY + 2.05 + (RH - 2.05) / 2, zPos));
      });
    }
    /* 南墙开三个洞：401(x=-4.4) / 电梯门(x=0，电梯组装体自己包边) / 405(x=4.4) */
    wall4(CZ0, [-4.4, 0, 4.4]);
    wall4(CZ1, OPP4);
    /* 关着的房门（纯几何，无交互）：401 关死；405 敞开（门板在房间里搭出来） */
    lvl4Grp.add(put(box(DW - 0.04, 2.02, 0.05, d4), -4.4, FY + 1.01, CZ0 + 0.03));
    OPP4.forEach(function (ox) { lvl4Grp.add(put(box(DW - 0.04, 2.02, 0.05, d4), ox, FY + 1.01, CZ1 - 0.03)); });
    /* 两端端墙：左端接下行井（开洞），右端封死 */
    {
      const SDZ = 3.43, SDW = 0.78, SDH = 2.24;
      lvl4Grp.add(put(box(T, RH, SDZ - SDW - CZ0, c4), CX0, FY + RH / 2, (CZ0 + SDZ - SDW) / 2));
      lvl4Grp.add(put(box(T, RH, CZ1 - (SDZ + SDW), c4), CX0, FY + RH / 2, (SDZ + SDW + CZ1) / 2));
      lvl4Grp.add(put(box(T, RH - SDH, SDW * 2, c4), CX0, FY + SDH + (RH - SDH) / 2, SDZ));
    }
    lvl4Grp.add(put(box(T, RH, CZ1 - CZ0, c4), CX1, FY + RH / 2, (CZ0 + CZ1) / 2));

    /* ============ 电梯门（南侧墙正中 x=0）：视觉上要一眼认出 ============
       亮钢双开门 + 红黑警示门框 + 门缝红色发光条 + 红色检修灯 + 发光「停运」标牌。
       撬开后 elev4Doors 隐藏、elev4Bent（弯开门板）与 elev4Shaft（井道）显现。 */
    {
      const EY = FY, EZ = CZ0;                 // 电梯所在墙面
      const EW = 1.44, EH = 2.3;               // 门洞外包边
      /* —— 闭合状态（默认）—— */
      elev4Doors = new THREE.Group();
      elev4Doors.position.set(0, EY, EZ);
      lvl4Grp.add(elev4Doors);
      {
        const steel = M(0x6a7076, { r: 0.22, m: 0.9 });   // 高反光拉丝钢
        // 门框：红黑警示条纹一圈（交替小块拼出，视觉突出）
        const redM = M(0xb42218, { r: 0.6 });
        const blkM = M(0x14100e, { r: 0.7 });
        for (let i = 0; i < 10; i++) {
          const w = EW / 10;
          elev4Doors.add(put(box(w * 0.92, 0.16, 0.1, i % 2 ? redM : blkM),
            -EW / 2 + w / 2 + i * w, EH + 0.1, T / 2 + 0.03));
        }
        // 门框立柱（左右竖框，同样带条纹顶块）
        elev4Doors.add(put(box(0.14, EH, 0.12, M(0x2c3134, { r: 0.4, m: 0.7 })), -EW / 2 - 0.02, EH / 2, T / 2 + 0.03));
        elev4Doors.add(put(box(0.14, EH, 0.12, M(0x2c3134, { r: 0.4, m: 0.7 })), EW / 2 + 0.02, EH / 2, T / 2 + 0.03));
        // 两扇闭合门板（各半宽，中间留缝）
        elev4Doors.add(put(box(EW / 2 - 0.03, EH - 0.06, 0.06, steel), -(EW / 4 - 0.015), (EH - 0.06) / 2, T / 2 + 0.02));
        elev4Doors.add(put(box(EW / 2 - 0.03, EH - 0.06, 0.06, steel), (EW / 4 - 0.015), (EH - 0.06) / 2, T / 2 + 0.02));
        // 门缝红色发光条：夜里一条竖红缝，一眼锁定
        elev4Doors.add(put(box(0.05, EH - 0.1, 0.015, M(0x33060a, { e: 0xff2a14, ei: 1.6 })), 0, (EH - 0.1) / 2, T / 2 + 0.06));
        // 楼层显示窗（暗）
        elev4Doors.add(put(box(0.2, 0.14, 0.02, M(0x05070a, { e: 0x0a1418, ei: 0.6 })), EW / 2 + 0.02, EH - 0.24, T / 2 + 0.1));
        // 红色检修灯（自发光 + 点光源）
        elev4Doors.add(put(box(0.1, 0.08, 0.06, M(0x300406, { e: 0xff1e10, ei: 2.2 })), -EW / 2 - 0.02, EH - 0.06, T / 2 + 0.1));
        elev4Doors.add(put(new THREE.PointLight(0xff2412, 0.55, 3.2, 2), 0, EH - 0.1, T / 2 + 0.35));
        // 发光「停运」标牌
        elev4Doors.add(put(box(0.62, 0.2, 0.02, M(0x1c0505, { e: 0xd22315, ei: 1.1 })), 0, EH + 0.36, T / 2 + 0.05));
      }
      /* —— 撬开状态（隐藏，pryElevator 时显示）—— */
      elev4Bent = new THREE.Group();
      elev4Bent.position.set(0, EY, EZ);
      elev4Bent.visible = false;
      lvl4Grp.add(elev4Bent);
      {
        const steelB = M(0x565c62, { r: 0.3, m: 0.85 });
        // 两扇被撬开的门板：斜着别在门洞两侧，中间露出大缺口
        const bl = put(box(EW / 2, EH - 0.1, 0.05, steelB), -EW / 2 - 0.28, (EH - 0.1) / 2, T / 2 + 0.34);
        bl.rotation.y = 0.9; elev4Bent.add(bl);
        const br = put(box(EW / 2, EH - 0.1, 0.05, steelB), EW / 2 + 0.28, (EH - 0.1) / 2, T / 2 + 0.34);
        br.rotation.y = -0.9; elev4Bent.add(br);
      }
      /* —— 井道内部（隐藏，撬开后可见）——
         直井下去 ~9m；一条笔直的绳子；一楼侧面透上来的火光（井底保持黑）。 */
      elev4Shaft = new THREE.Group();
      elev4Shaft.position.set(0, EY, EZ);
      elev4Shaft.visible = false;
      lvl4Grp.add(elev4Shaft);
      {
        const SW = 1.5, SD = 1.3, DEPTH = 9.2;    // 井宽/井深/向下深度
        const dark = M(0x08090a, { r: 0.95 });
        const bl2 = new THREE.Mesh(new THREE.PlaneGeometry(SW, DEPTH), dark);
        bl2.position.set(0, -DEPTH / 2 + 1.0, -SD / 2); elev4Shaft.add(bl2);       // 井后壁
        const sL = new THREE.Mesh(new THREE.PlaneGeometry(SD, DEPTH), dark);
        sL.rotation.y = Math.PI / 2; sL.position.set(-SW / 2, -DEPTH / 2 + 1.0, 0); elev4Shaft.add(sL);  // 井左壁
        const sR = new THREE.Mesh(new THREE.PlaneGeometry(SD, DEPTH), dark);
        sR.rotation.y = -Math.PI / 2; sR.position.set(SW / 2, -DEPTH / 2 + 1.0, 0); elev4Shaft.add(sR); // 井右壁
        // 一条笔直的绳子：从开口上沿一直垂进黑暗（加长，顶端藏在门楣后）
        elev4Shaft.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 10.6, 6),
          M(0x9a8a6c, { r: 0.9 })), 0, -2.9, -0.2));
        // 一楼侧面的火光：暖光打在井壁上 + 两片小火苗（光追效果）
        elev4Shaft.add(put(new THREE.PointLight(0xff6a24, 1.5, 6.5, 2), 0.45, -DEPTH + 1.3, -0.3));
        addFlame(elev4Shaft, -0.42, -DEPTH + 0.55, -0.35, 0.5, 0.8);
        addFlame(elev4Shaft, 0.48, -DEPTH + 0.4, -0.5, 0.42, 0.65);
      }
    }

    /* ============ 红色工具箱（走廊东端墙）：镰刀与锤子 ============ */
    {
      const CX = CX1 - T / 2 - 0.02, CZ = (CZ0 + CZ1) / 2;   // 端墙面中央
      const CW4 = 0.85, CH4 = 0.85, CD4 = 0.24;               // 约玩家模型一半长宽
      const redBox = M(0xa8241a, { r: 0.55, m: 0.3 });        // 消防红
      const grp = new THREE.Group();
      grp.position.set(CX - CD4 / 2, FY + 1.45, CZ);          // 悬挂高度 ~1.45m，玻璃面朝走廊(-x)
      lvl4Grp.add(grp);
      // 箱体五面板（前面留玻璃）：背/顶/底/左右
      grp.add(put(box(0.03, CH4, CW4, redBox), CD4 / 2 - 0.015, 0, 0));
      grp.add(put(box(CD4, 0.03, CW4, M(0x777c80, { r: 0.4, m: 0.7 })), 0, CH4 / 2 - 0.015, 0));
      grp.add(put(box(CD4, 0.03, CW4, M(0x777c80, { r: 0.4, m: 0.7 })), 0, -CH4 / 2 + 0.015, 0));
      grp.add(put(box(CD4, CH4, 0.03, redBox), 0, 0, -CW4 / 2 + 0.015));
      grp.add(put(box(CD4, CH4, 0.03, redBox), 0, 0, CW4 / 2 - 0.015));
      // 前玻璃（引用留存：打碎时隐藏）
      caseGlass4 = put(box(0.015, CH4 - 0.06, CW4 - 0.06,
        new THREE.MeshStandardMaterial({
          color: 0x9fc4d4, transparent: true, opacity: 0.22, roughness: 0.08,
          metalness: 0.1, side: THREE.DoubleSide, depthWrite: false
        })), -CD4 / 2 + 0.012, 0, 0);
      grp.add(caseGlass4);
      // 标签（贴在箱内下沿，随箱不随道具）
      grp.add(put(box(0.012, 0.07, 0.4, M(0xd8d2c4, { e: 0x6a6458, ei: 0.35 })), -CD4 / 2 + 0.025, -CH4 / 2 + 0.09, 0));
      /* 镰刀与锤子（☭ 式交错）：贴在箱内的墙面平面上（y-z 平面），不穿模。
         镰刀：整体偏左；短握把指向右上 45°；月牙绕圆心顺时针转 70°——
         弧从左下（−115°）扫过右下、右侧收在右上（35°），柄顶连在弧上的刃底。
         锤子：整体偏右下，握把指向左上 45°，与镰刀交错。 */
      toolsObj = new THREE.Group();
      toolsObj.position.copy(grp.position);
      toolsObj.visible = true;
      lvl4Grp.add(toolsObj);
      {
        const wood = M(0x6b4526, { r: 0.88 });
        const steel2 = M(0xb9c0c6, { r: 0.28, m: 0.85 });
        /* —— 镰刀 ——
           圆心 C=(0,0.12,−0.06)（整体左移），R=0.26，弧 150°：
           起刀角 −45°−70° = −115°，顺时针转过底部与右侧，收在 35°（右上）。 */
        const CB_R = 0.26;
        const CB_C = { x: 0, y: 0.12, z: -0.06 };
        /* 刃的起点（起刀端，−115°）——木柄要接在这里，而不是弧上随便一点 */
        const CB_S = {
          x: 0,
          y: CB_C.y + CB_R * Math.sin(-115 * Math.PI / 180),
          z: CB_C.z + CB_R * Math.cos(-115 * Math.PI / 180)
        };
        // 短握把：顶端接在刃的起点，向左下 45°（轴沿右上 45°）
        const sic = new THREE.Group();
        sic.position.set(CB_S.x, CB_S.y - 0.092, CB_S.z - 0.092);
        sic.rotation.x = Math.PI / 4;
        toolsObj.add(sic);
        sic.add(new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.016, 0.26, 7), wood));
        // 月牙：环面转到墙面平面；起刀 −115°（= −45° 再顺时针 70°），扫 150°
        const arcWrap = new THREE.Group();
        arcWrap.position.set(CB_C.x, CB_C.y, CB_C.z);
        arcWrap.rotation.y = -Math.PI / 2;          // 环面局部 X→+Z、Y→+Y（落到墙面）
        toolsObj.add(arcWrap);
        const cres = new THREE.Mesh(new THREE.TorusGeometry(CB_R, 0.018, 5, 16, Math.PI * 5 / 6), steel2);
        cres.rotation.z = -Math.PI / 4 - (70 * Math.PI / 180);   // 起刀 −115°，收在 35°（右上）
        arcWrap.add(cres);
        /* —— 锤子：整体偏右下，握把指向左上 45°，穿过月牙 —— */
        const ham = new THREE.Group();
        ham.position.set(0, 0.05, 0.07);
        ham.rotation.x = -Math.PI / 4;
        toolsObj.add(ham);
        ham.add(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.019, 0.56, 7), wood));
        ham.add(put(box(0.05, 0.09, 0.2, steel2), 0, 0.24, 0));   // 锤头在上端（左上）
        // 交错点绑带（刃的起点处，锤柄与镰把交汇）
        toolsObj.add(put(box(0.04, 0.14, 0.05, M(0x241a12, { r: 0.9 })), CB_S.x, CB_S.y, CB_S.z));
      }
      toolsObj.userData.pickup = { id: 'tools', name: '镰刀与锤子' };
      /* 手持专用模型：左手镰刀（刀刃朝前）、右手锤子 —— 双手抱持 */
      toolsHeldObj = new THREE.Group();
      {
        const woodH = M(0x6b4526, { r: 0.88 });
        const steelH = M(0xb9c0c6, { r: 0.28, m: 0.85 });
        // 右手：锤子（握把竖握，锤头朝上前）
        const hh = new THREE.Group();
        hh.position.set(0.16, -0.34, -0.46);
        hh.rotation.set(0.32, 0.1, -0.14);
        toolsHeldObj.add(hh);
        hh.add(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.019, 0.52, 7), woodH));
        hh.add(put(box(0.05, 0.09, 0.2, steelH), 0, 0.24, 0));
        // 左手：镰刀（短柄竖握，月牙从柄顶向前勾——刀刃朝前）
        const hs = new THREE.Group();
        hs.position.set(-0.17, -0.34, -0.46);
        hs.rotation.set(0.22, -0.1, 0.14);
        toolsHeldObj.add(hs);
        hs.add(new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.016, 0.42, 7), woodH));
        const arcH = new THREE.Group();
        arcH.position.set(0, 0.23, 0);
        arcH.rotation.y = 0;                        // 月牙平面转到正对视角（原 y-z 平面绕柄轴转了 90°，之前是侧对镜头）
        hs.add(arcH);
        const cresH = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.012, 5, 14, Math.PI * 0.75), steelH);
        cresH.rotation.z = Math.PI / 4 + Math.PI / 6;  // 再逆时针 30°：整体从顶上向左再偏一点
        arcH.add(cresH);
      }
    }

    /* ============ 405 房间（复用 503 布局：床/床头柜/卫生间隔墙）============
       差异：浴室门是关死的木门（不建洁具）、无衣柜、
       窗户位置是一个被炸开的大洞，屋内有火，洞外挂空调外机。
       局部原点 (4.4, FY, 0)，与走廊南墙的 405 门洞对齐。 */
    {
      const rm = new THREE.Group();
      rm.position.set(4.4, FY, 0);
      lvl4Grp.add(rm);
      const RW4 = 5.2, RD4 = 4.6, RH4 = 2.7;
      const wall4m = M(0x151210, { r: 0.96 });
      /* 玻璃必须用普通 MeshStandardMaterial 透明配方（同工具箱玻璃）——
         MeshPhysicalMaterial 的 transmission 在不少环境里会整面渲染成不透明，
         看起来就像窗户被"封死"了 */
      const paneMat = new THREE.MeshStandardMaterial({ color: 0x9fc4d4, transparent: true, opacity: 0.16, roughness: 0.08, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
      acWindowGlass = new THREE.Mesh(new THREE.PlaneGeometry(2.55, 1.82), paneMat);
      acWindowGlass.position.set(0, 1.36, -RD4 / 2 - 0.025); rm.add(acWindowGlass);
      const floor4m = M(0x0f0d0b, { r: 0.94 });
      // 地板 / 天花
      rm.add(put(box(RW4, T, RD4, floor4m), 0, -T / 2, 0));
      rm.add(put(box(RW4, T, RD4, M(0x090807)), 0, RH4 + T / 2, 0));
      // 左右墙（+z 侧不砌：走廊南墙已有 405 门洞）
      rm.add(put(box(T, RH4, RD4, wall4m), -RW4 / 2, RH4 / 2, 0));
      rm.add(put(box(T, RH4, RD4, wall4m), RW4 / 2, RH4 / 2, 0));
      /* 窗墙（-z）：大洞（x -1.3~1.3，y 0.35~2.35），像被炸开 */
      {
        const BX0 = -1.3, BX1 = 1.3, BY0 = 0.35, BY1 = 2.35;
        rm.add(put(box(BX0 + RW4 / 2, RH4, T, wall4m), (-RW4 / 2 + BX0) / 2, RH4 / 2, -RD4 / 2));
        rm.add(put(box(RW4 / 2 - BX1, RH4, T, wall4m), (BX1 + RW4 / 2) / 2, RH4 / 2, -RD4 / 2));
        rm.add(put(box(BX1 - BX0, BY0, T, wall4m), (BX0 + BX1) / 2, BY0 / 2, -RD4 / 2));
        rm.add(put(box(BX1 - BX0, RH4 - BY1, T, wall4m), (BX0 + BX1) / 2, (BY1 + RH4) / 2, -RD4 / 2));
        // 炸开的焦黑碎片边（参差感）
        const shardM = M(0x0c0a09, { r: 0.98 });
        for (let i = 0; i < 7; i++) {
          const sx = BX0 + (i / 6) * (BX1 - BX0) + (Math.random() - 0.5) * 0.2;
          const sy = i % 2 ? BY0 : BY1;
          const sh = put(box(0.1 + Math.random() * 0.22, 0.12 + Math.random() * 0.2, T + 0.06, shardM),
            sx, sy + (i % 2 ? 0.1 : -0.1), -RD4 / 2);
          sh.rotation.z = (Math.random() - 0.5) * 1.1; rm.add(sh);
        }
        // 墙面焦痕
        for (let i = 0; i < 3; i++) {
          const sc = new THREE.Mesh(new THREE.PlaneGeometry(1.4 + Math.random(), 1.0 + Math.random()),
            new THREE.MeshBasicMaterial({ color: 0x050404, transparent: true, opacity: 0.5 }));
          sc.position.set(-1.6 + i * 1.5, 1.2, -RD4 / 2 + T / 2 + 0.011);
          rm.add(sc);
        }
      }
      /* 405 门板：向内敞开 ~80°（铰链在洞西侧） */
      {
        const hinge = new THREE.Group();
        hinge.position.set(-0.48, 0, RD4 / 2 - 0.06);   // 局部：门洞西缘（世界 x≈3.92）
        hinge.rotation.y = 1.4;                          // 朝屋内(-z)甩开
        rm.add(hinge);
        const dM4 = M(0x241a10, { r: 0.88 });
        hinge.add(put(box(0.96, 2.02, 0.05, dM4), 0.48, 1.01, 0));
        hinge.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 6), M(0x59402a)), 0.82, 1.0, 0.05));
      }
      /* 床 + 床头柜 + 台灯造型（4F 没电：灯不亮） */
      {
        const bedW = M(0x1f1610, { r: 0.92, m: 0.08 });
        const bed = new THREE.Group(); bed.position.set(-1.35, 0, -0.5); rm.add(bed);
        bed.add(put(box(1.58, 0.28, 2.08, bedW), 0, 0.14, 0));
        bed.add(put(box(1.48, 0.24, 1.96, M(0x1d1a17, { r: 0.98 })), 0, 0.38, 0));
        bed.add(put(box(1.56, 0.78, 0.12, bedW), 0, 0.55, 1.04));
        const ns = new THREE.Group(); ns.position.set(-0.34, 0, 0.26); rm.add(ns);
        ns.add(put(box(0.58, 0.58, 0.48, bedW), 0, 0.29, 0));
        const lampG = new THREE.Group(); lampG.position.set(-0.34, 0.58, 0.26); rm.add(lampG);
        lampG.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.028, 10), M(0x2e2a25, { m: 0.7 })), 0, 0.014, 0));
        lampG.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.24, 6), M(0x2e2a25, { m: 0.7 })), 0, 0.15, 0));
        lampG.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.14, 0.15, 10, 1, true),
          M(0x2a2118, { r: 0.85 })), 0, 0.31, 0));
      }
      /* 卫生间隔墙照搬 503（BX=-0.95 / BZ=0.75），但门洞装一扇关死的木门，不建洁具 */
      {
        const BX = -0.95, BZ = 0.75;
        const tile = M(0x1b1d1e, { r: 0.55, m: 0.08 });
        rm.add(put(box(BX + RW4 / 2, RH4, T, tile), (-RW4 / 2 + BX) / 2, RH4 / 2, BZ));
        rm.add(put(box(T, RH4, 1.05 - BZ, tile), BX, RH4 / 2, (BZ + 1.05) / 2));
        rm.add(put(box(T, RH4, RD4 / 2 - 1.95, tile), BX, RH4 / 2, (1.95 + RD4 / 2) / 2));
        rm.add(put(box(T, RH4 - 2.05, 0.9, tile), BX, 2.05 + (RH4 - 2.05) / 2, 1.5));
        // 关死的浴室木门（门洞 z 1.05~1.95 处）+ 门框
        const bdM = M(0x2b2014, { r: 0.88 });
        rm.add(put(box(0.06, 2.02, 0.9, bdM), BX, 1.01, 1.5));
        const jamb = M(0x232019, { r: 0.9 });
        rm.add(put(box(T + 0.03, 2.05, 0.06, jamb), BX, 1.025, 1.05));
        rm.add(put(box(T + 0.03, 2.05, 0.06, jamb), BX, 1.025, 1.95));
        rm.add(put(box(T + 0.03, 0.06, 0.9, jamb), BX, 2.05, 1.5));
        rm.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.12, 6), M(0x59402a, { m: 0.5 })), BX - 0.06, 1.0, 1.72));
      }
      /* 屋内火（窗边两簇）+ 烟 + 光 */
      addFlame(rm, -0.8, 0.1, -1.9, 0.8, 1.1);
      addFlame(rm, 0.9, 0.05, -2.0, 0.7, 1.0);
      addSmoke(rm, 0, RH4 - 0.45, -1.6, 2.6);
      rm.add(put(new THREE.PointLight(0xff5a1e, 1.25, 8.0, 2), 0, 1.5, -1.7));
      rm.add(put(new THREE.PointLight(0x6a5040, 0.22, 7.0, 2), 0.8, 1.4, 0.8));
      /* 窗外的空调外机：扁盒 + 风扇网 + 支架（贴在炸开洞口下方外侧） */
      {
        const ac = new THREE.Group();
        ac.position.set(0.5, 0.45, -RD4 / 2 - 0.75);
        ac.matrixAutoUpdate = true;                 // 第 4 台会被 CG 拆落，保持矩阵可动
        rm.add(ac);
        acUnitMeshes = [ac];
        const acM = M(0x565a5e, { r: 0.5, m: 0.6, e: 0x2a1206, ei: 0.45 });
        ac.add(put(box(0.9, 0.6, 0.36, acM), 0, 0, 0));
        ac.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 14), M(0x14161a)), 0, 0, -0.19).rotateX(Math.PI / 2));
        for (let i = 0; i < 5; i++) {
          ac.add(put(box(0.44, 0.012, 0.012, M(0x2c3034)), 0, -0.18 + i * 0.09, -0.2));
        }
        // 支架两根
        ac.add(put(box(0.05, 0.05, 0.5, M(0x3a3e42, { m: 0.6 })), -0.32, -0.32, 0.2));
        ac.add(put(box(0.05, 0.05, 0.5, M(0x3a3e42, { m: 0.6 })), 0.32, -0.32, 0.2));
      }
    }

    /* 窗外沿墙再布置四台独立外机：三台跳跃踏点 + 最西一台是钩爪目标（间距更近） */
    {
      const acXs = [1.7, -1.5, -4.7, -7.0];
      const acM = M(0x565a5e, { r: 0.5, m: 0.6, e: 0x2a1206, ei: 0.45 });
      for (let ai = 0; ai < acXs.length; ai++) {
        const ac = new THREE.Group(); ac.position.set(acXs[ai], FY + 0.45, -3.05); lvl4Grp.add(ac);
        ac.matrixAutoUpdate = true;
        acUnitMeshes.push(ac);
        ac.add(put(box(0.9, 0.6, 0.36, acM), 0, 0, 0));
        ac.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.02, 14), M(0x14161a)), 0, 0, -0.19).rotateX(Math.PI / 2));
        for (let ri = 0; ri < 5; ri++) ac.add(put(box(0.44, 0.012, 0.012, M(0x2c3034)), 0, -0.18 + ri * 0.09, -0.2));
        ac.add(put(box(0.05, 0.05, 0.5, M(0x3a3e42, { m: 0.6 })), -0.32, -0.32, 0.2));
        ac.add(put(box(0.05, 0.05, 0.5, M(0x3a3e42, { m: 0.6 })), 0.32, -0.32, 0.2));
      }
    }
    /* 烧得更透：焦痕、倒下的杂物、火光、浓烟（比 5F 重）*/
    for (let i = 0; i < 7; i++) {
      const sc = new THREE.Mesh(new THREE.PlaneGeometry(1.1 + Math.random(), 0.8 + Math.random()),
        new THREE.MeshBasicMaterial({ color: 0x060505, transparent: true, opacity: 0.55 }));
      sc.rotation.x = -Math.PI / 2;
      sc.position.set(-6 + i * 1.9 + Math.random(), FY + 0.012, CZ0 + 0.4 + Math.random() * 1.2);
      lvl4Grp.add(sc);
    }
    for (let i = 0; i < 6; i++) {
      const jj = put(box(0.2 + Math.random() * 0.5, 0.14, 0.2 + Math.random() * 0.4, M(0x161310, { r: 0.97 })),
        -5.5 + i * 2.0 + Math.random(), FY + 0.07, CZ0 + 0.5 + Math.random() * 1.0);
      jj.rotation.set(0, Math.random() * 3, 0); lvl4Grp.add(jj);
    }
    const fireXs = [4.9, 1.7, -1.5, -4.7, -7.0];
    for (let i = 0; i < fireXs.length; i++) {
      const fx = fireXs[i];
      addFlame(lvl4Grp, fx, FY + 1.55, -3.02, 1.18, 2.25);
      addFlame(lvl4Grp, fx - 0.28, FY + 0.65, -3.08, 0.78, 1.45);
      addFlame(lvl4Grp, fx + 0.30, FY - 0.30, -3.04, 0.88, 1.30);
      addFlame(lvl4Grp, fx + 0.10, FY + 0.15, -3.24, 0.52, 0.95);
      const fl = put(new THREE.PointLight(0xff4814, 3.4, 9.5, 2), fx, FY + 1.05, -3.02); lvl4Grp.add(fl); acFireLights.push(fl);
      const fl2 = put(new THREE.PointLight(0xff9a32, 1.1, 4.5, 2), fx - 0.18, FY + 0.35, -3.12); lvl4Grp.add(fl2); acFireLights.push(fl2);
    }
    for (let i = 0; i < 11; i++) addFlame(lvl4Grp, -5.0 + i * 0.95, FY + 0.18 + (i % 3) * 0.12, -3.16, 0.38 + (i % 2) * 0.16, 0.72 + (i % 3) * 0.18);
    /* 记录外机原始位姿（第 4 台被电锯震落后 resetGame 要摆回去） */
    acUnitHome = acUnitMeshes.map(function (u) {
      return { x: u.position.x, y: u.position.y, z: u.position.z, rx: u.rotation.x, ry: u.rotation.y, rz: u.rotation.z };
    });
    addFlame(lvl4Grp, 2.2, FY + 0.35, CZ1 - 0.5, 0.9, 1.2);
    addFlame(lvl4Grp, -3.4, FY + 0.3, CZ0 + 0.45, 0.7, 0.9);
    addSmoke(lvl4Grp, 0.0, FY + RH - 0.5, (CZ0 + CZ1) / 2, 3.2);
    addSmoke(lvl4Grp, 4.2, FY + RH - 0.55, (CZ0 + CZ1) / 2, 2.8);
    lvl4Grp.add(put(new THREE.PointLight(0xff5a20, 1.0, 9.0, 2), 2.2, FY + 1.3, CZ1 - 0.6));
    lvl4Grp.add(put(new THREE.PointLight(0xff6a24, 0.55, 6.0, 2), -3.4, FY + 1.0, CZ0 + 0.5));

    /* 窗外环境：天光基底 + 森林火场景（同开场/503 窗外的山火基调）。
       没有这一层时，外机之外全是场景底色——翻出窗一片漆黑。 */
    {
      /* 半球光：夜空冷蓝自上、地面暖光自下，给外立面一个可读的底亮度 */
      lvl4Grp.add(new THREE.HemisphereLight(0x36404f, 0x140d08, 0.7));
      /* 4F 沿线燃着的窗（405 以西各户）：自发光，贴在外立面表面（立面外皮 z≈-2.30），
         外机行走时是唯一稳定的视觉参照 */
      for (const wx of [3.4, 0.6, -2.2, -5.0, -7.6]) {
        lvl4Grp.add(put(box(0.66, 0.85, 0.05, M(0x1a0f07, { e: 0xff7a2a, ei: 0.9, r: 0.8 })), wx, FY + 1.25, -2.28));
      }
      /* 街上两处火点：从四楼外能看见楼下在烧（地面用坠楼外立面自带的那块） */
      addFlame(lvl4Grp, -6.5, -13.3, -9.5, 1.1, 1.8);
      addFlame(lvl4Grp, 5.5, -13.4, -12.5, 0.9, 1.5);
      lvl4Grp.add(put(new THREE.PointLight(0xff4814, 1.0, 16, 2), -6.5, -12.6, -9.5));
      /* 本楼低层窗外火（3F/2F 窗口翻火，低头时墙面有内容） */
      addFlame(lvl4Grp, 3.0, FY - 2.55, -2.62, 0.9, 1.5);
      addFlame(lvl4Grp, 0.2, FY - 2.2, -2.6, 0.7, 1.2);
      addFlame(lvl4Grp, -3.0, FY - 2.7, -2.62, 0.8, 1.3);
      /* 森林火场：近处燃烧的树（从外机线低头/远眺都有内容） */
      const burnTreeSpots = [
        [-8.5, -8.0, 1], [-4.0, -10.5, 0], [1.5, -9.0, 1], [6.5, -11.0, 0],
        [-11.5, -5.5, 1], [9.8, -7.0, 1], [-2.0, -14.0, 0], [4.0, -15.5, 1]
      ];
      for (let bi = 0; bi < burnTreeSpots.length; bi++) {
        const bs = burnTreeSpots[bi], tg = new THREE.Group();
        const th = 4.5 + (bi % 3) * 1.4;
        const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, th, 5), treeMatTrunk);
        tr.position.y = th / 2; tg.add(tr);
        for (let cj = 0; cj < 3; cj++) {
          const cn = new THREE.Mesh(new THREE.ConeGeometry(1.5 - cj * 0.34, 1.8, 6),
            bs[2] ? treeMatBurn : treeMatLeaf);
          cn.position.y = th + cj * 1.05; tg.add(cn);
        }
        if (bs[2]) addFlame(tg, 0, th * 0.6, 0, 1.6, 2.6);
        tg.position.set(bs[0], FALL_GROUND, bs[1]);
        tg.rotation.y = bi * 1.7;
        lvl4Grp.add(tg);
      }
      /* 远景火墙：森林大火的地平线（复用开场火墙着色器，随时间翻涌） */
      {
        const gw2 = new THREE.Mesh(new THREE.PlaneGeometry(150, 34), fireWallMat.clone());
        gw2.position.set(0, FALL_GROUND + 10, -46);
        lvl4Grp.add(gw2); outFireWalls.push(gw2.material);
      }
    }

    /* 楼梯口木梁封挡（套用 5F 样式）：横在走廊左端，挡住井道门洞，
       后面的机器人被木梁 + 火苗遮住，只透出上半身剪影 */
    {
      const beam4 = M(0x7a5c3c, { e: 0x2a1206, ei: 0.5, r: 0.85 });   // 烤过的木头，带余烬红
      const bcz = (CZ0 + CZ1) / 2;
      // 主梁：斜插门口下半部
      const b4a = put(box(0.2, 0.26, 2.1, beam4), -6.45, FY + 0.85, bcz - 0.1);
      b4a.rotation.set(0.66, 0.05, 0.12); b4a.name = 'b4a'; lvl4Grp.add(b4a);
      // 副梁：横压在下方
      const b4b = put(box(0.17, 0.22, 1.7, beam4), -6.5, FY + 0.42, bcz + 0.35);
      b4b.rotation.set(-0.3, 0.1, 0.05); b4b.name = 'b4b'; lvl4Grp.add(b4b);
      // 第三根：更高一点，遮住机器人上半身
      const b4c = put(box(0.16, 0.2, 1.9, beam4), -6.38, FY + 1.5, bcz + 0.05);
      b4c.rotation.set(0.2, -0.08, 0.9); b4c.name = 'b4c'; lvl4Grp.add(b4c);
      // 梁上的火：三簇火苗，遮住井道里的机器人
      addFlame(lvl4Grp, -6.5, FY + 1.05, bcz - 0.6, 0.6, 0.9);
      addFlame(lvl4Grp, -6.45, FY + 0.6, bcz + 0.7, 0.5, 0.7);
      addFlame(lvl4Grp, -6.4, FY + 1.4, bcz + 0.1, 0.55, 0.85);
      /* 机器人身后的猛火：井道里从地面到天花板的大火墙 + 多簇火苗，
         让玩家透过木梁缝隙看到它被火场包围 */
      addFlame(lvl4Grp, -7.2, FY + 0.1, bcz - 0.5, 1.2, 2.8);
      addFlame(lvl4Grp, -7.0, FY + 0.1, bcz + 0.6, 1.0, 2.5);
      addFlame(lvl4Grp, -7.5, FY + 0.3, bcz, 1.4, 3.2);
      addFlame(lvl4Grp, -6.9, FY + 0.2, bcz + 0.2, 0.9, 2.2);
      addFlame(lvl4Grp, -7.8, FY + 0.5, bcz - 0.3, 1.1, 2.6);
      // 井道浓烟
      addSmoke(lvl4Grp, -7.3, FY + RH - 0.3, bcz, 3.5);
      // 封挡处的火光 + 井道猛火光
      lvl4Grp.add(put(new THREE.PointLight(0xff5518, 1.2, 7.0, 2), -6.4, FY + 1.2, bcz));
      lvl4Grp.add(put(new THREE.PointLight(0xff4810, 1.8, 10.0, 2), -7.3, FY + 1.5, bcz));
    }
  }

  /* ============ 505：它锯开的那户（开场运镜里的房间）============
     玩家从走廊 505 被撕开的门洞走进来。里面没有机器人——
     只有它"救人"的痕迹：烧过的家具、墙上的锯痕、床上盖着床单的轮廓。
     与开场对齐的细节：窗在这面墙的同一侧，门洞位置 = 运镜里它锯穿的那面墙。 */
  {
    const r5 = new THREE.Group();
    room505Grp = r5;                               // 供按楼层剔除用
    playerRoom.add(r5);
    // 505 的范围：x 2.7 ~ 7.0，z -2.3 ~ 2.3（与 503 同深，贴着走廊右端）
    const X0 = 2.7, X1 = 7.0, Z0 = -RD / 2, Z1 = RD / 2;
    const wall5 = M(0x110f0d, { r: 0.96 });
    const char5 = M(0x0a0908, { r: 0.99, m: 0.01 });
    // 地板 / 天花（比 503 更焦）
    r5.add(put(box(X1 - X0, T, RD, M(0x0d0b09, { r: 0.95 })), (X0 + X1) / 2, -T / 2, 0));
    r5.add(put(box(X1 - X0, T, RD, M(0x0a0909)), (X0 + X1) / 2, RH + T / 2, 0));
    // 左墙（和 503 之间）、右墙（楼端）
    r5.add(put(box(T, RH, RD, wall5), X0, RH / 2, 0));
    r5.add(put(box(T, RH, RD, wall5), X1, RH / 2, 0));
    // 窗墙（-z）：留窗洞 x∈[4.0, 5.8] y∈[0.95, 2.15]，和 503 的窗同规格
    const W5X0 = 4.0, W5X1 = 5.8, W5Y0 = 0.95, W5Y1 = 2.15;
    r5.add(put(box(W5X0 - X0, RH, T, wall5), (X0 + W5X0) / 2, RH / 2, Z0));
    r5.add(put(box(X1 - W5X1, RH, T, wall5), (W5X1 + X1) / 2, RH / 2, Z0));
    r5.add(put(box(W5X1 - W5X0, W5Y0, T, wall5), (W5X0 + W5X1) / 2, W5Y0 / 2, Z0));
    r5.add(put(box(W5X1 - W5X0, RH - W5Y1, T, wall5), (W5X0 + W5X1) / 2, (W5Y1 + RH) / 2, Z0));
    // 门墙（+z）：洞和走廊 505 开口对齐（x 3.9~4.9），整扇门被撕走
    r5.add(put(box(3.9 - X0, RH, T, wall5), (X0 + 3.9) / 2, RH / 2, Z1));
    r5.add(put(box(X1 - 4.9, RH, T, wall5), (4.9 + X1) / 2, RH / 2, Z1));
    r5.add(put(box(1.0, RH - 2.05, T, wall5), 4.4, 2.05 + (RH - 2.05) / 2, Z1));
    // 门洞两侧的锯口碎裂（比走廊侧更密——锯是从这边开的）
    for (let i = 0; i < 9; i++) {
      const side = i < 5 ? 3.88 : 4.92;
      const c = put(box(0.1 + Math.random() * 0.2, 0.14 + Math.random() * 0.3, 0.3, char5),
        side + (Math.random() - 0.5) * 0.24, 0.2 + Math.random() * 1.8, Z1 - 0.02);
      c.rotation.z = (Math.random() - 0.5) * 1.2; r5.add(c);
    }
    // 窗框（焦黑）
    const f5 = M(0x14110d);
    r5.add(put(box(2.02, 0.08, 0.22, f5), 4.9, 0.98, Z0 + 0.02));
    r5.add(put(box(2.02, 0.08, 0.22, f5), 4.9, 2.12, Z0 + 0.02));
    r5.add(put(box(0.08, 1.2, 0.22, f5), 3.94, 1.55, Z0 + 0.02));
    r5.add(put(box(0.08, 1.2, 0.22, f5), 5.86, 1.55, Z0 + 0.02));
    r5.add(put(box(0.05, 1.2, 0.18, f5), 4.9, 1.55, Z0 + 0.02));

    /* ---- 家具：被"处理"过的现场 ---- */
    // 床：框架上有锯痕，床单下盖着一个轮廓
    const bed5 = new THREE.Group(); bed5.position.set(6.0, 0, -0.7); r5.add(bed5);
    const bw5 = M(0x1c140c, { r: 0.92, m: 0.08 });
    bed5.add(put(box(1.5, 0.26, 2.0, bw5), 0, 0.13, 0));
    bed5.add(put(box(1.44, 0.2, 1.9, M(0x1d1b18, { r: 0.98 })), 0, 0.34, 0));
    // 床单下的形状：躯干 + 头两团起伏，只给轮廓不给细节
    const sheet5 = M(0x767068, { r: 0.97 });
    const torso = new THREE.Mesh(new THREE.SphereGeometry(0.3, 9, 7), sheet5);
    torso.scale.set(1.5, 0.55, 2.6); torso.position.set(0, 0.52, -0.1); bed5.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), sheet5);
    head.scale.set(1.1, 0.8, 1.2); head.position.set(0.02, 0.56, 0.72); bed5.add(head);
    // 床单垂边（把形状和床架连起来）
    bed5.add(put(box(1.5, 0.3, 2.0, sheet5), 0, 0.28, 0));
    // 床框上的锯痕：三道平行细槽
    for (let i = 0; i < 3; i++) {
      bed5.add(put(box(0.9, 0.015, 0.02, M(0x050404)),
        -0.2, 0.27 + i * 0.07, 0.55 + i * 0.1));
    }
    // 烧塌的书架（倒在地上，还在冒火苗）
    const shelf5 = put(box(1.5, 0.1, 0.4, char5), 3.6, 0.36, -1.2);
    shelf5.rotation.z = 1.35; r5.add(shelf5);
    for (let i = 0; i < 5; i++) {
      const bk = put(box(0.03, 0.24, 0.17, M(0x120e0b)),
        3.0 + Math.random() * 1.4, 0.05, -1.5 + Math.random() * 0.7);
      bk.rotation.set(Math.random(), Math.random() * 3, 1.5 + Math.random() * 0.2); r5.add(bk);
    }
    addFlame(r5, 3.7, 0.42, -1.25, 0.8, 1.1);
    addFlame(r5, 4.3, 0.3, -1.5, 0.55, 0.7);
    // 摔在地上的电视（屏幕炸裂发灰）
    const tv5 = put(box(0.8, 0.55, 0.2, M(0x09090b, { r: 0.7 })), 5.0, 0.29, 1.6);
    tv5.rotation.set(1.4, 0.4, 0.2); r5.add(tv5);

    /* ---- 便携收音机：摔落的电视旁，E 开关（先只有静电，广播稿之后随剧情灌）---- */
    radioGrp = new THREE.Group();
    radioGrp.position.set(4.35, 0.076, 1.30);
    radioGrp.rotation.set(0, Math.PI - 0.3, 0.05);   // 正面朝房门，进门一眼看到
    r5.add(radioGrp);
    {
      const shellR = M(0x1f1a14, { r: 0.75, m: 0.1 });
      const grill = M(0x0c0a08, { r: 0.95 });
      radioGrp.add(put(box(0.24, 0.15, 0.09, shellR), 0, 0, 0));              // 机身
      radioGrp.add(put(box(0.13, 0.10, 0.012, grill), -0.035, 0.01, 0.048)); // 喇叭网
      // 网孔：三排小暗点
      for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) {
        radioGrp.add(put(box(0.012, 0.012, 0.006, M(0x060505)),
          -0.085 + c * 0.026, 0.035 - r * 0.026, 0.055));
      }
      // 调谐旋钮 ×2 + 频率刻度条
      const knob = M(0x6a6257, { r: 0.4, m: 0.6 });
      for (const ky of [0.035, -0.035]) {
        radioGrp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.014, 8), knob),
          0.085, ky, 0.05));
      }
      radioGrp.add(put(box(0.06, 0.03, 0.004, M(0x14100c)), 0.085, 0.0, 0.05));
      // 拉杆天线（歪的）
      const ant = put(new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.34, 5),
        M(0x8f8a80, { r: 0.3, m: 0.85 })), -0.06, 0.19, -0.02);
      ant.rotation.z = 0.5; radioGrp.add(ant);
    }
    // 墙上的成排锯痕（它在这面墙上开过口）
    for (let i = 0; i < 4; i++) {
      const mk = put(box(0.02, 0.5 + Math.random() * 0.5, 0.015, M(0x040303)),
        X0 + 0.12, 0.9 + Math.random() * 0.9, -0.6 + i * 0.55);
      mk.rotation.x = (Math.random() - 0.5) * 0.2; r5.add(mk);
    }
    // 地面的焦痕
    for (let i = 0; i < 4; i++) {
      const sc = new THREE.Mesh(new THREE.PlaneGeometry(0.9 + Math.random(), 0.7 + Math.random() * 0.6),
        new THREE.MeshBasicMaterial({ color: 0x060505, transparent: true, opacity: 0.55 }));
      sc.rotation.x = -Math.PI / 2;
      sc.position.set(3.4 + Math.random() * 3.0, 0.012, -1.8 + Math.random() * 3.4);
      r5.add(sc);
    }
    // 浓烟（505 比走廊更呛）
    addSmoke(r5, 4.6, RH - 0.55, -0.6, 2.8);
    addSmoke(r5, 6.1, RH - 0.65, 0.6, 2.5);

    /* ---- 子弹：小边桌上一盒 9mm ---- */
    // 小边桌（床边，桌腿被撞歪了一点）
    const tbl5 = new THREE.Group(); tbl5.position.set(3.35, 0, 0.9); r5.add(tbl5);
    tbl5.add(put(box(0.5, 0.05, 0.44, bw5), 0, 0.6, 0));
    for (const lx of [-0.2, 0.2]) for (const lz of [-0.17, 0.17]) {
      const leg = put(box(0.045, 0.58, 0.045, char5), lx, 0.29, lz);
      leg.rotation.z = lx * 0.05; tbl5.add(leg);
    }
    bulletsObj = new THREE.Group();
    bulletsObj.position.set(3.35, 0.64, 0.9);
    r5.add(bulletsObj);
    const brass = M(0x8a6f2f, { r: 0.35, m: 0.85 });
    bulletsObj.add(put(box(0.16, 0.035, 0.1, M(0x1b1712, { r: 0.9 })), 0, 0, 0));  // 弹盒
    for (let i = 0; i < 6; i++) {                          // 露出头的几颗
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.03, 6), brass);
      b.position.set(-0.055 + (i % 3) * 0.055, 0.03, -0.02 + Math.floor(i / 3) * 0.045);
      b.rotation.z = 0.12 + Math.random() * 0.1; bulletsObj.add(b);
    }
    bulletsObj.userData.pickup = { id: 'bullets', name: '子弹' };

    /* ---- 消防斧：横放在床单上（后续劈开封挡的楼梯门）---- */
    axeObj = new THREE.Group();
    axeObj.position.set(6.0, 0.78, -0.5);
    axeObj.rotation.set(0, 0.45, Math.PI / 2);      // 手柄沿床横放
    r5.add(axeObj);
    {
      const hw = M(0x6b4526, { r: 0.88 });
      axeObj.add(new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.021, 0.66, 7), hw));
      axeObj.add(put(box(0.028, 0.15, 0.05, M(0x111114, { r: 0.6, m: 0.4 })), 0, -0.31, 0));   // 尾箍
      const head = new THREE.Group(); head.position.set(0, 0.32, 0); axeObj.add(head);
      head.add(put(box(0.055, 0.13, 0.085, M(0x8c1a12, { r: 0.5, m: 0.35 })), 0, 0.01, 0));   // 红色斧身
      head.add(put(box(0.05, 0.075, 0.2, M(0xb9c0c6, { r: 0.3, m: 0.85 })), 0, 0.10, 0.05));  // 钢刃
      head.add(put(box(0.045, 0.05, 0.06, M(0x2a2a2e, { r: 0.7 })), 0, -0.055, -0.07));       //  spike
    }
    axeObj.userData.pickup = { id: 'axe', name: '消防斧' };

  /* 505 的火光：窗外打进来的 + 屋内火苗的 */
  fire505Light = new THREE.PointLight(0xff5a20, 1.1, 8.0, 2);
  prLights.add(put(fire505Light, 4.9, 1.7, Z0 + 0.6));
  const inner5 = new THREE.PointLight(0xff6a24, 0.7, 4.0, 2);
  prLights.add(put(inner5, 3.9, 0.7, -1.2));
  // 窗外的火墙 + 近树（和 503 窗外同一片山火，站在 505 视角看）
  {
    const w5 = new THREE.Mesh(new THREE.PlaneGeometry(26, 12), fireWallMat.clone());
    w5.position.set(4.9, 3.0, Z0 - 9); r5.add(w5);
    outFireWalls.push(w5.material);
    for (let i = 0; i < 12; i++) {
      const th = 5.0 + Math.random() * 4.0;
      const tt = new THREE.Mesh(
        new THREE.ConeGeometry(0.7 + Math.random() * 0.7, th, 5), M(0x070606));
      tt.position.set(-1.0 + i * 1.1 + Math.random() * 0.6,
        FALL_GROUND + th / 2, Z0 - 4.5 - Math.random() * 5.0);
      r5.add(tt);
    }
  }
  doorLight = new THREE.PointLight(0xff5a20, 0.22, 2.6, 2);
  prLights.add(put(doorLight, 0.1, 1.5, RD / 2 - 0.5));

  // 窗框 + 窗外山火
  playerRoom.add(put(box(2.02, 0.08, 0.22, M(0x1a1713)), -1.1, 0.98, -RD / 2 + 0.02));
  playerRoom.add(put(box(2.02, 0.08, 0.22, M(0x1a1713)), -1.1, 2.12, -RD / 2 + 0.02));
  playerRoom.add(put(box(0.08, 1.2, 0.22, M(0x1a1713)), -2.06, 1.55, -RD / 2 + 0.02));
  playerRoom.add(put(box(0.08, 1.2, 0.22, M(0x1a1713)), -0.14, 1.55, -RD / 2 + 0.02));
  playerRoom.add(put(box(0.05, 1.2, 0.18, M(0x1a1713)), -1.1, 1.55, -RD / 2 + 0.02));
  /* 后墙窗外：火光 + 适量树木（省性能但有氛围）
     全部收进 prWinBack：这套背景板是 503 窗外视角专用的，
     在 4F 会正好糊在 405 窗外 —— 切到 4F 时整组隐藏（见 switchLevel）*/
  prWinBack = new THREE.Group(); playerRoom.add(prWinBack);
  {
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), fireWallMat.clone());
    bg.position.set(-1.1, 3.0, -RD / 2 - 11); prWinBack.add(bg);
    outFireWalls.push(bg.material);
    prWinBack.add(put(new THREE.PointLight(0xff4820, 0.35, 12, 2), -1.1, 1.8, -RD / 2 + 0.5));
    /* 近处树木：被火光照亮的剪影 */
    for (let i = 0; i < 15; i++) {
      const th = 5.0 + Math.random() * 4.0;
      const tt = new THREE.Mesh(
        new THREE.ConeGeometry(0.7 + Math.random() * 0.7, th, 5), M(0x060505));
      tt.position.set(-11 + i * 1.3 + Math.random() * 0.6,
        FALL_GROUND + th / 2, -RD / 2 - 4.5 - Math.random() * 5.0);
      prWinBack.add(tt);
    }
    /* 远处山坡树林：低多边形远处的火场剪影 */
    for (let i = 0; i < 20; i++) {
      const th = 6.0 + Math.random() * 5.0;
      const tt = new THREE.Mesh(
        new THREE.ConeGeometry(0.9 + Math.random() * 0.9, th, 5), M(0x050404));
      tt.position.set(
        -16 + i * 1.6 + Math.random() * 1.2,
        -5.5 + Math.random() * 2.0,
        -RD / 2 - 14 - Math.random() * 6.0);
      prWinBack.add(tt);
    }
  }

  /* ============ 楼体外景（只为坠落序列服务）============
     房间地板是 y=0，五楼层高约 2.8m，所以地面在 y ≈ -13.6。
     建一面带窗洞的外立面 + 地面，坠落时才有东西掠过、才有落点。 */
  {
    const ext = new THREE.Group();
    playerRoom.add(ext);
    fallExt = ext;                     // 4F 时整组隐藏（否则立面离 405 窗只有 2cm，直接糊死窗外）
    const FZ = -RD / 2 - 0.12;                 // 立面所在的 z（窗墙外侧）
    // 地面
    const asphalt = M(0x0d0d0e, { r: 0.96 });
    ext.add(put(box(44, 0.4, 44, asphalt), 0, FALL_GROUND - 0.2, -14));
    // 外立面：从地面一直砌到房间上方。
    // 每扇真窗（503 和 505）都要在立面上留真洞，否则会把窗户糊死。
    // 做法：立面沿 x 拆成两条，各带一个窗洞（两洞不跨条，互不影响）。
    const FH = 2.8 - FALL_GROUND;              // 立面总高
    const facade = M(0x151312, { r: 0.95 });
    const FX0 = -1.1 - 12, FX1 = -1.1 + 12;    // 立面左右范围
    const FYB = FALL_GROUND, FYT = 2.8;        // 立面上下范围
    /* 505 的窗洞（505 房间 x 2.7~7.0，窗在 4.0~5.8）——转成外立面坐标：
       立面挂在 playerRoom 原点，505 窗的 x 就是 4.0~5.8 */
    const W5AX0 = 4.0, W5AX1 = 5.8, W5AY0 = 0.95, W5AY1 = 2.15;
    function facadeStrip(xa, xb, hx0, hx1, hy0, hy1) {
      // 洞左侧 / 右侧 / 下方 / 上方 四块
      ext.add(put(box(hx0 - xa, FH, 0.24, facade), (xa + hx0) / 2, FYB + FH / 2, FZ));
      ext.add(put(box(xb - hx1, FH, 0.24, facade), (hx1 + xb) / 2, FYB + FH / 2, FZ));
      ext.add(put(box(hx1 - hx0, hy0 - FYB, 0.24, facade), (hx0 + hx1) / 2, (FYB + hy0) / 2, FZ));
      ext.add(put(box(hx1 - hx0, FYT - hy1, 0.24, facade), (hx0 + hx1) / 2, (hy1 + FYT) / 2, FZ));
    }
    facadeStrip(FX0, 1.95, WX0, WX1, WY0, WY1);              // 西条：503 的窗
    /* 东条：两个窗洞 —— 505 的窗（5F，y 0.95..2.15）+ 405 的窗（4F，y -2.50..-0.60）。
       405 窗洞是空调外机路线的出口：不洞开的话外机贴着的这面墙就是一堵实心死墙 */
    {
      const A0 = 3.15, A1 = 5.65, AY0 = -2.50, AY1 = -0.60;      // 405 窗洞
      const B0 = W5AX0, B1 = W5AX1, BY0 = W5AY0, BY1 = W5AY1;    // 505 窗洞
      const seg = function (xa, xb, ya, yb) {
        if (xb - xa < 0.01 || yb - ya < 0.01) return;
        ext.add(put(box(xb - xa, yb - ya, 0.24, facade), (xa + xb) / 2, (ya + yb) / 2, FZ));
      };
      seg(1.95, A0, FYB, FYT);                    // 西端整高
      seg(A0, B0, FYB, AY0); seg(A0, B0, AY1, FYT);                 // 405 洞西段
      seg(B0, A1, FYB, AY0); seg(B0, A1, AY1, BY0); seg(B0, A1, BY1, FYT);   // 双洞重叠段
      seg(A1, B1, FYB, BY0); seg(A1, B1, BY1, FYT);                 // 505 洞西段
      seg(B1, FX1, FYB, FYT);                     // 东端整高
    }
    // 立面上的窗洞：4 层 × 7 列，个别透出暖光（其它户还有人/已经烧了）
    const winDark = M(0x08090b, { r: 0.9 });
    const winLit = M(0x1a0f07, { e: 0xff7a2a, ei: 0.5, r: 0.8 });
    for (let fl = 0; fl < 4; fl++) {
      const wy = FALL_GROUND + 1.6 + fl * 2.8;
      for (let cl = 0; cl < 7; cl++) {
        const wx = -8.6 + cl * 2.5;
        if (Math.abs(wx + 1.1) < 1.3 && fl === 3) continue;   // 别和 503 窗重叠
        if (Math.abs(wx - 4.9) < 1.3 && fl === 3) continue;   // 别和 505 窗重叠
        const lit = Math.random() < 0.28;
        ext.add(put(box(1.5, 1.15, 0.06, lit ? winLit : winDark), wx, wy, FZ - 0.14));
        // 窗台
        ext.add(put(box(1.66, 0.09, 0.16, facade), wx, wy - 0.62, FZ - 0.16));
      }
    }
    // 楼下的杂物：坠落时的掠过参照。
    // 注意要给落点留出净空，否则镜头会正好停在某个箱体内部，眼前糊成一片灰
    const LANDX = -0.8, LANDZ = -4.1, CLEAR = 3.2;
    for (let i = 0; i < 9; i++) {
      const bx = -9 + Math.random() * 16;
      const bz = -3.2 - Math.random() * 4.5;
      if (Math.hypot(bx - LANDX, bz - LANDZ) < CLEAR) continue;   // 落点净空
      const bw = 0.6 + Math.random() * 1.6;
      ext.add(put(box(bw, 0.5 + Math.random() * 0.8, 0.6 + Math.random() * 1.2,
        M(0x100f0e, { r: 0.98 })),
        bx, FALL_GROUND + 0.3, bz));
    }
    /* 地面高度的火光带：要放远，而且要抬高——这个着色器底边是暗的、
       中段才亮，放太低的话镜头只能看到它暗的下缘 */
    {
      const gw = new THREE.Mesh(new THREE.PlaneGeometry(64, 15), fireWallMat.clone());
      gw.position.set(-1.1, FALL_GROUND + 9, -34);
      ext.add(gw);
      outFireWalls.push(gw.material);
      // 中景树：介于落点和火光带之间，提供层次
      for (let i = 0; i < 18; i++) {
        const th = 5.0 + Math.random() * 4.0;
        const tt = new THREE.Mesh(
          new THREE.ConeGeometry(0.6 + Math.random() * 0.7, th, 5), M(0x060505));
        tt.position.set(-16 + i * 1.9 + Math.random() * 0.9,
          FALL_GROUND + th / 2, -15 - Math.random() * 8);
        ext.add(tt);
      }
    }
    // 落点附近的地面被火光染红：也用来照出近处树干和地面质感
    const groundGlow = new THREE.PointLight(0xff5418, 1.15, 22, 2);
    prLights.add(put(groundGlow, -1.1, FALL_GROUND + 3.0, -10));
  }

  // 床：玩家从这里醒来；低多边形床垫、掀开的被子和有重量感的枕头
  const bed = new THREE.Group(); bed.position.set(-1.35, 0, -0.5); playerRoom.add(bed);
  const bedWood = M(0x24180f, { r: 0.92, m: 0.08 });
  const mattress = M(0x242126, { r: 0.98, m: 0.02 });
  const sheet = M(0x171a20, { r: 0.99, m: 0.01 });
  const pillowMat = M(0x2b2a2d, { r: 1.0, m: 0.01 });
  bed.add(put(box(1.58, 0.28, 2.08, bedWood), 0, 0.14, 0));
  bed.add(put(box(1.48, 0.24, 1.96, mattress), 0, 0.38, 0));
  const blanket = put(box(1.42, 0.13, 1.16, sheet), 0, 0.54, -0.38);
  blanket.rotation.x = -0.045; bed.add(blanket);
  const pillow = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 5), pillowMat);
  pillow.scale.set(1.55, 0.34, 0.74); pillow.position.set(0, 0.56, 0.72); bed.add(pillow);
  bed.add(put(box(1.56, 0.78, 0.12, bedWood), 0, 0.55, 1.04));
  for (const x of [-0.56, 0.56]) bed.add(put(box(0.08, 0.36, 0.08, bedWood), x, 0.24, -0.92));
  bed.add(put(box(1.25, 0.045, 0.04, M(0x0a0909)), 0, 0.84, 0.96));
  bed.add(put(box(1.05, 0.035, 0.04, M(0x0a0909)), 0, 0.68, 0.96));

  // 床头柜：抽屉、金属拉手
  const nightstand = new THREE.Group(); nightstand.position.set(-0.34, 0, 0.26); playerRoom.add(nightstand);
  nightstand.add(put(box(0.58, 0.58, 0.48, bedWood), 0, 0.29, 0));
  nightstand.add(put(box(0.46, 0.025, 0.18, M(0x0c0b0b)), 0, 0.45, -0.25));
  nightstand.add(put(box(0.46, 0.025, 0.18, M(0x0c0b0b)), 0, 0.17, -0.25));
  const drawerHandle = M(0x59402a, { r: 0.48, m: 0.45 });
  for (const y of [0.45, 0.17]) nightstand.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.13, 6), drawerHandle), 0, y, -0.36));

  /* 床头台灯：房间的主光源就在这里（不再吊在天花板上） */
  {
    const lamp = new THREE.Group(); lamp.position.set(-0.34, 0.58, 0.26); playerRoom.add(lamp);
    const metal = M(0x2e2a25, { r: 0.42, m: 0.7 });
    lamp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.028, 12), metal), 0, 0.014, 0));  // 底座
    lamp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.24, 8), metal), 0, 0.15, 0));   // 灯杆
    // 灯罩：外侧暗、内侧被灯泡照亮
    lampMat = M(0x3a2d1c, { e: 0xffc27a, ei: 0.5, r: 0.85 });
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.14, 0.15, 14, 1, true), lampMat);
    shade.material.side = THREE.DoubleSide;
    lamp.add(put(shade, 0, 0.31, 0));
    // 灯泡
    lamp.add(put(new THREE.Mesh(new THREE.SphereGeometry(0.036, 8, 6),
      M(0xfff0d0, { e: 0xffd9a0, ei: 1.4 })), 0, 0.30, 0));
    lampLight = new THREE.PointLight(0xffc078, 0.85, 4.2, 2);
    prLights.add(put(lampLight, -0.34, 0.88, 0.26));
  }

  // 衣柜：转 180°，门朝房间内侧；两扇门可以 E 打开
  const wardrobe = new THREE.Group(); wardrobe.position.set(1.92, 0, -1.62); playerRoom.add(wardrobe);
  wardrobe.rotation.y = Math.PI;
  const wardrobeDoor = M(0x1b130d, { r: 0.9, m: 0.12 });
  /* 柜体真正掏空：六块木板拼壳，开门能看见整个腔体 */
  {
    const inner = M(0x0d0a07, { r: 0.98 });
    wardrobe.add(put(box(1.08, 2.14, 0.03, bedWood), 0, 1.07, 0.285));    // 背板
    wardrobe.add(put(box(0.05, 2.14, 0.58, bedWood), -0.515, 1.07, 0));   // 左侧板
    wardrobe.add(put(box(0.05, 2.14, 0.58, bedWood), 0.515, 1.07, 0));    // 右侧板
    wardrobe.add(put(box(1.08, 0.05, 0.58, bedWood), 0, 2.115, 0));       // 顶板
    wardrobe.add(put(box(1.08, 0.10, 0.58, bedWood), 0, 0.05, 0));        // 底座（柜内底面 y=0.10）
    // 深色内衬：开门后看到的是这个空腔
    wardrobe.add(put(box(0.94, 2.0, 0.015, inner), 0, 1.10, 0.262));      // 内背
    wardrobe.add(put(box(0.015, 1.99, 0.5, inner), -0.487, 1.10, 0.015)); // 内左
    wardrobe.add(put(box(0.015, 1.99, 0.5, inner), 0.487, 1.10, 0.015));  // 内右
    wardrobe.add(put(box(0.94, 0.015, 0.5, inner), 0, 2.085, 0.015));     // 内顶
    // 挂衣杆 + 几件挂着的衣服（挂在上部，不遮住柜底）
    const rodM = M(0x8f8a80, { r: 0.3, m: 0.9 });
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.94, 8), rodM);
    rod.rotation.z = Math.PI / 2; wardrobe.add(put(rod, 0, 1.94, 0.02));
    const clothes = [0x1a1d22, 0x241a1a, 0x15181a, 0x201c16];
    for (let i = 0; i < 4; i++) {
      const c = put(box(0.17, 0.62, 0.10, M(clothes[i], { r: 0.98 })),
        -0.33 + i * 0.22, 1.60, 0.02);
      c.rotation.z = (Math.random() - 0.5) * 0.06; wardrobe.add(c);
    }
    // 柜底一双旧鞋，让"底部"这个空间有东西
    for (const sx of [-0.3, -0.14]) {
      wardrobe.add(put(box(0.11, 0.07, 0.26, M(0x14100c, { r: 0.95 })), sx, 0.135, 0.05));
    }
  }
  /* 两扇门各自绕外侧竖边旋转；把手在中缝一侧（原来和铰链同侧，所以看着像装反了） */
  wardrobeDoors = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 0.5, 0, -0.29);       // 铰链在柜体外侧竖边
    wardrobe.add(pivot);
    const leaf = new THREE.Group();
    leaf.position.set(-side * 0.25, 1.07, 0);        // 门板中心相对铰链
    pivot.add(leaf);
    leaf.add(put(box(0.49, 1.97, 0.025, wardrobeDoor), 0, 0, 0));
    // 门板上的凹线装饰
    leaf.add(put(box(0.33, 1.62, 0.008, M(0x140e09, { r: 0.92 })), 0, 0, 0.017));
    // 把手：靠中缝那一侧（leaf 局部 -side 方向）
    leaf.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.13, 8), drawerHandle),
      -side * 0.18, -0.02, -0.04));
    // 铰链页片：贴在外侧竖边
    for (const hy of [0.7, -0.7]) {
      leaf.add(put(box(0.018, 0.09, 0.05, drawerHandle), side * 0.235, hy, 0));
    }
    wardrobeDoors.push({ pivot: pivot, side: side });
  }

  /* ---- 手枪：放在衣柜底板上，只能右手握持 ---- */
  {
    pistolObj = new THREE.Group();
    pistolObj.position.set(0.16, 0.135, 0.02);       // 柜底
    pistolObj.rotation.set(0, 0.55, 0);
    wardrobe.add(pistolObj);
    const steel = M(0x191c20, { r: 0.4, m: 0.8 });
    const steelD = M(0x0f1114, { r: 0.5, m: 0.72 });
    const grip = M(0x15110d, { r: 0.92, m: 0.05 });
    /* 套筒做成独立组：开枪时后坐复进，打空后停在后方（套筒后定） */
    pistolSlide = new THREE.Group();
    pistolObj.add(pistolSlide);
    pistolSlide.add(put(box(0.152, 0.030, 0.027, steel), 0.004, 0.030, 0));
    pistolSlide.add(put(box(0.052, 0.020, 0.022, steelD), 0.052, 0.030, 0));   // 枪口段
    // 抛壳口：做成真的开口（框住的凹槽），套筒后定时能看见里面
    pistolSlide.add(put(box(0.030, 0.013, 0.021, M(0x05070a)), -0.020, 0.038, 0.005));
    // 套筒后端的防滑纹
    for (let i = 0; i < 4; i++) {
      pistolSlide.add(put(box(0.004, 0.024, 0.028, steelD), -0.052 + i * 0.010, 0.030, 0));
    }
    // 准星 / 照门（长在套筒上，跟着一起动）
    pistolSlide.add(put(box(0.006, 0.008, 0.008, M(0x2f353c, { r: 0.35, m: 0.85 })), 0.072, 0.049, 0));
    pistolSlide.add(put(box(0.010, 0.008, 0.020, M(0x2f353c, { r: 0.35, m: 0.85 })), -0.062, 0.049, 0));
    // 套筒后定时露出的枪管/弹膛（固定件，被套筒挡着）
    pistolObj.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.12, 7),
      M(0x23282d, { r: 0.45, m: 0.8 })), 0.02, 0.030, 0).rotateZ(Math.PI / 2));
    // 机匣 + 扳机护圈
    pistolObj.add(put(box(0.108, 0.020, 0.023, steelD), -0.010, 0.010, 0));
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.019, 0.005, 4, 10, Math.PI), steelD);
    guard.rotation.x = Math.PI / 2; guard.rotation.z = Math.PI;
    pistolObj.add(put(guard, -0.012, -0.004, 0));
    pistolObj.add(put(box(0.008, 0.016, 0.006, M(0x2a2f35, { r: 0.4, m: 0.8 })), -0.014, -0.004, 0)); // 扳机
    // 握把：向后下倾斜，带纹理片
    const g = put(box(0.038, 0.086, 0.027, grip), -0.056, -0.038, 0);
    g.rotation.z = -0.26; pistolObj.add(g);
    for (let i = 0; i < 3; i++) {
      const gp = put(box(0.030, 0.006, 0.029, M(0x0c0a08, { r: 0.98 })), -0.050 - i * 0.008, -0.020 - i * 0.022, 0);
      gp.rotation.z = -0.26; pistolObj.add(gp);
    }
    // 弹匣底板（空匣，插在握把里）
    pistolObj.add(put(box(0.040, 0.008, 0.028, steelD), -0.078, -0.078, 0));
    pistolObj.userData.pickup = { id: 'pistol', name: '手枪' };
  }
  // 简单书桌与椅子：房间不是空盒子，但仍保留逃生通道
  const desk = new THREE.Group(); desk.position.set(1.52, 0, 1.18); playerRoom.add(desk);
  desk.add(put(box(1.35, 0.08, 0.62, bedWood), 0, 0.78, 0));
  for (const dx of [-0.55, 0.55]) desk.add(put(box(0.07, 0.78, 0.07, bedWood), dx, 0.39, 0));
  desk.add(put(box(0.42, 0.05, 0.42, bedWood), -0.56, 0.43, 0.05));

  /* ---- 手机：桌上可拾取（之后当手电 + 剧情线索）---- */
  {
    phoneObj = new THREE.Group();
    phoneObj.position.set(1.72, 0.83, 1.06);
    phoneObj.rotation.set(-Math.PI / 2, 0, 0.35);      // 平放在桌面，屏幕朝上
    playerRoom.add(phoneObj);
    const body = M(0x0c0d10, { r: 0.35, m: 0.65 });
    phoneObj.add(put(box(0.071, 0.146, 0.009, body), 0, 0, 0));            // 机身
    phoneScreenMat = M(0x0a1622, { e: 0x2f6ea8, ei: 0.85, r: 0.1 });        // 屏幕（发光）
    phoneObj.add(put(box(0.064, 0.132, 0.002, phoneScreenMat), 0, 0, 0.0056));
    phoneObj.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.003, 8),
      M(0x05060a)), 0.02, 0.058, -0.0056));                                 // 背面摄像头
    phoneObj.userData.pickup = { id: 'phone', name: '手机' };
  }

  /* ==================== 厕所（床后隔断出来的独立空间）====================
     隔墙：x = -0.95（带门洞）与 z = 0.75（实墙），围出 1.6×1.5 的卫生间 */
  {
    const BX = -0.95, BZ = 0.75;                       // 隔墙位置
    const tile = M(0x1b1d1e, { r: 0.55, m: 0.08 });    // 瓷砖墙
    const tileF = M(0x151718, { r: 0.6, m: 0.06 });    // 地砖
    const porcelain = M(0x3b3d3e, { r: 0.3, m: 0.1 }); // 陶瓷洁具

    // 隔墙：z = BZ（实墙，从左墙到门洞侧墙）
    playerRoom.add(put(box(BX + RW / 2, RH, T, tile), (-RW / 2 + BX) / 2, RH / 2, BZ));
    // 隔墙：x = BX，中间留 0.9m 门洞（z 1.05 ~ 1.95）
    playerRoom.add(put(box(T, RH, 1.05 - BZ, tile), BX, RH / 2, (BZ + 1.05) / 2));
    playerRoom.add(put(box(T, RH, RD / 2 - 1.95, tile), BX, RH / 2, (1.95 + RD / 2) / 2));
    playerRoom.add(put(box(T, RH - 2.05, 0.9, tile), BX, 2.05 + (RH - 2.05) / 2, 1.5));
    // 卫生间地砖（略高一点，视觉上分区）
    playerRoom.add(put(box(BX + RW / 2 - T, 0.02, RD / 2 - BZ - T, tileF),
      (-RW / 2 + BX) / 2, 0.011, (BZ + RD / 2) / 2));
    // 门框
    const bJamb = M(0x232019, { r: 0.9 });
    playerRoom.add(put(box(T + 0.03, 2.05, 0.06, bJamb), BX, 1.025, 1.05));
    playerRoom.add(put(box(T + 0.03, 2.05, 0.06, bJamb), BX, 1.025, 1.95));
    playerRoom.add(put(box(T + 0.03, 0.06, 0.9, bJamb), BX, 2.05, 1.5));

    // 马桶（靠尽头墙）
    const wc = new THREE.Group(); wc.position.set(-2.1, 0, 1.95); playerRoom.add(wc);
    wc.add(put(box(0.36, 0.36, 0.16, porcelain), 0, 0.18, 0.24));           // 水箱
    wc.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.15, 0.36, 12), porcelain), 0, 0.18, -0.04));
    const seat = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.045, 6, 14), M(0x46484a, { r: 0.35 }));
    seat.rotation.x = Math.PI / 2; wc.add(put(seat, 0, 0.38, -0.04));
    wc.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.012, 8),
      M(0x8f8a80, { r: 0.3, m: 0.9 })), 0.12, 0.37, 0.24));                 // 冲水按钮

    // 洗手台（靠左墙）
    const sink = new THREE.Group(); sink.position.set(-2.42, 0, 1.15); playerRoom.add(sink);
    sink.add(put(box(0.36, 0.06, 0.5, porcelain), 0.06, 0.82, 0));          // 台面
    sink.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.11, 0.13, 12), porcelain), 0.08, 0.79, 0));
    sink.add(put(box(0.3, 0.72, 0.44, M(0x1d1a15, { r: 0.9 })), 0.06, 0.4, 0)); // 台下柜
    const chrome = M(0x9a958c, { r: 0.22, m: 0.95 });
    sink.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.17, 8), chrome), -0.06, 0.93, 0));
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.12, 8), chrome);
    spout.rotation.z = -Math.PI / 2.6; sink.add(put(spout, 0.0, 1.0, 0));
    // 镜子（洗手台上方）
    const mirror = put(box(0.03, 0.6, 0.44, M(0x20282e, { e: 0x1a2630, ei: 0.18, r: 0.06, m: 0.9 })),
      -RW / 2 + T / 2 + 0.02, 1.5, 1.15);
    playerRoom.add(mirror);
    playerRoom.add(put(box(0.05, 0.66, 0.5, M(0x14100b, { r: 0.9 })), -RW / 2 + T / 2, 1.5, 1.15));

    /* ---- 湿毛巾：挂在毛巾架上，可拾取 ----
       架子装在卫浴内侧的实墙上（进门后右手边那道 z=BZ 隔墙），
       用两个支架把杆和墙面连起来，不再是悬空的一根棍子 */
    const rack = M(0x9a958c, { r: 0.25, m: 0.92 });
    const WALLZ = BZ + T / 2;                 // 隔墙朝卫浴一侧的表面
    const RACKX = -1.78, RACKY = 1.24, RACKZ = WALLZ + 0.075;
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.52, 8), rack);
    bar.rotation.z = Math.PI / 2;             // 杆沿 x 走，平行于墙面
    playerRoom.add(put(bar, RACKX, RACKY, RACKZ));
    for (const bx of [RACKX - 0.24, RACKX + 0.24]) {
      // 支架：从墙面伸出来托住杆
      playerRoom.add(put(box(0.028, 0.028, 0.085, rack), bx, RACKY, WALLZ + 0.04));
      playerRoom.add(put(box(0.05, 0.06, 0.014, rack), bx, RACKY, WALLZ + 0.008));   // 墙上的底座
    }
    towelObj = new THREE.Group();
    towelObj.position.set(RACKX, RACKY - 0.02, RACKZ);
    playerRoom.add(towelObj);
    // 湿毛巾：深色、略带反光（湿的），对折挂在杆上；布面平行于墙
    const towelMat = M(0x2b3a42, { r: 0.62, m: 0.06 });
    const front = put(box(0.30, 0.38, 0.02, towelMat), 0, -0.19, 0.014);
    front.rotation.z = 0.03; towelObj.add(front);
    const back = put(box(0.30, 0.34, 0.02, towelMat), 0, -0.17, -0.014);
    back.rotation.z = -0.025; towelObj.add(back);
    towelObj.add(put(box(0.30, 0.03, 0.05, towelMat), 0, 0.005, 0));        // 搭在杆上的折边
    towelObj.userData.pickup = { id: 'towel', name: '湿毛巾' };

    // 卫生间顶灯（坏的，只有微弱余光）
    const bLight = new THREE.PointLight(0x7f9fb5, 0.16, 2.6, 2);
    prLights.add(put(bLight, -1.8, RH - 0.35, 1.5));
  }

  // 电视柜 + 亮着雪花的旧电视
  const tvStand = new THREE.Group(); tvStand.position.set(0.82, 0, -1.97); playerRoom.add(tvStand);
  tvStand.add(put(box(1.15, 0.42, 0.46, bedWood), 0, 0.22, 0));
  tvStand.add(put(box(1.04, 0.045, 0.38, M(0x0d0b0a)), 0, 0.46, -0.015));
  for (const x of [-0.43, 0.43]) tvStand.add(put(box(0.07, 0.18, 0.07, bedWood), x, 0.05, 0));
  {
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = 64;
    tvCtx = cv.getContext('2d'); tvTex = new THREE.CanvasTexture(cv);
    const frame = put(box(0.82, 0.64, 0.15, M(0x09090b, { r: 0.65, m: 0.2 })), 0, 0.78, -0.06);
    frame.rotation.y = 0.22; tvStand.add(frame);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.69, 0.48), new THREE.MeshBasicMaterial({ map: tvTex }));
    // 屏幕贴在机壳朝向玩家的一面，避免被电视外壳遮住
    scr.position.set(0, 0.78, 0.02); scr.rotation.y = 0.22; tvStand.add(scr);
    tvStand.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.18, 6), M(0x292728)), 0, 1.13, -0.02));
    tvLight = new THREE.PointLight(0x9fc4e6, 0.42, 2.8, 2);
    prLights.add(put(tvLight, 0.65, 0.9, -1.45));
  }

  // 地上散落物 + 渗进来的烟
  playerRoom.add(put(box(0.24, 0.06, 0.1, M(0x1d1a16)), -0.9, 0.03, -1.1));
  playerRoom.add(put(box(0.24, 0.06, 0.1, M(0x1d1a16)), -0.6, 0.03, -1.35));
  const fallen = put(box(0.1, 0.55, 0.1, wood), 0.2, 0.1, -1.7);
  fallen.rotation.z = 1.4; playerRoom.add(fallen);
  /* 烟雾：原来贴在天花板上，因为用的是不受光材质，在暗房间里会呈现成一团
     发光的亮斑。降低高度、缩小、压暗，让它像真的沉在上层空气里 */
  addSmoke(playerRoom, -0.6, RH - 0.72, -0.6, 2.4);
  addSmoke(playerRoom, 1.1, RH - 0.8, 0.4, 2.1);
  prLights.add(new THREE.HemisphereLight(0x241a20, 0x0a0709, 0.32));
}

/* ==================== [6c] 一楼大堂（电梯绳滑下后的楼层） ====================
   广阔大堂 + 前台 + 保安亭；正门被燃烧的木梁封死，侧门在东墙（通向楼后窄巷）。
   低可见度：浓烟 + 雾 + 大片火。 */
let lvl1Grp = null, sideDoor1Pivot = null, sideDoor1Open = false;
let keyObj = null, bullets1Obj = null, ropeTowel = null, acUnit = null, acMound = null;
let burnCars = [], playerCar = null, blackRoomGrp = null, inGarage = false;
let crawlCG = false, crawlT0 = 0, garageSideHeard = false, garageSideDone = false;
let blackroomT0 = 0, blackroomPhase = -1, carEscapeT0 = 0, carEscapePhase = -1, carBurnT0 = 0;
const LVL1_Y = -11.6;
const fogLvl1 = new THREE.FogExp2(0x0a0605, 0.13);
let prevSceneFog = null;
const lvl1Colliders = [
  { x0: -1.3, x1: 2.5, z0: 6.05, z1: 6.75 },     // 前台
  { x0: 5.48, x1: 5.74, z0: 6.40, z1: 7.30 },    // 保安亭西墙（门洞以南）
  { x0: 5.48, x1: 5.74, z0: 8.00, z1: 8.90 },    // 保安亭西墙（门洞以北）
  { x0: 5.48, x1: 8.44, z0: 6.28, z1: 6.54 },    // 保安亭南墙
  { x0: 5.48, x1: 8.44, z0: 8.76, z1: 9.02 },    // 保安亭北墙
  { x0: 8.16, x1: 8.44, z0: 6.40, z1: 8.90 },    // 保安亭东墙
  { x0: 6.40, x1: 7.40, z0: 8.05, z1: 8.65 },    // 保安亭桌子
  { x0: -1.45, x1: 1.45, z0: 8.90, z1: 9.50 },   // 正门燃烧木梁
  { x0: -4.75, x1: -3.35, z0: 7.45, z1: 8.55 },  // 瓦砾堆 ①
  { x0: -5.95, x1: -4.95, z0: 3.45, z1: 4.45 },  // 瓦砾堆 ②
  { x0: -4.00, x1: -2.40, z0: 4.70, z1: 5.70 },  // 塌落的天花板
  { x0: -2.75, x1: -0.45, z0: 4.40, z1: 5.40 },  // 长沙发
  { x0: -2.20, x1: -1.00, z0: 5.58, z1: 6.22 },  // 茶几
  { x0: 3.45, x1: 4.35, z0: 2.55, z1: 3.25 },    // 自动售货机（北墙边）
  { x0: 1.95, x1: 2.65, z0: 8.30, z1: 8.90 },    // 行李箱
  { x0: 2.65, x1: 3.05, z0: 6.15, z1: 6.55 },    // 垃圾桶
  { x0: 3.00, x1: 3.40, z0: 7.20, z1: 7.60 },    // 绿植（前台东北）
  { x0: 8.40, x1: 8.80, z0: 8.70, z1: 9.10 },    // 绿植（保安亭北）
  { x0: -7.40, x1: -7.00, z0: 3.40, z1: 3.80 },  // 绿植（西南角）
  { x0: -2.10, x1: -1.70, z0: 8.70, z1: 9.10 },  // 绿植（正门旁）
  { x0: -7.70, x1: -7.42, z0: 4.80, z1: 8.40 },  // 车库楼梯西护栏
  { x0: -6.58, x1: -6.30, z0: 4.80, z1: 8.40 },  // 车库楼梯东护栏
  { x0: -7.55, x1: -6.45, z0: 8.18, z1: 8.45 }   // 卷帘门
];
{
  lvl1Grp = new THREE.Group();
  lvl1Grp.visible = false;
  playerRoom.add(lvl1Grp);
  const F1 = LVL1_Y, FH1 = 3.2, T1 = 0.24;
  const floorM = M(0x0d0a08, { r: 0.96 }), wallM = M(0x14110d, { r: 0.97 }),
    wallD = M(0x0f0c0a, { r: 0.97 }), wood1 = M(0x1a140d, { r: 0.9 });
  /* 地板 / 天花 */
  /* 地板分四块，西侧留出通往地下车库的楼梯口（x -7.55..-6.45, z 4.9..8.3） */
  lvl1Grp.add(put(box(0.6, 0.2, 7.6, floorM), -7.85, F1 - 0.1, 6.25));
  lvl1Grp.add(put(box(1.1, 0.2, 2.45, floorM), -7.0, F1 - 0.1, 3.675));
  lvl1Grp.add(put(box(1.1, 0.2, 1.75, floorM), -7.0, F1 - 0.1, 9.175));
  lvl1Grp.add(put(box(15.9, 0.2, 7.6, floorM), 1.5, F1 - 0.1, 6.25));
  lvl1Grp.add(put(box(17.6, 0.2, 7.6, M(0x090706, { r: 0.98 })), 0.65, F1 + FH1 + 0.1, 6.25));
  /* 北墙（z=3.0，电梯井出口 x -0.78..0.78） */
  lvl1Grp.add(put(box(7.12, FH1, T1, wallM), -4.34, F1 + FH1 / 2, 3.0));
  lvl1Grp.add(put(box(8.42, FH1, T1, wallM), 4.99, F1 + FH1 / 2, 3.0));
  lvl1Grp.add(put(box(1.56, FH1 - 2.3, T1, wallM), 0, F1 + 2.3 + (FH1 - 2.3) / 2, 3.0));
  /* 南墙（z=9.5，正门洞 x -1.15..1.15） */
  lvl1Grp.add(put(box(6.75, FH1, T1, wallM), -4.525, F1 + FH1 / 2, 9.5));
  lvl1Grp.add(put(box(8.05, FH1, T1, wallM), 5.175, F1 + FH1 / 2, 9.5));
  lvl1Grp.add(put(box(2.3, FH1 - 2.4, T1, wallM), 0, F1 + 2.4 + (FH1 - 2.4) / 2, 9.5));
  /* 西墙（x=-7.9）/ 东墙（x=9.2，侧门洞 z 5.55..6.65） */
  lvl1Grp.add(put(box(T1, FH1, 6.5, wallM), -7.9, F1 + FH1 / 2, 6.25));
  lvl1Grp.add(put(box(T1, FH1, 2.55, wallM), 9.2, F1 + FH1 / 2, 4.275));
  lvl1Grp.add(put(box(T1, FH1, 2.85, T1 * 0 + T1, wallM), 9.2, F1 + FH1 / 2, 8.075));
  lvl1Grp.add(put(box(T1, FH1 - 2.2, 1.1, wallM), 9.2, F1 + 2.7, 6.1));
  /* 封漏：东墙北段 z 2.55..3.0 原是全高空洞（能看见楼外），补上 */
  lvl1Grp.add(put(box(T1, FH1, 0.45, wallM), 9.2, F1 + FH1 / 2, 2.775));
  /* 封漏：大堂北缘（电梯井两侧 x ±0.82 以外）原是敞口，补墙挡住楼外虚空 */
  lvl1Grp.add(put(box(7.08, FH1, T1, wallM), -4.36, F1 + FH1 / 2, 2.42));
  lvl1Grp.add(put(box(8.38, FH1, T1, wallM), 5.01, F1 + FH1 / 2, 2.42));
  /* 电梯井底部围合（接通上方井道，z=2.99 一侧开向大堂） */
  lvl1Grp.add(put(box(0.12, 1.4, 1.3, wallD), -0.75, F1 + 0.7, 2.34));
  lvl1Grp.add(put(box(0.12, 1.4, 1.3, wallD), 0.75, F1 + 0.7, 2.34));
  lvl1Grp.add(put(box(1.5, 1.4, 0.12, wallD), 0, F1 + 0.7, 1.69));
  /* 一楼电梯门套 + 被挤开的门板 */
  const steel1 = M(0x565c62, { r: 0.3, m: 0.85 });
  lvl1Grp.add(put(box(0.14, 2.3, 0.16, M(0x2c3134, { r: 0.4, m: 0.7 })), -0.82, F1 + 1.15, 2.99));
  lvl1Grp.add(put(box(0.14, 2.3, 0.16, M(0x2c3134, { r: 0.4, m: 0.7 })), 0.82, F1 + 1.15, 2.99));
  const dL1 = put(box(0.72, 2.24, 0.05, steel1), -0.72, F1 + 1.12, 3.06);
  dL1.rotation.y = 0.85; lvl1Grp.add(dL1);
  const dR1 = put(box(0.72, 2.24, 0.05, steel1), 0.72, F1 + 1.12, 3.06);
  dR1.rotation.y = -0.85; lvl1Grp.add(dR1);
  /* 前台：长柜台 + 台面 + 翻倒的椅子 + 散落的纸 */
  const deskM = M(0x1c1712, { r: 0.85 });
  lvl1Grp.add(put(box(3.6, 1.06, 0.55, deskM), 0.6, F1 + 0.53, 6.4));
  lvl1Grp.add(put(box(3.8, 0.06, 0.72, M(0x241e17, { r: 0.8 })), 0.6, F1 + 1.09, 6.4));
  const chair1 = put(box(0.46, 0.07, 0.46, deskM), 2.9, F1 + 0.24, 5.5);
  chair1.rotation.z = 1.35; chair1.rotation.y = 0.4; lvl1Grp.add(chair1);
  lvl1Grp.add(put(box(0.07, 0.5, 0.07, deskM), 2.68, F1 + 0.2, 5.32));
  for (let i = 0; i < 4; i++) {
    const pp = put(box(0.21, 0.004, 0.3, M(0x6a655c, { r: 0.9 })),
      -0.6 + i * 0.5, F1 + 0.06 + i * 0.002, 5.4 + Math.sin(i * 2.1) * 0.5);
    pp.rotation.y = i * 0.7; lvl1Grp.add(pp);
  }
  /* 保安亭：x 5.6..8.3 / z 6.4..8.9，高 2.6，南墙带窗洞，西墙留门洞 */
  const BH1 = 2.6, boothM = M(0x171310, { r: 0.95 });
  lvl1Grp.add(put(box(0.14, BH1, 0.9, boothM), 5.6, F1 + BH1 / 2, 6.85));
  lvl1Grp.add(put(box(0.14, BH1, 0.9, boothM), 5.6, F1 + BH1 / 2, 8.45));
  lvl1Grp.add(put(box(0.14, BH1 - 2.1, 0.7, boothM), 5.6, F1 + 2.1 + (BH1 - 2.1) / 2, 7.65));
  /* 南墙（窗洞 x 6.2..7.6 / y F1+1.0..F1+1.75） */
  lvl1Grp.add(put(box(0.6, BH1, 0.14, boothM), 5.9, F1 + BH1 / 2, 6.4));
  lvl1Grp.add(put(box(0.7, BH1, 0.14, boothM), 7.95, F1 + BH1 / 2, 6.4));
  lvl1Grp.add(put(box(1.4, 1.0, 0.14, boothM), 6.9, F1 + 0.5, 6.4));
  lvl1Grp.add(put(box(1.4, BH1 - 1.75, 0.14, boothM), 6.9, F1 + 1.75 + (BH1 - 1.75) / 2, 6.4));
  /* 北墙 / 东墙 / 顶 */
  lvl1Grp.add(put(box(2.84, BH1, 0.14, boothM), 6.95, F1 + BH1 / 2, 8.9));
  lvl1Grp.add(put(box(0.14, BH1, 2.64, boothM), 8.3, F1 + BH1 / 2, 7.65));
  lvl1Grp.add(put(box(2.98, 0.12, 2.78, boothM), 6.95, F1 + BH1 + 0.06, 7.65));
  /* 保安亭桌子 */
  const tblM = M(0x211a13, { r: 0.85 });
  lvl1Grp.add(put(box(1.0, 0.05, 0.55, tblM), 6.9, F1 + 0.74, 8.35));
  lvl1Grp.add(put(box(0.05, 0.72, 0.5, tblM), 6.45, F1 + 0.37, 8.35));
  lvl1Grp.add(put(box(0.05, 0.72, 0.5, tblM), 7.35, F1 + 0.37, 8.35));
  /* 侧门钥匙（桌上） */
  keyObj = new THREE.Group();
  keyObj.position.set(6.68, F1 + 0.78, 8.3);
  lvl1Grp.add(keyObj);
  {
    const brass = M(0x8a7a4a, { r: 0.38, m: 0.8 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.008, 6, 10), brass);
    ring.rotation.x = Math.PI / 2; keyObj.add(ring);
    keyObj.add(put(box(0.085, 0.008, 0.018, brass), 0.065, 0, 0));
    keyObj.add(put(box(0.014, 0.008, 0.026, brass), 0.098, 0, 0.012));
    keyObj.add(put(box(0.014, 0.008, 0.02, brass), 0.078, 0, 0.011));
  }
  keyObj.userData.pickup = { id: 'key', name: '侧门钥匙' };
  /* 两发子弹（桌上） */
  bullets1Obj = new THREE.Group();
  bullets1Obj.position.set(7.15, F1 + 0.79, 8.42);
  lvl1Grp.add(bullets1Obj);
  {
    bullets1Obj.add(put(box(0.16, 0.035, 0.1, M(0x1b1712, { r: 0.9 })), 0, 0, 0));
    const bMat = M(0x8a7a4a, { r: 0.35, m: 0.8 });
    for (let i = 0; i < 2; i++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.055, 6), bMat);
      b.position.set(-0.04 + i * 0.08, 0.045, 0);
      b.rotation.z = 0.12 + i * 0.09;
      bullets1Obj.add(b);
    }
  }
  bullets1Obj.userData.pickup = { id: 'bullets', name: '子弹' };
  /* 正门：门框 + 四根交叉的燃烧木梁 + 门外火光 */
  const beamM = M(0x1c1208, { r: 0.9 });
  lvl1Grp.add(put(box(0.14, 2.4, 0.3, wallD), -1.15, F1 + 1.2, 9.5));
  lvl1Grp.add(put(box(0.14, 2.4, 0.3, wallD), 1.15, F1 + 1.2, 9.5));
  for (let i = 0; i < 4; i++) {
    const bm = put(box(0.22, 2.7, 0.16, beamM), -0.5 + i * 0.34, F1 + 1.25, 9.42 - (i % 2) * 0.12);
    bm.rotation.z = (i % 2 ? -1 : 1) * (0.5 + i * 0.14);
    lvl1Grp.add(bm);
    addFlame(lvl1Grp, -0.5 + i * 0.34, F1 + 1.9 + (i % 2) * 0.4, 9.3, 0.55, 0.9);
  }
  lvl1Grp.add(put(new THREE.PointLight(0xff5a1c, 2.4, 8, 2), 0, F1 + 1.5, 8.9));
  {
    const glow1 = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.6), fireWallMat.clone());
    glow1.rotation.y = Math.PI;
    glow1.position.set(0, F1 + 1.3, 9.9); lvl1Grp.add(glow1);
    outFireWalls.push(glow1.material);
  }
  /* 侧门（东墙 x=9.2，z 5.55..6.65）：金属门，默认锁死 */
  const sdFrame = M(0x2c3134, { r: 0.4, m: 0.7 });
  lvl1Grp.add(put(box(0.16, 2.3, 0.12, sdFrame), 9.2, F1 + 1.15, 5.5));
  lvl1Grp.add(put(box(0.16, 2.3, 0.12, sdFrame), 9.2, F1 + 1.15, 6.7));
  sideDoor1Pivot = new THREE.Group();
  sideDoor1Pivot.position.set(9.2, F1, 5.58);
  lvl1Grp.add(sideDoor1Pivot);
  sideDoor1Pivot.add(put(box(0.07, 2.18, 1.04, M(0x3a4046, { r: 0.45, m: 0.75 })), 0, 1.09, 0.53));
  sideDoor1Pivot.add(put(box(0.03, 0.1, 0.26, M(0x6a6458, { r: 0.4, m: 0.6 })), -0.06, 1.05, 0.92));
  sideDoor1Pivot.add(put(box(0.02, 0.16, 0.4, M(0x101418, { e: 0x2a3a4a, ei: 0.5 })), -0.06, 1.7, 0.53));
  /* 侧门外：楼后树林（只能看不能出去），泥土地面 + 茂密树木 */
  lvl1Grp.add(put(box(11, 0.2, 9, M(0x0d0b08, { r: 0.98 })), 14.7, F1 - 0.15, 6.2));
  const treeSpots = [[11.8, 3.4, 0], [13.2, 7.8, 1], [12.4, 9.2, 0], [15.2, 4.6, 0], [16.4, 7.2, 1], [14.2, 6.0, 0], [18.0, 5.6, 0]];
  for (let ti = 0; ti < treeSpots.length; ti++) {
    const ts = treeSpots[ti], tg = new THREE.Group();
    const th = 3 + (ti % 3) * 0.7;
    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.3, th, 5), treeMatTrunk);
    tr.position.y = th / 2; tg.add(tr);
    for (let tj = 0; tj < 3; tj++) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(1.55 - tj * 0.36, 1.7, 6), ts[2] ? treeMatBurn : treeMatLeaf);
      c.position.y = th + tj * 1.05; tg.add(c);
    }
    if (ts[2]) addFlame(tg, 0, th * 0.55, 0, 2.1, 3.4);
    tg.position.set(ts[0], F1 - 0.05, ts[1]);
    tg.rotation.y = ti * 1.3;
    lvl1Grp.add(tg);
  }
  lvl1Grp.add(put(new THREE.PointLight(0xff5a1c, 1.6, 14, 2), 15.5, F1 + 2.2, 6.0));
  lvl1Grp.add(put(new THREE.PointLight(0x4a5a7a, 0.4, 8, 2), 11.0, F1 + 3.0, 6.0));
  /* 空调外机预建在门外（隐藏），开门后竖直带火砸进泥土；永不旋转——火焰面片的反向四元数已按单位朝向预计算。加大加重、落点就在门口，出门必被堵 */
  acUnit = new THREE.Group();
  const acShell = M(0x3a4044, { r: 0.5, m: 0.6 });
  acUnit.add(put(box(1.35, 0.95, 0.6, acShell), 0, 0.48, 0));
  const acFan = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.05, 12), M(0x14181a, { r: 0.7 }));
  acFan.rotation.x = Math.PI / 2; acFan.position.set(-0.3, 0.55, 0.32); acUnit.add(acFan);
  for (let gi = 0; gi < 4; gi++) acUnit.add(put(box(0.52, 0.035, 0.035, M(0x22282c, { r: 0.6 })), 0.34, 0.2 + gi * 0.2, 0.32));
  addFlame(acUnit, -0.3, 1.05, 0.08, 0.7, 1.1);
  addFlame(acUnit, 0.4, 0.98, -0.12, 0.55, 0.85);
  acUnit.position.set(10.0, F1, 6.1);
  acUnit.visible = false;
  lvl1Grp.add(acUnit);
  acMound = new THREE.Mesh(new THREE.ConeGeometry(0.95, 0.36, 7), M(0x0c0a08, { r: 0.98 }));
  acMound.position.set(10.0, F1 + 0.15, 6.1);
  acMound.visible = false;
  lvl1Grp.add(acMound);
  /* 大片着火：南墙根 / 东墙根 / 大堂中部瓦砾火 */
  const fireSpots = [
    [-5.2, 8.6, 1.3, 2.0], [-3.9, 9.0, 1.0, 1.6], [3.4, 8.9, 1.2, 1.9],
    [6.8, 9.1, 0.9, 1.4], [8.6, 4.4, 0.8, 1.3], [-6.9, 5.2, 0.9, 1.5],
    [-4.0, 3.9, 0.8, 1.2], [2.2, 4.3, 0.7, 1.1]
  ];
  for (let i = 0; i < fireSpots.length; i++) {
    const fs = fireSpots[i];
    addFlame(lvl1Grp, fs[0], F1 + fs[3] * 0.45, fs[1], fs[2], fs[3]);
    addFlame(lvl1Grp, fs[0] + 0.3, F1 + fs[3] * 0.3, fs[1] - 0.2, fs[2] * 0.7, fs[3] * 0.7);
  }
  /* 瓦砾堆 + 塌落的天花板 */
  const rubM = M(0x100e0c, { r: 0.98 });
  const rub1 = put(box(1.3, 0.9, 1.0, rubM), -4.05, F1 + 0.4, 8.0);
  rub1.rotation.y = 0.4; rub1.rotation.z = 0.12; lvl1Grp.add(rub1);
  const rub2 = put(box(0.9, 0.7, 0.9, rubM), -5.45, F1 + 0.3, 3.95);
  rub2.rotation.y = -0.3; lvl1Grp.add(rub2);
  const rub3 = put(box(1.6, 0.16, 1.1, M(0x191512, { r: 0.95 })), -3.2, F1 + 0.5, 5.2);
  rub3.rotation.z = 0.42; rub3.rotation.y = 0.2; lvl1Grp.add(rub3);
  /* 大堂常见陈设：沙发茶几、绿植、售货机、行李、散落的纸张、灭火器箱、安全出口灯 */
  const sofaM = M(0x1a1410, { r: 0.92 });
  lvl1Grp.add(put(box(2.2, 0.42, 0.85, sofaM), -1.6, F1 + 0.21, 4.9));
  lvl1Grp.add(put(box(2.2, 0.5, 0.2, sofaM), -1.6, F1 + 0.62, 4.55));
  lvl1Grp.add(put(box(0.2, 0.5, 0.85, sofaM), -2.6, F1 + 0.45, 4.9));
  lvl1Grp.add(put(box(0.2, 0.5, 0.85, sofaM), -0.6, F1 + 0.45, 4.9));
  lvl1Grp.add(put(box(1.1, 0.3, 0.55, tblM), -1.6, F1 + 0.15, 5.9));
  for (let i = 0; i < 5; i++) {
    const pp2 = put(box(0.16, 0.004, 0.22, M(0x8a8578, { r: 0.9 })), -1.85 + Math.random() * 0.5, F1 + 0.31, 5.75 + Math.random() * 0.3);
    pp2.rotation.y = Math.random() * 1.2; lvl1Grp.add(pp2);
  }
  for (let i = 0; i < 7; i++) {
    const fp = put(box(0.16, 0.003, 0.22, M(0x6a6558, { r: 0.95 })), -3 + Math.random() * 7, F1 + 0.005, 4 + Math.random() * 4.5);
    fp.rotation.y = Math.random() * 3; lvl1Grp.add(fp);
  }
  /* 绿植 x4：深色陶盆 + 几丛焦边叶子（低多边形锥体） */
  const potM = M(0x2a1c14, { r: 0.85 });
  const leafM = M(0x0d1f12, { r: 0.9 });
  const plantSpots = [[-7.2, 3.6], [3.2, 7.4], [8.6, 8.9], [-1.9, 8.9]];
  for (let i = 0; i < plantSpots.length; i++) {
    const px = plantSpots[i][0], pz = plantSpots[i][1];
    lvl1Grp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.12, 0.3, 8), potM), px, F1 + 0.15, pz));
    for (let j = 0; j < 4; j++) {
      const lf = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.55 + (j % 2) * 0.2, 5), leafM);
      lf.position.set(px + (Math.random() - 0.5) * 0.14, F1 + 0.55 + (j % 2) * 0.08, pz + (Math.random() - 0.5) * 0.14);
      lf.rotation.z = (Math.random() - 0.5) * 0.5; lf.rotation.x = (Math.random() - 0.5) * 0.5;
      lvl1Grp.add(lf);
    }
  }
  /* 自动售货机（北墙边，正面一条暗灯朝南） */
  lvl1Grp.add(put(box(0.9, 1.9, 0.7, M(0x14181c, { r: 0.5, m: 0.4 })), 3.9, F1 + 0.95, 2.9));
  lvl1Grp.add(put(box(0.7, 1.5, 0.03, M(0x0a0e12, { e: 0x1a2a38, ei: 0.5 })), 3.9, F1 + 1.0, 3.26));
  /* 倒下的行李箱（正门口，逃生者丢下的） */
  const lug = put(box(0.62, 0.24, 0.42, M(0x241a20, { r: 0.8 })), 2.3, F1 + 0.12, 8.6);
  lug.rotation.y = 0.7; lug.rotation.z = 0.06; lvl1Grp.add(lug);
  /* 垃圾桶（前台东端） */
  lvl1Grp.add(put(new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.4, 8), M(0x1c1f22, { r: 0.6, m: 0.5 })), 2.85, F1 + 0.2, 6.35));
  /* 灭火器箱（保安亭西墙外，红色小箱） */
  lvl1Grp.add(put(box(0.34, 0.5, 0.14, M(0x5a1410, { r: 0.6 })), 5.46, F1 + 1.3, 6.85));
  /* 安全出口灯（侧门上方，绿色发光——浓烟里唯一指路的） */
  lvl1Grp.add(put(box(0.06, 0.2, 0.5, M(0x061a0e, { e: 0x2aff7a, ei: 1.4 })), 9.1, F1 + 2.45, 6.1));
  lvl1Grp.add(put(new THREE.PointLight(0x2aff7a, 0.5, 2.6, 2), 8.85, F1 + 2.3, 6.1));
  /* 通往地下车库的楼梯（大堂西侧，南向下 8 级到平台，尽头是卷帘门） */
  const gstM = M(0x141210, { r: 0.95 });
  const GRISE = 0.18125, GTREAD = 0.27;
  for (let i = 1; i <= 8; i++) {
    lvl1Grp.add(put(box(1.1, GRISE, GTREAD, gstM), -7.0, F1 - GRISE * i + GRISE / 2, 4.9 + (i - 0.5) * GTREAD));
  }
  /* 底部平台 */
  lvl1Grp.add(put(box(1.1, 0.14, 1.3, gstM), -7.0, F1 - 1.45 - 0.07, 7.7));
  /* 楼梯井侧墙（从平台一直高过大堂地面，兼作护栏） */
  lvl1Grp.add(put(box(0.12, 2.45, 3.5, wallD), -7.61, F1 - 1.45 + 1.225, 6.6));
  lvl1Grp.add(put(box(0.12, 2.45, 3.5, wallD), -6.39, F1 - 1.45 + 1.225, 6.6));
  /* 南端卷帘门（波纹板）+ 门楣 */
  const shutM = M(0x2a2e32, { r: 0.45, m: 0.7 });
  for (let i = 0; i < 6; i++) {
    lvl1Grp.add(put(box(1.06, 0.3, 0.06, shutM), -7.0, F1 - 1.45 + 0.65 + i * 0.3, 8.32));
  }
  lvl1Grp.add(put(box(1.1, 0.35, 0.1, wallD), -7.0, F1 - 1.45 + 2.28, 8.32));
  /* 「地下车库」指示牌（暗绿微光）+ 平台一盏昏黄小灯 */
  lvl1Grp.add(put(box(0.5, 0.2, 0.05, M(0x0a140e, { e: 0x2a6a4a, ei: 0.9 })), -7.0, F1 - 1.45 + 2.0, 8.26));
  lvl1Grp.add(put(new THREE.PointLight(0xffc98a, 0.5, 3.2, 2), -7.0, F1 - 1.45 + 2.0, 7.4));
  /* ============ 地下车库（爬过卷帘门小口进入；空旷、黑暗、到处是车）============
     车库地面在 1F 楼板下 3.5m（与 floorYAt 的行走高度一致）——
     之前几何只下了 1.45m，顶板切过保安亭、玩家落地后整个沉到地坪以下 */
  const FG = F1 - 3.5;                       // 车库地面标高
  const garW = M(0x14161a, { r: 0.95 });
  const garF = M(0x0e0f11, { r: 0.98 });
  const garC = M(0x0f1113, { r: 0.95 });
  lvl1Grp.add(put(box(17.4, 0.2, 14.2, garF), 0.5, FG - 0.1, 15.4));          // 地面
  lvl1Grp.add(put(box(17.4, 0.2, 14.2, garC), 0.5, FG + 3.1, 15.4));          // 顶板
  lvl1Grp.add(put(box(17.4, 3.2, 0.2, garW), 0.5, FG + 1.5, 22.4));           // 南墙
  lvl1Grp.add(put(box(0.2, 3.2, 14.2, garW), -8.2, FG + 1.5, 15.4));          // 西墙
  lvl1Grp.add(put(box(0.2, 3.2, 14.2, garW), 9.2, FG + 1.5, 15.4));           // 东墙
  lvl1Grp.add(put(box(0.65, 3.2, 0.2, garW), -7.875, FG + 1.5, 8.5));         // 北墙·楼梯井西
  lvl1Grp.add(put(box(15.65, 3.2, 0.2, garW), 1.375, FG + 1.5, 8.5));         // 北墙·楼梯井东
  /* 车库四周墙体碰撞：之前只有可视化几何、没有碰撞体，
     玩家能直接穿东西南北墙走到楼外（表现成"侧门旁的空缺"） */
  lvl1Colliders.push(
    { x0: 9.0, x1: 9.4, z0: 8.4, z1: 22.6 },     // 东墙
    { x0: -8.4, x1: -8.0, z0: 8.4, z1: 22.6 },   // 西墙
    { x0: -8.4, x1: 9.4, z0: 22.3, z1: 22.7 }    // 南墙
  );
  /* 布局（参考现实车库）：南北两面墙各一排垂直车位（车尾不贴墙、留 0.7m），
     两排之间是中央通车道（约 4m，不摆任何东西）；柱子插在车位与车位之间承重，
     不占车道。燃烧的车在北排西端（爬进门正对），玩家的车在南排东端（挨着出口坡道）。 */
  const ROW_N = 11.35, ROW_S = 19.55;         // 两排车位的中心线
  const pillarAt = [
    [-3.1, ROW_N], [-0.1, ROW_N], [2.9, ROW_N],
    [-3.1, ROW_S], [-0.1, ROW_S], [2.9, ROW_S]
  ];
  for (let pi = 0; pi < pillarAt.length; pi++) {
    lvl1Grp.add(put(box(0.5, 3.0, 0.5, garW), pillarAt[pi][0], FG + 1.5, pillarAt[pi][1]));
    lvl1Colliders.push({ x0: pillarAt[pi][0] - 0.25, x1: pillarAt[pi][0] + 0.25, z0: pillarAt[pi][1] - 0.25, z1: pillarAt[pi][1] + 0.25 });
  }
  const carSpots = [
    /* 北排：第一辆就是爬进来撞见的燃烧车 */
    [-4.6, ROW_N, 0, 0x1a1d22, 1],
    [-1.6, ROW_N, 0, 0x22262c, 0],
    [ 1.4, ROW_N, 0, 0x15181c, 0],
    [ 4.4, ROW_N, 0, 0x1c1a18, 0],
    /* 南排 */
    [-4.6, ROW_S, 0, 0x201c16, 0],
    [-1.6, ROW_S, 0, 0x1a1d22, 0],
    [ 1.4, ROW_S, 0, 0x22262c, 0]
  ];
  for (let ci = 0; ci < carSpots.length; ci++) {
    const cs = carSpots[ci];
    const car = makeCar(cs[0], cs[1], cs[2], cs[3], cs[4] === 1);
    car.position.y = FG;
    lvl1Grp.add(car);
    lvl1Colliders.push({ x0: cs[0] - 0.95, x1: cs[0] + 0.95, z0: cs[1] - 2.2, z1: cs[1] + 2.2 });
    if (cs[4] === 1) burnCars.push({ x: cs[0], z: cs[1], grp: car, exploded: false });
  }
  /* 玩家的车：南排东端，车头朝出口坡道 */
  playerCar = makeCar(4.6, ROW_S, Math.PI, 0x1c2c4a, false);
  playerCar.position.y = FG;
  lvl1Grp.add(playerCar);
  lvl1Colliders.push({ x0: 4.6 - 0.95, x1: 4.6 + 0.95, z0: ROW_S - 2.2, z1: ROW_S + 2.2 });
  /* 出口坡道（东南角，向上通车辆卷帘门） */
  const rampM = M(0x131518, { r: 0.95 });
  for (let ri = 0; ri < 6; ri++) lvl1Grp.add(put(box(3.2, 0.18, 0.5, rampM), 7.4, FG + 0.09 + ri * 0.18, 19.4 + ri * 0.5));
  const gshutM = M(0x262a2e, { r: 0.5, m: 0.7 });
  for (let gi = 0; gi < 8; gi++) lvl1Grp.add(put(box(3.6, 0.32, 0.08, gshutM), 7.4, FG + 0.16 + gi * 0.32, 22.3));
  lvl1Grp.add(put(box(3.8, 0.3, 0.14, garW), 7.4, FG + 2.75, 22.3));
  /* 尽头小门（西南角，贴着西墙内侧面西，被困的人在门后） */
  lvl1Grp.add(put(box(0.1, 2.0, 0.9, M(0x2a2018, { r: 0.7 })), -8.05, FG + 1.0, 20.5));
  lvl1Grp.add(put(box(0.06, 0.12, 0.2, M(0x6a6458, { r: 0.4, m: 0.6 })), -7.96, FG + 1.0, 20.2));
  /* 昏暗灯光 + 安全出口应急灯 + 烟雾 */
  lvl1Grp.add(put(new THREE.PointLight(0xffc98a, 0.4, 5, 2), -7.0, FG + 2.6, 9.5));
  lvl1Grp.add(put(new THREE.PointLight(0xff5a3a, 0.5, 6, 2), 7.4, FG + 2.4, 20.5));
  lvl1Grp.add(put(new THREE.PointLight(0x3a4a5a, 0.3, 7, 2), 0.5, FG + 2.8, 15));
  lvl1Grp.add(put(box(0.4, 0.16, 0.05, M(0x061a0e, { e: 0x2aff7a, ei: 1.0 })), 7.4, FG + 2.5, 22.2));
  for (let si = 0; si < 8; si++) addSmoke(lvl1Grp, -7 + Math.random() * 15, FG + 1.2 + Math.random() * 1.4, 9.5 + Math.random() * 12, 2.6 + Math.random() * 1.4);
  /* 黑色密室（隐藏在地图远处，专供「直接开出口卷帘门」的坏结局） */
  blackRoomGrp = new THREE.Group();
  blackRoomGrp.position.set(108, -50, 108);
  const blkM = M(0x050505, { r: 0.98 });
  blackRoomGrp.add(put(box(5, 0.2, 5, blkM), 0, -0.1, 0));
  blackRoomGrp.add(put(box(5, 0.2, 5, blkM), 0, 3.0, 0));
  blackRoomGrp.add(put(box(5, 3.2, 0.2, blkM), 0, 1.5, -2.5));
  blackRoomGrp.add(put(box(5, 3.2, 0.2, blkM), 0, 1.5, 2.5));
  blackRoomGrp.add(put(box(0.2, 3.2, 5, blkM), -2.5, 1.5, 0));
  blackRoomGrp.add(put(box(0.2, 3.2, 5, blkM), 2.5, 1.5, 0));
  blackRoomGrp.add(put(new THREE.PointLight(0x4a5a7a, 0.5, 6, 2), 0, 2.4, 0.8));
  blackRoomGrp.visible = false;
  playerRoom.add(blackRoomGrp);
  /* 浓烟 + 火星 + 灯光 */
  for (let i = 0; i < 12; i++) {
    addSmoke(lvl1Grp, -7 + Math.random() * 15, F1 + 1.6 + Math.random() * 1.3,
      3.4 + Math.random() * 5.8, 3.2 + Math.random() * 1.6);
  }
  lvl1Grp.add(makeEmbers(36, { x0: -7.5, x1: 9, y0: F1 + 0.2, y1: F1 + 3.0, z0: 3.2, z1: 9.3 }, 0xff6a26, 0.12));
  lvl1Grp.add(put(new THREE.PointLight(0xff6a24, 1.5, 8, 2), -4.6, F1 + 1.4, 7.6));
  lvl1Grp.add(put(new THREE.PointLight(0xff7a30, 0.9, 6, 2), 8.2, F1 + 1.2, 4.6));
  lvl1Grp.add(put(new THREE.PointLight(0xffc98a, 0.5, 4, 2), 6.9, F1 + 2.2, 7.6));
  lvl1Grp.add(put(new THREE.PointLight(0xff6a24, 1.2, 5, 2), 0, F1 + 1.0, 2.6));
  lvl1Grp.add(new THREE.HemisphereLight(0x2a1a12, 0x050304, 0.4));
  addFlame(lvl1Grp, -0.5, F1 + 0.5, 3.3, 0.5, 0.8);
  /* 滑绳时包在绳子上的毛巾（CG 期间可见，之后留在绳底） */
  ropeTowel = new THREE.Group();
  ropeTowel.visible = false;
  {
    const cloth = M(0x33454e, { r: 0.6, m: 0.05 });
    const wrap = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.022, 6, 10), cloth);
    wrap.rotation.x = Math.PI / 2; ropeTowel.add(wrap);
    const tail1 = put(box(0.07, 0.17, 0.016, cloth), 0.035, -0.1, 0.01);
    tail1.rotation.z = 0.2; ropeTowel.add(tail1);
    const tail2 = put(box(0.06, 0.13, 0.016, M(0x26343b, { r: 0.68 })), -0.03, -0.085, -0.012);
    tail2.rotation.z = -0.16; ropeTowel.add(tail2);
  }
  ropeTowel.position.set(0, 1.6, -0.2);
  elev4Shaft.add(ropeTowel);
}
/* ==================== [7] 音效 ====================
   真实音频优先；解码失败时回退到原合成音。Electron/file:// 也兼容
   （base64 内嵌避开 CORS 与离线场景）。 */
let AC = null, master = null, fireGain = null;
let sfxBus = null, musicBus = null;   // 音效总线 / 音乐总线（ESC 菜单各自调音量）
let fiveBuf = null;                   // AudioBuffer: five40.mp3 解码结果（5F 背景音乐）
let oneBuf = null;                    // AudioBuffer: one.mp3 解码结果（一楼/地下车库 BGM）
let fourBuf = null;                   // AudioBuffer: four.mp3 解码结果（四楼/天台 BGM）
let bgmFiveSrc = null, bgmOneSrc = null, bgmFourSrc = null;   // 三条 BGM 的循环实例
const MUSIC_BASE = 0.21;              // 音乐基础音量 ≈ 电锯典型响度 × 70%（比电锯小 30%）
let sawLoopBuf = null;             // AudioBuffer: chainsaw_loop.mp3 解码结果
let sawRevBuf  = null;             // AudioBuffer: chainsaw_rev.mp3  解码结果
let sawLoopSrc = null;             // BufferSource: 正在循环的实例
let sawLoopGain = null;            // 循环段的 Gain（按距离驱动音量/滤波器）
let sawLoopLP   = null;            // 低通滤波（距离远的闷）
let sawLoopBP   = null;            // 带通（中高频，模拟隔墙）

/* 把 base64 字符串变成 ArrayBuffer（给 decodeAudioData 用） */
function _b64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const buf = new ArrayBuffer(len);
  const view = new Uint8Array(buf);
  for (let i = 0; i < len; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

/* BGM 调度：
   五楼（curLevel 0）：仅游玩状态循环播放 five40.mp3；
   四楼/天台（curLevel -1 / 1）：整段持续播放 four.mp3 ——
     包括空调外机攀爬、坠落 QTE、钩爪分镜、直升机救援/撤离、被追杀等所有 CG，
     一路放到点「重活一世」重开为止（重开是整页刷新，音频状态随之归零）；
   一楼/地下车库（curLevel -2）：整段持续播放 one.mp3，规则同上。
   三条轨道按楼层互斥，换楼层时旧轨道停止、新轨道起播。 */
function tickBGM(src, want, buf) {
  if (!buf) return src;
  if (want && !src) {
    const s = AC.createBufferSource(); s.buffer = buf; s.loop = true;
    s.connect(musicBus); s.start(); return s;
  }
  if (!want && src) { try { src.stop(); } catch (e) {} return null; }
  return src;
}
function updateBGM() {
  if (!AC || !musicBus) return;
  const wantFive = !!fiveBuf && curLevel === 0 && state === 'play';
  const wantFour = !!fourBuf && (curLevel === -1 || curLevel === 1);
  const wantOne = !!oneBuf && curLevel === -2;
  bgmFiveSrc = tickBGM(bgmFiveSrc, wantFive, fiveBuf);
  bgmFourSrc = tickBGM(bgmFourSrc, wantFour, fourBuf);
  bgmOneSrc = tickBGM(bgmOneSrc, wantOne, oneBuf);
}

const SFX = {
  init: function () {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    master = AC.createGain(); master.gain.value = 0.7;
    /* 音效总线：电锯/脚步等所有合成与采样音经 master 过这里；ESC 菜单的「音效」滑条控制它 */
    sfxBus = AC.createGain(); master.connect(sfxBus); sfxBus.connect(AC.destination);
    /* 音乐总线：mp3 背景音乐直连输出、不进 master —— 「音效」滑条不影响音乐 */
    musicBus = AC.createGain(); musicBus.connect(AC.destination);
    this.applyVolumes();
    this.fireLoop(); this.drone();
    this.loadChainsaw(); this.loadBGM();
  },
  /* 应用 ESC 菜单里存的音量（0..100），并把滑条位置同步回去 */
  applyVolumes: function () {
    if (!AC || !sfxBus || !musicBus) return;
    let s = 100, m = 100;
    try {
      s = parseInt(localStorage.getItem('sfxVol') || '100', 10) || 100;
      m = parseInt(localStorage.getItem('musVol') || '100', 10) || 100;
    } catch (e) {}
    s = Math.max(0, Math.min(100, s)); m = Math.max(0, Math.min(100, m));
    sfxBus.gain.value = s / 100;
    musicBus.gain.value = MUSIC_BASE * (m / 100);
    const s1 = document.getElementById('sfxVol'), m1 = document.getElementById('musVol');
    if (s1) s1.value = s; if (m1) m1.value = m;
  },
  loadBGM: function () {
    if (!AC) return;
    try {
      if (window.FIVE_B64) AC.decodeAudioData(_b64ToBytes(window.FIVE_B64), function (buf) { fiveBuf = buf; }, function () {});
      if (window.ONE_B64) AC.decodeAudioData(_b64ToBytes(window.ONE_B64), function (buf) { oneBuf = buf; }, function () {});
      if (window.FOUR_B64) AC.decodeAudioData(_b64ToBytes(window.FOUR_B64), function (buf) { fourBuf = buf; }, function () {});
    } catch (e) { /* 解码失败就没有 BGM，不影响游戏 */ }
  },
  loadChainsaw: function () {
    // 必须走 window.，裸标识符在文件缺失时会抛 ReferenceError 而不是给 undefined
    const b64 = window.SFX_B64;
    if (!AC || !b64 || !b64.loop) return;
    try {
      AC.decodeAudioData(_b64ToBytes(b64.loop),
        function (buf) { sawLoopBuf = buf; }, function () {});
      if (b64.rev) {
        AC.decodeAudioData(_b64ToBytes(b64.rev),
          function (buf) { sawRevBuf = buf; }, function () {});
      }
    } catch (e) { /* 解码失败就用合成音兜底 */ }
  },
  /* 按距离刷新电锯循环音：远处闷、近处亮
     仅当 sawLoopSrc 已经在跑（startChainsaw 之后）时调用 */
  updateChainsawDist: function (dist, wall01) {
    if (!AC || !sawLoopGain || !sawLoopSrc) return;
    const d = Math.max(0.5, dist);
    // 1/d 衰减 + 远端最低 0.05；墙越厚越闷、越响度衰减
    /* 加响：原来上限 0.5 太克制，破门后那一下的压迫感出不来。
       上限提到 0.95、近场系数 0.9→1.6；robotOut 之后再额外 ×1.35。
       四楼被封住时机器人虽然不推进，电锯声仍要刷存在感 → 再 ×1.5。 */
    let vol = Math.min(0.95, 1.6 / d) * (1 - 0.5 * wall01) + 0.05 * (1 - wall01);
    if (typeof robotOut !== 'undefined' && robotOut) vol = Math.min(1.0, vol * 1.35);
    if (typeof lvl4Barred !== 'undefined' && lvl4Barred && curLevel === -1) vol = Math.min(1.0, vol * 1.5);
    const t = AC.currentTime;
    sawLoopGain.gain.cancelScheduledValues(t);
    sawLoopGain.gain.linearRampToValueAtTime(vol, t + 0.18);
    if (sawLoopLP) {
      // 距离 1m → 3500Hz，30m+ → 600Hz；隔墙再额外压低 800Hz
      const f = Math.max(380, Math.min(3800, 4200 - d * 100 - wall01 * 1500));
      sawLoopLP.frequency.cancelScheduledValues(t);
      sawLoopLP.frequency.linearRampToValueAtTime(f, t + 0.22);
    }
    if (sawLoopBP) {
      const q = Math.max(0.7, Math.min(2.4, 2.6 - d * 0.04));
      sawLoopBP.Q.linearRampToValueAtTime(q, t + 0.22);
    }
  },
  startChainsaw: function () {           // 起动：轰一脚油门 + 起循环
    if (!AC) return;
    this.revChainsaw(0.85);
    if (!sawLoopBuf || sawLoopSrc) return;   // 素材没解码好 / 已经在循环
    sawLoopLP  = AC.createBiquadFilter(); sawLoopLP.type  = 'lowpass';  sawLoopLP.frequency.value = 3800;
    sawLoopBP  = AC.createBiquadFilter(); sawLoopBP.type  = 'bandpass'; sawLoopBP.Q.value = 1.4;
    sawLoopGain = AC.createGain(); sawLoopGain.gain.value = 0.0;
    sawLoopSrc = AC.createBufferSource(); sawLoopSrc.buffer = sawLoopBuf; sawLoopSrc.loop = true;
    // 掐掉首尾各 30ms：MP3 编码器会在两端补静音，不切掉循环会有一声「哒」
    sawLoopSrc.loopStart = 0.03;
    sawLoopSrc.loopEnd = Math.max(0.1, sawLoopBuf.duration - 0.03);
    sawLoopSrc.connect(sawLoopLP); sawLoopLP.connect(sawLoopBP);
    sawLoopBP.connect(sawLoopGain); sawLoopGain.connect(master);
    sawLoopSrc.start(0, 0.03);
  },
  /* 轰油门：有素材就播真实录音，没有就退回合成音，保证任何情况下都有声 */
  revChainsaw: function (strength) {
    if (!AC) return;
    const k = strength || 1;
    if (sawRevBuf) {
      const s = AC.createBufferSource(); s.buffer = sawRevBuf;
      const g = AC.createGain(); g.gain.value = 0.3 * k;
      const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400 + 1600 * k;
      s.connect(lp); lp.connect(g); g.connect(master);
      s.start(); s.stop(AC.currentTime + sawRevBuf.duration);
      return;
    }
    this.sawSynth(k, 2.2);               // 兜底
  },
  /* 合成电锯音（仅当真实素材不可用时使用） */
  sawSynth: function (speed, dur) {
    if (!AC) return;
    const t = AC.currentTime, d = dur || 1.6;
    const o = AC.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(52, t);
    o.frequency.exponentialRampToValueAtTime(190 * speed, t + d * 0.55);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.14 * speed, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.001, t + d);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 400; bp.Q.value = 1.1;
    o.connect(bp); bp.connect(g); g.connect(master); o.start(); o.stop(t + d + 0.1);
  },
  stopChainsaw: function () {
    if (!AC || !sawLoopSrc) return;
    const t = AC.currentTime;
    sawLoopGain.gain.cancelScheduledValues(t);
    sawLoopGain.gain.linearRampToValueAtTime(0.0, t + 0.3);
    const s = sawLoopSrc; sawLoopSrc = null;
    setTimeout(function () { try { s.stop(); } catch (e) {} }, 350);
  },
  noise: function (sec) {
    const b = AC.createBuffer(1, AC.sampleRate * (sec || 2), AC.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  },
  fireLoop: function () {           // 替换关键词：fire burning crackling / house fire
    const s = AC.createBufferSource(); s.buffer = this.noise(3); s.loop = true;
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320;
    fireGain = AC.createGain(); fireGain.gain.value = 0.1;
    const lfo = AC.createOscillator(); lfo.frequency.value = 0.6;
    const lg = AC.createGain(); lg.gain.value = 0.045;
    lfo.connect(lg); lg.connect(fireGain.gain); lfo.start();
    s.connect(lp); lp.connect(fireGain); fireGain.connect(master); s.start();
  },
  drone: function () {              // 替换关键词：dark ambient drone
    const o = AC.createOscillator(); o.type = 'sine'; o.frequency.value = 41;
    const o2 = AC.createOscillator(); o2.type = 'sine'; o2.frequency.value = 42.6;
    const g = AC.createGain(); g.gain.value = 0.038;
    o.connect(g); o2.connect(g); g.connect(master); o.start(); o2.start();
  },
  tick: function () {               // 替换关键词：typewriter keystroke
    if (!AC) return;
    const o = AC.createOscillator(); o.type = 'square'; o.frequency.value = 1750;
    const g = AC.createGain();
    g.gain.setValueAtTime(0.038, AC.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + 0.028);
    o.connect(g); g.connect(master); o.start(); o.stop(AC.currentTime + 0.035);
  },
  boom: function () {               // 替换关键词：distant explosion
    if (!AC) return;
    const t = AC.currentTime;
    const s = AC.createBufferSource(); s.buffer = this.noise(2);
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1600, t);
    lp.frequency.exponentialRampToValueAtTime(110, t + 1.3);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.45, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.7);
    s.connect(lp); lp.connect(g); g.connect(master); s.start(); s.stop(t + 1.8);
  },
  cough: function () {              // 两声连咳：噪声过带通，第二声稍弱
    if (!AC) return;
    const t0 = AC.currentTime;
    for (let i = 0; i < 2; i++) {
      const t = t0 + i * 0.24;
      const s = AC.createBufferSource(); s.buffer = this.noise(0.3);
      const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.6;
      bp.frequency.setValueAtTime(900 - i * 180, t);
      bp.frequency.exponentialRampToValueAtTime(380, t + 0.14);
      const g = AC.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.22 - i * 0.07, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
      s.connect(bp); bp.connect(g); g.connect(master); s.start(t); s.stop(t + 0.2);
    }
  },
  scream: function () {             // 替换关键词：scream far away horror
    if (!AC) return;
    const t = AC.currentTime;
    const s = AC.createBufferSource(); s.buffer = this.noise(2); s.playbackRate.value = 1.35;
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 7;
    bp.frequency.setValueAtTime(880, t);
    bp.frequency.exponentialRampToValueAtTime(1750, t + 0.45);
    bp.frequency.exponentialRampToValueAtTime(680, t + 1.1);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.exponentialRampToValueAtTime(0.085, t + 0.16);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.25);
    s.connect(bp); bp.connect(g); g.connect(master); s.start(); s.stop(t + 1.3);
  },
  whoosh: function () {             // 替换关键词：glass break + whoosh pass by
    if (!AC) return;
    const t = AC.currentTime;
    const s = AC.createBufferSource(); s.buffer = this.noise(2);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.linearRampToValueAtTime(2600, t + 0.5);
    bp.frequency.linearRampToValueAtTime(500, t + 1.1);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.35);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    s.connect(bp); bp.connect(g); g.connect(master); s.start(); s.stop(t + 1.3);
  },
  voice: function () {              // 替换：I will deliver you 合成女声（平静、轻度失真）
    if (!AC) return;
    const t = AC.currentTime;
    const o = AC.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(214, t);
    o.frequency.linearRampToValueAtTime(178, t + 0.42);
    o.frequency.linearRampToValueAtTime(202, t + 0.95);
    o.frequency.linearRampToValueAtTime(146, t + 1.75);
    const vib = AC.createOscillator(); vib.frequency.value = 5.6;
    const vg = AC.createGain(); vg.gain.value = 5.5;
    vib.connect(vg); vg.connect(o.frequency);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.085, t + 0.12);
    g.gain.linearRampToValueAtTime(0.07, t + 1.5);
    g.gain.exponentialRampToValueAtTime(0.001, t + 2.05);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 720; bp.Q.value = 2.2;
    o.connect(bp); bp.connect(g); g.connect(master);
    vib.start(); o.start(); o.stop(t + 2.1); vib.stop(t + 2.1);
  },
  heart: function (n) {             // 替换关键词：heartbeat（闭眼段落）
    if (!AC) return;
    for (let i = 0; i < (n || 3); i++) {
      const t = AC.currentTime + i * 0.85;
      for (const off of [0, 0.19]) {
        const o = AC.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(62, t + off);
        o.frequency.exponentialRampToValueAtTime(34, t + off + 0.16);
        const g = AC.createGain();
        g.gain.setValueAtTime(0.001, t + off);
        g.gain.linearRampToValueAtTime(off ? 0.1 : 0.16, t + off + 0.03);
        g.gain.exponentialRampToValueAtTime(0.001, t + off + 0.22);
        o.connect(g); g.connect(master); o.start(t + off); o.stop(t + off + 0.25);
      }
    }
  },
  breath: function () {             // 替换关键词：gasp breath（睁眼瞬间）
    if (!AC) return;
    const t = AC.currentTime;
    const s = AC.createBufferSource(); s.buffer = this.noise(2);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 620; bp.Q.value = 0.9;
    const g = AC.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.1, t + 0.22);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    s.connect(bp); bp.connect(g); g.connect(master); s.start(); s.stop(t + 1.1);
  },
  /* 坠落风声：噪声经带通，音量与亮度随下落时间上升。
     翻窗和失重段只有微风，进入加速段后风声压过一切 */
  wind: function (dur) {
    if (!AC) return;
    const t = AC.currentTime, d = dur || 3.0;
    const s = AC.createBufferSource(); s.buffer = this.noise(5); s.loop = true;
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.7;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.linearRampToValueAtTime(520, t + 2.3);      // 失重段：还很轻
    bp.frequency.linearRampToValueAtTime(1500, t + d * 0.94);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.001, t);
    g.gain.linearRampToValueAtTime(0.035, t + 1.5);          // 翻窗：几乎没风
    g.gain.linearRampToValueAtTime(0.075, t + 2.3);          // 失重瞬间：风起来了
    g.gain.linearRampToValueAtTime(0.32, t + d * 0.93);      // 加速段：灌满耳朵
    g.gain.linearRampToValueAtTime(0.0008, t + d);
    s.connect(bp); bp.connect(g); g.connect(master);
    s.start(t); s.stop(t + d + 0.1);
  },
  /* 落地撞击：一记很闷很重的低频 + 短促的骨感高频 */
  impact: function () {
    if (!AC) return;
    const t = AC.currentTime;
    const o = AC.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(96, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 0.28);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.6, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.55);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.6);
    const s = AC.createBufferSource(); s.buffer = this.noise(0.4);
    const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g2 = AC.createGain();
    g2.gain.setValueAtTime(0.34, t);
    g2.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
    s.connect(lp); lp.connect(g2); g2.connect(master); s.start(t); s.stop(t + 0.3);
  },
  setFire: function (v) { if (fireGain) fireGain.gain.value = v; },
  /* 脚步：低频闷响（鞋底落地）+ 一小段带通噪声（沙砾摩擦）。
     跑步时更响、更快、频率更高 */
  step: function (running) {
    if (!AC) return;
    const t = AC.currentTime;
    const amp = running ? 0.075 : 0.038;
    // 落地闷响
    const o = AC.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(running ? 108 : 86, t);
    o.frequency.exponentialRampToValueAtTime(running ? 52 : 44, t + 0.075);
    const g = AC.createGain();
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.11);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.13);
    // 鞋底摩擦
    const s = AC.createBufferSource(); s.buffer = this.noise(0.2);
    const bp = AC.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = running ? 2100 : 1500; bp.Q.value = 0.9;
    const g2 = AC.createGain();
    g2.gain.setValueAtTime(amp * 0.55, t);
    g2.gain.exponentialRampToValueAtTime(0.0008, t + 0.065);
    s.connect(bp); bp.connect(g2); g2.connect(master);
    s.start(t); s.stop(t + 0.08);
  },
  /* 丢弃落地：hard = 手机磕地板的脆响，soft = 毛巾的闷扑，metal = 手枪的金属当啷 */
  thud: function (kind) {
    if (!AC) return;
    const t = AC.currentTime;
    const hard = kind === 'hard', metal = kind === 'metal';
    const s = AC.createBufferSource(); s.buffer = this.noise(0.3);
    const f = AC.createBiquadFilter();
    if (metal) { f.type = 'bandpass'; f.frequency.value = 3400; f.Q.value = 2.6; }
    else if (hard) { f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 1.6; }
    else { f.type = 'lowpass'; f.frequency.value = 420; }
    const g = AC.createGain();
    g.gain.setValueAtTime(metal ? 0.11 : (hard ? 0.1 : 0.07), t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + (metal ? 0.13 : (hard ? 0.09 : 0.16)));
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t); s.stop(t + 0.24);
    if (metal) {
      /* 金属件落地会有两三个短促的谐波，听起来才"当啷" */
      const freqs = [1180, 1760, 2480];
      for (let i = 0; i < freqs.length; i++) {
        const o = AC.createOscillator(); o.type = 'triangle';
        o.frequency.setValueAtTime(freqs[i], t);
        o.frequency.exponentialRampToValueAtTime(freqs[i] * 0.82, t + 0.16);
        const g2 = AC.createGain();
        g2.gain.setValueAtTime(0.035 / (i + 1), t);
        g2.gain.exponentialRampToValueAtTime(0.0006, t + 0.16 + i * 0.03);
        o.connect(g2); g2.connect(master); o.start(t); o.stop(t + 0.24);
      }
      // 底下再垫一记闷响，表示是重物
      const o3 = AC.createOscillator(); o3.type = 'sine';
      o3.frequency.setValueAtTime(150, t);
      o3.frequency.exponentialRampToValueAtTime(70, t + 0.09);
      const g3 = AC.createGain();
      g3.gain.setValueAtTime(0.06, t);
      g3.gain.exponentialRampToValueAtTime(0.0008, t + 0.12);
      o3.connect(g3); g3.connect(master); o3.start(t); o3.stop(t + 0.14);
    } else if (hard) {
      const o = AC.createOscillator(); o.type = 'triangle';
      o.frequency.setValueAtTime(190, t);
      o.frequency.exponentialRampToValueAtTime(90, t + 0.07);
      const g2 = AC.createGain();
      g2.gain.setValueAtTime(0.055, t);
      g2.gain.exponentialRampToValueAtTime(0.0008, t + 0.1);
      o.connect(g2); g2.connect(master); o.start(t); o.stop(t + 0.12);
    }
  },
  /* 手机震动：两下短促的嗡（收消息时用） */
  buzz: function () {
    if (!AC) return;
    for (const off of [0, 0.26]) {
      const t = AC.currentTime + off;
      const o = AC.createOscillator(); o.type = 'square';
      o.frequency.setValueAtTime(145, t);
      const g = AC.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.05, t + 0.03);
      g.gain.setValueAtTime(0.05, t + 0.14);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 0.2);
      const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700;
      o.connect(lp); lp.connect(g); g.connect(master);
      o.start(t); o.stop(t + 0.24);
    }
  }
};

/* ==================== [8] 字幕打字机 ==================== */
const subEl = document.getElementById('sub');
let typeTimer = null;
let sayT1 = null, sayT2 = null;
function say(text, hold) {
  clearInterval(typeTimer);
  clearTimeout(sayT1); clearTimeout(sayT2);
  subEl.classList.remove('fadeout');
  const span = document.createElement('span');
  const cur = document.createElement('span'); cur.className = 'cur';
  subEl.innerHTML = ''; subEl.appendChild(span); subEl.appendChild(cur);
  let i = 0;
  typeTimer = setInterval(function () {
    if (i < text.length) { span.textContent += text[i++]; SFX.tick(); }
    else {
      clearInterval(typeTimer);
      setTimeout(function () { cur.style.display = 'none'; }, 400);
    }
  }, 48);
  /* 打完字之后再算存在时间：超过 2s 开始渐隐、3s 完全消失。
     长句子（打字要 1~2 秒）不能从弹出那一刻开始计时，否则字还没打完就淡了。 */
  const typeMs = text.length * 48;
  sayT1 = setTimeout(function () { subEl.classList.add('fadeout'); }, typeMs + 2000);
  sayT2 = setTimeout(function () {
    subEl.innerHTML = ''; subEl.classList.remove('fadeout');
  }, typeMs + 3000);
}
function clearSay() {
  clearInterval(typeTimer); clearTimeout(sayT1); clearTimeout(sayT2);
  subEl.innerHTML = ''; subEl.classList.remove('fadeout');
}

/* ==================== [9] 相机路径（Catmull-Rom） ==================== */
const KEYS = [
  { t: 0.0, p: [14, 48, 66], l: [0, 13, -8] },
  { t: 5.0, p: [-6, 34, 52], l: [-2, 12, -8] },
  { t: 9.5, p: [-30, 20, 34], l: [-3, 11, -8] },
  { t: 14.0, p: [-26, 11, 12], l: [-2, 10, -6] },
  { t: 18.0, p: [-6, 13, 15], l: [-3.5, 13.6, -2] },
  { t: 21.5, p: [-3.5, 14.6, 9.5], l: [-3.5, 14.5, -2] },
  { t: 25.0, p: [-3.5, 14.6, 3.0], l: [-3.5, 14.5, -2] },
  { t: 27.0, p: [-3.5, 14.55, -1.2], l: [-3.5, 14.5, -4.0] },
  { t: 30.5, p: [-3.4, 14.6, -2.6], l: [-2.6, 14.4, -5.4] },
  { t: 34.0, p: [-3.5, 14.6, -3.4], l: [-3.2, 14.5, -6.2] },
  { t: 37.0, p: [-3.7, 14.78, -4.2], l: [-3.9, 15.08, -7.0] },
  { t: 40.0, p: [-3.9, 14.82, -4.6], l: [-3.9, 15.2, -7.0] },
  { t: 44.0, p: [-3.9, 14.85, -5.3], l: [-3.9, 15.24, -7.0] },
  { t: 48.0, p: [-3.9, 14.85, -5.35], l: [-3.9, 15.26, -7.0] },
  { t: 54.0, p: [-3.9, 14.85, -5.36], l: [-3.9, 15.26, -7.0] }
];
const KP = KEYS.map(function (k) { return new THREE.Vector3().fromArray(k.p); });
const KL = KEYS.map(function (k) { return new THREE.Vector3().fromArray(k.l); });
const _a = new THREE.Vector3(), _b = new THREE.Vector3();
function catmull(arr, i, k, out) {
  const n = arr.length;
  const p0 = arr[Math.max(0, i - 1)], p1 = arr[i],
    p2 = arr[Math.min(n - 1, i + 1)], p3 = arr[Math.min(n - 1, i + 2)];
  const k2 = k * k, k3 = k2 * k;
  out.set(0, 0, 0);
  out.addScaledVector(p0, -0.5 * k3 + k2 - 0.5 * k);
  out.addScaledVector(p1, 1.5 * k3 - 2.5 * k2 + 1.0);
  out.addScaledVector(p2, -1.5 * k3 + 2.0 * k2 + 0.5 * k);
  out.addScaledVector(p3, 0.5 * k3 - 0.5 * k2);
  return out;
}
function sampleCam(t) {
  const last = KEYS.length - 1;
  if (t <= KEYS[0].t) { _a.copy(KP[0]); _b.copy(KL[0]); return; }
  if (t >= KEYS[last].t) { _a.copy(KP[last]); _b.copy(KL[last]); return; }
  let i = 0;
  for (let j = 0; j < last; j++) { if (t >= KEYS[j].t && t <= KEYS[j + 1].t) { i = j; break; } }
  const k = (t - KEYS[i].t) / (KEYS[i + 1].t - KEYS[i].t);
  catmull(KP, i, k, _a); catmull(KL, i, k, _b);
}

/* ==================== [10] 时间轴 ==================== */
function flash(a) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;background:#ff9a4a;opacity:' + a +
    ';z-index:25;pointer-events:none;transition:opacity .75s;';
  document.body.appendChild(el);
  requestAnimationFrame(function () {
    requestAnimationFrame(function () { el.style.opacity = '0'; });
  });
  setTimeout(function () { el.remove(); }, 850);
}
const EV = [
  { t: 1.2, f: function () { say('23:40 · 2026年 · 加州 · 翠湖湾社区 17 号楼', 2800); } },
  { t: 5.2, f: function () { say('山火烧到第七天。没人告诉我们，火最初是从哪里起来的。', 3200); } },
  { t: 10.0, f: function () { say('消防队进不了山。他们派来了一台机器——Threehalves。', 3200); } },
  { t: 13.2, f: function () { SFX.boom(); flash(0.32); } },
  { t: 15.0, f: function () { say('23:15，它进了我们这栋楼。广播说，留在屋里，等它破门。', 3200); } },
  { t: 19.2, f: function () { say('23:22，通讯断了。楼道广播只剩下电流声。', 2800); } },
  { t: 21.4, f: function () { SFX.scream(); } },
  { t: 22.6, f: function () { say('然后我听见了尖叫。是楼上的人。', 2600); } },
  { t: 25.2, f: function () { say('……不是被火困住的那种叫声。', 2400); } },
  { t: 26.7, f: function () { SFX.whoosh(); SFX.setFire(0.19); } },
  { t: 30.2, f: function () { say('它还在楼里。', 2200); } },
  { t: 32.6, f: function () { SFX.startChainsaw(); } },       // 起动：轰油门 + 起循环
  { t: 34.0, f: function () { say('它还在「救人」。', 2600); } },
  { t: 37.6, f: function () { SFX.revChainsaw(0.75); } },      // 走近，补一脚油门
  { t: 40.8, f: function () { SFX.revChainsaw(1.0); } },       // 举锯，狠踩油门
  { t: 43.4, f: function () { SFX.voice(); say('「 I will deliver you. 」', 3000); } },
  { t: 47.4, f: function () { document.getElementById('title').classList.add('show'); } },
  {
    t: 52.0, f: function () {     // 51→52：标题在羊头上多定格 1 秒
      document.getElementById('title').classList.remove('show');
      clearSay();
      document.getElementById('cont').classList.add('show');
      setState('await');
      hideIntroFf();
    }
  }
];
let evIdx = 0;

/* 举锯前挥 */
/* 举锯 → 前挥 → 收回定格。
   终场不让锯条正对镜头（端面看过去只剩一条细线），而是停在斜举姿态，
   锯齿和警示条都能读出来 */
function swingPose(t) {
  const t0 = 40.9, t1 = 41.8, t2 = 42.35, t3 = 43.6;
  if (t < t0) return { rot: 0.02, roll: 0.0, lean: 0 };
  if (t < t1) { const k = (t - t0) / (t1 - t0), e = k * k * (3 - 2 * k); return { rot: 0.02 - 1.0 * e, roll: 0.55 * e, lean: -0.05 * e }; }
  if (t < t2) { const k = (t - t1) / (t2 - t1), e = k * k; return { rot: -0.98 + 1.62 * e, roll: 0.55 - 0.2 * e, lean: -0.05 + 0.16 * e }; }
  if (t < t3) { const k = (t - t2) / (t3 - t2), e = k * k * (3 - 2 * k); return { rot: 0.64 - 1.06 * e, roll: 0.35 + 0.28 * e, lean: 0.11 - 0.11 * e }; }
  return { rot: -0.42, roll: 0.63, lean: 0 };   // 斜举定格
}

/* ==================== [11] 状态机 ==================== */
let state = 'idle';     // idle → intro → await → closing → black → opening → wake → play
let elapsed = 0;
/* 闭眼/睁眼/醒来这些过渡用挂钟时间驱动，
   即使浏览器把 requestAnimationFrame 节流掉，时长也不会被拖长 */
let stateT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
function setState(s, backSec) {
  state = s;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  stateT0 = now - (backSec || 0) * 1000;
}
function stateSec() {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return (now - stateT0) / 1000;
}
const lidUp = document.querySelector('#eyelids .lid.up');
const lidDown = document.querySelector('#eyelids .lid.down');
const blackout = document.getElementById('blackout');
const contEl = document.getElementById('cont');
const hudEl = document.getElementById('hud');
const lockHintEl = document.getElementById('lockHint');

function setLids(p) {   // p: 0 全开, 1 全闭
  lidUp.style.transform = 'translateY(' + (-100 + 100 * p) + '%)';
  lidDown.style.transform = 'translateY(' + (100 - 100 * p) + '%)';
  blackout.style.opacity = String(Math.max(0, (p - 0.82) / 0.18));
}
setLids(0);

/* 玩家视角 */
const PR = playerRoom.position;
const LIE = { x: -1.35, y: 0.62, z: 0.45, yaw: 0.05, pitch: 0.86 };
const SIT = { x: -1.15, y: 1.06, z: 0.18, yaw: 0.04, pitch: -0.06 };
const pauseMenu = document.getElementById('pauseMenu');
const resumeBtn = document.getElementById('resumeBtn');
const exitBtn = document.getElementById('exitBtn');
const achBtn = document.getElementById('achBtn');
const portraitBtn = document.getElementById('portraitBtn');
const portraitView = document.getElementById('portraitView');
const portraitGrid = document.getElementById('portraitGrid');
const portraitFile = document.getElementById('portraitFile');
const portraitPreview = document.getElementById('portraitPreview');
const portraitCurrentName = document.getElementById('portraitCurrentName');
const portraitFileState = document.getElementById('portraitFileState');
const portraitStatus = document.getElementById('portraitStatus');
const portraitResetBtn = document.getElementById('portraitResetBtn');
const portraitBackBtn = document.getElementById('portraitBackBtn');
const rotatePrompt = document.getElementById('rotatePrompt');
const rotateMenuBtn = document.getElementById('rotateMenuBtn');
const portraitPresets = [
  { id: 'penguin', name: '企鹅形象', src: 'robot_portrait_penguin.png', b64: 'penguin', filter: '' },
  { id: 'none', name: '原始建模', src: '', b64: '', filter: '' }
];
function portraitAssetUrl(path) {
  try { return new URL(path, document.baseURI).href; }
  catch (e) { return path; }
}
const inventorySlots = Array.from(document.querySelectorAll('#inventory .slot'));
const mobileControls = document.getElementById('mobileControls');
const crouchBtn = document.getElementById('crouchBtn');
const moveKeys = { forward: false, back: false, left: false, right: false };
const playerPos = { x: -0.25, z: -0.35 };
const playerColliders = [
  { x0: -2.22, x1: -0.48, z0: -1.68, z1: 0.66 },   // 床
  { x0: -0.72, x1: 0.04, z0: -0.12, z1: 0.66 },    // 床头柜
  { x0: 1.25, x1: 2.55, z0: -2.18, z1: -1.10 },    // 衣柜
  { x0: 0.72, x1: 2.30, z0: 0.66, z1: 1.70 },      // 书桌
  { x0: 0.06, x1: 1.58, z0: -2.24, z1: -1.66 },    // 电视柜
  /* 卫生间隔墙：x=-0.95 那道墙（门洞 z 1.05~1.95 留空），以及 z=0.75 那道实墙 */
  { x0: -1.06, x1: -0.84, z0: 0.64, z1: 1.05 },    // 门洞前段隔墙
  { x0: -1.06, x1: -0.84, z0: 1.95, z1: 2.30 },    // 门洞后段隔墙
  { x0: -2.50, x1: -0.84, z0: 0.64, z1: 0.86 },    // z=0.75 实墙
  /* 卫生间内洁具 */
  { x0: -2.40, x1: -1.80, z0: 1.66, z1: 2.28 },    // 马桶
  { x0: -2.50, x1: -2.10, z0: 0.88, z1: 1.42 },    // 洗手台
  /* 505 室内家具 */
  { x0: 5.30, x1: 6.75, z0: -1.72, z1: 0.32 },     // 505 床（含床单轮廓）
  { x0: 2.90, x1: 4.30, z0: -1.60, z1: -0.90 },    // 倒塌的书架
  { x0: 4.60, x1: 5.40, z0: 1.30, z1: 1.90 },      // 摔落的电视
  { x0: 3.10, x1: 3.60, z0: 0.66, z1: 1.14 }       // 放子弹的小桌
];
/* 楼梯井内的栏板/护栏：各层通用（挡住两条跑道之间，防止一步串到错误标高） */
const stairColliders = [
  /* 4 条跑道之间的栏板：防止一步横穿到相邻跑道（那会一下差 1.45~2.9m 标高）*/
  { x0: -11.82, x1: -7.80, z0: 3.49, z1: 3.51 },   // B1 | B2（碰撞体做薄，给跑道留够宽度）
  { x0: -9.98, x1: -7.80, z0: 4.39, z1: 4.41 },    // B2 | B3
  { x0: -11.82, x1: -7.80, z0: 5.29, z1: 5.31 },   // B3 | B4
  /* 这里原来有一道"入口平台东侧护栏"（x -7.92~-7.80, z 4.10~5.60）。
     它膨胀后挡住 x -8.10~-7.62，而 4F/天台的出口条带要到 x -7.62 才可走 ——
     中间是一段谁都进不去的死区，玩家沿 B3/B4 走到东端就被卡死。
     现在已经不需要它了：入口平台是 lvl 0 专属，B3/B4 的出口条带各自按楼层门禁，
     5F 的玩家根本走不到那两条带上。 */
];
/* 天台障碍物（curLevel===1 时生效）：水塔、机组、外机、机房、管道…… */
const roofColliders = [
  { x0: -5.35, x1: -3.05, z0: -0.55, z1: 1.75 },   // 水塔（含支腿）
  { x0: 0.50, x1: 2.70, z0: -2.10, z1: -0.50 },    // 通风机组
  { x0: -1.90, x1: 3.80, z0: 3.49, z1: 3.91 },     // 空调外机一排
  { x0: 4.40, x1: 6.40, z0: -2.00, z1: -0.20 },    // 电梯机房
  { x0: -8.75, x1: -5.15, z0: -2.00, z1: -1.40 },  // 三个通风竖井
  { x0: -2.40, x1: -1.40, z0: -1.25, z1: -0.55 },  // 放子弹的台子
  /* 楼梯井小屋（penthouse）：必须给出口门洞留缺口，
     否则整块碰撞体会把 B4 出口条带（z 4.85~5.60）堵死，玩家出不了楼梯井 */
  { x0: -12.85, x1: -7.15, z0: 2.35, z1: 5.25 },   // 门洞南侧
  { x0: -12.85, x1: -7.15, z0: 6.25, z1: 6.45 },   // 门洞北侧
  { x0: -12.85, x1: -7.55, z0: 5.25, z1: 6.25 },   // 门洞所在那段：只挡到 -7.55，留出通道
  { x0: -6.15, x1: -5.85, z0: 1.75, z1: 2.05 },    // 立管
  { x0: 3.25, x1: 3.55, z0: 1.75, z1: 2.05 }
];
let lookYaw = 0, lookPitch = 0, pointerLocked = false, pointerLockFailed = false, lookActive = false, menuOpen = false;
let portraitOpen = false;
let crouchHeld = false, crouchAmount = 0, selectedSlot = 0, walkPhase = 0, walkAmount = 0;
let lookTouchId = null, lookTouchX = 0, lookTouchY = 0;
let moveTouchId = null, moveAxisX = 0, moveAxisY = 0, moveAutoSprint = false;
let sprintHeld = false;
const INPUT_MODE_KEY = 'threehalves_input_mode';
let inputMode = 'desktop';
function inferredInputMode() {
  const coarse = !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches);
  const touches = Number(navigator.maxTouchPoints || 0) > 0;
  return coarse || (touches && Math.min(innerWidth, innerHeight) <= 760) ? 'touch' : 'desktop';
}
function isTouchMode() { return inputMode === 'touch'; }
function isPortraitViewport() { return innerHeight > innerWidth; }
function orientationGateActive() {
  return isTouchMode() && document.body.classList.contains('playing') && state === 'play' &&
    !menuOpen && !portraitOpen && !phoneViewOpen && !choiceOpen && !escapeCG;
}
function updateOrientationGate() {
  if (!rotatePrompt) return;
  const show = orientationGateActive() && isPortraitViewport();
  rotatePrompt.classList.toggle('show', show);
  rotatePrompt.setAttribute('aria-hidden', String(!show));
  if (show) clearTransientInput();
}
if (rotateMenuBtn) rotateMenuBtn.addEventListener('click', function () {
  setPauseMenu(true);
  updateOrientationGate();
});
function resetOrientationGateAfterResize() {
  updateOrientationGate();
  if (typeof refreshTouchButtons === 'function') refreshTouchButtons();
}
function applyInputMode(mode, persist) {
  inputMode = mode === 'touch' ? 'touch' : 'desktop';
  if (persist) { try { localStorage.setItem(INPUT_MODE_KEY, inputMode); } catch (e) {} }
  document.documentElement.setAttribute('data-input-mode', inputMode);
  if (typeof mobileControls !== 'undefined' && mobileControls) mobileControls.setAttribute('aria-hidden', String(!isTouchMode()));
  const dt = document.getElementById('deviceTouchBtn'), dd = document.getElementById('deviceDesktopBtn');
  if (dt) dt.classList.toggle('selected', isTouchMode());
  if (dd) dd.classList.toggle('selected', !isTouchMode());
  const hint = document.getElementById('pauseHint');
  if (hint) hint.textContent = isTouchMode() ? '左侧摇杆移动 · 右侧空白区域滑动视角' : '鼠标已释放 · 继续游戏后点击画面重新捕获';
  clearTransientInput();
  if (isTouchMode() && document.pointerLockElement && document.exitPointerLock) {
    lockGraceUntil = Date.now() + 600; document.exitPointerLock();
  }
}
try { inputMode = localStorage.getItem(INPUT_MODE_KEY) || inferredInputMode(); } catch (e) { inputMode = inferredInputMode(); }
document.documentElement.setAttribute('data-input-mode', inputMode);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function releasePointerCaptureSafe(el, id) {
  if (el && id !== null && el.releasePointerCapture) { try { el.releasePointerCapture(id); } catch (e) {} }
}
function clearTransientInput() {
  moveKeys.forward = moveKeys.back = moveKeys.left = moveKeys.right = false;
  moveAxisX = moveAxisY = 0; moveAutoSprint = false;
  sprintHeld = false; lookActive = false;
  if (lookTouchId !== null) releasePointerCaptureSafe(canvas, lookTouchId);
  lookTouchId = null;
  const movePad = document.getElementById('movePad');
  if (moveTouchId !== null) releasePointerCaptureSafe(movePad, moveTouchId);
  moveTouchId = null;
  const stick = document.getElementById('moveStick');
  if (stick) stick.style.transform = 'translate3d(0,0,0)';
  if (movePad) movePad.classList.remove('running');
  document.querySelectorAll('.touchBtn.active').forEach(function (b) { b.classList.remove('active'); });
  if (crouchBtn) crouchBtn.classList.toggle('active', crouchHeld);
}
function clearMoveInput() { clearTransientInput(); }
function selectInventorySlot(index) {
  selectedSlot = clamp(index, 0, 3);
  inventorySlots.forEach(function (slot, i) { slot.classList.toggle('selected', i === selectedSlot); });
  /* 选中即自动拿到右手；已经在左手的物品保持在左手不动（V 换手的结果要保住）。
     未选中的右手物品收回背包，左手的不受影响，所以可以左右手各拿一件。
     子弹这类 NO_HAND 物品不参与上手。 */
  if (typeof equipToHand === 'function') {
    for (let i = 0; i < 4; i++) {
      if (!inv[i]) continue;
      if (inv[i].hand === 'L') continue;                 // 左手的留着
      if (i !== selectedSlot && inv[i].hand === 'R') stowToPack(i);
    }
    const sel = inv[selectedSlot];
    if (sel && sel.hand !== 'L' && !NO_HAND[sel.id]) equipToHand(selectedSlot, 'R');
    refreshInventoryHUD();
  }
}
function requestLookLock() {
  if (state !== 'play' || menuOpen) return;
  if (isTouchMode()) { lookActive = true; return; }
  if (document.pointerLockElement === canvas) {
    pointerLocked = true; lookActive = true; pointerLockFailed = false;
    return;
  }

  /* 桌面端只有真实 Pointer Lock 才能提供不受屏幕边缘限制的相对位移。
     requestPointerLock 失败时不能退回到“隐藏光标 + 普通 mousemove”：那种输入仍会
     被屏幕边缘截断，正是视角转到一半后停住的原因。 */
  lookActive = false;
  pointerLockFailed = false;
  updateMouseLockHint();
  if (!canvas.requestPointerLock) {
    pointerLockFailed = true;
    updateMouseLockHint();
    return;
  }
  try {
    const pr = canvas.requestPointerLock();
    if (pr && typeof pr.catch === 'function') {
      pr.catch(function () {
        /* 自动重锁没有用户激活时会被正常拒绝；只要随后点击画面即可重试。 */
        if (document.pointerLockElement !== canvas) {
          pointerLockFailed = true;
          lookActive = false;
          updateMouseLockHint();
        }
      });
    }
  } catch (e) {
    pointerLockFailed = true;
    lookActive = false;
    updateMouseLockHint();
  }
}
let lockGraceUntil = 0;      // 程序主动解锁后的冷却：这段时间内的 pointerlockchange 不算"玩家想暂停"
let prevFramePlay = false;   // 上一帧是否处于实战状态：用于检测"刚进入实战"，自动锁回鼠标
let pauseStartedAt = 0;
function setPauseMenu(open) {
  const wasPaused = menuOpen;
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  menuOpen = open;
  if (!open && portraitOpen) portraitSetView(false);
  if (open && !wasPaused) pauseStartedAt = now;
  if (!open && wasPaused && pauseStartedAt > 0) {
    const pausedFor = now - pauseStartedAt;
    introT0 += pausedFor;
    stateT0 += pausedFor;
    pauseStartedAt = 0;
  }
  if (open) { lookActive = false; clearMoveInput(); }
  pauseMenu.classList.toggle('show', open);
  pauseMenu.setAttribute('aria-hidden', String(!open));
  updateOrientationGate();
  if (open && document.pointerLockElement === canvas && document.exitPointerLock) {
    lockGraceUntil = Date.now() + 600;
    document.exitPointerLock();
  }
  if (open && achOpen) { setAchView(false); }
}
function exitGame() {
  /* 「重新开始」：整局重来，直接刷新页面 */
  if (SFX.isChainsawOn) SFX.stopChainsaw();
  if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
  location.reload();
}
/* 左键开枪 / 劈砍：手枪或消防斧在手 + 指针锁定时 */
addEventListener('mousedown', guard(function (e) {
  if (e.button !== 0) return;
  if (state !== 'play' || menuOpen || phoneViewOpen) return;
  if (!document.pointerLockElement) return;
  if (itemInHand('pistol')) firePistol();
  else if (itemInHand('axe')) chopSwing();
}, 'mousedown'));

/* ---- 消防斧劈砍：抡斧动画 → 160ms 后命中判定 → 木板掉落 ---- */
function chopSwing() {
  if (axeSwingT > 0) return;                 // 还在抡
  const aimOk = aimTarget && aimTarget.kind === 'barricade';
  if (aimOk && !phoneNewsRead) { say('手机的信息是不是忘记看了...', 2600); return; }   // 不看手机短信不许劈梁
  axeSwingT = 0.42;
  setTimeout(function () {
    if (state !== 'play') return;
    if (!aimOk) return;                      // 没对准封挡，只挥了个空
    SFX.chop();
    lookPitch += (Math.random() - 0.5) * 0.03;      // 震屏
    lookYaw += (Math.random() - 0.5) * 0.02;
    // 火花/木屑加在 scene 下，必须用世界坐标（playerRoom 偏移在 92,0,92）
    spawnSparks(PR.x - 6.55, PR.y + 1.0 + Math.random() * 0.8, PR.z + 3.43, 0x8a6a3e, 14, 2.2);
    barricadeHits++;
    /* 两根梁、三下：① 主梁劈出断口 ② 主梁断成两截倒下 ③ 副梁断倒 */
    if (barricadeHits === 1) {
      const p0 = barricadePlanks[0];
      if (p0) { p0.cracked = true; p0.crackT = 0; }
    } else if (barricadeHits === 2) {
      if (barricadePlanks[0]) barricadePlanks[0].fallen = true;
    } else {
      for (let i = 0; i < barricadePlanks.length; i++) barricadePlanks[i].fallen = true;
    }
    if (barricadeHits >= 3 && !barricadeBroken) {
      barricadeBroken = true;
      /* 上面 else 分支已经把所有梁标成 fallen 了，这里不用再遍历一遍
         （原来这行用的是改写时已删掉的 total 变量 → ReferenceError）*/
      say('梁塌开了——过得去了。', 2200);
      /* 路通了 → 直接进抉择 CG（不再让玩家自己走楼梯） */
      setTimeout(startStairChoice, 900);
    } else if (barricadeHits < 3) {
      say(barricadeHits === 1 ? '劈出了个口子——木头裂了。' : '梁断了！再一下！', 1800);
    }
  }, 160);
}
/* 木板掉落动画：旋转着落到地上散开 */
function updateBarricade(dt) {
  for (let i = 0; i < barricadePlanks.length; i++) {
    const pl = barricadePlanks[i];
    /* 断裂阶段：还没倒，但已经被劈出断口 —— 梁往下沉一点、扭一下，
       给出"再来一下就断"的物理反馈 */
    if (pl.cracked && !pl.fallen) {
      pl.crackT = Math.min(1, (pl.crackT || 0) + dt * 2.2);
      const k = pl.crackT;
      pl.mesh.position.y = pl.homePos.y - 0.09 * k;
      pl.mesh.rotation.z = pl.homeRot.z + 0.14 * k;
      pl.mesh.rotation.x = pl.homeRot.x - 0.06 * k;
      pl.mesh.matrixAutoUpdate = true;
      continue;
    }
    if (!pl.fallen || pl.t >= 1) continue;
    pl.mesh.matrixAutoUpdate = true;        // 静态冻结过的要放开才能动
    pl.t = Math.min(1, pl.t + dt * 1.8);
    const k = pl.t, e = k * k;
    pl.mesh.position.lerpVectors(pl.homePos, pl.landPos, e);
    pl.mesh.rotation.x = pl.homeRot.x + (pl.landRot.x - pl.homeRot.x) * e;
    pl.mesh.rotation.y = pl.landRot.y * e;
    pl.mesh.rotation.z = pl.landRot.z * e;
  }
}
document.addEventListener('pointerlockchange', function () {  const wasLocked = pointerLocked;
  pointerLocked = document.pointerLockElement === canvas;
  document.body.classList.toggle('pointer-locked', pointerLocked);
  if (!isTouchMode()) lookActive = pointerLocked;
  if (pointerLocked) pointerLockFailed = false;
  /* 看手机时是主动放开鼠标（要点消息），不是玩家想暂停——别弹设置菜单。
     暂停菜单只由 ESC 控制。 */
  /* 只有"玩家自己按 Esc 松开鼠标"才弹暂停菜单。
     程序主动解锁（看手机、CG、开菜单、死亡演出）都在冷却窗口内，不算。 */
  if (wasLocked && !pointerLocked && state === 'play' &&
      !menuOpen && !phoneViewOpen && !choiceOpen && !escapeCG &&
      Date.now() > lockGraceUntil) setPauseMenu(true);
  updateMouseLockHint();
});
document.addEventListener('pointerlockerror', function () {
  pointerLocked = false;
  if (!isTouchMode()) lookActive = false;
  document.body.classList.remove('pointer-locked');
  pointerLockFailed = true;
  updateMouseLockHint();
});
/* 实战中鼠标未被锁定时给出明显提示。
   CG / 开场期间游戏会主动 exitPointerLock，回到实战后如果没锁回鼠标，
   视角就完全失灵、鼠标移出窗口即"离开游戏"——这里给出可见的一键恢复路径。 */
function updateMouseLockHint() {
  if (!lockHintEl) return;
  lockHintEl.textContent = pointerLockFailed ? '鼠标锁定失败 · 点击画面重试' : '点击画面 · 锁定鼠标';
  const show = !isTouchMode() && state === 'play' && !menuOpen && !phoneViewOpen &&
    !choiceOpen && !acQte && !document.pointerLockElement;
  lockHintEl.classList.toggle('show', show);
}
canvas.addEventListener('click', function (e) {
  /* CG 抉择期间：鼠标滑动决定朝向，点击确认当前朝向的选项 */
  if (choiceOpen && pointerLocked && document.pointerLockElement === canvas) {
    if (choiceHover < 0) pickStairs(1);        // 朝左看 = 上天台
    else if (choiceHover > 0) pickStairs(-1);   // 朝右看 = 下四楼
    return;
  }
  if (phoneViewOpen) return;
  if (choiceOpen) return;   // 没锁定时让 HTML 按钮自己处理
  requestLookLock(e);
});
canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
const mouseSens = 0.0026;              // 视角灵敏度（可在代码里改这个值，或 window.mouseSens = x 动态调整）
if (!window.mouseSens) window.mouseSens = mouseSens;
function _lookSens() { return (window.mouseSens != null) ? window.mouseSens : mouseSens; }
document.addEventListener('mousemove', function (e) {
  if (state !== 'play' || menuOpen || phoneViewOpen) return;
  /* CG 抉择期间：鼠标滑动控制视角偏向，只做预览高亮，不自动选择（必须点击确认）*/
  if (choiceOpen) {
    if (document.pointerLockElement !== canvas) return;
    choiceLookAccum += e.movementX * 0.003;
    choiceLookAccum = clamp(choiceLookAccum, -0.6, 0.6);
    choiceHover = choiceLookAccum < -0.1 ? -1 : choiceLookAccum > 0.1 ? 1 : 0;
    if (choiceHover === -1) { scEl.classList.add('hl-left'); scEl.classList.remove('hl-right'); }
    else if (choiceHover === 1) { scEl.classList.add('hl-right'); scEl.classList.remove('hl-left'); }
    else { scEl.classList.remove('hl-left', 'hl-right'); }
    return;
  }
  if (document.pointerLockElement !== canvas) return;
  /* 鼠标控制视角 —— 标准 FPS 方向：鼠标往右滑=视角往右转 */
  const s = _lookSens();
  lookYaw -= e.movementX * s;
  lookPitch = clamp(lookPitch - e.movementY * s * 0.81, -1.02, 0.66);
});
canvas.addEventListener('pointerdown', function (e) {
  if (e.pointerType !== 'touch' || state !== 'play' || menuOpen || phoneViewOpen) return;
  /* 抓钩 QTE 期间画面在子弹时间、视角锁死，点屏不应当转视角——
     直接当一次按键处理，和桌面按空格同一条路径。 */
  if (acQte === 3) { if (acQteTap()) return; }
  if (lookTouchId !== null) return;                 // 已有环视触点：第二指不抢
  lookTouchId = e.pointerId; lookTouchX = e.clientX; lookTouchY = e.clientY;
  lookActive = true;
  if (canvas.setPointerCapture) { try { canvas.setPointerCapture(e.pointerId); } catch (err) {} }
  e.preventDefault();
});
canvas.addEventListener('pointermove', function (e) {
  if (e.pointerId !== lookTouchId || state !== 'play' || menuOpen || phoneViewOpen) return;
  lookYaw -= (e.clientX - lookTouchX) * 0.0062;
  lookPitch = clamp(lookPitch - (e.clientY - lookTouchY) * 0.0052, -1.02, 0.66);
  lookTouchX = e.clientX; lookTouchY = e.clientY;
  e.preventDefault();
});
function endTouchLook(e) { if (e.pointerId === lookTouchId) lookTouchId = null; }
canvas.addEventListener('pointerup', endTouchLook);
canvas.addEventListener('pointercancel', endTouchLook);
canvas.addEventListener('lostpointercapture', endTouchLook);

/* ---- 左下模拟摇杆：第一个触点成为 owner，连续输出 moveAxisX/Y；
   推到外圈触发奔跑（带迟滞），仍要满足湿毛巾等剧情规则才能真正跑起来 ---- */
{
  const movePad = document.getElementById('movePad');
  const stick = document.getElementById('moveStick');
  const JOY_R = 74;                       // 底座可视半径（148px 的一半）
  const DEAD = 0.16, ON = 0.82, OFF = 0.72;
  function stickReset() {
    moveAxisX = moveAxisY = 0; moveAutoSprint = false;
    if (stick) stick.style.transform = 'translate3d(0,0,0)';
    movePad.classList.remove('running');
  }
  function stickCenter() { const r = movePad.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  function stickApply(cx, cy) {
    const c = stickCenter();
    let dx = cx - c.x, dy = cy - c.y;
    const d = Math.hypot(dx, dy);
    if (d > JOY_R) { dx = dx / d * JOY_R; dy = dy / d * JOY_R; }
    if (stick) stick.style.transform = 'translate3d(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px,0)';
    const nx = dx / JOY_R, ny = dy / JOY_R;
    const mag = Math.hypot(nx, ny);
    if (mag < DEAD) { moveAxisX = moveAxisY = 0; }
    else {
      const k = Math.min(1, (mag - DEAD) / (1 - DEAD)) / mag;
      moveAxisX = nx * k; moveAxisY = ny * k;
    }
    if (!moveAutoSprint && mag >= ON) moveAutoSprint = true;
    else if (moveAutoSprint && mag < OFF) moveAutoSprint = false;
    movePad.classList.toggle('running', moveAutoSprint);
  }
  movePad.addEventListener('pointerdown', function (e) {
    if (e.pointerType !== 'touch' || moveTouchId !== null) return;
    if (state !== 'play' || menuOpen || phoneViewOpen) return;
    moveTouchId = e.pointerId;
    if (movePad.setPointerCapture) { try { movePad.setPointerCapture(e.pointerId); } catch (err) {} }
    stickApply(e.clientX, e.clientY);
    e.preventDefault(); e.stopPropagation();
  });
  movePad.addEventListener('pointermove', function (e) {
    if (e.pointerId !== moveTouchId) return;
    stickApply(e.clientX, e.clientY);
    e.preventDefault();
  });
  const stickEnd = function (e) {
    if (e.pointerId !== moveTouchId) return;
    moveTouchId = null; stickReset();
    e.preventDefault();
  };
  movePad.addEventListener('pointerup', stickEnd);
  movePad.addEventListener('pointercancel', stickEnd);
  movePad.addEventListener('lostpointercapture', function () { moveTouchId = null; stickReset(); });
}
crouchBtn.addEventListener('pointerdown', function (e) {
  if (state !== 'play' || menuOpen) return;
  crouchHeld = !crouchHeld; crouchBtn.classList.toggle('active', crouchHeld);
  e.preventDefault(); e.stopPropagation();
});

/* ---- 触控动作键：F 拾取 / E 交互 / Q 丢弃 / V 换手 / 手机 / 攻击 / 奔跑 ----
   都走键盘同一条函数路径，行为完全一致 */
function bindTapButton(id, fn, needPlay) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('pointerdown', function (e) {
    e.preventDefault(); e.stopPropagation();
    if (needPlay !== false && (state !== 'play' || menuOpen)) return;
    el.classList.add('active');
    fn();
  });
  const clr = function () { el.classList.remove('active'); };
  el.addEventListener('pointerup', clr);
  el.addEventListener('pointercancel', clr);
}
bindTapButton('pickBtn', function () { if (!phoneViewOpen) tryPickup(); });
bindTapButton('useBtn', function () { if (!phoneViewOpen) tryInteract(); });
bindTapButton('dropBtn', function () { if (!phoneViewOpen) tryDrop(); });
bindTapButton('swapBtn', function () { if (!phoneViewOpen) toggleHand(); });
bindTapButton('phoneBtn', function () { togglePhoneView(); }, false);
bindTapButton('reloadBtn', function () { if (!phoneViewOpen) startReload(); });
/* 攻击键：手枪就开枪，斧头就劈 */
bindTapButton('attackBtn', function () {
  if (phoneViewOpen) return;
  if (itemInHand('pistol')) firePistol();
  else if (itemInHand('axe')) chopSwing();
});
/* 手机奔跑只由摇杆拉到外圈触发；桌面端仍保留 Shift 键。 */
/* 攻击键按需显示：手里有武器时才出现 */
function refreshTouchButtons() {
  const ab = document.getElementById('attackBtn');
  const rb = document.getElementById('reloadBtn');
  if (ab) ab.classList.toggle('hide', !(itemInHand('pistol') || itemInHand('axe') || itemInHand('tools')));
  if (rb) rb.classList.toggle('hide', !itemInHand('pistol'));
}

/* ==================== 机器人形象（当前页面会话） ==================== */
const PORTRAIT_MAX_BYTES = 8 * 1024 * 1024;
let portraitSourceImage = null;
let portraitSourceUrl = '';
let portraitSourceIsObjectUrl = false;
let portraitTextureSerial = 0;
function portraitSetStatus(text, error) {
  if (!portraitStatus) return;
  portraitStatus.textContent = text || '';
  portraitStatus.style.color = error ? '#e07a58' : '';
}
function portraitDisposeTexture() {
  if (robotPortraitMaterial && robotPortraitMaterial.map) {
    robotPortraitMaterial.map.dispose();
    robotPortraitMaterial.map = null;
  }
  robotPortraitTexture = null;
  robotPortraitReady = false;
  if (robotPortraitSprite) robotPortraitSprite.visible = false;
}
function portraitRevokeSource() {
  if (portraitSourceUrl && portraitSourceIsObjectUrl) {
    try { URL.revokeObjectURL(portraitSourceUrl); } catch (e) {}
  }
  portraitSourceUrl = '';
  portraitSourceIsObjectUrl = false;
  portraitSourceImage = null;
}
function portraitCanvasTexture(image, style) {
  const maxSide = 768;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
  cv.height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
  const ctx = cv.getContext('2d');
  if (style === 'mono') ctx.filter = 'grayscale(1) contrast(1.2)';
  else if (style === 'ember') ctx.filter = 'sepia(1) saturate(2.2) hue-rotate(320deg) brightness(.82) contrast(1.15)';
  ctx.drawImage(image, 0, 0, cv.width, cv.height);
  const tx = new THREE.CanvasTexture(cv);
  if (THREE.sRGBEncoding) tx.encoding = THREE.sRGBEncoding;
  tx.needsUpdate = true;
  return tx;
}
function portraitApplyTexture(texture, name, image, sourceUrl) {
  portraitDisposeTexture();
  portraitRevokeSource();
  robotPortraitTexture = texture;
  portraitSourceImage = image || null;
  portraitSourceUrl = sourceUrl || '';
  portraitSourceIsObjectUrl = !!(sourceUrl && sourceUrl.indexOf('blob:') === 0);
  robotPortraitName = name || '默认形象';
  robotPortraitId = portraitSourceIsObjectUrl ? 'upload' : (name === '企鹅形象' ? 'penguin' : 'upload');
  robotPortraitReady = true;
  if (robotPortraitMaterial) {
    robotPortraitMaterial.map = texture;
    robotPortraitMaterial.needsUpdate = true;
  }
  const iw = image && (image.naturalWidth || image.width) || 1;
  const ih = image && (image.naturalHeight || image.height) || 1;
  const aspect = Math.max(0.42, Math.min(1.55, iw / ih));
  if (robotPortraitSprite) robotPortraitSprite.scale.set(1.82 * aspect, 1.82, 1);
  if (portraitPreview) {
    portraitPreview.src = sourceUrl || (portraitPresets[0] && portraitPresets[0].src) || '';
    const preset = portraitPresets.find(function (item) { return item.id === robotPortraitId; });
    portraitPreview.style.filter = preset ? preset.filter : '';
  }
  if (portraitCurrentName) portraitCurrentName.textContent = robotPortraitName;
  if (portraitFileState) portraitFileState.textContent = portraitSourceIsObjectUrl ? '已选择当前页面图片 · 不会上传或保存' : '最大 8MB · 只在本次打开页面内使用';
  portraitSetStatus('已应用：' + robotPortraitName, false);
  portraitGrid && portraitGrid.querySelectorAll('.portraitChoice').forEach(function (el) {
    el.classList.toggle('selected', el.getAttribute('data-portrait') === robotPortraitId);
  });
}
function updateRobotPortraitVisibility() {
  if (!robotPortraitSprite) return;
  /* 开场运镜（cineStage）始终展示完整建模；实战中形象生效时
     隐藏机器人本体、只留电锯——内置形象和上传图片同等对待 */
  const cineStage = (state === 'idle' || state === 'intro' || state === 'await' ||
    state === 'closing' || state === 'black' || state === 'opening' || state === 'wake');
  const active = !!(robotPortraitReady && robot.visible && !cineStage);
  robotPortraitSprite.visible = active;
  if (robotBodyHidden !== active) {
    robotBodyHidden = active;
    for (let i = 0; i < robot.children.length; i++) {
      const child = robot.children[i];
      if (child === chainsaw || child === robotPortraitSprite) continue;
      child.visible = !active;
    }
  }
}
/* “原始建模”占位图：运行时生成一张深色小卡，避免预览框出现破图 */
let _portraitPlaceholderUrl = '';
function portraitPlaceholderUrl() {
  if (_portraitPlaceholderUrl) return _portraitPlaceholderUrl;
  const cv = document.createElement('canvas'); cv.width = 96; cv.height = 120;
  const ctx = cv.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 120);
  g.addColorStop(0, '#151210'); g.addColorStop(1, '#060505');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 96, 120);
  ctx.strokeStyle = 'rgba(216,115,55,.55)'; ctx.strokeRect(4.5, 4.5, 87, 111);
  ctx.fillStyle = '#c8b9a5'; ctx.font = '20px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('原始', 48, 52); ctx.fillText('建模', 48, 78);
  _portraitPlaceholderUrl = cv.toDataURL('image/png');
  return _portraitPlaceholderUrl;
}
/* 切回原始建模：清掉形象纹理，机器人本体在实战中恢复显示 */
function portraitClearToOriginal(name) {
  portraitDisposeTexture();
  portraitRevokeSource();
  robotPortraitReady = false;
  robotPortraitId = 'none';
  robotPortraitName = name || '原始建模';
  if (robotPortraitSprite) robotPortraitSprite.visible = false;
  if (portraitPreview) { portraitPreview.src = portraitPlaceholderUrl(); portraitPreview.style.filter = ''; }
  if (portraitCurrentName) portraitCurrentName.textContent = robotPortraitName;
  if (portraitFileState) portraitFileState.textContent = '最大 8MB · 只在本次打开页面内使用';
  portraitSetStatus('已应用：' + robotPortraitName, false);
  portraitGrid && portraitGrid.querySelectorAll('.portraitChoice').forEach(function (el) {
    el.classList.toggle('selected', el.getAttribute('data-portrait') === robotPortraitId);
  });
}
function portraitLoadPreset(preset) {
  if (!preset || !window.THREE) return;
  if (preset.id === 'none') { portraitClearToOriginal(preset.name); return; }
  portraitSetStatus('正在加载形象…', false);
  const serial = ++portraitTextureSerial;
  /* 首选内嵌 base64：不依赖网络与协议，file:// 直接打开也能加载 */
  const b64 = window.PORTRAIT_B64 && window.PORTRAIT_B64[preset.b64];
  if (b64) {
    const img = new Image();
    img.onload = function () {
      if (serial !== portraitTextureSerial) return;
      portraitApplyTexture(portraitCanvasTexture(img, ''), preset.name, img, '');
    };
    img.onerror = function () {
      if (serial === portraitTextureSerial) portraitSetStatus('内置形象解码失败', true);
    };
    img.src = 'data:image/png;base64,' + b64;
    return;
  }
  /* 兜底：内嵌包缺失时走文件路径（托管 HTTP 下可用） */
  const assetUrl = portraitAssetUrl(preset.src);
  const loader = new THREE.TextureLoader();
  loader.load(assetUrl, function (loaded) {
    if (serial !== portraitTextureSerial) { loaded.dispose(); return; }
    const image = loaded.image;
    const tx = portraitCanvasTexture(image, '');
    loaded.dispose();
    portraitApplyTexture(tx, preset.name, image, '');
  }, undefined, function () {
    if (serial === portraitTextureSerial) {
      portraitSetStatus('内置形象加载失败：' + assetUrl, true);
      if (portraitPreview) portraitPreview.src = assetUrl;
    }
  });
}
function portraitBuildGrid() {
  if (!portraitGrid) return;
  portraitGrid.innerHTML = '';
  portraitPresets.forEach(function (preset) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'portraitChoice'; btn.setAttribute('data-portrait', preset.id);
    btn.setAttribute('aria-label', '选择' + preset.name);
    const img = document.createElement('img');
    img.src = preset.id === 'none' ? portraitPlaceholderUrl() : portraitAssetUrl(preset.src);
    img.alt = preset.name; img.style.filter = preset.filter || '';
    const label = document.createElement('span'); label.textContent = preset.name;
    btn.appendChild(img); btn.appendChild(label); portraitGrid.appendChild(btn);
    btn.classList.toggle('selected', preset.id === robotPortraitId);
    btn.addEventListener('click', function () { portraitLoadPreset(preset); });
  });
}
function portraitSetView(open) {
  portraitOpen = !!open;
  if (!portraitView) return;
  portraitView.classList.toggle('show', portraitOpen);
  portraitView.setAttribute('aria-hidden', String(!portraitOpen));
  if (portraitOpen) {
    portraitBuildGrid();
    if (robotPortraitId === '') portraitLoadPreset(portraitPresets[0]);
  }
  updateOrientationGate();
}
function portraitLoadFile(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png)$/.test(file.type) || !/\.(jpe?g|png)$/i.test(file.name)) {
    portraitSetStatus('只支持 JPG 或 PNG 图片', true); portraitFile.value = ''; return;
  }
  if (file.size > PORTRAIT_MAX_BYTES) {
    portraitSetStatus('图片超过 8MB 限制', true); portraitFile.value = ''; return;
  }
  const url = URL.createObjectURL(file);
  const serial = ++portraitTextureSerial;
  portraitSetStatus('正在读取：' + file.name, false);
  const img = new Image();
  img.onload = function () {
    if (serial !== portraitTextureSerial) { URL.revokeObjectURL(url); return; }
    const tx = portraitCanvasTexture(img, '');
    portraitApplyTexture(tx, file.name, img, url);
  };
  img.onerror = function () { URL.revokeObjectURL(url); if (serial === portraitTextureSerial) portraitSetStatus('图片读取失败', true); };
  img.src = url;
}
if (portraitBtn) portraitBtn.addEventListener('click', function () {
  pauseMenu.classList.remove('show');
  portraitSetView(true);
});
if (portraitBackBtn) portraitBackBtn.addEventListener('click', function () {
  portraitSetView(false);
  pauseMenu.classList.add('show');
});
if (portraitResetBtn) portraitResetBtn.addEventListener('click', function () {
  portraitFile.value = ''; portraitLoadPreset(portraitPresets[0]);
});
if (portraitFile) portraitFile.addEventListener('change', function () { portraitLoadFile(this.files && this.files[0]); });
  if (portraitView) portraitView.addEventListener('click', function (e) {
    if (e.target === portraitView) { portraitSetView(false); pauseMenu.classList.add('show'); }
  });
  portraitLoadPreset(portraitPresets[0]);

inventorySlots.forEach(function (slot, i) {
  slot.addEventListener('click', function (e) { selectInventorySlot(i); e.stopPropagation(); });
});
resumeBtn.addEventListener('click', function () {
  setPauseMenu(false);
  requestLookLock();
});
/* ESC 菜单音量滑条：音效 = 电锯/走路等所有采样与合成音；音乐 = 五楼 BGM 这类 mp3。
   值存 localStorage，SFX.init 时恢复 */
(function () {
  function bindVolSlider(id, apply) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', function () {
      const v = Math.max(0, Math.min(100, parseInt(el.value, 10) || 0));
      try { localStorage.setItem(id, String(v)); } catch (e) {}
      apply(v / 100);
    });
  }
  bindVolSlider('sfxVol', function (v) { if (sfxBus) sfxBus.gain.value = v; });
  bindVolSlider('musVol', function (v) { if (musicBus) musicBus.gain.value = MUSIC_BASE * v; });
})();
exitBtn.addEventListener('click', exitGame);
/* 成就系统：ESC 菜单 → 成就 → 单独界面（右上角登录 + 小字云端同步 + 竖向滚动列表） */
const achView = document.getElementById('achView');
const achLoginBtn = document.getElementById('achLoginBtn');
const achBackBtn = document.getElementById('achBackBtn');
const achSectionsEl = document.getElementById('achSections');
const achCountUnlocked = document.getElementById('achCountUnlocked');
const achCountTotal = document.getElementById('achCountTotal');
const achSyncState = document.getElementById('achSyncState');
const achToast = document.getElementById('achToast');
let achOpen = false;
let achToastBusy = false;
const achToastQueue = [];

/* 所有结局成就未解锁时隐藏名称与说明；额外保留「心急则味散」隐藏成就。 */
const ACHIEVEMENTS = [
  { id: 'end1', type: 'ending', hidden: true, name: '信仰之跃', desc: '从五楼窗口坠下。', secret: '', hint: '???' },
  { id: 'end2', type: 'ending', hidden: true, name: '飞升撤离', desc: '从楼顶登上救援绳梯，成功撤离。', secret: '', hint: '???' },
  { id: 'end3', type: 'ending', hidden: true, name: '摇扇风甚微', desc: '独自驾车冲出车库，活了下来。', secret: '', hint: '???' },
  { id: 'end4', type: 'ending', hidden: true, name: '火焰并不比太阳闪耀', desc: '救出被困的人，和他们一起驾车逃离。', secret: '', hint: '???' },
  { id: 'end5', type: 'ending', hidden: true, name: '差一步美满', desc: '没能钩住下一台空调外机，坠楼身亡。', secret: '', hint: '???' },
  { id: 'end6', type: 'ending', hidden: true, name: '这次不行', desc: '从四楼外墙登上救援梯，成功撤离。', secret: '', hint: '???' },
  { id: 'phone_light', type: 'normal', name: '不再惧怕黑暗', desc: '拿到手机照明。', secret: '' },
  { id: 'tools_path', type: 'normal', name: '不再迷茫', desc: '拿到镰刀与锤子。', secret: '' },
  { id: 'h_black', type: 'hidden', hidden: true, name: '心急则味散', desc: '直接打开车库尽头的卷帘门。', secret: '',
    hint: '???' }
];
const ACH_KEY = 'threehalves_ach';   // localStorage 键

/* ============================================================
   VibeHub 云存档桥接
   ------------------------------------------------------------
   平台规范（sdk/v3）：存档走 vibe.save（玩家自己的数据，本人读写），
   全局排行榜才用 vibe.global，单局元数据用 room.data。成就是玩家级
   永久进度，所以落 vibe.save；同时保留 localStorage 作为离线兜底，
   这样 SDK 加载失败或断网时成就不丢。

   数据形状带版本号，SDK 明确不会自动迁移：
     { v: 2, unlocked: { end1: true, ... } }
   v 升到 2 是因为旧存档是裸的 { id: true } 映射，需要一次字段升级。
   ============================================================ */
const VIBEHUB_WORK = (function () {
  /* Hosted games use /<project-slug>/ as their first path segment. Reading it
     at runtime keeps SDK auth bound to the exact hosted project instead of
     guessing from the title. Local previews deliberately disable cloud auth. */
  const parts = String(location.pathname || '').split('/').filter(Boolean);
  const candidate = parts[0] || '';
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(candidate)
    && candidate !== 'opening.html' && candidate !== 'index.html'
    ? candidate : '';   // Local preview has no trustworthy project slug
})();
const ACH_CLOUD_KEY = 'achievements';  // vibe.save 里的键名
const ACH_SCHEMA_V = 2;

let vibeInst = null;                  // VibeHub.init() 的返回，可能为 null
let vibeUser = null;                  // vibe.login() 返回的 {id, name, image}
let vibeLoading = false;
let vibeAttachPromise = null;
let achCloudDirty = false;            // 本地有改动、还没推到云端
let achCloudState = 'local';          // local | syncing | synced | error

function vibeAvailable() {
  return !!(vibeInst && typeof vibeInst.save === 'object' && vibeInst.save);
}
function achValidSet(obj) {
  const valid = {};
  ACHIEVEMENTS.forEach(function (a) { if (obj && obj[a.id]) valid[a.id] = true; });
  return valid;
}
/* 从云端拉一份成就，和本地合并（云端优先，本地是离线缓存）。
   登录状态变化、打开成就面板时各调一次。 */
async function achSyncFromCloud() {
  if (!vibeAvailable() || !vibeUser) return false;
  achCloudState = 'syncing';
  if (achOpen) renderAchievements();
  try {
    const rec = await vibeInst.save.get(ACH_CLOUD_KEY);
    if (rec) {
      const incoming = achValidSet(rec.unlocked || rec);
      if (Object.keys(incoming).length) achUnlocked = achValidSet(Object.assign({}, achUnlocked, incoming));
      achSave();
    }
    achCloudDirty = false;
    achCloudState = 'synced';
    if (achOpen) renderAchievements();
    return true;
  } catch (e) {
    achCloudState = 'error';
    if (achOpen) renderAchievements();
    console.warn('[VibeHub] 拉取成就失败', e); return false;
  }
}
/* 把当前成就推到云端。解锁时调用；登录/登出时也会各推一次。
   失败静默保留本地副本，下次解锁或登录再试。 */
async function achPushCloud() {
  if (!vibeAvailable() || !vibeUser) return false;
  achCloudState = 'syncing';
  if (achOpen) renderAchievements();
  const payload = { v: ACH_SCHEMA_V, unlocked: achUnlocked };
  try {
    await vibeInst.save.set(ACH_CLOUD_KEY, payload);
    achCloudDirty = false;
    achCloudState = 'synced';
    if (achOpen) renderAchievements();
    return true;
  } catch (e) {
    achCloudDirty = true;
    achCloudState = 'error';
    if (achOpen) renderAchievements();
    console.warn('[VibeHub] 推送成就失败', e); return false;
  }
}
function achLocalLoad() {
  try { achUnlocked = JSON.parse(localStorage.getItem(ACH_KEY) || '{}') || {}; } catch (e) { achUnlocked = {}; }
  achUnlocked = achValidSet(achUnlocked);
  achSave();
}
function achSave() {
  try { localStorage.setItem(ACH_KEY, JSON.stringify(achUnlocked)); } catch (e) {}
  if (vibeUser) achCloudDirty = true;
}
function achUnlockSound() {
  if (!AC || !master) return;
  const t = AC.currentTime;
  /* 两声短促金属提示：清晰但不刺耳，走现有音效总线。 */
  [659.25, 987.77].forEach(function (freq, i) {
    const o = AC.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
    const g = AC.createGain();
    const at = t + i * 0.11;
    g.gain.setValueAtTime(0.001, at);
    g.gain.exponentialRampToValueAtTime(i ? 0.13 : 0.10, at + 0.018);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.32);
    o.connect(g); g.connect(master); o.start(at); o.stop(at + 0.34);
  });
}
function achRunToast() {
  if (achToastBusy || !achToastQueue.length || !achToast) return;
  achToastBusy = true;
  const a = achToastQueue.shift();
  achToast.querySelector('.achToastName').textContent = a.name;
  achToast.querySelector('.achToastDesc').textContent = a.desc;
  achUnlockSound();
  /* 同时设置内联目标值，避免后台标签页或部分内嵌浏览器丢失 class 触发的过渡。 */
  void achToast.offsetWidth;
  achToast.classList.add('show');
  achToast.style.opacity = '1';
  achToast.style.transform = 'translateX(0)';
  setTimeout(function () {
    achToast.classList.remove('show');
    achToast.style.opacity = '0';
    achToast.style.transform = 'translateX(calc(100% + 28px))';
    setTimeout(function () { achToastBusy = false; achRunToast(); }, 420);
  }, 3600);
}
function achQueueToast(a) {
  achToastQueue.push(a);
  achRunToast();
}
function achUnlock(id) {
  const achievement = ACHIEVEMENTS.find(function (a) { return a.id === id; });
  if (!achievement || achUnlocked[id]) return;
  achUnlocked[id] = true;
  achSave();
  /* 网络写入只做后台 best-effort；提示和本地进度先立即完成 */
  achPushCloud();
  achQueueToast(achievement);
  if (achOpen) renderAchievements();
}
function achCounts() {
  let u = 0; for (let i = 0; i < ACHIEVEMENTS.length; i++) if (achUnlocked[ACHIEVEMENTS[i].id]) u++;
  return { u: u, t: ACHIEVEMENTS.length };
}
function renderAchievements() {
  const secs = { ending: [], normal: [], hidden: [] };
  ACHIEVEMENTS.forEach(function (a) { (secs[a.type] || secs.normal).push(a); });
  const secTitles = { ending: '结局', normal: '里程碑', hidden: '隐秘' };
  const unlockedCount = achCounts();
  achCountUnlocked.textContent = String(unlockedCount.u);
  achCountTotal.textContent = String(unlockedCount.t);
  const syncLabel = !vibeUser ? '本地' : (achCloudState === 'syncing' ? '同步中' : achCloudState === 'error' ? '同步失败' : '云端');
  achSyncState.textContent = syncLabel;
  let html = '';
  ['ending', 'normal', 'hidden'].forEach(function (type) {
    const arr = secs[type];
    if (!arr.length) return;
    html += '<div class="achSec"><div class="achSec-h">' + secTitles[type] + '</div>';
    arr.forEach(function (a) {
      const un = !!achUnlocked[a.id];
      const concealed = !!a.hidden && !un;
      let name = a.name, desc = a.desc, lockTxt = '';
      if (concealed) {
        name = '???'; desc = (a.hint || '???'); lockTxt = '未解锁';
      } else if (!un) {
        lockTxt = '未解锁';
      } else {
        lockTxt = a.secret ? ('完成 · ' + a.secret) : '完成';
      }
      html += '<div class="achItem ' + (un ? 'unlocked' : '') + ' ' + (concealed ? 'hidden' : '') + '">' +
        '<div class="achTrophy"><svg viewBox="0 0 24 24"><path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 5H4a3 3 0 0 0 3 4M17 5h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8 21h8M9 17h6"/></svg></div>' +
        '<div class="achBody"><div class="achName">' + name + '</div><div class="achDesc">' + desc + '</div></div>' +
        '<div class="achLock">' + lockTxt + '</div></div>';
    });
    html += '</div>';
  });
  achSectionsEl.innerHTML = html;
}
function setAchView(open) {
  achOpen = open;
  achView.classList.toggle('show', open);
  achView.setAttribute('aria-hidden', String(!open));
  if (open) {
    renderAchievements();
    if (vibeUser) achSyncFromCloud();
  }
}
achBtn.addEventListener('click', function () {
  /* 成就页仍属于暂停状态：只隐藏暂停面板，不解除 menuOpen。 */
  pauseMenu.classList.remove('show');
  pauseMenu.setAttribute('aria-hidden', 'true');
  setAchView(true);
});
achBackBtn.addEventListener('click', function () {
  setAchView(false);
  pauseMenu.classList.add('show');
  pauseMenu.setAttribute('aria-hidden', 'false');
});
achView.addEventListener('wheel', function (e) {
  if (!achOpen) return;
  achSectionsEl.scrollTop += e.deltaY;
  e.preventDefault();
  e.stopPropagation();
}, { passive: false });
/* 登录：走 VibeHub SDK 的内存态授权。SDK 不弹自带登录窗，游戏自己给按钮
   和账号状态；授权成功后主站登录会话还在，通常几乎瞬间完成。
   SDK 不可用（离线、加载失败）时按钮给出明确提示，不影响本地成就。 */
function vibeStatusText() {
  if (!VIBEHUB_WORK) return '本地预览';
  if (vibeLoading) return '授权中…';
  if (vibeUser) return '已登录 · ' + (vibeUser.name || vibeUser.id || '玩家');
  if (!window.VibeHub) return '平台离线';
  return '登录';
}
function refreshAchLoginUI() {
  const txt = vibeStatusText();
  achLoginBtn.disabled = !VIBEHUB_WORK || vibeLoading;
  achLoginBtn.classList.toggle('on', !!vibeUser);
  achLoginBtn.classList.toggle('busy', vibeLoading);
  achLoginBtn.querySelector('.ach-login-text').textContent = txt;
  if (achOpen) renderAchievements();
}
async function vibeEnsureInit() {
  if (!VIBEHUB_WORK) return null;
  if (vibeInst) return vibeInst;
  if (vibeAttachPromise) return vibeAttachPromise;
  vibeAttachPromise = (async function () {
    const api = window.__vibeHubReady ? await window.__vibeHubReady : window.VibeHub;
    if (!api || typeof api.init !== 'function') return null;
    try { vibeInst = await api.init({ work: VIBEHUB_WORK }); }
    catch (e) { console.warn('[VibeHub] init 失败', e); vibeInst = null; }
    return vibeInst;
  })();
  try { return await vibeAttachPromise; }
  finally { vibeAttachPromise = null; }
}
async function vibeDoLogin() {
  if (vibeLoading) return;
  if (vibeUser) { vibeLogout(); return; }
  vibeLoading = true; refreshAchLoginUI();
  try {
    const inst = await vibeEnsureInit();
    if (!inst) { vibeUser = null; }
    else vibeUser = await inst.login();
  } catch (e) { console.warn('[VibeHub] 登录失败', e); vibeUser = null; }
  vibeLoading = false;
  refreshAchLoginUI();
  if (vibeUser) {
    await achSyncFromCloud();
    await achPushCloud();
  } else if (achOpen) renderAchievements();
}
function vibeLogout() {
  if (!vibeInst) { vibeUser = null; refreshAchLoginUI(); return; }
  try { vibeInst.logout(); } catch (e) {}
  vibeUser = null;
  refreshAchLoginUI();
  if (achOpen) renderAchievements();
}
achLoginBtn.addEventListener('click', function () { vibeDoLogin(); });
/* SDK 在 opening.js 之后才到时也能接上；失败自然保持本地成就。 */
if (window.__vibeHubReady) {
  window.__vibeHubReady.then(function () { refreshAchLoginUI(); });
  vibeEnsureInit().then(function (inst) {
    if (!inst || typeof inst.onAuthChange !== 'function') { refreshAchLoginUI(); return; }
    inst.onAuthChange(function (user) {
      vibeUser = user || null;
      achCloudState = vibeUser ? 'syncing' : 'local';
      refreshAchLoginUI();
      if (user) achSyncFromCloud().then(function () { return achPushCloud(); });
    });
    /* init() may have restored a hash token before the listener was attached. */
    if (inst.isLoggedIn && inst.isLoggedIn()) {
      vibeUser = inst.user || null;
      achCloudState = vibeUser ? 'syncing' : 'local';
      refreshAchLoginUI();
      if (vibeUser) {
        achSyncFromCloud().then(function () { return achPushCloud(); });
      }
    }
  });
} else if (window.VibeHub && typeof window.VibeHub.init === 'function') {
  vibeEnsureInit().then(function (inst) {
    if (!inst || typeof inst.onAuthChange !== 'function') { refreshAchLoginUI(); return; }
    inst.onAuthChange(function (user) {
      vibeUser = user || null;
      refreshAchLoginUI();
      if (user) achSyncFromCloud();
    });
  });
}
/* ESC 菜单中的设备选择：手动覆盖自动推断，存 localStorage 持续生效 */
(function () {
  function bindDeviceChoice(mode) {
    const btn = document.getElementById(mode === 'touch' ? 'deviceTouchBtn' : 'deviceDesktopBtn');
    if (!btn) return;
    btn.addEventListener('click', function () { applyInputMode(mode, true); });
  }
  bindDeviceChoice('touch');
  bindDeviceChoice('desktop');
  applyInputMode(inputMode, false);
})();
document.addEventListener('keydown', function (e) {
  if (e.code === 'Escape' && achOpen) {
    e.preventDefault();
    e.stopImmediatePropagation();
    setAchView(false);
    pauseMenu.classList.add('show');
    pauseMenu.setAttribute('aria-hidden', 'false');
  }
}, true);
/* 手机端右上角设置按钮：呼出/收起暂停菜单 */
bindTapButton('menuBtn', function () {
  if (state !== 'play') return;
  setPauseMenu(!menuOpen);
}, false);

/* 可行走区域（playerRoom 局部坐标）：卧室 + 门洞 + 5F 走廊。
   原来是把玩家硬钳在卧室盒子里，现在改成「在任一区域内即可」，
   出门才能真的走到走廊上。 */
const walkAreas = [
  { x0: -2.38, x1: 2.38, z0: -2.08, z1: 2.18 },    // 卧室（含卫生间，靠隔墙碰撞体限制）
  /* 门洞：z 范围要和「房间」「走廊」都有足够重叠（各 ~0.2m），
     否则斜着穿门时 x/z 分轴判定会在两块区域的缝隙上卡住脚 */
  { x0: -0.52, x1: 0.52, z0: 1.98, z1: 2.74 },     // 503 门洞
  { x0: -6.80, x1: 6.80, z0: 2.58, z1: 4.32 },     // 5F 走廊
  { x0: 2.76, x1: 6.94, z0: -2.08, z1: 2.18 },     // 505 室内
  { x0: 3.88, x1: 4.92, z0: 1.98, z1: 2.74 },      // 505 门洞（被撕开的那扇）
  /* 楼梯井（劈开废料才进得去）：入口平台 + 4 条跑道 + 2 个转角平台。
     lvl:'any' —— 楼梯井是各层共用的竖向通道 */
  /* 入口平台只属于 5F —— 标成 'any' 会让天台/4F 的玩家走进井里的 B1/B2，
     那两条带的绝对台阶高度和当前楼层标高差 3 米，一步就是瞬移 */
  { x0: -7.86, x1: -6.60, z0: 2.60, z1: 4.40 },               // 入口平台（B1+B2，5F）
  { x0: -11.82, x1: -7.80, z0: 2.60, z1: 3.50, lvl: 'any' },  // B1 上行U1（往西上）
  { x0: -9.98, x1: -7.80, z0: 3.50, z1: 4.40, lvl: 'any' },   // B2 下行D1（往西下）
  { x0: -9.98, x1: -7.80, z0: 4.40, z1: 5.30, lvl: 'any' },   // B3 下行D2（往东下→4F）
  { x0: -11.82, x1: -7.80, z0: 5.30, z1: 6.20, lvl: 'any' },  // B4 上行U2（往东上→天台）
  { x0: -10.90, x1: -9.90, z0: 3.50, z1: 5.30, lvl: 'any' },  // 下行转角平台（B2↔B3）
  { x0: -12.74, x1: -11.74, z0: 2.60, z1: 6.20, lvl: 'any' }, // 上行转角平台（B1↔B4）
  { x0: -7.86, x1: -6.60, z0: 4.40, z1: 5.30, lvl: -1 },      // 4F 出口条带（只在 4F 可走）
  { x0: -7.86, x1: -6.60, z0: 5.30, z1: 6.20, lvl: 1 },       // 天台出口条带（只在天台可走）
  /* 天台 / 四楼走廊：平面范围与 5F 重叠，必须按楼层过滤，
     否则在 5F 就能靠天台那块巨大的可行走区穿墙 */
  { x0: -12.6, x1: 11.1, z0: -2.6, z1: 6.3, lvl: 1 },      // 天台屋面（含楼梯井出口那一侧）
  { x0: -6.80, x1: 6.80, z0: 2.58, z1: 4.32, lvl: -1 },    // 四楼走廊
  { x0: 1.95, x1: 6.85, z0: -2.2, z1: 2.2, lvl: -1 },      // 405 房间（四楼）
  { x0: 3.95, x1: 4.85, z0: 2.0, z1: 2.75, lvl: -1 },       // 405 门洞过渡带（跨过走廊墙）
  /* 一楼大堂（lvl -2，滑绳下来才到） */
  { x0: -7.7, x1: 8.9, z0: 2.55, z1: 9.15, lvl: -2 },      // 一楼大堂
  { x0: -7.55, x1: -6.45, z0: 4.85, z1: 8.35, lvl: -2 },   // 地下车库楼梯与平台
  { x0: -8.0, x1: 9.0, z0: 8.45, z1: 22.2, lvl: -2 }       // 地下车库（爬过卷帘门小口进入）
];
/* 405 房间内的碰撞体（世界坐标；房间局部原点在 (4.4, -2.90, 0)） */
const lvl4RoomColliders = [
  { x0: 2.26, x1: 3.84, z0: -1.54, z1: 0.54 },   // 床（局部 -1.35,-0.5 → 世界 3.05,-0.5）
  { x0: 3.77, x1: 4.35, z0: 0.02, z1: 0.50 },    // 床头柜
  { x0: 1.80, x1: 3.45, z0: 0.64, z1: 0.86 },    // 卫生间隔墙 z=0.75 实墙
  { x0: 3.38, x1: 3.52, z0: 0.75, z1: 1.05 },    // 隔墙 x=-0.95 前段
  { x0: 3.38, x1: 3.52, z0: 1.95, z1: 2.30 },    // 隔墙 x=-0.95 后段
  { x0: 3.34, x1: 3.56, z0: 1.00, z1: 2.00 }     // 关死的浴室木门（整段封住）
];
function playerBlocked(x, z) {
  const r = 0.14;   // 玩家碰撞半径。楼梯跑道只有 0.75m 宽，0.18 太肥会处处磨墙
  let inside = false;
  for (let i = 0; i < walkAreas.length; i++) {
    const a = walkAreas[i];
    /* 按楼层过滤：不写 lvl 的默认只属于 5F；'any' 是各层共用（楼梯井） */
    if (a.lvl === undefined) { if (curLevel !== 0) continue; }
    else if (a.lvl !== 'any' && a.lvl !== curLevel) continue;
    if (x > a.x0 && x < a.x1 && z > a.z0 && z < a.z1) { inside = true; break; }
  }
  if (!inside) return true;
  /* 家具/隔墙碰撞体只在 5F 有效（4F 内部与天台障碍物之后单独加） */
  if (curLevel === 0) {
    for (let i = 0; i < playerColliders.length; i++) {
      const b = playerColliders[i];
      if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
    }
  }
  /* 以下都是 5F 专有的门/封路规则 */
  if (curLevel === 0) {
    /* 关着的门挡住门洞；开到一定角度才放行（503 的门，505 没有门） */
    if (doorAngle > -0.9 && x > -0.55 && x < 0.55 && z > 2.16 && z < 2.52) return true;
    /* 走廊左端：塌落的废料堵着楼梯口。劈开后放行进楼梯井 */
    if (!barricadeBroken && z > 2.58 && x < -5.4) return true;
  }
  /* 天台障碍物 */
  if (curLevel === 1) {
    for (let i = 0; i < roofColliders.length; i++) {
      const b = roofColliders[i];
      if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
    }
  }
  /* 四楼：木梁封住楼梯口，玩家不能走回井道/触碰机器人 */
  if (curLevel === -1 && lvl4Barred && x < -6.0) return true;
  /* 四楼 405 房间内的家具/隔墙碰撞（世界坐标 = 房间局部 + (4.4, FY, 0)） */
  if (curLevel === -1) {
    for (let i = 0; i < lvl4RoomColliders.length; i++) {
      const b = lvl4RoomColliders[i];
      if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
    }
  }
  /* 一楼：大堂家具/保安亭墙体碰撞 + 侧门未开时封住门洞 */
  if (curLevel === -2) {
    for (let i = 0; i < lvl1Colliders.length; i++) {
      const b = lvl1Colliders[i];
      if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
    }
    if (inGarage) {
      if (z < 8.42) return true;   // 车库北墙（爬进来后回不去）
    } else {
      if (x > 9.05 - r && x < 9.45 + r && z > 5.45 && z < 6.75) return true;   // 侧门只能看不能出
    }
  }
  /* 楼梯井里的栏板/护栏（各层通用，防止串到错误标高） */
  for (let i = 0; i < stairColliders.length; i++) {
    const b = stairColliders[i];
    if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
  }
  return false;
}
function updatePlayerMovement(dt) {
  if (acQte) { updateAcQte(dt); return; }
  if (acClimbMode) { updateAcClimb(dt); return; }
  const targetCrouch = crouchHeld ? 1 : 0;
  crouchAmount += (targetCrouch - crouchAmount) * Math.min(1, dt * 10);
  if (state !== 'play' || menuOpen || phoneViewOpen || choiceOpen) {
    walkAmount += (0 - walkAmount) * Math.min(1, dt * 10);
    updateStamina(dt, false); isSprinting = false;
    return;
  }

  let forward = (moveKeys.forward ? 1 : 0) - (moveKeys.back ? 1 : 0) - moveAxisY;
  let strafe = (moveKeys.right ? 1 : 0) - (moveKeys.left ? 1 : 0) + moveAxisX;
  const len = Math.hypot(forward, strafe);
  if (len > 1) { forward /= len; strafe /= len; }
  const moving = len > 0.01;
  // 奔跑：需要手上拿着湿毛巾（捂口鼻才敢在烟里跑）；摇杆推满外圈同样请求奔跑
  isSprinting = updateStamina(dt, moving, moveAutoSprint);
  const yaw = SIT.yaw + lookYaw;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const sprintMul = isSprinting ? 1.85 : 1.0;
  const speed = (1.65 - crouchAmount * 0.72) * sprintMul * dt;
  const dx = (fx * forward + rx * strafe) * speed;
  const dz = (fz * forward + rz * strafe) * speed;
  if (!playerBlocked(playerPos.x + dx, playerPos.z)) playerPos.x += dx;
  if (!playerBlocked(playerPos.x, playerPos.z + dz)) playerPos.z += dz;
  walkAmount += ((moving ? 1 : 0) - walkAmount) * Math.min(1, dt * 12);
  if (moving) {
    const prev = walkPhase;
    walkPhase += dt * (crouchHeld ? 6.5 : (isSprinting ? 14.5 : 9.5));
    /* 每半个周期（π）落一次脚：跨过 π 的整数倍就播一声 */
    if (Math.floor(walkPhase / Math.PI) !== Math.floor(prev / Math.PI)) {
      if (!crouchHeld || Math.random() < 0.5) SFX.step(isSprinting);
    }
  }
}

/* ==================== [11b] 物品 · 持物 · 体力 ====================
   F 拾取 / E 交互 / Q 丢弃 / V 换手（左右手）
   物品占背包栏位；拿在手上时栏位右下角出现简笔画手（左手正常，右手镜像）
   ================================================================ */
const promptEl = document.getElementById('prompt');
const staminaEl = document.getElementById('stamina');
const staminaFill = staminaEl.querySelector('.fill');

/* 世界里可拾取的物体登记表 */
const worldItems = [];      // { id, name, obj, held, homePos, homeRot }
function registerItem(obj, heldObj) {
  if (!obj || !obj.userData.pickup) return;
  worldItems.push({
    id: obj.userData.pickup.id,
    name: obj.userData.pickup.name,
    obj: obj,
    held: heldObj || null,      // 手里用的专用模型（没有就直接搬世界那个）
    homeParent: obj.parent,     // 原父节点（手枪在衣柜里，不是房间根节点）
    homePos: obj.position.clone(),
    homeRot: obj.rotation.clone()
  });
}

/* 手里的湿毛巾：挂在架子上那块薄片贴到镜头前会变成一块长板，
   手里这条是「对折搭在手上」的造型 —— 一条，不是一团 */
function makeHeldTowel() {
  const g = new THREE.Group();
  const cloth = M(0x33454e, { r: 0.6, m: 0.05 });
  const clothDark = M(0x26343b, { r: 0.68, m: 0.04 });
  // 搭在手上的主体：一条长方形毛巾，略微下垂
  const main = new THREE.Mesh(new THREE.BoxGeometry(0.20, 0.028, 0.085), cloth);
  g.add(main);
  // 前后各垂下一片，形成对折搭挂的样子
  const f1 = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.115, 0.02), cloth);
  f1.position.set(-0.004, -0.068, 0.036); f1.rotation.x = 0.13; g.add(f1);
  const f2 = new THREE.Mesh(new THREE.BoxGeometry(0.185, 0.085, 0.02), clothDark);
  f2.position.set(0.006, -0.052, -0.034); f2.rotation.x = -0.1; g.add(f2);
  // 两道横向织纹，低多边形也能读出是布
  for (const ty of [-0.03, -0.085]) {
    const s = new THREE.Mesh(new THREE.BoxGeometry(0.192, 0.008, 0.026), clothDark);
    s.position.set(0, ty, 0.038); g.add(s);
  }
  // 末端的一角翘起，暗示是软的
  const corner = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.075, 0.018), cloth);
  corner.position.set(0.082, -0.115, 0.03); corner.rotation.z = 0.42; g.add(corner);
  g.visible = false;
  return g;
}
const towelHeldObj = makeHeldTowel();

/* 每件物品能否用左手握持。拾取默认进右手，V 键才换到左手。 */
const ITEM_LEFT_OK = { towel: true, phone: true, pistol: false, axe: false, tools: false };
/* 不拿在手里的物品（子弹这类消耗品）：拾取只进背包，V 对它无效 */
const NO_HAND = { bullets: true, key: true };
/* 可叠加物品：一次拾取的默认数量（世界模型上可以用 rec.count 覆盖） */
const STACKABLE = { bullets: 2 };

registerItem(phoneObj);
registerItem(towelObj, towelHeldObj);
registerItem(pistolObj);
registerItem(bulletsObj);
registerItem(axeObj);
registerItem(toolsObj, toolsHeldObj);
registerItem(keyObj);          // 一楼保安亭：侧门钥匙
registerItem(bullets1Obj);     // 一楼保安亭：两发子弹

/* 背包：4 格，每格 null 或 { id, name, hand:null|'L'|'R' } */
const inv = [null, null, null, null];
function invFind(id) { for (let i = 0; i < 4; i++) if (inv[i] && inv[i].id === id) return i; return -1; }
function invFirstFree() { for (let i = 0; i < 4; i++) if (!inv[i]) return i; return -1; }
function itemInHand(id) { const i = invFind(id); return i >= 0 && inv[i].hand; }
function anyHeld() { for (let i = 0; i < 4; i++) if (inv[i] && inv[i].hand) return inv[i]; return null; }

/* 手上的模型：从世界里搬到 camera 下面当第一人称持物 */
const handRig = new THREE.Group();      // 挂在相机下，随视角走
cam.add(handRig);
/* 关键：渲染器只遍历 scene 图，相机不在场景里时挂在相机下的子物体和灯光都不会生效 */
scene.add(cam);
const HAND_POSE = {
  // 右手在右下、左手在左下；手机竖握屏幕朝脸，毛巾攥成一团
  // 注意：towelObj 的布料是从原点往下垂的（挂杆造型），所以持握时 y 要往上抬，
  // 否则布料整体掉到画面外
  phone: {
    R: { p: [0.155, -0.145, -0.40], r: [-0.26, -0.30, 0.05], s: 1 },
    L: { p: [-0.155, -0.145, -0.40], r: [-0.26, 0.30, -0.05], s: 1 }
  },
  towel: {
    R: { p: [0.20, -0.155, -0.40], r: [0.18, -0.42, 0.10], s: 1 },
    L: { p: [-0.20, -0.155, -0.40], r: [0.18, 0.42, -0.10], s: 1 }
  },
  pistol: {
    // 双持不了，只做右手；枪口朝前下压一点，像随手垂握
    R: { p: [0.17, -0.19, -0.38], r: [0.14, -1.62, 0.06], s: 1 },
    L: { p: [-0.17, -0.19, -0.38], r: [0.14, -1.52, -0.06], s: 1 }
  },
  axe: {   /* 双手抡斧：柄近乎竖直握在身前偏右，斧刃朝前。
              模型局部：柄沿 +Y、刃沿 +Z 伸出，所以绕 Y 转 180° 让刃对准视线方向 */
    R: { p: [0.15, -0.32, -0.5], r: [0.34, Math.PI, -0.34], s: 1 },
    L: { p: [-0.15, -0.32, -0.5], r: [0.34, Math.PI, 0.34], s: 1 }
  },
  tools: { /* 镰刀与锤子：只能双手抱持 —— 专用模型内部已经分好
              左手镰刀（刀刃朝前）/ 右手锤子 的位置，挂载点直接居中即可 */
    R: { p: [0, 0, 0], r: [0, 0, 0], s: 1 }
  }
};
let phoneLight = null;      // 手机手电（SpotLight）
function ensurePhoneLight() {
  if (phoneLight) return;
  phoneLight = new THREE.SpotLight(0xd8ecff, 0, 7.0, 0.62, 0.55, 1.6);
  phoneLight.position.set(0, 0, 0);
  phoneLight.target.position.set(0, 0, -3);
  cam.add(phoneLight); cam.add(phoneLight.target);
}

/* 把某个物品放到手上 / 收回世界 */
function attachToHand(rec, hand) {
  const pose = HAND_POSE[rec.id] && HAND_POSE[rec.id][hand];
  if (!pose) return;
  const m = rec.held || rec.obj;     // 有专用持握模型就用它
  if (rec.held) rec.obj.visible = false;   // 世界里那份藏起来
  m.visible = true;
  handRig.add(m);
  m.position.set(pose.p[0], pose.p[1], pose.p[2]);
  m.rotation.set(pose.r[0], pose.r[1], pose.r[2]);
  m.scale.setScalar(pose.s);
  if (rec.id === 'phone') {
    ensurePhoneLight();
    if (phoneScreenMat) phoneScreenMat.emissiveIntensity = 1.5;   // 屏幕亮起来
  }
}
function detachFromHand(rec) {
  const m = rec.held || rec.obj;
  if (m.parent === handRig) handRig.remove(m);
  if (rec.held) { rec.held.visible = false; }
  (rec.homeParent || playerRoom).add(rec.obj);
  rec.obj.position.copy(rec.homePos);
  rec.obj.rotation.copy(rec.homeRot);
  rec.obj.scale.setScalar(1);
  if (rec.id === 'phone' && phoneScreenMat) phoneScreenMat.emissiveIntensity = 0.85;
}
function recOf(id) { for (let i = 0; i < worldItems.length; i++) if (worldItems[i].id === id) return worldItems[i]; return null; }

/* HUD 刷新 */
/* ---- 物品栏贴图：每种物品一张 SVG 线稿 ---- */
const ITEM_ICON = {
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M10.5 4.6h3"/><path d="M11 19.3h2"/></svg>',
  towel: '<svg viewBox="0 0 24 24"><path d="M3.5 7h17"/><path d="M4.5 7c0 4-1 5.5-1 8.5 0 2.4 1.6 3.5 4 3.5h9c2.4 0 4-1.1 4-3.5 0-3-1-4.5-1-8.5"/><path d="M8 11h8M8 14.5h8"/></svg>',
  pistol: '<svg viewBox="0 0 24 24"><path d="M2.5 8.5h17.5v3.5H12l-1 2"/><path d="M11 14l-2.5 6.5H5.5l2-6.5"/><path d="M7.5 12v2"/><path d="M17 8.5v-1.2"/></svg>',
  bullets: '<svg viewBox="0 0 24 24"><path d="M8 20V9.5c0-2 1-3.2 2-4.6 1 1.4 2 2.6 2 4.6V20z" transform="translate(-2 0)"/><path d="M6 14.5h4"/><path d="M14 20V9.5c0-2 1-3.2 2-4.6 1 1.4 2 2.6 2 4.6V20z" transform="translate(-0.5 0)"/><path d="M13.5 14.5h4"/></svg>',
  axe: '<svg viewBox="0 0 24 24"><path d="M9 21.5 14.5 6"/><path d="M12.5 8.5c1.5-3.5 4.5-5 7.5-4.5 1 2.8-.4 6-3.4 7.6-1.5.8-3 .6-4.1-.6"/><path d="M8.2 20.8l2.1.7"/></svg>',
tools: '<svg viewBox="0 0 24 24"><path d="M2.2 21 5.2 18"/><path d="M5.1 18.3A10.5 10.5 0 0 0 19.3 3.9"/><path d="M6.3 6.3 20.3 20.3"/><path d="M8.7 3.8 6.6 1.7 1.7 6.6 3.8 8.7Z"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="7" cy="7" r="3.4"/><path d="M9.4 9.4 20 20"/><path d="M16.6 16.6l2.8-2.8"/><path d="M13.6 13.6l2.4-2.4"/></svg>'
};
function buildInventoryIcons() {
  inventorySlots.forEach(function (slot) {
    if (slot.querySelector('.ico')) return;
    const ico = document.createElement('span'); ico.className = 'ico';
    const cnt = document.createElement('span'); cnt.className = 'cnt';
    slot.insertBefore(ico, slot.querySelector('.nm'));
    slot.appendChild(cnt);
  });
}
buildInventoryIcons();

/* 双手物品（消防斧 / 镰刀与锤子）是否正拿在手上 */
function twoHandedHeld() {
  const a = invFind('axe');
  if (a >= 0 && inv[a].hand) return true;
  const t = invFind('tools');
  if (t >= 0 && inv[t].hand) return true;
  return false;
}
/* 双手物品在手时：另一只手的物品【保留握持状态】，只隐藏模型、取消效果
   （毛巾冲刺 / 手机手电在各自逻辑里按 twoHandedHeld 判定）；
   换回单手物品时这里自动恢复显示。 */
function refreshHandVisibility() {
  const suppressed = twoHandedHeld();
  for (let i = 0; i < 4; i++) {
    const it = inv[i];
    if (!it || !it.hand) continue;
    if (it.id === 'axe' || it.id === 'tools') continue;   // 双手物品自己正常显示
    const rec = recOf(it.id);
    if (!rec) continue;
    const m = rec.held || rec.obj;
    if (m.parent !== handRig) continue;                   // 不在手上的不管
    m.visible = !suppressed;
  }
}

function refreshInventoryHUD() {
  for (let i = 0; i < 4; i++) {
    const slot = inventorySlots[i], it = inv[i];
    slot.classList.toggle('filled', !!it);
    slot.classList.remove('inhand-l', 'inhand-r');
    if (it && it.hand === 'L') slot.classList.add('inhand-l');
    if (it && it.hand === 'R') slot.classList.add('inhand-r');
    const nm = slot.querySelector('.nm');
    if (nm) nm.textContent = it ? it.name : '';
    /* 贴图 + 数量角标 */
    const ico = slot.querySelector('.ico');
    if (ico) ico.innerHTML = (it && ITEM_ICON[it.id]) ? ITEM_ICON[it.id] : '';
    const cnt = slot.querySelector('.cnt');
    const isStack = !!(it && STACKABLE[it.id]);
    slot.classList.toggle('stack', isStack);
    if (cnt) cnt.textContent = isStack ? String(it.count || 0) : '';
    /* 手枪：名字后面挂弹药状态（膛+匣，套筒后定时显示 ! ） */
    if (nm && it && it.id === 'pistol') {
      nm.textContent = '手枪 ' + (slideLocked ? '!' : (chambered ? '●' : '○')) + magLoaded;
    }
    slot.setAttribute('aria-label', '物品栏 ' + (i + 1) + (it
      ? ('，' + it.name + (it.hand ? (it.hand === 'L' ? '，左手持握' : '，右手持握') : ''))
      : '，空'));
  }
  // 体力条：拿到湿毛巾并握在手上才显示
  const towelHeld = itemInHand('towel');
  staminaEl.classList.toggle('show', !!towelHeld);
  refreshHandVisibility();   // 双手物品在手时隐藏另一只手的持物模型（状态保留）
  if (typeof refreshTouchButtons === 'function') refreshTouchButtons();   // 触控攻击/奔跑键跟着变
}

/* ---- 拾取 / 丢弃 / 自动上手 ---- */
/* 交互范围：必须在 REACH 米内、且视线基本对着它（点积阈值）才认 */
const REACH = 1.9;
const FACE_DOT = 0.92;

function equipToHand(slotIdx, hand) {
  const it = inv[slotIdx];
  if (!it) return;
  const rec = recOf(it.id);
  if (!rec) return;
  hand = hand || 'R';
  if (hand === 'L' && !ITEM_LEFT_OK[it.id]) hand = 'R';
  if (it.hand === hand) return;
  // 同一只手上原来那件收回背包
  for (let i = 0; i < 4; i++) {
    if (i !== slotIdx && inv[i] && inv[i].hand === hand) stowToPack(i);
  }
  it.hand = hand;
  attachToHand(rec, hand);
  refreshInventoryHUD();
}
function handSlot(hand) {
  for (let i = 0; i < 4; i++) if (inv[i] && inv[i].hand === hand) return i;
  return -1;
}
/* V 键换手——真交换：
   两手都有东西 → 两件物品互换手（谁也不收回背包）；
   只有一只手有 → 换到另一只空手；
   不在手上 → 拿到空着的手（优先右手）。
   物品栏的左右手标签由 refreshInventoryHUD 按 inv[i].hand 自动刷新。 */
function toggleHand() {
  const si = selectedSlot;
  const it = inv[si];
  if (!it) return;
  const rec = recOf(it.id);
  if (!rec) return;
  if (NO_HAND[it.id]) { say('这不是拿在手里的东西。', 1400); return; }
  if (magInHand) { say('（手上正忙着压弹。）', 1400); return; }
  if (it.id === 'axe') { say('消防斧得两只手抡，换不了手。', 1600); return; }
  if (it.id === 'tools') { say('镰刀与锤子得两只手抱着，换不了手。', 1600); return; }

  const ls = handSlot('L'), rs = handSlot('R');
  {   // 另一只手是斧头/镰刀锤子时，任何东西都不能和它换（双手家伙只认右手）
    const oi = it.hand === 'R' ? inv[ls] : inv[rs];
    if (oi && (oi.id === 'axe' || oi.id === 'tools')) { say('这只手得留给它。', 1600); return; }
  }
  if (!it.hand) {
    // 不在手上：拿到空着的手
    if (rs < 0) equipToHand(si, 'R');
    else if (ls < 0 && ITEM_LEFT_OK[it.id]) equipToHand(si, 'L');
    else say('两只手都占着。', 1400);
    return;
  }
  const otherSlot = it.hand === 'R' ? ls : rs;
  if (otherSlot < 0) {
    // 另一只手是空的：直接换过去
    const target = it.hand === 'R' ? 'L' : 'R';
    if (target === 'L' && !ITEM_LEFT_OK[it.id]) { say('这个只能用右手拿。', 1400); return; }
    equipToHand(si, target);
    return;
  }
  // 两手都有东西：真交换。先检查两件各自要去的手是否允许
  const other = inv[otherSlot];
  const myNew = it.hand === 'R' ? 'L' : 'R';
  const otherNew = it.hand;
  if (myNew === 'L' && !ITEM_LEFT_OK[it.id]) { say('这个只能用右手拿，换不了。', 1600); return; }
  if (otherNew === 'L' && !ITEM_LEFT_OK[other.id]) { say(other.name + '不能用左手拿，换不了。', 1600); return; }
  const recOther = recOf(other.id);
  const m1 = rec.held || rec.obj, m2 = recOther.held || recOther.obj;
  if (m1.parent === handRig) handRig.remove(m1);
  if (m2.parent === handRig) handRig.remove(m2);
  it.hand = myNew; other.hand = otherNew;
  attachToHand(rec, myNew);
  attachToHand(recOther, otherNew);
  refreshInventoryHUD();
}
function stowToPack(slotIdx) {
  const it = inv[slotIdx];
  if (!it || !it.hand) return;
  const rec = recOf(it.id);
  if (rec) {
    const m = rec.held || rec.obj;
    if (m.parent === handRig) handRig.remove(m);
    m.visible = false;
    rec.obj.visible = false;
  }
  it.hand = null;
  if (it.id === 'phone' && phoneLight) phoneLight.intensity = 0;
}

function tryPickup() {
  const tgt = aimTarget;
  if (!tgt || tgt.kind !== 'item') return;
  const rec = tgt.rec;
  // 可叠加物品（子弹）：并进已有的一格。真消耗品——地上那堆有多少就拿多少
  if (STACKABLE[rec.id]) {
    const ex = invFind(rec.id);
    const amount = (rec.count === undefined || rec.count === null) ? STACKABLE[rec.id] : rec.count;
    if (amount <= 0) { say('空盒子。', 1500); return; }
    if (ex >= 0) inv[ex].count = (inv[ex].count || 1) + amount;
    else {
      const slotIdx = invFirstFree();
      if (slotIdx < 0) { say('背包满了。', 1400); return; }
      inv[slotIdx] = { id: rec.id, name: rec.name, hand: null, count: amount };
    }
    // 世界里的这份收掉，数量归零（再捡不到东西）
    rec.count = 0;
    rec.obj.visible = false;
    if (rec.held) rec.held.visible = false;
    rec.phys = null; rec.dropped = false;
    if (rec.id === 'bullets') say(amount + ' 发 9mm。省着点用。', 2400);
    refreshInventoryHUD();
    return;
  }
  if (invFind(rec.id) >= 0) return;
  const slotIdx = invFirstFree();
  if (slotIdx < 0) { say('背包满了。', 1400); return; }
  inv[slotIdx] = { id: rec.id, name: rec.name, hand: null };
  rec.dropped = false;                             // 不再是地上的掉落物
  if (NO_HAND[rec.id]) { rec.obj.visible = false; if (rec.held) rec.held.visible = false; refreshInventoryHUD(); return; }   // 子弹/钥匙只进背包，世界模型收掉
  selectInventorySlot(slotIdx);                    // 选中即自动上手
  if (rec.id === 'phone') {
    achUnlock('phone_light');
    say('手机还有电。屏幕能当手电用。按 Tab 查看。', 2800);
  }
  if (rec.id === 'towel') say('湿毛巾。捂住口鼻能多撑一会儿……跑起来也不容易被烟呛住。', 3200);
  if (rec.id === 'tools') {
    achUnlock('tools_path');
    say('镰刀与锤子。沉甸甸的……也许能撬开什么。', 2800);
  }
}

/* Q 丢弃：从手上/背包里扔出去，带抛物线 + 落地反弹，落地后可再次拾取 */
function tryDrop() {
  const it = inv[selectedSlot];
  if (!it) return;
  if (magInHand) { say('（手上正忙着压弹。）', 1400); return; }
  const rec = recOf(it.id);
  /* 可叠加物品：把剩余数量写回世界那份，捡回来只有这么多（真消耗） */
  if (rec && STACKABLE[it.id]) rec.count = it.count || 0;
  inv[selectedSlot] = null;
  if (it.id === 'phone' && phoneLight) phoneLight.intensity = 0;
  if (rec) {
    // 收掉手里的模型，把世界模型放到镜头前一点点，然后交给物理
    const m = rec.held || rec.obj;
    if (m.parent === handRig) handRig.remove(m);
    if (rec.held) rec.held.visible = false;
    playerRoom.add(rec.obj);
    rec.obj.visible = true;
    rec.obj.scale.setScalar(1);
    // 世界坐标 → playerRoom 局部坐标
    cam.getWorldDirection(_aimDir);
    const wx = cam.position.x + _aimDir.x * 0.45;
    const wy = cam.position.y - 0.12;
    const wz = cam.position.z + _aimDir.z * 0.45;
    rec.obj.position.set(wx - PR.x, wy - PR.y, wz - PR.z);
    rec.obj.rotation.set(Math.random() * 0.5, Math.random() * 3.14, Math.random() * 0.5);
    rec.phys = {
      vx: _aimDir.x * 1.5, vy: 0.7, vz: _aimDir.z * 1.5,
      wx: (Math.random() - 0.5) * 7, wz: (Math.random() - 0.5) * 7,
      rest: false
    };
    rec.dropped = true;
  }
  refreshInventoryHUD();
}

/* 掉落物的简易物理：重力 + 地面反弹 + 摩擦，落定后 rest=true 停止计算 */
const DROP_HALF = 0.035;      // 物件半高，避免陷进地板
function updateDroppedItems(dt) {
  for (let i = 0; i < worldItems.length; i++) {
    const rec = worldItems[i];
    const p = rec.phys;
    if (!p || p.rest) continue;
    const o = rec.obj;
    /* 落地高度按物件当前所在楼层取，天台丢的东西落在天台面上，不再穿到楼下 */
    const floorLvl = floorYAt(o.position.x, o.position.z) + DROP_HALF;
    p.vy -= 9.8 * dt;
    o.position.x += p.vx * dt;
    o.position.y += p.vy * dt;
    o.position.z += p.vz * dt;
    o.rotation.x += p.wx * dt;
    o.rotation.z += p.wz * dt;
    // 撞墙/家具：把水平速度反弹掉一部分
    if (playerBlocked(o.position.x, o.position.z)) {
      o.position.x -= p.vx * dt; o.position.z -= p.vz * dt;
      p.vx *= -0.32; p.vz *= -0.32;
    }
    if (o.position.y <= floorLvl) {
      o.position.y = floorLvl;
      if (Math.abs(p.vy) < 0.5) {
        // 停下来：躺平，摆正到贴地
        p.rest = true; p.vx = p.vy = p.vz = 0;
        o.rotation.x = Math.PI / 2 * (rec.id === 'phone' ? 1 : 0);
        o.rotation.z = 0;
      } else {
        p.vy = -p.vy * 0.34;                 // 反弹
        p.vx *= 0.62; p.vz *= 0.62;
        p.wx *= 0.5; p.wz *= 0.5;
        SFX.thud(rec.id === 'towel' ? 'soft' : (rec.id === 'pistol' ? 'metal' : 'hard'));
      }
    }
  }
}

/* E：交互 */
function tryInteract() {
  const tgt = aimTarget;
  if (!tgt) return;
  if (tgt.kind === 'door') { doorOpen = !doorOpen; return; }
  if (tgt.kind === 'lamp') { lampOn = !lampOn; return; }
  if (tgt.kind === 'wardrobe') {
    wardrobeOpen = !wardrobeOpen;
    if (wardrobeOpen && !pistolSeen) {
      pistolSeen = true;
      say('……柜子里有把枪。是爸爸留下的那把。弹匣是空的。', 3400);
    }
    return;
  }
  if (tgt.kind === 'elevator') { say('电梯早就停运了。井道里只有热风往上涌。', 3000); return; }
  if (tgt.kind === 'elev4') {
    if (pry4Done || pry4Busy) return;
    if (itemInHand('tools')) { pryElevator(); return; }
    say('电梯门卡死了。需要根撬棍或者什么东西撬开……', 3200); return;
  }
  if (tgt.kind === 'rope4') {
    if (invFind('towel') < 0) { say('直接滑下去，手会磨烂的……需要一条毛巾垫着。', 3000); return; }
    beginRopeCG(); return;
  }
  if (tgt.kind === 'sideDoor1') {
    if (sideDoor1Open) return;
    if (invFind('key') >= 0) {
      sideDoor1Open = true;
      SFX.thud('metal');
      hideObjective();
      say('钥匙转动了。侧门开了——外面是楼后的树林，火光把树影烧得发红。', 3600);
      setTimeout(function () { dropACUnit(); }, 1400);
    } else {
      say('锁死了。得有钥匙。', 2400);
    }
    return;
  }
  if (tgt.kind === 'frontDoor1') { say('木梁烧得正旺，靠近不了。', 2600); return; }
  if (tgt.kind === 'garageShutter') { beginCrawlCG(); return; }
  if (tgt.kind === 'burnCar') { beginCarBurnDeath(tgt); return; }
  if (tgt.kind === 'playerCar') { beginCarEscape(); return; }
  if (tgt.kind === 'exitShutter') { achUnlock('h_black'); beginBlackRoom(); return; }
  if (tgt.kind === 'garageDoor') { garageDoorInteract(); return; }
  if (tgt.kind === 'stair4') { say('火势太大，我无法做到...', 3000); return; }
  if (tgt.kind === 'acWindow') {
    // 四楼窗户必须先用斧头或镰刀+锤子打碎，之后再次按 E 才能攀爬
    if (!acWindowBroken) {
      if (!itemInHand('tools') && !itemInHand('axe')) { say('需要斧头，或镰刀与锤子来打碎玻璃。', 2200); return; }
      acWindowBroken = true; spawnWindowShards4(); SFX.glassBreak(); jolt4Amp = 0.45;
      if (acWindowGlass) acWindowGlass.visible = false;
      say('窗户玻璃碎了。再按 E 攀爬到空调外机。', 2400); return;
    }
    beginAcClimb(); return;
  }
  if (tgt.kind === 'toolCase') {
    /* 第一次 E：念旁白；旁白打完即将消散后再次 E 才能打碎玻璃 */
    if (!case4Read) {
      case4Read = true;
      const line = '里面镰刀与锤子交错摆放，标签上写着「如遇危险，请呼唤我们」...';
      say(line, 3400);
      /* 与 say() 的时序一致：打字 字数×48ms，打完 2s 开始渐隐 */
      case4FadeAt = performance.now() + line.length * 48 + 2000;
      return;
    }
    if (performance.now() < case4FadeAt) { say('……', 600); return; }   // 旁白还没走到消散
    /* 打碎玻璃 */
    case4GlassBroken = true; glassBreakT = 0.90;
    if (caseGlass4) caseGlass4.visible = false;
    if (toolsObj) toolsObj.visible = true;
    spawnGlassShards4();
    jolt4Amp = 0.45;
    SFX.glassBreak();
    _wp.set(PR.x + 6.7, PR.y - 2.90 + 1.45, PR.z + 3.34);
    spawnSparks(_wp.x, _wp.y, _wp.z, 0xbfd8e2, 18, 1.8);
    say('玻璃碎了。', 1600);
    return;
  }
  if (tgt.kind === 'window') { beginFallEnding(); return; }
  if (tgt.kind === 'radio') { toggleRadio(); return; }
  if (tgt.kind === 'ladder') { beginEscapeCG(); return; }
  /* 四楼外机救援梯：登上 → 复用天台撤离 CG，结局 6「这次不行」 */
  if (tgt.kind === 'rescueLadder') { beginEscapeCG('结局 6', '这次不行'); return; }
  if (tgt.kind === 'item') { tryPickup(); return; }
}

/* ==================== 手机视图（Tab）====================
   手上握着手机按 Tab 翻看：背景虚化，屏幕中央放大的手机，
   右上角电量（只剩一格、红色），左上角信号（三格竖条，1 白 2 灰）。
   进入 505 收到消息后信号变灰 + ×（无服务）——之后会影响剧情。 */
let phoneViewOpen = false;
let phoneHasSignal = true;
let phoneMsg505 = false;        // 505 的消息是否已触发
const phoneViewEl = document.getElementById('phoneView');

function togglePhoneView() {
  if (phoneViewOpen) { closePhoneView(); return; }
  if (!itemInHand('phone')) return;      // 只有拿在手上才能看
  phoneViewOpen = true;
  refreshPhoneView();
  phoneViewEl.classList.add('show');
  promptEl.classList.remove('show');
  /* 呼出鼠标：解锁指针才能点消息框 */
  if (document.pointerLockElement) { lockGraceUntil = Date.now() + 600; document.exitPointerLock(); }
}
function closePhoneView() {
  phoneViewOpen = false;
  phoneViewEl.classList.remove('show');
  /* 天台那条短信读完、收起手机 → 弹出任务并开始 2:00 倒计时 */
  if (phoneRoofMsg && phoneNewsRead && heliTimer < 0 && !heliArrived && !phoneWeakMsg) startHeliCountdown();
  /* 收起手机：把鼠标重新交给视角（触屏设备不需要） */
  if (state === 'play' && !menuOpen && !isTouchMode()) {
    setTimeout(function () { if (!phoneViewOpen && !menuOpen && state === 'play') requestLookLock(); }, 60);
  }
}
function refreshPhoneView() {
  phoneViewEl.classList.toggle('nosignal', !phoneHasSignal);
  phoneViewEl.classList.toggle('hasmsg', (phoneMsg505 || phoneRoofMsg) && !phoneNewsRead);
  phoneViewEl.classList.toggle('news', phoneNewsRead);
  phoneViewEl.classList.toggle('roofmsg', phoneRoofMsg);
  const tip = phoneViewEl.querySelector('.pv-tip');
  if (tip) tip.textContent = isTouchMode() ? '点击下方「收起」关闭' : 'Tab · 收起';
  const scr = phoneViewEl.querySelector('.pv-screen');
  if (scr) scr.textContent = (phoneHasSignal || phoneNewsRead) ? '' : '无服务';
  /* 消息框标题：505 那条是新闻推送，天台这两条是短信 */
  const ttl = phoneViewEl.querySelector('.pv-msg span');
  if (ttl) ttl.textContent = phoneRoofMsg ? '短信' : '实时热报';
  /* 短信正文：第二条（弱点情报）到了就换成它 */
  const sb = phoneViewEl.querySelector('.sms-body');
  const sf = phoneViewEl.querySelector('.sms-from');
  if (sb) sb.textContent = phoneWeakMsg
    ? '官方说明机器人的弱点是正面腰部左侧的压力罐...'
    : '救援直升机即将进山';
  if (sf) sf.textContent = phoneWeakMsg ? '应急广播' : '未知号码';
}
/* 「收起」按钮：触屏和桌面通用。原来这个按钮没有绑事件，手机上看手机
   只能靠 Tab 键或那个 9px 的小字，等于卡死。 */
const pvCloseBtn = phoneViewEl.querySelector('.pv-close');
if (pvCloseBtn) pvCloseBtn.addEventListener('click', function (e) {
  e.preventDefault(); e.stopPropagation();
  if (phoneViewOpen) closePhoneView();
});
const pvTipEl = phoneViewEl.querySelector('.pv-tip');
if (pvTipEl) pvTipEl.addEventListener('click', function (e) {
  e.preventDefault(); e.stopPropagation();
  if (phoneViewOpen) closePhoneView();
});
/* 点开「实时热报」→ 看到新闻 → 信号消失，目标转向楼梯 */
phoneViewEl.querySelector('.pv-msg').addEventListener('click', function () {
  if (phoneNewsRead) return;
  phoneNewsRead = true;
  /* 天台那条短信：读完不掉信号，收起手机后启动倒计时 */
  if (phoneRoofMsg) {
    SFX.buzz();
    refreshPhoneView();
    return;
  }
  /* 505 的新闻推送：读完信号消失 */
  phoneHasSignal = false;
  SFX.buzz();
  refreshPhoneView();
  setTimeout(function () {
    say('没信号了', 2200);
    /* 任务替换 ②：看完消息 → 去劈楼梯 */
    showObjective('用斧头劈开被挡住的楼梯', '走廊左端 · 消防斧在 505');
  }, 1600);
});
/* 各处的「重活一世」：整个游戏重开 */
Array.prototype.forEach.call(document.querySelectorAll('.restart'), function (b) {
  b.addEventListener('click', function () { location.reload(); });
});

/* ==================== 剧情目标 HUD + 触发链 ====================
   出卧室门 → "505的住户好像遇害了..." → 目标【去505看看】(顶部弹出后滑到左上)
   进 505 → 手机震了一下（未读消息，手机屏幕脉冲发光）
   Tab 看手机 → 顶部白消息框(红点) → 点开看新闻 → 信号没了 → 目标【去楼梯间】
   走回卧室门口 → 504 门砰开，机器人出来追杀 */
let leftRoomOnce = false, phoneNewsRead = false, robotOut = false, robotDead = false;
let robotWalkT = 0, deathT0 = 0, bloodPts = null;
const objEl = document.getElementById('objective');

let objTimerId = null;
function showObjective(big, small) {
  clearTimeout(objTimerId);
  /* 替换旧任务：先收回（去掉 corner + show），下一帧再弹出，
     这样"顶部弹出 → 滑到左上角"的动作每次都完整播一遍，而不是从左上角原地改字 */
  const wasShown = objEl.classList.contains('show');
  const doShow = function () {
    objEl.querySelector('.obj-big').textContent = big;
    objEl.querySelector('.obj-small').textContent = small || '';
    objEl.classList.remove('corner');
    objEl.classList.add('show');
    objTimerId = setTimeout(function () { objEl.classList.add('corner'); }, 2000);
  };
  if (wasShown) {
    objEl.classList.remove('show');
    objTimerId = setTimeout(doShow, 420);        // 等淡出结束再弹新的
  } else doShow();
}
function hideObjective() {
  clearTimeout(objTimerId);
  objEl.classList.remove('show', 'corner');
}

/* 支线任务 HUD：与主任务同套弹出→滑角动作，但停在主任务下方、字体更小 */
const sidequestEl = document.getElementById('sidequest');
let sqTimerId = null;
function showSideQuest(big, small) {
  clearTimeout(sqTimerId);
  if (!sidequestEl) return;
  const wasShown = sidequestEl.classList.contains('show');
  const doShow = function () {
    sidequestEl.querySelector('.sq-big').textContent = big;
    sidequestEl.querySelector('.sq-small').textContent = small || '';
    sidequestEl.classList.remove('corner');
    sidequestEl.classList.add('show');
    sqTimerId = setTimeout(function () { sidequestEl.classList.add('corner'); }, 2000);
  };
  if (wasShown) {
    sidequestEl.classList.remove('show');
    sqTimerId = setTimeout(doShow, 420);
  } else doShow();
}
function hideSideQuest() {
  clearTimeout(sqTimerId);
  if (sidequestEl) sidequestEl.classList.remove('show', 'corner');
}
/* 触屏没有 Tab 键，提示语跟着输入方式变 */
function phoneKeyName() { return ('ontouchstart' in window) ? '手机键' : 'Tab'; }

function updateStory(dt) {
  if (state !== 'play' || menuOpen || escapeCG) return;
  /* 以下 5F 触发必须限定楼层：四楼 405 房间的坐标范围与 505 重叠，会误触发 */
  if (curLevel === 0) {
    /* 第一次走出卧室门 */
    if (!leftRoomOnce && playerPos.z > 2.3 && playerPos.z < 2.7) {
      leftRoomOnce = true;
      say('505的住户好像遇害了...', 2600);
      setTimeout(function () { showObjective('去505看看', '505在你的左侧，那个怪物刚走'); }, 1400);
    }
    /* 505 触发：收到消息（信号还在，等看完新闻才没） */
    if (!phoneMsg505 && playerPos.x > 2.7 && playerPos.x < 7.0 && playerPos.z > -2.3 && playerPos.z < 2.2) {
      phoneMsg505 = true;
      SFX.buzz();
      say('手机震了一下', 2200);
      refreshPhoneView();
      /* 任务替换 ①：先在屏幕上方弹出，再滑到左上角顶掉旧任务 */
      setTimeout(function () {
        showObjective('手握手机按' + phoneKeyName() + '打开手机', '有一条新消息');
      }, 1200);
    }
  }
  /* 看完新闻（信号没了）后走回卧室门口 → 504 门被撞开，追杀开始 */
  /* 看完新闻后「走回自己家这一侧」→ 504 门被撞开。
     两种算法都要：
       ① 走廊里跨过 x=2.0 这条线（从 505 去楼梯间必经，贴墙/走中间都躲不掉）
       ② 回到自己卧室内部
     注意 ② 必须同时限定 x∈[-2.4, 2.4]：505 的 z 范围是 -2.08~2.18，
     只写 z<2.2 会把整个 505 算进去 —— 那样在 505 里刚看完新闻就触发了。 */
  if (curLevel === 0 && phoneNewsRead && !robotOut &&
      ((playerPos.z > 2.4 && playerPos.x < 2.0) ||
       (playerPos.z < 2.2 && playerPos.x > -2.4 && playerPos.x < 2.4))) {
    robotOut = true;
    SFX.slam();
    /* 破门那一下：门响 + 电锯猛轰两脚油门（先大后小），突然放大压迫感 */
    SFX.revChainsaw(1.0);
    setTimeout(function () { SFX.revChainsaw(0.85); }, 420);
    breakDoor504();
    robot.visible = true;
    /* 机器人出场：左下角旁白（任务保持"劈开楼梯"不变，只是变紧迫了）*/
    say('该死！赶紧劈开逃跑，哪里都行！', 3400);
  }
  /* 四楼 405 房间：走到炸开的窗洞附近 → 一次性旁白 */
  if (curLevel === -1 && !lvl4RoomHint &&
      playerPos.x > 1.9 && playerPos.x < 6.9 && playerPos.z < -1.2) {
    lvl4RoomHint = true;
    say('或许我们可以走空调外机躲一躲...', 3200);
  }
  updateRobotPortraitVisibility();
  updateRobot(dt);
  updateGarageRobot(dt);   // 地下车库巡逻机器人（复用同一模型，只在这一层接管）
}

/* ---- 504 破门：它比门框高，是直接把门连门楣一起顶烂撞出来 ----
   门板整片飞出去砸在走廊上，门楣塌下来，碎块四散 */
let door504Debris = [], door504Stumps = [];
function breakDoor504() {
  if (!door504) return;
  const dbM = M(0x6b5136, { r: 0.9 });   // 提亮：原来的 0x1d150d 近黑，堆在门口全糊成一团
  /* 门板：脱框飞出，平躺在走廊地上（厚度 0.05 → 躺平后 y=0.026，不浮空不穿地）*/
  const leaf = door504.children[0];
  if (leaf) {
    door504.remove(leaf);
    playerRoom.add(leaf);
    leaf.position.set(3.0, 1.0, 4.1);
    leaf.rotation.set(0, 0.2, 0);
    door504Debris.push({
      mesh: leaf, t: 0,
      from: leaf.position.clone(),
      to: new THREE.Vector3(2.4, 0.026, 3.35),
      // 绕 X 精确转 90° 躺平，只用 Y 轴给一点朝向变化
      rotTo: new THREE.Vector3(Math.PI / 2, 0.42, 0)
    });
  }
  /* 掉落的门框碎块：都是 box(w, h, 0.12)，躺平后 0.12 那一边竖起来 → y = 0.06 */
  for (let i = 0; i < 4; i++) {
    const w = 0.12 + Math.random() * 0.22;
    const c = put(box(w, 0.1 + Math.random() * 0.16, 0.12, dbM),
      3.2 + (Math.random() - 0.5) * 1.0, 2.0 + Math.random() * 0.35, 4.35);
    c.rotation.set(Math.random() * 0.5, Math.random() * 3, Math.random() * 0.5);
    playerRoom.add(c);
    door504Debris.push({
      mesh: c, t: 0,
      from: c.position.clone(),
      to: new THREE.Vector3(c.position.x + (Math.random() - 0.5) * 1.2,
        0.061 + i * 0.004,                       // 微小错层，避免同高度互相穿插
        3.5 + Math.random() * 0.7),
      rotTo: new THREE.Vector3(Math.PI / 2, Math.random() * 3, 0)   // 躺平
    });
  }
  /* 门洞顶部被顶豁：门楣整块消失，洞变高（它才站得起来走出来）*/
  if (door504Lintel) door504Lintel.visible = false;  /* 留在门框上的断口：沿着被撞豁的洞口边缘长出锯齿状残片——
     这些不掉，是"从框上撕下来"的痕迹，让破口看起来嵌在门框里而不是干净的方孔 */
  if (!door504Stumps.length) {
    const CWz = 4.34;                             // 504 门所在的 z（走廊对面墙）
    /* 只在洞口上沿留 5 块短碎茬（原来 17 块又多又暗，把整个门洞糊住了）。
       材质用提亮的木色，长度压到 0.16m 以内，不伸进洞里挡视线。 */
    const stumpM = M(0x6b5136, { r: 0.88 });
    for (let i = 0; i < 5; i++) {
      const h = 0.08 + Math.random() * 0.08;
      const st = put(box(0.07 + Math.random() * 0.07, h, 0.12, stumpM),
        2.82 + i * 0.19, 2.36 - h / 2, CWz);
      st.rotation.set(0, 0, (Math.random() - 0.5) * 0.3);
      playerRoom.add(st); door504Stumps.push(st);
    }
  }
  for (let i = 0; i < door504Stumps.length; i++) door504Stumps[i].visible = true;
  // 木屑：加在 scene 下 → 必须用世界坐标（playerRoom 偏移 92,0,92）
  spawnSparks(PR.x + 3.2, PR.y + 1.8, PR.z + 4.3, 0x6b4a28, 22, 2.6);
  door504.visible = false;
}
/* 碎块下落动画 */
function updateDoorDebris(dt) {
  for (let i = 0; i < door504Debris.length; i++) {
    const d = door504Debris[i];
    if (d.t >= 1) continue;
    d.t = Math.min(1, d.t + dt * 1.5);
    const e = d.t * d.t;                       // 加速下落
    d.mesh.position.lerpVectors(d.from, d.to, e);
    d.mesh.rotation.x = d.rotTo.x * e;
    d.mesh.rotation.y = d.rotTo.y * e;
    d.mesh.rotation.z = d.rotTo.z * e;
    if (d.t >= 1) SFX.shellTink();
  }
}

/* ---- 机器人追杀：从 504 出来 → 沿走廊逼近玩家 ---- */
function updateRobot(dt) {
  if (!robotOut || state !== 'play') return;
  if (curLevel === -2) return;   // 一楼没有机器人——它下不来
  /* 四楼被木梁封住：机器人卡在楼梯井里，只朝玩家方向小幅待机，不推进、不致死。
     被打中弱点时同样僵住（压力罐乱闪）——僵直计时在这里也要消耗，
     否则 updateLvl4Timer 的"僵直即冻结"会变成永久暂停 */
  if (curLevel === -1 && lvl4Barred) {
    robotWalkT += dt;
    if (robotStunT > 0) {
      robotStunT -= dt;
      const fl = Math.abs(Math.sin(robotStunT * 22));
      if (tankGlow) tankGlow.intensity = 0.04 + fl * 0.55;
      if (tankMat) tankMat.emissiveIntensity = 0.15 + fl * 1.3;
      robot.rotation.z = (Math.random() - 0.5) * 0.012;
      return;
    }
    robot.rotation.z = 0;
    if (tankGlow) tankGlow.intensity = 0;
    robot.position.y = -2.90 + Math.abs(Math.sin(robotWalkT * 2.2)) * 0.02;
    /* 面朝走廊里的玩家（模型前方是局部 +Z）*/
    const dx = playerPos.x - robot.position.x, dz = playerPos.z - robot.position.z;
    robot.rotation.y = Math.atan2(dx, dz);
    robot.rotation.z = Math.sin(robotWalkT * 5.5) * 0.02;   // 焦躁地小幅晃动
    return;
  }
  /* 瘫痪计时：压力罐被打中后短暂僵住 */
  if (robotStunT > 0) {
    robotStunT -= dt;
    /* 瘫痪：压力罐蓝光乱闪 + 罐体自发光跳动（tankGlow 是 PointLight，只有 intensity）*/
    const fl = Math.abs(Math.sin(robotStunT * 22));
    if (tankGlow) tankGlow.intensity = 0.04 + fl * 0.55;
    if (tankMat) tankMat.emissiveIntensity = 0.15 + fl * 1.3;
    /* 身体轻微抽动，看出是"僵住"而不是卡帧 */
    robot.rotation.z = (Math.random() - 0.5) * 0.012;
    lastStepPh = Math.floor(robotWalkT * 3.6 / Math.PI);   // 恢复时不会立刻补一声脚步
    return;
  }
  robot.rotation.z = 0;
  if (tankGlow) tankGlow.intensity = 0;      // 恢复后重新熄灭
  robotWalkT += dt;
  const rx = robot.position.x, rz = robot.position.z;
  /* 出门段：先从 504 屋内直走进走廊，之后再寻路 */
  if (rz > 3.9) {
    robot.position.z -= dt * 0.8;
  } else {
    const dx = playerPos.x - rx, dz = playerPos.z - rz;
    const d = Math.hypot(dx, dz);
    if (d > 0.05) {
      const sp = 0.62 * robotSpeedMul * dt;      // 缓慢逼近；天台倒计时期间 ×1.5
      const nx = rx + dx / d * sp, nz = rz + dz / d * sp;
      if (!robotBlocked(nx, rz)) robot.position.x = nx;
      if (!robotBlocked(rx, robot.position.z + (nz - rz))) robot.position.z = nz;
    }
    /* 面朝玩家 */
    /* 面朝玩家。模型的"前"是局部 +Z（前腿 z=+0.20、头和电锯在前、臀部在 -0.78），
       所以 yaw 直接取 atan2(dx, dz)——之前多加了一个 π，它是倒着走过来的。 */
    robot.rotation.y = Math.atan2(dx, dz);
    /* 腿：左两条先摆、右两条反相（四足交替） */
    const legs = robot.userData.legs;
    const ph = robotWalkT * 3.6;
    if (legs) {
      for (let i = 0; i < legs.length; i++) {
        const left = legs[i].position.x < 0;
        legs[i].rotation.x = Math.sin(left ? ph : ph + Math.PI) * 0.34 - 0.06;
      }
    }
    /* 上下起伏 + 跟着楼梯高度走（否则它会浮在台阶上或者陷进去）*/
    robot.position.y = floorYAt(robot.position.x, robot.position.z) +
      Math.abs(Math.sin(robotWalkT * 3.6)) * 0.015;
    /* 脚步声：每半步一次，按距离衰减 */
    const stepIdx = Math.floor(ph / Math.PI);
    if (stepIdx !== lastStepPh) {
      lastStepPh = stepIdx;
      SFX.step(d);
    }
    /* 碰到玩家 → 死亡演出 */
    if (d < 1.0) beginDeath();
  }
}

/* ---- 地下车库巡逻机器人：直接复用楼上的机器人模型（零新增几何，省性能）----
   眼睛亮 5s / 灭 3s 循环：熄灯时玩家手机手电是黑暗里唯一的光，给足安全感；
   玩家开手电 → 剧烈电锯声 + 直线追踪；关掉手电不丢目标 —— 先朝最后目击方向搜寻
   一阵，再在车道里随机游走；手枪打中弱点（压力罐）会僵直 7 秒，僵直期间
   无论光亮与否都不行动。碰到玩家致死。 */
let garageRobotOn = false, garPatrolT = 0, garEyeT = 0, garMode = 'patrol', garPatrolIdx = 0;
let garSearchT = 0, garLastX = 0, garLastZ = 0, garWanderX = 0, garWanderZ = 0;
const GAR_PATROL = [[-5.5, 15.4], [5.5, 15.4]];   // 中央通车道两端（不摆车、不摆柱）
function startGarageRobot() {
  garageRobotOn = true; garPatrolT = 0; garEyeT = 0; garMode = 'patrol'; garPatrolIdx = 0;
  garSearchT = 0;
  robot.position.set(2.0, GAR_Y, 15.4);
  robot.rotation.set(0, 0, 0);
}
function stopGarageRobot() {
  garageRobotOn = false; garMode = 'patrol';
  if (SFX.isChainsawOn) { SFX.stopChainsaw(); SFX.isChainsawOn = false; }
  if (eyeMatL) eyeMatL.emissiveIntensity = 1.6;
  if (eyeLight) eyeLight.intensity = 0.4;
}
function robotBlockedGarage(x, z) {
  const r = 0.45;
  for (let i = 0; i < lvl1Colliders.length; i++) {
    const b = lvl1Colliders[i];
    if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
  }
  return false;
}
function garWalkTo(tx, tz, sp, dt) {
  const rx = robot.position.x, rz = robot.position.z;
  const dx = tx - rx, dz = tz - rz;
  const d = Math.hypot(dx, dz);
  if (d > 0.05) {
    const nx = rx + dx / d * sp * dt, nz = rz + dz / d * sp * dt;
    if (!robotBlockedGarage(nx, rz)) robot.position.x = nx;
    if (!robotBlockedGarage(robot.position.x, nz)) robot.position.z = nz;
    robot.rotation.y = Math.atan2(dx, dz);
  }
  return d;
}
function updateGarageRobot(dt) {
  if (!garageRobotOn || !robotOut || state !== 'play') return;
  garEyeT += dt; garPatrolT += dt;
  /* 眼睛：亮 5s / 灭 3s */
  const lit = (garEyeT % 8) < 5;
  if (eyeMatL) eyeMatL.emissiveIntensity = lit ? 1.6 : 0.05;
  if (eyeLight) eyeLight.intensity = lit ? 0.5 : 0.0;
  /* 手枪弱点僵直：和楼上同一套 robotStunT —— 僵直期间无论光亮都不行动 */
  if (robotStunT > 0) {
    robotStunT -= dt;
    if (garMode === 'chase') { garMode = 'search'; garSearchT = 0; }
    if (SFX.isChainsawOn) { SFX.stopChainsaw(); SFX.isChainsawOn = false; }
    const fl = Math.abs(Math.sin(robotStunT * 22));
    if (tankGlow) tankGlow.intensity = 0.04 + fl * 0.55;
    if (tankMat) tankMat.emissiveIntensity = 0.15 + fl * 1.3;
    robot.rotation.z = (Math.random() - 0.5) * 0.012;
    return;
  }
  robot.rotation.z = 0;
  if (tankGlow) tankGlow.intensity = 0;
  if (tankMat) tankMat.emissiveIntensity = 0.15;
  const lightOn = itemInHand('phone') && !twoHandedHeld();
  if (lightOn && garMode !== 'chase') {
    garMode = 'chase';
    SFX.startChainsaw(); SFX.revChainsaw(1.0);
    say('（它看见光了——！！）', 2000);
  } else if (!lightOn && garMode === 'chase') {
    /* 关灯不丢目标：先朝最后目击位置搜寻一阵 */
    garMode = 'search';
    garSearchT = 6;
    if (SFX.isChainsawOn) { SFX.stopChainsaw(); SFX.isChainsawOn = false; }
    say('（它追丢了……先别开灯。）', 2200);
  }
  if (garMode === 'chase') {
    garLastX = playerPos.x; garLastZ = playerPos.z;       // 持续记录最后目击点
    const d = garWalkTo(playerPos.x, playerPos.z, 2.1, dt);
    SFX.updateChainsawDist(Math.max(0.8, d), 0);
    if (d < 1.0) beginDeath();
    return;
  }
  if (garMode === 'search') {
    /* 朝最后目击方向游走一阵；到点或超时 → 随机游走 */
    garSearchT -= dt;
    const d = garWalkTo(garLastX, garLastZ, 0.9, dt);
    if (d < 0.6 || garSearchT <= 0) {
      garMode = 'wander';
      garWanderX = -5.5 + Math.random() * 11;
      garWanderZ = 13.8 + Math.random() * 3.2;
    }
    return;
  }
  if (garMode === 'wander') {
    /* 在中央车道里随机游走 */
    const d = garWalkTo(garWanderX, garWanderZ, 0.8, dt);
    if (d < 0.5) {
      garWanderX = -5.5 + Math.random() * 11;
      garWanderZ = 13.8 + Math.random() * 3.2;
    }
    return;
  }
  /* patrol：沿中央车道两端巡逻 */
  const wp = GAR_PATROL[garPatrolIdx];
  if (garWalkTo(wp[0], wp[1], 0.8, dt) < 0.3) garPatrolIdx = (garPatrolIdx + 1) % GAR_PATROL.length;
  /* 四足腿摆通用 */
  const legs = robot.userData.legs;
  const ph = garPatrolT * 3.6;
  if (legs) for (let i = 0; i < legs.length; i++) {
    const left = legs[i].position.x < 0;
    legs[i].rotation.x = Math.sin(left ? ph : ph + Math.PI) * 0.34 - 0.06;
  }
  robot.position.y = GAR_Y + Math.abs(Math.sin(garPatrolT * 3.6)) * 0.015;
}
function robotBlocked(x, z) {
  const r = 0.42;
  for (let i = 0; i < walkAreas.length; i++) {
    const a = walkAreas[i];
    /* 按楼层过滤（和 playerBlocked 同规则）。
       原来不过滤：四楼会拿五楼卧室/走廊的判定放行，直接穿墙走进虚空 */
    if (a.lvl === undefined) { if (curLevel !== 0) continue; }
    else if (a.lvl !== 'any' && a.lvl !== curLevel) continue;
    if (x > a.x0 - r * 0.2 && x < a.x1 + r * 0.2 && z > a.z0 && z < a.z1) return false;
  }
  /* 四楼 405 房间内的隔墙/床：机器人同样不能穿（分轴移动会自己绕开，不会卡死） */
  if (curLevel === -1) {
    for (let i = 0; i < lvl4RoomColliders.length; i++) {
      const b = lvl4RoomColliders[i];
      if (x > b.x0 - r && x < b.x1 + r && z > b.z0 - r && z < b.z1 + r) return true;
    }
  }
  return true;
}

/* ---- 死亡演出：被电锯举起 → 看到胸口转动的锯 → 闭眼 → 你解脱了 ---- */
function beginDeath() {
  if (state !== 'play') return;
  stopGarageRobot();         // 车库巡逻线（含电锯声）一并停掉
  setState('death');
  deathT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  closePhoneView();
  endStairChoice();          // 死亡演出盖掉抉择 CG
  menuOpen = false;
  /* 演出一开始就放开鼠标：玩家已经失去控制权，也免得 ESC 弹出暂停菜单 */
  if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  /* 胸口血雾粒子 */
  const n = 90, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 0.34;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 0.22;
    pos[i * 3 + 2] = -0.62 + (Math.random() - 0.5) * 0.1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  bloodPts = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0x6e0f08, size: 0.035, transparent: true, opacity: 0
  }));
  cam.add(bloodPts);
  if (SFX.isChainsawOn) { SFX.revChainsaw(1.0); }
}
function updateDeath() {
  const t = (performance.now() - deathT0) / 1000;
  /* 视角强制转向机器人。
     lookYaw 是被鼠标无界累加的（可能是 12.7 这种值），而目标角在 ±π 内，
     所以必须把差值折到 [-π, π] 走最短路，否则会疯转或者根本转不过去。 */
  const dx = robot.position.x - playerPos.x, dz = robot.position.z - playerPos.z;
  const wantYaw = Math.atan2(-dx, -dz) - SIT.yaw;
  let dYaw = (wantYaw - lookYaw) % (Math.PI * 2);
  if (dYaw > Math.PI) dYaw -= Math.PI * 2;
  if (dYaw < -Math.PI) dYaw += Math.PI * 2;
  lookYaw += dYaw * 0.12;
  let wantPitch;
  if (t < 1.2) {                              // 抖动（已经对上了，只是抖）
    lookYaw += (Math.random() - 0.5) * 0.04;
    wantPitch = -0.05;
  } else if (t < 2.5) {                       // 被举起来，视角被抬高
    wantPitch = 0.95;
  } else {                                    // 低头看到胸口的锯
    wantPitch = -0.62;
  }
  lookPitch += (wantPitch - lookPitch) * 0.07;
  if (t > 2.3 && bloodPts) {
    bloodPts.material.opacity = Math.min(0.9, (t - 2.3) * 0.8);
    const p = bloodPts.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.array[i * 3 + 1] += (Math.random() - 0.62) * 0.012;   // 暗红粒子跳动
    }
    p.needsUpdate = true;
  }
  if (t > 3.8) setLids(Math.min(1, (t - 3.8) / 1.1));
  if (t > 5.2) {
    if (SFX.isChainsawOn) { SFX.stopChainsaw(); SFX.isChainsawOn = false; }
    const dEl = document.getElementById('deathTitle');
    if (dEl) dEl.classList.add('show');
    /* 死了要把鼠标交还给玩家，否则点不到「重活一世」 */
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    document.body.classList.add('ending');       // 收掉准星/HUD/触控
    state = 'dead';
  }
}

/* ---- 特效：火花粒子池（打偏/命中/劈柴共用）---- */
const sparkPool = [];
function spawnSparks(x, y, z, color, n, spd) {
  const pos = new Float32Array(n * 3), vel = [];
  for (let i = 0; i < n; i++) {
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    vel.push(new THREE.Vector3((Math.random() - 0.5), Math.random() * 0.8, (Math.random() - 0.5))
      .normalize().multiplyScalar((spd || 2.4) * (0.4 + Math.random() * 0.6)));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({
    color: color, size: 0.03, transparent: true, opacity: 1
  }));
  p.userData.vel = vel; p.userData.life = 0.55;
  scene.add(p); sparkPool.push(p);
}
function updateSparks(dt) {
  for (let i = sparkPool.length - 1; i >= 0; i--) {
    const p = sparkPool[i];
    p.userData.life -= dt;
    if (p.userData.life <= 0) {
      scene.remove(p); p.geometry.dispose(); p.material.dispose(); sparkPool.splice(i, 1); continue;
    }
    const a = p.geometry.attributes.position;
    for (let j = 0; j < a.count; j++) {
      const v = p.userData.vel[j];
      a.array[j * 3] += v.x * dt; a.array[j * 3 + 1] += v.y * dt; a.array[j * 3 + 2] += v.z * dt;
      v.y -= 5.5 * dt;
    }
    a.needsUpdate = true;
    p.material.opacity = Math.max(0, p.userData.life / 0.55);
  }
}
/* 枪口火光 + 曳光 */
let muzzleT = 0, tracerT = 0;
const muzzleLight = new THREE.PointLight(0xffc27a, 0, 3.2);
muzzleLight.position.set(0.17, -0.12, -0.5); cam.add(muzzleLight);
const tracerGeo = new THREE.BufferGeometry().setFromPoints(
  [new THREE.Vector3(0.17, -0.16, -0.4), new THREE.Vector3(0.17, -0.16, -3.2)]);
const tracer = new THREE.Line(tracerGeo,
  new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0 }));
tracer.visible = false; cam.add(tracer);

/* ---- 抛壳：飞出的黄铜弹壳，带旋转和落地 ---- */
function ejectShell() {
  const rec = recOf('pistol');
  const gun = rec && (rec.held || rec.obj);
  if (!gun) return;
  const sh = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.005, 0.019, 6),
    M(0xb08838, { r: 0.3, m: 0.9 }));
  // 从抛壳口的世界位置起飞
  const wp = new THREE.Vector3(-0.02, 0.045, 0.01);
  gun.localToWorld(wp);
  sh.position.copy(wp);
  scene.add(sh);
  shellPool.push({
    mesh: sh, life: 2.2,
    v: new THREE.Vector3(0.4 + Math.random() * 0.5, 1.5 + Math.random() * 0.6,
      1.1 + Math.random() * 0.5).applyQuaternion(cam.quaternion),
    w: new THREE.Vector3((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22)
  });
}
function updateShells(dt) {
  for (let i = shellPool.length - 1; i >= 0; i--) {
    const s = shellPool[i];
    s.life -= dt;
    if (s.life <= 0) {
      scene.remove(s.mesh); s.mesh.geometry.dispose(); shellPool.splice(i, 1); continue;
    }
    s.v.y -= 9.0 * dt;
    s.mesh.position.addScaledVector(s.v, dt);
    s.mesh.rotation.x += s.w.x * dt; s.mesh.rotation.y += s.w.y * dt; s.mesh.rotation.z += s.w.z * dt;
    // 落地：弹一下然后躺平
    const floorY = playerRoom.position.y + 0.008;
    if (s.mesh.position.y < floorY) {
      s.mesh.position.y = floorY;
      if (Math.abs(s.v.y) > 0.35) { s.v.y = -s.v.y * 0.32; s.v.x *= 0.5; s.v.z *= 0.5; SFX.shellTink(); }
      else { s.v.set(0, 0, 0); s.w.multiplyScalar(0.82); }
    }
  }
}

/* ---- 手枪射击：真实供弹链（弹匣 → 弹膛 → 抛壳 → 打空后套筒后定）---- */
function firePistol() {
  if (reloadT > 0 || magInHand) return;           // 压弹中不能开枪
  /* 套筒后定：再扣扳机只有空响，除非重新上膛 */
  if (slideLocked) {
    SFX.click();
    say('套筒卡在后面了。得压弹、上膛。（R）', 2600);
    return;
  }
  if (!chambered) {
    /* 膛里没弹：如果弹匣有弹，就当作忘了上膛 */
    SFX.click(); SFX.tick2();
    say(magLoaded > 0 ? '没上膛。（R）' : '空的。得先压弹。（R）', 2400);
    return;
  }
  /* 开火 */
  chambered = false;
  SFX.shot();
  slideT = 0.1;                                   // 套筒后坐复进
  ejectShell();                                   // 抛壳
  muzzleLight.intensity = 2.4; muzzleT = 0.09;
  tracer.material.opacity = 0.9; tracerT = 0.07; tracer.visible = true;
  lookPitch += 0.05;                              // 后坐
  /* 自动上膛：弹匣还有弹就顶一发进膛，没有就套筒后定 */
  if (magLoaded > 0) { magLoaded--; chambered = true; }
  else { slideLocked = true; setTimeout(function () { SFX.slideLock(); }, 110); }
  refreshInventoryHUD();
  /* 命中判定：弱点 = 身侧蓝色压力罐 */
  cam.getWorldDirection(_aimDir);
  let hit = false;
  if (robotOut && tankMesh) {
    tankMesh.getWorldPosition(_wp);
    const toT = _wp.clone().sub(cam.position);
    const proj = toT.dot(_aimDir);
    const miss = Math.sqrt(Math.max(0, toT.lengthSq() - proj * proj));
    if (proj > 0 && miss < 0.26) hit = true;
  }
  if (hit) {
    robotStunT = 7;                               // 短暂瘫痪
    /* 四楼：它僵住的那几秒，木梁倒计时同步暂停（见 updateLvl4Timer） */
    tankMesh.getWorldPosition(_wp);
    spawnSparks(_wp.x, _wp.y, _wp.z, 0x7ec8ff, 26, 3.2);
    SFX.ping();
    say('打中了压力罐——它踉跄着僵住了。', 3000);
  } else {
    const hp = cam.position.clone().addScaledVector(_aimDir, 2.6);
    spawnSparks(hp.x, hp.y, hp.z, 0xd9a06a, 10, 1.6);
  }
}

/* ---- 压弹演出用的道具：一只弹匣 + 待压的散弹（挂在相机下）---- */
let magObj = null, magBullets = [], magInHand = false;
function ensureMagProp() {
  if (magObj) return;
  magObj = new THREE.Group();
  const steelM = M(0x14171b, { r: 0.5, m: 0.75 });
  const brassM = M(0xa8842f, { r: 0.32, m: 0.88 });
  // 匣体（细长盒）+ 底板 + 侧面观察孔
  magObj.add(put(box(0.030, 0.115, 0.026, steelM), 0, 0, 0));
  magObj.add(put(box(0.040, 0.008, 0.030, M(0x0d1013, { r: 0.55, m: 0.7 })), 0, -0.062, 0));
  for (let i = 0; i < 4; i++) {
    magObj.add(put(box(0.006, 0.006, 0.028, M(0x05070a)), 0.010, -0.040 + i * 0.024, 0));
  }
  // 匣口（上端的进弹唇）
  magObj.add(put(box(0.032, 0.010, 0.028, M(0x1c2126, { r: 0.45, m: 0.8 })), 0, 0.060, 0));
  // 匣内待压的子弹：先全部隐藏，压一颗显一颗
  magBullets = [];
  for (let i = 0; i < MAG_CAP; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.0048, 0.0052, 0.019, 6), brassM);
    b.rotation.z = Math.PI / 2;
    b.position.set(0, 0.048 - i * 0.0145, 0);
    b.visible = false;
    magObj.add(b);
    magBullets.push(b);
  }
  magObj.visible = false;
  handRig.add(magObj);
}
/* 一颗正在被压进去的子弹（从画面下方飞到匣口） */
let pressBullet = null;
function ensurePressBullet() {
  if (pressBullet) return;
  pressBullet = new THREE.Mesh(new THREE.CylinderGeometry(0.0048, 0.0052, 0.019, 6),
    M(0xa8842f, { r: 0.32, m: 0.88 }));
  pressBullet.rotation.z = Math.PI / 2;
  pressBullet.visible = false;
  handRig.add(pressBullet);
}

/* ---- 压弹：R 键。演出顺序 ----
   1) 手枪压低移出画面（放下枪）
   2) 弹匣从画面下方升起到中间
   3) 子弹一颗颗从下方飞进匣口（每颗一声）
   4) 弹匣插回手枪，手枪抬回持握位，拉套筒上膛 */
function startReload() {
  if (reloadT > 0 || magInHand) return;
  if (!itemInHand('pistol')) return;
  const bi = invFind('bullets');
  const have = bi >= 0 ? (inv[bi].count || 0) : 0;
  if (magLoaded >= MAG_CAP && chambered) { say('弹匣是满的。', 1600); return; }
  /* 没散弹了：只拉套筒（弹匣里还有弹才有意义） */
  if (have <= 0) {
    if (magLoaded > 0 && (slideLocked || !chambered)) { reloadStep = 99; reloadT = 0.55; return; }
    say('身上没有子弹了。', 2000);
    return;
  }
  ensureMagProp(); ensurePressBullet();
  magInHand = true;
  reloadStep = 1;                 // 1=放下枪+举匣, 2=逐颗压, 3=插回, 99=拉套筒
  reloadT = 0.5;
  reloadPhase = 0;
  /* 匣里已有的弹先显示出来 */
  for (let i = 0; i < MAG_CAP; i++) magBullets[i].visible = i < magLoaded;
  magObj.visible = true;
  say('（压弹……）', 1400);
}
let reloadPhase = 0;              // 演出内部计时（0..1 用于插值）
let gunDownK = 0;                 // 手枪"放下"程度 0..1
/* 压弹推进：按 reloadStep 走演出，同时驱动手枪/弹匣的位移动画 */
function updateReload(dt) {
  /* --- 动画部分：每帧插值（即使 reloadT 已走完也要把姿态摆回去）--- */
  const recG = recOf('pistol');
  const gunM = recG && (recG.held || recG.obj);
  const gunPose = HAND_POSE.pistol && HAND_POSE.pistol.R;
  if (gunM && gunPose && (magInHand || reloadStep === 99 || gunDownK > 0)) {
    /* 放下枪：往下沉 + 转向内侧 */
    const wantDown = (magInHand && reloadStep <= 2) ? 1 : 0;
    gunDownK += (wantDown - gunDownK) * Math.min(1, dt * 6);
    if (gunDownK > 0.002) {
      gunM.position.set(gunPose.p[0] + gunDownK * 0.04,
        gunPose.p[1] - gunDownK * 0.22, gunPose.p[2] + gunDownK * 0.06);
      gunM.rotation.set(gunPose.r[0] + gunDownK * 0.5, gunPose.r[1], gunPose.r[2] - gunDownK * 0.35);
    } else if (gunM.parent === handRig) {
      gunM.position.set(gunPose.p[0], gunPose.p[1], gunPose.p[2]);
      gunM.rotation.set(gunPose.r[0], gunPose.r[1], gunPose.r[2]);
      gunDownK = 0;
    }
  }
  if (magObj && magObj.visible) {
    /* 弹匣：从画面下方升到中间（step1），压弹时停住（step2），插回时移向枪（step3） */
    let mp;
    if (reloadStep === 1) {
      const k = 1 - Math.max(0, reloadT) / 0.5;
      mp = [0.02, -0.42 + 0.24 * k, -0.34];
    } else if (reloadStep === 2) {
      mp = [0.02, -0.18, -0.34];
    } else {
      const k = 1 - Math.max(0, reloadT) / 0.45;   // step3：插进握把
      mp = [0.02 + 0.13 * k, -0.18 - 0.02 * k, -0.34 - 0.04 * k];
    }
    magObj.position.set(mp[0], mp[1], mp[2]);
    magObj.rotation.set(0.1, 0, reloadStep === 3 ? -0.26 * (1 - Math.max(0, reloadT) / 0.45) : 0.02);
  }
  /* 正在压入的那颗子弹：从下方飞到匣口 */
  if (pressBullet && pressBullet.visible && reloadStep === 2) {
    const k = 1 - Math.max(0, reloadT) / 0.34;
    const e = k * k;
    pressBullet.position.set(0.02, -0.34 + 0.20 * e, -0.32);
    if (k > 0.92) pressBullet.visible = false;
  }

  /* --- 计时部分 --- */
  if (reloadT <= 0) return;
  reloadT -= dt;
  if (reloadT > 0) return;

  const bi = invFind('bullets');
  const have = bi >= 0 ? (inv[bi].count || 0) : 0;

  if (reloadStep === 1) {                 // 弹匣举到位 → 开始压第一颗
    reloadStep = 2;
    if (have > 0 && magLoaded < MAG_CAP) {
      pressBullet.visible = true; pressBullet.position.set(0.02, -0.34, -0.32);
      reloadT = 0.34;
    } else { reloadStep = 3; reloadT = 0.45; }
    return;
  }
  if (reloadStep === 2) {                 // 一颗压进去了
    if (have > 0 && magLoaded < MAG_CAP) {
      inv[bi].count--;
      magLoaded++;
      if (magBullets[magLoaded - 1]) magBullets[magLoaded - 1].visible = true;
      SFX.magPress();
      if (inv[bi].count <= 0) inv[bi] = null;
      refreshInventoryHUD();
    }
    pressBullet.visible = false;
    /* 还能继续压就再来一颗，否则进入插匣 */
    const bi2 = invFind('bullets');
    if (bi2 >= 0 && (inv[bi2].count || 0) > 0 && magLoaded < MAG_CAP) {
      pressBullet.visible = true; pressBullet.position.set(0.02, -0.34, -0.32);
      reloadT = 0.34;
    } else {
      reloadStep = 3; reloadT = 0.45;
    }
    return;
  }
  if (reloadStep === 3) {                 // 弹匣插进握把
    magObj.visible = false;
    magInHand = false;
    SFX.magIn();
    /* 没上膛/套筒后定 → 接着拉套筒 */
    if (slideLocked || !chambered) { reloadStep = 99; reloadT = 0.42; }
    else { reloadStep = 0; say('压好了。', 1500); }
    return;
  }
  if (reloadStep === 99) {                // 拉套筒上膛
    if (magLoaded > 0) { magLoaded--; chambered = true; }
    slideLocked = false; slideT = 0.16;
    SFX.slideRelease();
    refreshInventoryHUD();
    reloadStep = 0;
    say(chambered ? '上膛了。' : '空的。', 1600);
    return;
  }
}

/* 枪声 / 砸门 / 空枪 */
SFX.shot = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.4);
  const g = AC.createGain();
  g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
  s.connect(lp); lp.connect(g); g.connect(master); s.start();
  const o = AC.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
  const og = AC.createGain(); og.gain.setValueAtTime(0.5, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  o.connect(og); og.connect(master); o.start(); o.stop(t + 0.2);
};
SFX.slam = function () {                     // 门被撞开
  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.5);
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
  const g = AC.createGain();
  g.gain.setValueAtTime(1.0, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  s.connect(lp); lp.connect(g); g.connect(master); s.start();
  const o = AC.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(72, t); o.frequency.exponentialRampToValueAtTime(30, t + 0.4);
  const og = AC.createGain(); og.gain.setValueAtTime(0.8, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  o.connect(og); og.connect(master); o.start(); o.stop(t + 0.55);
};
SFX.click = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const o = AC.createOscillator(); o.type = 'square'; o.frequency.value = 1900;
  const g = AC.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  o.connect(g); g.connect(master); o.start(); o.stop(t + 0.06);
};
SFX.tick2 = function () {                  // 空枪第二声咔嗒（击锤落空）
  if (!AC) return;
  setTimeout(function () { SFX.click(); }, 90);
};
SFX.ping = function () {                   // 打中金属罐
  if (!AC) return;
  const t = AC.currentTime;
  [1250, 1980, 3150].forEach(function (f, i) {
    const o = AC.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 0.72, t + 0.3);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.22 / (i + 1), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
    o.connect(g); g.connect(master); o.start(); o.stop(t + 0.36);
  });
};
/* 脚步：金属蹄踏地，音量按距离衰减（d = 与玩家的水平距离）*/
SFX.step = function (d) {
  if (!AC) return;
  const v = Math.max(0, 1 - d / 15);
  if (v < 0.03) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.09);
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.5 * v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  s.connect(lp); lp.connect(g); g.connect(master); s.start();
  const o = AC.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(58, t + 0.07);
  const og = AC.createGain(); og.gain.setValueAtTime(0.3 * v, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(og); og.connect(master); o.start(); o.stop(t + 0.1);
};
/* 套筒后定（打空那一下的"锵"）*/
SFX.slideLock = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.12);
  const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 3;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.4, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
  s.connect(bp); bp.connect(g); g.connect(master); s.start();
  const o = AC.createOscillator(); o.type = 'square';
  o.frequency.setValueAtTime(720, t); o.frequency.exponentialRampToValueAtTime(300, t + 0.08);
  const og = AC.createGain(); og.gain.setValueAtTime(0.16, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  o.connect(og); og.connect(master); o.start(); o.stop(t + 0.12);
};
/* 拉套筒上膛（金属滑动 + 闭锁"咔锵"）*/
SFX.slideRelease = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.22);
  const bp = AC.createBiquadFilter(); bp.type = 'bandpass';
  bp.frequency.setValueAtTime(1200, t); bp.frequency.linearRampToValueAtTime(3400, t + 0.18);
  bp.Q.value = 2.2;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.28, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
  s.connect(bp); bp.connect(g); g.connect(master); s.start();
  setTimeout(function () { SFX.slideLock(); }, 190);      // 闭锁那一声
};
/* 压弹：一颗子弹压进弹匣（金属摩擦 + 弹簧）*/
SFX.magPress = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.1);
  const hp = AC.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.22, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
  s.connect(hp); hp.connect(g); g.connect(master); s.start();
  const o = AC.createOscillator(); o.type = 'sine';
  o.frequency.setValueAtTime(880, t); o.frequency.exponentialRampToValueAtTime(1450, t + 0.07);
  const og = AC.createGain(); og.gain.setValueAtTime(0.1, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  o.connect(og); og.connect(master); o.start(); o.stop(t + 0.1);
};
/* 弹壳落地：金属薄壳的"当啷"——非谐和的多分音 + 噪声瞬态，
   不用纯正弦（那个听起来像玻璃/玻璃杯） */
SFX.shellTink = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const base = 1150 + Math.random() * 550;
  /* 噪声瞬态：金属撞击的"嗒"，是金属感的关键 */
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.06);
  const bpN = AC.createBiquadFilter(); bpN.type = 'bandpass';
  bpN.frequency.value = base * 2.4; bpN.Q.value = 1.1;
  const gN = AC.createGain();
  gN.gain.setValueAtTime(0.16, t); gN.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
  s.connect(bpN); bpN.connect(gN); gN.connect(master); s.start();
  /* 非整数倍分音（金属特征）：三角波带更多高次，衰减长短不一 */
  const ratios = [1, 2.76, 5.4, 8.93];
  const decays = [0.34, 0.26, 0.18, 0.12];
  for (let i = 0; i < ratios.length; i++) {
    const o = AC.createOscillator();
    o.type = i === 0 ? 'triangle' : 'sine';
    o.frequency.setValueAtTime(base * ratios[i], t);
    // 轻微下滑，像壳在地上滚
    o.frequency.exponentialRampToValueAtTime(base * ratios[i] * 0.94, t + decays[i]);
    const g = AC.createGain();
    g.gain.setValueAtTime(0.085 / (1 + i * 0.9), t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + decays[i]);
    o.connect(g); g.connect(master); o.start(); o.stop(t + decays[i] + 0.02);
  }
};
/* 弹匣插入握把（"咔哒"闷响 + 卡榫）*/
SFX.magIn = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.13);
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.42, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
  s.connect(lp); lp.connect(g); g.connect(master); s.start();
  const o = AC.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(320, t); o.frequency.exponentialRampToValueAtTime(120, t + 0.09);
  const og = AC.createGain(); og.gain.setValueAtTime(0.26, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
  o.connect(og); og.connect(master); o.start(); o.stop(t + 0.13);
};
SFX.chop = function () {                   // 斧头劈进木头  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.16);
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
  s.connect(lp); lp.connect(g); g.connect(master); s.start();
  const o = AC.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(210, t); o.frequency.exponentialRampToValueAtTime(80, t + 0.1);
  const og = AC.createGain(); og.gain.setValueAtTime(0.4, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
  o.connect(og); og.connect(master); o.start(); o.stop(t + 0.15);
};

/* 收音机：503 电视柜上的便携收音机，E 开关，先只有静电声。
   剧情内容（广播稿）之后再灌。 */let radioOn = false, radioSrc = null, radioGain = null;
function toggleRadio() {
  if (!AC) { say('收音机没有电。', 1600); return; }
  radioOn = !radioOn;
  if (radioOn) {
    if (!radioSrc) {
      radioSrc = AC.createBufferSource();
      radioSrc.buffer = SFX.noise(3); radioSrc.loop = true;
      const bp = AC.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = 1700; bp.Q.value = 0.5;
      const am = AC.createOscillator(); am.frequency.value = 0.4;   // 静电的起伏
      const amg = AC.createGain(); amg.gain.value = 900;
      am.connect(amg); amg.connect(bp.frequency); am.start();
      radioGain = AC.createGain(); radioGain.gain.value = 0.0;
      radioSrc.connect(bp); bp.connect(radioGain); radioGain.connect(master);
      radioSrc.start();
    }
    radioGain.gain.linearRampToValueAtTime(0.06, AC.currentTime + 0.5);
    say('……只有静电。什么台都没有。', 2600);
  } else if (radioGain) {
    radioGain.gain.linearRampToValueAtTime(0.0, AC.currentTime + 0.4);
  }
}

/* ==================== 结局 1：猎魔人的信仰之跃 ====================
   翻窗 → 坠落（风粒子 + 风声）→ 落地侧脸 → 血泊扩散 → 闭眼 → 大字幕
   分段全部用挂钟秒数驱动，掉帧也不会拖长 */
let fallT0 = 0, fallPhase = 0, windPts = null, bloodMesh = null, endTitleShown = false;
let fallEndingLine = '结局 1', fallEndingName = '猎魔人的信仰之跃';
let acQteSawObj = null;
let acQteSawLight = null;        // 克隆电锯的锯尖火光（原版由机器人更新驱动，克隆体要自己闪）
const acQteSawWorld = new THREE.Vector3();   // 电锯钉回墙面后的世界坐标（分镜瞟它用）
let acSickleHook = null;         // 钩在第 5 台外机支架上的镰刀模型（成功分镜用）
let acLadderGrp = null, acLadderReady = false;   // 救援梯（挂在钩点旁，按 E 登上）
let crawlStage = 0;               // 爬行 CG 当前阶段（落地音效一次性触发用）
let acRescueBeam = null;         // 救援探照灯（参考天台直升机的探照灯）
let escapeEndingLine = '结局 2', escapeEndingName = '飞升撤离';   // 撤离 CG 字幕（救援线改为「这次不行」）
let escapeRescue = false;        // 撤离 CG 的四楼救援变体：相机往南漂（不穿楼），注视点跟随机器人实际标高
let FALL_FREEZE = null;      // 调试：把坠落序列定格在某一秒
function ensureFallProps() {
  if (!windPts) {
    /* 风粒子：竖直细条，坠落时从下往上飞过镜头 */
    const n = 260, g = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 7;
      pos[i * 3 + 1] = Math.random() * 26 - 13;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 7;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    windPts = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xbfd2dd, size: 0.055, transparent: true, opacity: 0.0,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }));
    scene.add(windPts);
  }
  if (!bloodMesh) {
    /* 血泊：贴地的圆面，用 canvas 做出不规则边缘和中心的深色 */
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    const rg = c.createRadialGradient(64, 64, 6, 64, 64, 62);
    /* 用不受光材质，所以贴图本身就得够亮，否则在暗沥青上分不出来 */
    rg.addColorStop(0, 'rgba(126,10,13,0.98)');
    rg.addColorStop(0.5, 'rgba(92,7,10,0.88)');
    rg.addColorStop(0.82, 'rgba(58,4,6,0.5)');
    rg.addColorStop(1, 'rgba(34,2,3,0)');
    c.fillStyle = rg; c.fillRect(0, 0, 128, 128);
    // 边缘泼溅
    c.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * 6.28, r = 40 + Math.random() * 26;
      c.fillStyle = 'rgba(104,8,11,' + (0.35 + Math.random() * 0.5) + ')';
      c.beginPath();
      c.ellipse(64 + Math.cos(a) * r, 64 + Math.sin(a) * r,
        2 + Math.random() * 6, 2 + Math.random() * 5, a, 0, 6.28);
      c.fill();
    }
    bloodMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(cv), transparent: true,
        opacity: 0, depthWrite: false
      }));
    bloodMesh.rotation.x = -Math.PI / 2;
    bloodMesh.visible = false;
    scene.add(bloodMesh);
  }
}
function spawnGlassShards4() {
  for (const sh of glassShards4) { if (sh.parent) sh.parent.remove(sh); }
  glassShards4 = []; if (!caseGlass4 || !caseGlass4.parent) return;
  const base = caseGlass4.position;
  for (let i = 0; i < 12; i++) {
    const w = 0.10 + Math.random()*0.22, h = 0.10 + Math.random()*0.28;
    const geo = new THREE.BufferGeometry(); const j = (Math.random()-0.5)*0.18;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0,w,j,0,-j,h,0]),3));
    const sh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({color:0xbfe8f4,transparent:true,opacity:0.82,side:THREE.DoubleSide,depthWrite:false}));
    sh.position.set(base.x-0.035, base.y+(Math.random()-0.5)*0.72, base.z+(Math.random()-0.5)*0.50);
    sh.rotation.set(Math.random()*0.8, Math.PI/2+(Math.random()-0.5)*0.25, Math.random()*Math.PI*2);
    sh.userData.vx=-(0.25+Math.random()*0.45); sh.userData.vy=(Math.random()-0.15)*0.55; sh.userData.vz=(Math.random()-0.5)*0.5; sh.userData.spin=(Math.random()-0.5)*8;
    caseGlass4.parent.add(sh); glassShards4.push(sh);
  }
}
function updateGlassBreak(dt) {
  if (typeof glassBreakT !== 'number' || glassBreakT <= 0) return;
  glassBreakT=Math.max(0,glassBreakT-dt); const fade=glassBreakT/0.90;
  for (const sh of glassShards4) { sh.position.x+=sh.userData.vx*dt; sh.position.y+=sh.userData.vy*dt; sh.position.z+=sh.userData.vz*dt; sh.userData.vy-=1.4*dt; sh.rotation.x+=sh.userData.spin*dt; sh.rotation.z+=sh.userData.spin*0.7*dt; sh.material.opacity=Math.max(0,fade*0.82); }
  if (glassBreakT<=0.001) { for (const sh of glassShards4) if (sh.parent) sh.parent.remove(sh); glassShards4=[]; }
}
function spawnWindowShards4() {
  if (!acWindowGlass || !acWindowGlass.parent) return;
  const base = acWindowGlass.position, parent = acWindowGlass.parent;
  // 清理旧窗户碎片，仅保留本次飞散
  for (const sh of glassShards4) if (sh.parent) sh.parent.remove(sh);
  glassShards4 = [];
  for (let i=0;i<14;i++) {
    const w=0.12+Math.random()*0.24, h=0.10+Math.random()*0.30, g=new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0,0,0,w,0,0,(Math.random()-0.5)*0.18,h,0]),3));
    const sh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0xbfe8f4,transparent:true,opacity:0.88,side:THREE.DoubleSide,depthWrite:false}));
    sh.position.set(base.x-0.03,base.y+(Math.random()-0.5)*0.7,base.z+(Math.random()-0.5)*1.0); sh.rotation.y=Math.PI/2; sh.rotation.z=Math.random()*6.28;
    sh.userData.vx=-(0.2+Math.random()*0.5); sh.userData.vy=(Math.random()-0.3)*0.8; sh.userData.vz=(Math.random()-0.5)*0.9; sh.userData.spin=(Math.random()-0.5)*9;
    parent.add(sh); glassShards4.push(sh);
  }
  glassBreakT=0.95;
}
function beginAcClimb() {
  if (state!=='play' || curLevel!==-1 || !acWindowBroken || acClimbMode) return;
  acClimbMode=1; acClimbIndex=0; acJumpT=0; acMountT=1.1; playerPos.x=4.9; playerPos.z=-2.15; playerFloorY=-2.90; clearMoveInput(); promptEl.classList.remove('show'); say('攀爬到空调外机上，小心脚下。',2600);
  /* 上外机就有微弱的直升机声——救援在来的路上（后续挂在外机等救援） */
  if (AC && heliTimer < 0) startHeliSound();
  if (heliGain && AC) heliGain.gain.setTargetAtTime(0.085, AC.currentTime, 2.5);
}
function updateAcClimb(dt) {
  if (!acClimbMode) return false; if (acClimbMode>=2) { playerPos.x=-4.7; playerPos.z=-3.05; return true; }
  const xs=[4.9,1.7,-1.5,-4.7,-7.0];
  if (acMountT>0) { acMountT=Math.max(0,acMountT-dt); const p=1-acMountT/1.1,e=p*p*(3-2*p); playerPos.x=4.9; playerPos.z=-2.15-e*0.90; lookPitch=-0.12+Math.sin(p*Math.PI)*0.15; return true; }
  if (acJumpT>0) {
    acJumpT=Math.max(0,acJumpT-dt); const p=1-acJumpT/0.82, e=p*p*(3-2*p);
    // 跳跃只做水平跨越 + 垂直抛物线；不要让镜头向墙外平移（先上后下）
    playerPos.x=acJumpFromX+(acJumpToX-acJumpFromX)*e;
    playerPos.z=-3.05;
    playerFloorY=-2.90 + Math.sin(p*Math.PI)*0.34;
    lookPitch=-0.03 - Math.sin(p*Math.PI)*0.08;
    if(acJumpT<=0){ playerFloorY=-2.90; lookPitch=-0.03; acClimbIndex++; if(acClimbIndex>=3){ beginAcQte(); } }
    return true;
  }
  const dir=(moveKeys.right?1:0)-(moveKeys.left?1:0); if(dir){playerPos.x+=dir*dt*0.72; playerPos.x=clamp(playerPos.x,xs[acClimbIndex]-0.54,xs[acClimbIndex]+0.54);} playerPos.z=-3.05; return true;
}
if(!document.getElementById('acQteStyle')){ const st=document.createElement('style'); st.id='acQteStyle'; st.textContent='@keyframes acPulse{to{transform:scale(1.12);background:#c96a1e}}'; document.head.appendChild(st);}
function ensureAcQteSaw(){
  if (acQteSawObj) return;
  acQteSawObj = chainsaw.clone(true); acQteSawObj.traverse(function(o){ if(o.isMesh) o.material = o.material.clone(); });
  acQteSawLight = null;
  acQteSawObj.traverse(function(o){ if(o.isPointLight) acQteSawLight = o; });
  acQteSawObj.scale.setScalar(1.15); cam.add(acQteSawObj);
}
function clearAcQteSaw(){ if(acQteSawObj){ if(acQteSawObj.parent) acQteSawObj.parent.remove(acQteSawObj); acQteSawObj=null; } acQteSawLight=null; }
/* QTE 按键反馈：进度条闪一下黄色。键盘和触屏共用同一条路径，
   免得两套实现的行为慢慢分叉。 */
function acQteFlash() {
  const bar = document.querySelector('#acQte .qbar i');
  if (bar) { bar.style.background = '#ffd060'; setTimeout(function () { bar.style.background = '#f60'; }, 90); }
}
/* 抓钩 QTE 的一次按键：+0.10 进度，够 0.98 就翻过第 4 阶段。
   空格键和触屏点击都走这里，手机上没有空格键。 */
function acQteTap() {
  if (acQte !== 3) return false;
  acQteProgress = Math.min(1, acQteProgress + 0.10);
  SFX.step(false); acQteFlash();
  return true;
}
/* QTE 覆盖层：居中的空格键帽 + 下方进度条（子弹时间抓钩） */
function ensureAcQteDom(){
  let q=document.getElementById('acQte');
  if(!q){
    q=document.createElement('div'); q.id='acQte';
    /* 桌面按空格、手机点屏幕，两种输入都要说清楚 */
    const cap = isTouchMode() ? '点屏幕' : '空格';
    q.style.cssText='position:fixed;left:50%;top:54%;transform:translateX(-50%);z-index:40;color:#fff;text-align:center;font:700 26px "Segoe UI",sans-serif;text-shadow:0 2px 8px #000;pointer-events:none;display:none';
    q.innerHTML='<div class="qkey" style="border:3px solid #fff;border-radius:10px;padding:10px 34px;display:inline-block;font-size:30px;letter-spacing:8px;animation:acPulse .5s infinite alternate">'+cap+'</div>'+
      '<div class="qbar" style="width:280px;height:12px;border:2px solid #fff;margin:14px auto 0;background:rgba(0,0,0,.55)"><i style="display:block;height:100%;width:0;background:#f60"></i></div>'+
      '<div style="margin-top:10px;font-size:14px;font-weight:400;letter-spacing:3px;color:rgba(255,255,255,.85)">连点'+cap+' · 用镰刀钩住下一台外机！</div>';
    document.body.appendChild(q);
  }
  return q;
}
function hideAcQteDom(){ const q=document.getElementById('acQte'); if(q) q.style.display='none'; }
function acQteCleanup(){
  acQte=0; acFloorY=null; acFallVy=0; hideAcQteDom(); clearAcQteSaw();
  if(acSickleHook){ if(acSickleHook.parent) acSickleHook.parent.remove(acSickleHook); acSickleHook=null; }
  if(SFX.isChainsawOn){ SFX.stopChainsaw(); SFX.isChainsawOn=false; }
}
/* 救援梯 / 探照灯 / 撤离字幕复位（进入 4F 与整局重开都要调） */
function resetAcRescueProps(){
  if (acLadderGrp && lvl4Grp) lvl4Grp.remove(acLadderGrp);
  acLadderGrp = null; acLadderReady = false;
  if (acRescueBeam){
    if (acRescueBeam.target && acRescueBeam.target.parent) acRescueBeam.target.parent.remove(acRescueBeam.target);
    if (acRescueBeam.parent) acRescueBeam.parent.remove(acRescueBeam);
  }
  acRescueBeam = null;
  escapeEndingLine = '结局 2'; escapeEndingName = '飞升撤离';
  escapeRescue = false;
}
function beginAcQte(){
  acQte=1; acQteProgress=0; acQteT=0; acQteCamYaw=lookYaw; acClimbMode=3;
  clearMoveInput(); promptEl.classList.remove('show'); document.body.classList.add('cg');
  acFloorY=-2.90;                                   // 从这里开始垂直高度由 CG 接管
  for(let ui=0;ui<acUnitMeshes.length;ui++) acUnitMeshes[ui].matrixAutoUpdate=true;
  /* 进入坠落 CG：左上角倒计时任务收起，任务更新为「会赢吗？」；直升机声渐强 */
  hideObjective();
  showObjective('会赢吗？', '');
  const tElQ=document.getElementById('objTimer'); if(tElQ) tElQ.classList.remove('show');
  if (heliTimer < 0 && heliGain && AC) heliGain.gain.setTargetAtTime(0.3, AC.currentTime, 5.0);
  /* 电锯藏在镜头左前方深处（刺出瞬间才显形）；镜头先缓缓转向下一台外机
     导板水平转向 90°：长刃横在画面里，而不是被机身挡成一块板 */
  ensureAcQteSaw(); acQteSawObj.visible=false;
  acQteSawObj.position.set(-0.38,-0.06,-1.85); acQteSawObj.rotation.set(0.12,Math.PI/2,0.14);
  ensureAcQteDom();
}
function updateAcQte(dt){
  if(!acQte) return;
  acQteT+=dt;

  if(acQte===1){                       /* ① 以当前视角缓缓挪向下一台外机 → 电锯刺出 */
    /* 就近转向：把目标角差归一化到 [-π,π]，避免绕远转好几圈 */
    let dYaw = ((Math.PI/2 - SIT.yaw) - lookYaw) % (Math.PI*2);
    if (dYaw > Math.PI) dYaw -= Math.PI*2;
    if (dYaw < -Math.PI) dYaw += Math.PI*2;
    const k=Math.min(1,acQteT/1.5), e=k*k*(3-2*k);
    lookYaw += dYaw * Math.min(1, dt*(2.0+e*3.5));
    lookPitch += (-0.10-lookPitch) * Math.min(1, dt*2.5);
    if(acQteT>=1.5 && !acQteSawObj.visible){
      acQteSawObj.visible=true; heliShakeAmt=0.55;
      SFX.startChainsaw(); SFX.revChainsaw(1.0);
      setTimeout(function(){ if(SFX.isChainsawOn) SFX.revChainsaw(0.85); }, 420);
    }
    /* 电锯是"刺出来"的：从墙体深处 (z=-2.3) 快速捅到 -1.35，带缓出和火花；
       锯尖火光闪烁（原版由机器人更新驱动，克隆体自己闪），读得出是台运转中的电锯 */
    if(acQteSawObj.visible){
      const sk=Math.min(1,(acQteT-1.5)/0.24), se=1-Math.pow(1-sk,3);   // easeOutCubic：猛地刺出
      acQteSawObj.position.z = -2.3 + 0.95*se;
      if(acQteSawLight) acQteSawLight.intensity = 0.14 + Math.random()*0.26;
      if(sk>=1 && !acQteSawObj.userData.stabbed){
        acQteSawObj.userData.stabbed = true;
        spawnSparks(PR.x+playerPos.x-0.4, PR.y-2.90+playerFloorY+1.5, PR.z-2.4, 0xcfd8de, 12, 1.6);
      }
    }
    if(acQteT>2.7){
      acQte=2; acQteT=0; SFX.pry();   // 金属呻吟：外机要断了
      /* 电锯就此钉在墙里：从镜头道具转为世界道具。
         位置与朝向都按世界值搬运 —— 否则镜头的旋转会被重新解释，
         电锯会凭空再转 90° */
      if(acQteSawObj){
        const swp=new THREE.Vector3(); acQteSawObj.getWorldPosition(swp);
        const swq=new THREE.Quaternion(); acQteSawObj.getWorldQuaternion(swq);
        cam.remove(acQteSawObj); lvl4Grp.add(acQteSawObj);
        acQteSawObj.position.copy(lvl4Grp.worldToLocal(swp));
        acQteSawObj.quaternion.copy(swq);
        acQteSawWorld.set(swp.x, swp.y, swp.z);
      }
    }
    return;
  }
  if(acQte===2){                       /* ② 脚下震动 → 低头看：外机倾斜、摇摇欲坠 */
    heliShakeAmt = Math.max(0.3, heliShakeAmt*Math.pow(0.08, dt));
    lookPitch += (-0.88-lookPitch) * Math.min(1, dt*4);
    const u=acUnitMeshes[3], h=acUnitHome[3];
    if(u&&h){ const k=Math.min(1,acQteT/1.3);
      u.rotation.x = h.rx + 0.46*k*k + Math.sin(acQteT*30)*0.006;
      u.position.y = h.y - 0.14*k;
    }
    if(acQteT>1.5){                    /* ③ 彻底断开 → 连人带机坠落（子弹时间）
                                          （电锯已在 ①→② 钉进墙里，保持原位不动） */
      acQte=3; acQteT=0; acFallVy=0;
      if(SFX.isChainsawOn){ SFX.stopChainsaw(); SFX.isChainsawOn=false; }
      SFX.wind(1.6);
      ensureAcQteDom().style.display='block';
    }
    return;
  }
  if(acQte===3){                       /* ③ 子弹时间坠落：极其缓慢的时间流动 ——
                                          拖得越久位置越低，获救的机会越渺茫 */
    acFallVy = Math.min(0.12, acFallVy + dt*0.5);          // 几近凝滞的下坠（子弹时间）
    acFloorY = playerFloorY - acFallVy*dt;
    playerFloorY = acFloorY;
    const u=acUnitMeshes[3];
    if(u && !u.userData.landed){ u.position.y -= acFallVy*dt; u.rotation.z += dt*0.06; }
    acQteProgress = Math.max(0, acQteProgress - dt*0.015); // 泄条很慢，节奏交给玩家
    const q=document.getElementById('acQte');
    if(q){ const i=q.querySelector('i'); if(i) i.style.width=(acQteProgress*100)+'%'; }
    lookPitch += (-0.5-lookPitch) * Math.min(1, dt*1.2);
    heliShakeAmt = 0.22;
    if(acQteProgress>=0.98){           /* ★ 成功：镰刀钩住下一台 */
      acQte=4; acQteT=0; acQteProgress=1;
      hideAcQteDom(); document.body.classList.remove('cg');
      setHeldItemsVisible(true);
      /* 镰刀建模钩在第 5 台外机的支架上：刀刃扣住横杆，柄垂向玩家 */
      if(!acSickleHook && toolsHeldObj && toolsHeldObj.children[1]){
        acSickleHook = toolsHeldObj.children[1].clone(true);
        acSickleHook.position.set(0.34, -0.24, 0.17);      // 支架横杆位置（机身局部）
        acSickleHook.rotation.set(2.75, 0.25, 0.35);       // 倒挂：月牙扣杆、柄垂下
        acSickleHook.scale.setScalar(1.15);
        acUnitMeshes[4].add(acSickleHook);
      }
    } else if(playerFloorY < -4.4){    /* ★ 失败：坠到明显低于外机半个身位 ——
                                          这个深度在现实里已经抓不住任何东西了 */
      const failFrom={x:PR.x+playerPos.x, y:PR.y+playerFloorY+1.58, z:PR.z-3.05};
      acQteCleanup();
      document.body.classList.remove('cg');
      beginFallEnding('结局 5','差一步美满', failFrom, '（差一步……就差一步！）');
    }
    return;
  }
  if(acQte===4){                       /* ④ 分镜：看刀刃钩住支架 → 瞟电锯 → 听砸地声 →
                                          低头看燃烧的残骸 → 之后一直挂在钩点下摇摆
                                          （玩家没有爬上去——后续等直升机救援） */
    const th=Math.sin(acQteT*2.3)*0.5;
    playerPos.x = -6.68 + Math.sin(th)*1.05 + Math.sin(acQteT*13)*0.03;   // 摆荡 + 高频抖
    playerPos.z = -3.05 + Math.sin(acQteT*1.7)*0.12 + Math.cos(acQteT*11)*0.02;
    acFloorY = -2.15 - Math.cos(th)*1.45 - 1.2;        // 视点整个低于外机顶一大截
    playerFloorY = acFloorY;
    heliShakeAmt = Math.max(heliShakeAmt*Math.pow(0.4, dt), 0.18);   // 持续的细碎颤动
    /* 断裂的外机以真实重力坠向楼下泥地 */
    const u=acUnitMeshes[3];
    if(u && !u.userData.landed){
      acFallVy += 9.8*dt;
      u.position.y -= acFallVy*dt;
      u.rotation.z += dt*1.4;
      if(u.position.y <= -13.45){
        u.position.y = -13.45; u.userData.landed = true;
        u.rotation.x = 0.1; u.rotation.z = 0.35;
        SFX.thud('hard'); SFX.boom();
        spawnSparks(PR.x-4.7, PR.y-13.2, PR.z-3.1, 0x5a4a34, 26, 2.4);
        heliShakeAmt = 0.4;
        /* 残骸带火：楼下黑暗里也要看得见它砸在那里 */
        addFlame(u, -0.2, 0.42, 0.05, 0.8, 1.25);
        addFlame(u, 0.28, 0.3, -0.08, 0.55, 0.95);
        u.add(put(new THREE.PointLight(0xff5a1e, 1.6, 8, 2), 0, 0.55, 0));
      }
    }
    /* 视线分镜：钩点 → 电锯 → 残骸 → 回正 */
    let wantP = 0.45, wantY2 = 0.3;                        // 仰头看刀刃钩进外机支架
    if(acQteT>=1.3 && acQteT<2.3){                         // 瞟一眼墙里的电锯
      const dx=acQteSawWorld.x-(PR.x+playerPos.x);
      const dy=acQteSawWorld.y-(PR.y+playerFloorY+1.58);
      const dz=acQteSawWorld.z-(PR.z+playerPos.z);
      wantY2 = Math.atan2(-dx,-dz);
      wantP = Math.atan2(dy, Math.hypot(dx,dz));
    } else if(acQteT>=2.3 && acQteT<3.5){ wantP = -1.25; } // 低头：楼下燃烧的残骸
    /* 救援探照灯：挂点稳定后从头顶斜射下来，扫两下再锁定玩家（参考天台直升机的探照灯） */
    if(acQteT>0.5){
      if(!acRescueBeam){
        acRescueBeam = new THREE.SpotLight(0xdfeaff, 0, 44, 0.22, 0.45, 1.2);
        const bt = new THREE.Object3D();
        lvl4Grp.add(acRescueBeam); lvl4Grp.add(bt);
        acRescueBeam.target = bt;
      }
      const bk = Math.min(1, (acQteT-0.5)/6);
      acRescueBeam.intensity = 0.6 + bk*3.0;
      const bs = Math.sin(acQteT*0.8) * (1-bk) * 3.0;
      acRescueBeam.position.set(PR.x + playerPos.x + 1.0 + bs, 24, PR.z - 3.05 + Math.cos(acQteT*0.6)*(1-bk)*2.0);
      acRescueBeam.target.position.set(PR.x + playerPos.x, PR.y + playerFloorY + 1.4, PR.z + playerPos.z);
    }
    let dY2 = (wantY2 - lookYaw) % (Math.PI*2);
    if(dY2 > Math.PI) dY2 -= Math.PI*2;
    if(dY2 < -Math.PI) dY2 += Math.PI*2;
    if(acQteT<3.5){                        // 分镜期间锁镜头；结束后交还自由视角
      lookYaw += dY2 * Math.min(1, dt*5);
      lookPitch += (wantP-lookPitch) * Math.min(1, dt*4);
    } else if(!lookActive){
      lookActive = true; requestLookLock();   // 可以转头看墙、看森林、看下面的火场
    }
    /* 挂在外机下的左右摇摆颤动：叠在视线分镜上 */
    lookYaw += Math.sin(acQteT*6.3)*0.014;
    lookPitch += Math.sin(acQteT*5.1)*0.01;
    if(acQteT>1.15 && acQteT-dt<=1.15) say('（钩住了——抓紧！！）', 1800);
    if(acQteT>2.35 && acQteT-dt<=2.35) say('（下面……砸下去了。）', 2000);
    /* 探照灯锁定后放下救援梯：按 E 登上 → 天台撤离 CG（结局 6 · 这次不行） */
    if(acQteT>=4.5 && !acLadderGrp){
      acLadderGrp = new THREE.Group();
      acLadderGrp.position.set(-6.68, -4.7, -3.05);
      lvl4Grp.add(acLadderGrp);
      const ropeM2 = M(0x8a7a5a, { r: 0.95 }), rungM2 = M(0x6b5136, { r: 0.9 });
      for (const rx2 of [-0.19, 0.19]) {
        const rope2 = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 10, 5), ropeM2);
        rope2.position.set(rx2, 5, 0); acLadderGrp.add(rope2);
      }
      for (let ri2 = 0; ri2 < 24; ri2++) {
        const rung2 = put(box(0.46, 0.035, 0.05, rungM2), 0, 0.25 + ri2 * 0.4, 0);
        rung2.rotation.z = (Math.random() - 0.5) * 0.05; acLadderGrp.add(rung2);
      }
      acLadderReady = true;
      showObjective('按 E 登上救援梯', '');
      say('（救援梯！抓住它！）', 2400);
    }
    /* 分镜结束后一直挂在钩点下摇摆——等玩家登上救援梯 */
  }
}
function acClimbJump(){ if(acClimbMode!==1||acMountT>0||acJumpT>0||acClimbIndex>=3)return; const xs=[4.9,1.7,-1.5,-4.7,-7.0]; if(Math.abs(playerPos.x-xs[acClimbIndex])<0.62){acJumpFromX=playerPos.x;acJumpToX=xs[acClimbIndex+1];acJumpT=0.82;clearMoveInput();SFX.step(false);} }
function beginFallEnding(line, name, from, sayText) {
  if (state === 'fall') return;
  fallEndingLine = line || '结局 1'; fallEndingName = name || '猎魔人的信仰之跃';
  achUnlock(fallEndingLine === '结局 5' ? 'end5' : 'end1');   // 结局成就：信仰之跃 / 差一步美满
  acQteCleanup();
  document.body.classList.remove('cg');
  ensureFallProps();
  clearSay();
  promptEl.classList.remove('show');
  document.body.classList.add('ending');    // CSS 统一收掉所有游戏内 UI
  hudEl.classList.remove('show');           // 双保险，不依赖 CSS 优先级
  staminaEl.classList.remove('show');
  if (document.pointerLockElement === canvas && document.exitPointerLock) document.exitPointerLock();
  lookActive = false;
  clearMoveInput();
  setState('fall');
  fallT0 = performance.now();
  fallPhase = 0;
  endTitleShown = false;
  // 记下起跳点：默认五楼窗口；AC 外机坠落线会传入当前空中位置
  if (from) fallFrom.set(from.x, from.y, from.z);
  else fallFrom.set(PR.x - 1.1, PR.y + 1.62, PR.z - 2.34);
  SFX.setFire(0.05);
  if (SFX.isChainsawOn) { SFX.stopChainsaw(); SFX.isChainsawOn = false; }
  SFX.wind(4.1);
  say(sayText || '这里是五楼。它说它会解救我。', 2600);
}
const fallFrom = new THREE.Vector3();
/* 五楼：房间地板 y=0，层高 2.8m ×  ≈ 4.85 层 → 地面在 y ≈ -13.6 */

function updateFallEnding() {
  /* ?fallt=2.5 可以把坠落序列定格在第 2.5 秒，方便逐帧调这段动画 */
  const sT = (FALL_FREEZE != null)
    ? FALL_FREEZE
    : (performance.now() - fallT0) / 1000;
  /* 0.0–1.5s 翻窗：镜头抬高、前倾，越过窗台
     1.5–4.2s 坠落：加速下落 + 翻滚 + 风粒子
     4.2s     落地：闪白 + 撞击声
     4.2–8.0s 侧脸躺地，血泊扩散
     6.5–9.0s 缓慢闭眼
     8.6s     大字幕 */
  const el = document.getElementById('endTitle');
  if (sT < FALL_T_JUMP) {
    // ① 翻窗：撑上窗台，身体前倾越过
    const k = sT / FALL_T_JUMP, e = k * k * (3 - 2 * k);
    cam.position.set(fallFrom.x, fallFrom.y + e * 0.34, fallFrom.z - e * 0.62);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(-0.14 - e * 0.58, 0.02, e * 0.07);
    if (windPts) windPts.material.opacity = e * 0.18;
  } else if (sT < FALL_T_TIP) {
    /* ② 翻过窗台的失重瞬间：几乎没有下坠速度，身体在翻转。
       这一段只是把总时长拉长、把"要掉下去了"的空档做出来，
       不影响后面加速段的速度感 */
    const tt = sT - FALL_T_JUMP;
    const k = tt / (FALL_T_TIP - FALL_T_JUMP), e = k * k;
    const y = fallFrom.y + 0.34 - 0.5 * FALL_G_TIP * tt * tt;
    cam.position.set(
      fallFrom.x + e * 0.10,
      y,
      fallFrom.z - 0.62 - e * 0.22
    );
    // 视线从"看向楼下"翻到"完全朝下"
    cam.rotation.set(-0.72 - e * 0.30, 0.02 + e * 0.04, e * 0.22);
    if (windPts) {
      windPts.position.copy(cam.position);
      windPts.material.opacity = 0.18 + e * 0.14;
      const p = windPts.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let yy = p.getY(i) + 0.055;
        if (yy > 13) yy -= 26;
        p.setY(i, yy);
      }
      p.needsUpdate = true;
    }
  } else if (sT < FALL_T_LAND) {
    /* ③ 加速坠落：重力与末速度都和改动前一致，只是起点带了失重段的初速度 */
    const ft = sT - FALL_T_TIP;
    const yTip = fallFrom.y + 0.34 - 0.5 * FALL_G_TIP * Math.pow(FALL_T_TIP - FALL_T_JUMP, 2);
    const y = yTip - (FALL_V_TIP * ft + 0.5 * FALL_G * ft * ft);
    cam.position.set(
      fallFrom.x + 0.10 + ft * 0.14,
      Math.max(FALL_GROUND_Y, y),
      fallFrom.z - 0.84 - ft * 0.55
    );
    const fp = ft / (FALL_T_LAND - FALL_T_TIP);
    cam.rotation.set(-1.02 - fp * 0.26, 0.06 + fp * 0.10, 0.22 + fp * fp * 1.05);
    if (windPts) {
      windPts.position.copy(cam.position);
      windPts.material.opacity = Math.min(0.80, 0.32 + fp * 0.60);
      const p = windPts.geometry.attributes.position;
      // 粒子上掠速度跟着实际下落速度走，观感和之前一致
      const rise = (FALL_V_TIP + FALL_G * ft) * 0.030;
      for (let i = 0; i < p.count; i++) {
        let yy = p.getY(i) + rise;
        if (yy > 13) yy -= 26;
        p.setY(i, yy);
      }
      p.needsUpdate = true;
    }
  } else {
    // ④ 落地：侧脸贴地
    if (fallPhase < 1) {
      fallPhase = 1;
      SFX.impact();
      flash(0.5);
      if (windPts) windPts.material.opacity = 0;
      bloodMesh.visible = true;
      /* 放在脸前方约 0.8m。贴太近的话一个 0.6m 的面片就比整个视野还宽，
         会变成一整屏红棕色 */
      bloodMesh.position.set(
        fallFrom.x - PR.x + 0.46,
        FALL_GROUND + 0.012,
        fallFrom.z - PR.z - 2.55
      );
    }
    const gt = sT - FALL_T_LAND;
    const settle = Math.min(1, gt / 0.55);
    cam.position.set(
      fallFrom.x + 0.30,
      FALL_GROUND_Y - settle * 0.12,
      fallFrom.z - 1.75
    );
    /* 两段运镜：
       前 2.2s 视线压低，看着自己身下渗开的血；
       之后 2.6s 缓慢抬眼，转向那片烧了七天的山火。 */
    const LOOK_BLOOD = { pitch: -0.13, roll: -1.44 };
    const LOOK_FIRE = { pitch: 0.34, roll: -1.02 };
    const turn = Math.max(0, Math.min(1, (gt - 2.2) / 2.6));
    const te = turn * turn * (3 - 2 * turn);        // 缓入缓出，像是费力地转动眼球
    cam.rotation.set(
      LOOK_BLOOD.pitch + (LOOK_FIRE.pitch - LOOK_BLOOD.pitch) * te,
      0.08,
      LOOK_BLOOD.roll + (LOOK_FIRE.roll - LOOK_BLOOD.roll) * te - settle * 0.04
    );
    // 血泊缓慢扩散（前半段就在渗，配合第一段"看着自己的血"的运镜）
    const bp = Math.min(1, gt / 3.6);
    const eb = bp * bp * (3 - 2 * bp);
    bloodMesh.scale.setScalar(0.30 + eb * 0.95);
    bloodMesh.material.opacity = Math.min(0.88, eb * 1.15);
    /* 闭眼要等抬眼看完火场再开始：转向在 2.2→4.8s，所以 4.9s 起闭眼，
       2.6s 闭完，7.5s 上字幕 */
    if (gt > 4.9) setLids(Math.min(1, (gt - 4.9) / 2.6));
    // 大字幕
    if (gt > 7.4 && !endTitleShown) {
      endTitleShown = true;
      el.querySelector('.line').textContent = fallEndingLine;
      el.querySelector('.name').textContent = fallEndingName;
      el.classList.add('show');
    }
  }
}

/* ---- 视线瞄准：找出准星前方 2.2m 内可交互的东西 ---- */
let aimTarget = null;
const _rc = new THREE.Raycaster();
const _aimDir = new THREE.Vector3();
const _wp = new THREE.Vector3();
function updateAim() {
  aimTarget = null;
  /* 外机交互 CG 期间关闭瞄准；唯一例外：挂在钩点上、救援梯已放下 → 瞄准梯子 */
  if (state !== 'play' || menuOpen || phoneViewOpen || choiceOpen ||
      (acClimbMode && !(acQte===4 && acLadderReady))) { promptEl.classList.remove('show'); return; }
  cam.getWorldDirection(_aimDir);
  const camPos = cam.position;
  let best = null, bestD = REACH;
  // 可拾取物：范围 + 朝向双重判定
  for (let i = 0; i < worldItems.length; i++) {
    const rec = worldItems[i];
    if (invFind(rec.id) >= 0) continue;              // 已在背包里
    if (!rec.obj.visible) continue;
    if (rec.id === 'pistol' && !wardrobeOpen) continue;   // 柜门没开，看不到也拿不到
    if (STACKABLE[rec.id] && rec.count === 0) continue;   // 空了的弹盒不再提示可拾取
    /* 镰刀与锤子：在玻璃后面看得到，但玻璃碎了才拿得到 */
    if (rec.id === 'tools' && (curLevel !== -1 || !case4GlassBroken)) continue;
    rec.obj.getWorldPosition(_wp);
    const d = _wp.distanceTo(camPos);
    if (d > bestD) continue;
    const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
    if (dot < FACE_DOT) continue;                    // 没面向它
    best = { kind: 'item', rec: rec, name: rec.name, d: d }; bestD = d;
  }
  // 衣柜门：瞄柜体中部
  if (wardrobeDoors.length) {
    _wp.set(PR.x + 1.92, PR.y + 1.35, PR.z - 1.62 + 0.34);
    const d = _wp.distanceTo(camPos);
    if (d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.86) { best = { kind: 'wardrobe', name: wardrobeOpen ? '关上衣柜' : '打开衣柜', d: d }; bestD = d; }
    }
  }
  // 窗户：贴近才认，提示用它的语言
  {
    _wp.set(PR.x - 1.1, PR.y + 1.55, PR.z - 2.3 + 0.1);
    const d = _wp.distanceTo(camPos);
    if (d < 1.5) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.90 && d < bestD) {
        best = { kind: 'window', name: 'deliver【解救】', d: d }; bestD = d;
      }
    }
  }
  // 门：门板中心（跟着开合角度走），两侧都能开关
  if (doorPivot) {
    doorPivot.getWorldPosition(_wp);
    _wp.x += Math.cos(doorAngle) * 0.5;
    _wp.z += -Math.sin(doorAngle) * 0.5;
    _wp.y = PR.y + 1.0;
    const d = _wp.distanceTo(camPos);
    if (d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.86) { best = { kind: 'door', name: doorOpen ? '关门' : '开门', d: d }; bestD = d; }
    }
  }
  // 楼梯口废料堆：拿斧头才能劈开清路
  if (barricadeGrp && !barricadeBroken) {
    /* 注意：playerRoom 整体偏移在 (92,0,92)，瞄准点必须加 PR，
       否则算出来是 130m 外的一个点，永远瞄不到（这就是之前"劈不开"的原因）*/
    _wp.set(PR.x - 6.55, PR.y + 1.15, PR.z + 3.43);
    const d = _wp.distanceTo(camPos);
    if (d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.72) {
        best = { kind: 'barricade', name: itemInHand('axe') ? '劈开挡路的废料（左键）' : '塌下来的梁和碎料堵住了——需要能劈的东西', d: d };
        bestD = d;
      }
    }
  }
  // 绳梯（天台，直升机抵达后才有）
  if (ladderReady && ladderGrp && curLevel === 1 && !escapeCG) {
    _wp.set(PR.x + ladderGrp.position.x, PR.y + 2.90 + 1.2, PR.z + ladderGrp.position.z);
    const d = _wp.distanceTo(camPos);
    if (d < 2.6 && d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.6) { best = { kind: 'ladder', name: '爬上绳梯', d: d }; bestD = d; }
    }
  }
  // 救援梯（四楼外机钩爪线：挂在钩点旁，直升机放下后按 E 登上）
  if (curLevel === -1 && acLadderReady && acLadderGrp && acQte===4 && !escapeCG) {
    _wp.set(PR.x - 6.68, PR.y - 3.3, PR.z - 3.05);
    const dRL = _wp.distanceTo(camPos);
    if (dRL < 2.6 && dRL < bestD) {
      const dotRL = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dotRL > 0.35) { best = { kind: 'rescueLadder', name: '登上救援梯', d: dRL }; bestD = dRL; }
    }
  }
  // 床头台灯
  if (lampLight) {
    _wp.set(PR.x - 0.34, PR.y + 0.88, PR.z + 0.26);
    const d = _wp.distanceTo(camPos);
    if (d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.9) { best = { kind: 'lamp', name: lampOn ? '关灯' : '开灯', d: d }; bestD = d; }
    }
  }
  // 收音机（电视柜右侧）
  if (radioGrp) {
    radioGrp.getWorldPosition(_wp);
    const d = _wp.distanceTo(camPos);
    if (d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.9) { best = { kind: 'radio', name: radioOn ? '关掉收音机' : '打开收音机', d: d }; bestD = d; }
    }
  }
  // 停用的电梯（5F 走廊中段）：只给一句提示，不可用
  // 注意 RD/T 是房间构建块里的局部常量，这里只能用算好的字面值：RD/2+T/2+2.0 = 4.4
  {
    _wp.set(PR.x + 1.9, PR.y + 1.1, PR.z + 4.34);
    const d = _wp.distanceTo(camPos);
    if (d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.88) { best = { kind: 'elevator', name: '电梯（停运）', d: d }; bestD = d; }
    }
  }
  // 四楼电梯门（南侧墙正中）：手持镰刀锤子可撬，撬开后改瞄准绳子
  if (curLevel === -1 && !pry4Done) {
    _wp.set(PR.x + 0.0, PR.y - 2.90 + 1.1, PR.z + 2.42);
    const d = _wp.distanceTo(camPos);
    if (d < 2.4 && d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.72) {
        best = { kind: 'elev4', name: itemInHand('tools') ? '撬开电梯门' : '电梯门（卡死）', d: d };
        bestD = d;
      }
    }
  }
  // 撬开后的井道绳子：显示消耗提示（滑下机制后续设计）
  if (curLevel === -1 && pry4Done) {
    _wp.set(PR.x + 0.0, PR.y - 2.90 + 0.9, PR.z + 2.3);
    const d = _wp.distanceTo(camPos);
    if (d < 2.4 && d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.6) { best = { kind: 'rope4', name: invFind('towel') >= 0 ? '毛巾包住绳子，滑下一楼' : '顺绳滑下（需要一条毛巾）', d: d }; bestD = d; }
    }
  }
  // 四楼楼梯口：火太大过不去
  if (curLevel === -1) {
    _wp.set(PR.x - 6.5, PR.y - 2.90 + 1.2, PR.z + 3.34);
    const d = _wp.distanceTo(camPos);
    if (d < 2.2 && d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.6) { best = { kind: 'stair4', name: '楼梯口（烈焰）', d: d }; bestD = d; }
    }
  }
  // 红色工具箱（东端墙）：旁白 → 打碎玻璃 → F 拾取镰刀锤子
  if (curLevel === -1 && acClimbMode === 0) {
    _wp.set(PR.x + 4.9, PR.y - 2.90 + 0.95, PR.z - 3.05); const dAC=_wp.distanceTo(camPos);
    if(dAC<2.0 && dAC<bestD && _wp.clone().sub(camPos).normalize().dot(_aimDir)>0.55){
      const canSmash = itemInHand('tools') || itemInHand('axe');
      best={kind:'acWindow',name:acWindowBroken?'攀爬空调外机':(canSmash?'打碎窗户玻璃':'窗户玻璃（需要工具）'),d:dAC}; bestD=dAC;
    }
  }
  if (curLevel === -1 && !case4GlassBroken) {
    _wp.set(PR.x + 6.7, PR.y - 2.90 + 1.45, PR.z + 3.34);
    const d = _wp.distanceTo(camPos);
    if (d < 2.2 && d < bestD) {
      const dot = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dot > 0.72) {
        const canBreak = case4Read && (performance.now() >= case4FadeAt);
        best = { kind: 'toolCase', name: case4Read ? (canBreak ? '打碎玻璃' : '工具箱') : '查看工具箱', d: d };
        bestD = d;
      }
    }
  }
  // 一楼：侧门（东墙）与正门（南墙，被燃烧的木梁封死）
  if (curLevel === -2) {
    _wp.set(PR.x + 9.2, PR.y + LVL1_Y + 1.1, PR.z + 6.1);
    const dSD = _wp.distanceTo(camPos);
    if (dSD < 2.4 && dSD < bestD) {
      const dotSD = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dotSD > 0.72) {
        best = { kind: 'sideDoor1', name: sideDoor1Open ? '侧门（已开）' : (invFind('key') >= 0 ? '用钥匙打开侧门' : '侧门（锁死了）'), d: dSD };
        bestD = dSD;
      }
    }
    _wp.set(PR.x + 0, PR.y + LVL1_Y + 1.3, PR.z + 9.3);
    const dFD = _wp.distanceTo(camPos);
    if (dFD < 2.6 && dFD < bestD) {
      const dotFD = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dotFD > 0.72) { best = { kind: 'frontDoor1', name: '正门（被燃烧的木梁堵死）', d: dFD }; bestD = dFD; }
    }
    // 地下车库卷帘门（楼梯平台尽头）
    _wp.set(PR.x - 7.0, PR.y + LVL1_Y - 1.45 + 1.1, PR.z + 8.3);
    const dGS = _wp.distanceTo(camPos);
    if (dGS < 2.4 && dGS < bestD) {
      const dotGS = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dotGS > 0.72) { best = { kind: 'garageShutter', name: '卷帘门（地下车库）', d: dGS }; bestD = dGS; }
    }
  }
  if (curLevel === -2 && inGarage) {
    for (let bi = 0; bi < burnCars.length; bi++) {
      const bc = burnCars[bi];
      if (bc.exploded) continue;
      _wp.set(PR.x + bc.x, PR.y + GAR_Y + 0.8, PR.z + bc.z);
      const dBC = _wp.distanceTo(camPos);
      if (dBC < 2.6 && dBC < bestD) {
        const dotBC = _wp.clone().sub(camPos).normalize().dot(_aimDir);
        if (dotBC > 0.72) { best = { kind: 'burnCar', name: '燃烧的车（别碰）', d: dBC, ref: bc }; bestD = dBC; }
      }
    }
    _wp.set(PR.x + 4.6, PR.y + GAR_Y + 0.8, PR.z + 19.55);
    const dPC = _wp.distanceTo(camPos);
    if (dPC < 2.7 && dPC < bestD) {
      const dotPC = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dotPC > 0.72) { best = { kind: 'playerCar', name: '我的车', d: dPC }; bestD = dPC; }
    }
    _wp.set(PR.x + 7.4, PR.y + GAR_Y + 1.2, PR.z + 22.3);
    const dES = _wp.distanceTo(camPos);
    if (dES < 2.9 && dES < bestD) {
      const dotES = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dotES > 0.72) { best = { kind: 'exitShutter', name: '车辆卷帘门', d: dES }; bestD = dES; }
    }
    _wp.set(PR.x - 7.95, PR.y + GAR_Y + 1.0, PR.z + 20.5);
    const dGD = _wp.distanceTo(camPos);
    if (dGD < 2.4 && dGD < bestD) {
      const dotGD = _wp.clone().sub(camPos).normalize().dot(_aimDir);
      if (dotGD > 0.72) {
        const gdName = garageSideDone ? '小门（已打开）'
          : garageSideHeard ? (itemInHand('tools') ? '砸开小门的锁扣' : '小门（需要镰刀与锤子）')
          : '小门（里面有声音）';
        best = { kind: 'garageDoor', name: gdName, d: dGD };
        bestD = dGD;
      }
    }
  }
  aimTarget = best;
  if (best) {
    const key = best.kind === 'item' ? 'F' : 'E';
    promptEl.innerHTML = '<b>' + key + '</b> · ' + best.name;
    promptEl.classList.add('show');
  } else {
    promptEl.classList.remove('show');
  }
}

/* ---- 门 / 灯 / 衣柜的开合状态 ---- */
let doorOpen = false, doorAngle = -0.12, lampOn = true;
let wardrobeOpen = false, wardrobeAngle = 0, pistolSeen = false;

/* ---- 体力 / 奔跑：拿着湿毛巾才能冲刺，3s 耗尽，5s 回满 ---- */
const STAM_MAX = 3.0;                 // 满体力可跑 3 秒
let stamina = STAM_MAX, sprintLock = false;
function updateStamina(dt, moving, sprintReq) {
  const canSprint = !!itemInHand('towel') && !itemInHand('axe') && !itemInHand('tools');   // 双手家伙占着手，跑不了
  const sprinting = canSprint && (sprintHeld || !!sprintReq) && moving && !sprintLock && stamina > 0;
  if (sprinting) {
    stamina = Math.max(0, stamina - dt);
    if (stamina <= 0) sprintLock = true;             // 耗尽后必须松开或等回满
  } else {
    // 5 秒回满 → 每秒回 STAM_MAX/5
    stamina = Math.min(STAM_MAX, stamina + dt * (STAM_MAX / 5));
    if (stamina >= STAM_MAX * 0.999) sprintLock = false;
  }
  const p = stamina / STAM_MAX;
  staminaFill.style.width = (p * 100).toFixed(1) + '%';
  staminaEl.classList.toggle('empty', sprintLock);
  return sprinting;
}
let isSprinting = false;

/* ---- 楼层状态 + 地面高度 ----
   移动系统是平面的（只有 x/z），竖向靠 floorYAt 把视高抬起/放下。
   4F 在 5F 正下方、天台在正上方，同一个 (x,z) 要能返回不同标高，
   所以引入 curLevel：非楼梯井区域按当前楼层取基准标高，
   楼梯井内部坐标唯一（两个井分别在走廊左右两端），按台阶绝对求值。
   楼层几何各成一组，切层时显隐切换。 */
let curLevel = 0;                                  // 0=5F, -1=4F, 1=天台
let robotSpeedMul = 1;                             // 机器人速度倍率（天台倒计时期间 ×1.5）
let phoneRoofMsg = false;                          // 天台那条短信是否已到
let phoneWeakMsg = false;                          // 弱点情报那条（坚持满 1 分钟后到）
const LVL_Y = { '0': 0, '-1': -2.90, '1': 2.90, '-2': LVL1_Y };
const ST = {
  /* 只有一个楼梯井（走廊左端，劈开废料才进得去）。
     井道在 z 方向拓宽成 4 条跑道：下行 2 条 + 上行 2 条 ——
     上天台和下四楼共用同一个入口，消防斧那道门禁才管得住两条路。
       跑道宽 0.90m（两侧有栏板的中间两条，0.75 只剩 0.45 可走，太窄）
       B1 z 2.60~3.50  上行 U1（往西上，0 → +1.45）
       B2 z 3.50~4.40  下行 D1（往西下，0 → -1.45）
       B3 z 4.40~5.30  下行 D2（往东下，-1.45 → -2.90）→ 东端条带 = 4F 出口
       B4 z 5.30~6.20  上行 U2（往东上，+1.45 → +2.90）→ 东端条带 = 天台出口
     走廊门洞只开在 B1+B2 上（入口平台也只覆盖这两条），
     B3/B4 的东端条带各自是 4F / 天台的出口标高，互不冲突。 */
  XA: -7.86,        // 入口平台内缘 / 各跑道东端
  XB: -9.94,        // 下行第一段西端
  XC: -10.86,       // 下行转角平台外缘
  XD: -11.78,       // 上行第一段西端
  XE: -12.70,       // 上行转角平台外缘
  RISE: 0.18125, TREAD: 0.26, NST: 8,
  /* 四条跑道紧邻，不留缝：留缝会让台阶之间出现看得见的空隙，
     而且缝上的点会落到 floorYAt 的兜底分支 */
  B1: [2.60, 3.50], B2: [3.50, 4.40], B3: [4.40, 5.30], B4: [5.30, 6.20]
};
const DROP1 = ST.RISE * ST.NST;                    // 单段 1.45m
function inShaft(x, z) { return x <= ST.XA && x >= ST.XE - 0.1 && z > ST.B1[0] && z < ST.B4[1]; }
function floorYAt(x, z) {
  /* 外机交互CG（QTE 坠落/摆荡）期间垂直高度由 CG 全权接管，
     否则 applyPlayerCam 的楼层平滑会把 playerFloorY 拉回楼层标高 */
  if (acFloorY !== null) return acFloorY;
  if (inShaft(x, z)) {
    /* 转角平台必须整块判定，而且要在跑道判定之前 ——
       上行转角横跨全部 4 条跑道，如果先按跑道算，同一个 x 上
       B1 会给 +1.45、B2/B3 给 -1.45，在平台上走两步就差 2.9m（瞬移/卡住）。 */
    if (x <= ST.XD + 0.06) return DROP1;                       // 上行转角（+1.45，整块平的）
    /* B1：上行第一段（往西上）→ 上行转角 */
    if (z < ST.B1[1]) {
      if (x <= ST.XD) return DROP1;
      const n = Math.min(ST.NST, Math.floor((ST.XA - x) / ST.TREAD) + 1);
      return ST.RISE * n;
    }
    /* B2：下行第一段（往西下）→ 下行转角 */
    if (z < ST.B2[1]) {
      if (x <= ST.XB) return -DROP1;
      const n = Math.min(ST.NST, Math.floor((ST.XA - x) / ST.TREAD) + 1);
      return -ST.RISE * n;
    }
    /* B3：下行第二段（往东下）→ 四楼 */
    if (z < ST.B3[1]) {
      if (x <= ST.XB) return -DROP1;
      const n = Math.min(ST.NST, Math.floor((x - ST.XB) / ST.TREAD) + 1);
      return -DROP1 - ST.RISE * n;
    }
    /* B4：上行第二段（往东上）→ 天台 */
    if (x <= ST.XD) return DROP1;
    const n = Math.min(ST.NST, Math.floor((x - ST.XD) / ST.TREAD) + 1);
    return DROP1 + ST.RISE * n;
  }
  /* 一楼通往地下车库的楼梯：南向下 8 级到平台（只在这段 z 生效——
     之前 z>4.9 全域生效，沿着西墙走到被困人群的小门也会被当成楼梯，
     脚下标高一路起伏，走到门口忽高忽低） */
  if (curLevel === -2 && x > -7.55 && x < -6.45 && z > 4.9 && z < 7.2) {
    if (z >= 7.06) return LVL1_Y - 1.45;
    const gn = Math.min(8, Math.floor((z - 4.9) / 0.27) + 1);
    return LVL1_Y - 0.18125 * gn;
  }
  /* 地下车库：爬过卷帘门后整片平地（车库地面 = 1F 下 3.5m，与几何 FG/GAR_Y 一致；
     从 -1.45 平台爬进来时会随脚本向下落到这一层） */
  if (curLevel === -2 && inGarage) return LVL1_Y - 3.5;
  /* 井外：按当前楼层 */
  return LVL_Y[String(curLevel)] || 0;
}
let playerFloorY = 0;           // 平滑后的脚下高度

/* 切换楼层：把对应楼层的几何显出来，其余隐藏。
   切换只发生在楼梯井尽头（玩家在封闭井道里，看不到切换过程）。 */
function switchLevel(n) {
  if (curLevel === n) return;
  curLevel = n;
  /* 按楼层剔除：不在这一层的几何和它内部的光源整组关掉。
     Three.js 会跳过 visible=false 的子树，光源也不再参与着色器计算 —— 
     场上有 35 个点光源，这是最有效的一笔优化。 */
  if (lvl4Grp) lvl4Grp.visible = (n === -1);
  if (roofGrp) roofGrp.visible = (n === 1);
  if (corrGrp) corrGrp.visible = (n === 0);
  if (room505Grp) room505Grp.visible = (n === 0);
  if (lvl1Grp) lvl1Grp.visible = (n === -2);
  /* fallExt（坠楼外立面）与 prWinBack（503 窗外山火）各层常显：
     外立面已在 4F 窗位开出 405 窗洞（见外墙构建处的 4F 补洞），
     外机行走时它就是整条墙线背后的实体墙 + 森林火场景 */
  /* 一楼浓烟：换成呛人的厚雾；离开一楼时还原 */
  if (n === -2) { prevSceneFog = scene.fog; scene.fog = fogLvl1; }
  else if (scene.fog === fogLvl1) scene.fog = prevSceneFog;
  /* prLights 里是 5F 的 9 盏灯（台灯/电视/窗外火光/走廊火光…），
     离开 5F 就整组关掉 —— 前向渲染下每盏灯都进所有材质的着色器循环，
     这是同类优化里收益最直接的一项 */
  if (prLights) prLights.visible = (n === 0);
  /* 脚下高度立刻对齐，避免过渡时视高抽一下 */
  playerFloorY = floorYAt(playerPos.x, playerPos.z);
  onLevelEnter(n);
}
/* 进入某层时的机制挂钩（剧情文本之后再灌，这里只做机制）*/
function onLevelEnter(n) {
  if (n === -1) {
    acClimbMode = 0; acClimbIndex = 0; acJumpT = 0; acMountT = 0; glassBreakT = 0; acQte=0; acQteProgress=0; acWindowBroken = false;
    acFloorY = null; acFallVy = 0; hideAcQteDom(); clearAcQteSaw();
    if(acSickleHook){ if(acSickleHook.parent) acSickleHook.parent.remove(acSickleHook); acSickleHook=null; }
    if(SFX.isChainsawOn){ SFX.stopChainsaw(); SFX.isChainsawOn=false; }
    resetAcRescueProps();
    /* 外机摆回原始位姿（第 4 台可能被电锯震落过） */
    for (let ui = 0; ui < acUnitMeshes.length; ui++) {
      const u = acUnitMeshes[ui], h = acUnitHome[ui];
      if (u && h) { u.position.set(h.x, h.y, h.z); u.rotation.set(h.rx, h.ry, h.rz); u.userData.landed = false; }
    }
    case4Read = false; case4GlassBroken = false; case4FadeAt = 0;
    if (caseGlass4) caseGlass4.visible = true;
    if (acWindowGlass) acWindowGlass.visible = true;
    for (const sh of glassShards4) if (sh.parent) sh.parent.remove(sh);
    glassShards4 = [];
  }
  if (n === 1 && !roofSignalDone) {
    roofSignalDone = true;
    /* 天台：信号恢复一格 */
    phoneHasSignal = true; phoneRoofMsg = true; phoneNewsRead = false;
    refreshPhoneView();
    say('我们到天台真的会得救吗？', 3000);
    /* 明确告诉玩家手机来消息了，否则不知道要按 Tab */
    setTimeout(function () {
      SFX.buzz();
      say('手机震了一下', 2000);
      showObjective('手握手机按' + phoneKeyName() + '打开手机', '有一条新消息');
    }, 3200);
    /* 台子上刷出 6 发子弹 */
    /* 把那盒子弹搬到天台台子上，数量设 6（复用同一件物品，省一套模型和注册）*/
    const recB = recOf('bullets');
    if (recB && roofBulletsObj) {
      recB.count = 6;
      recB.phys = null; recB.dropped = false;
      recB.obj.visible = true;
      roofGrp.add(recB.obj);
      roofBulletsObj.getWorldPosition(_fw);
      recB.obj.position.set(-1.9, 2.90 + 0.70, -0.9);
      recB.obj.rotation.set(0, 0.3, 0);
      recB.obj.matrixAutoUpdate = true;      // 之前被静态冻结过，搬动前要放开
    }
  }
}
/* ---- 四楼倒计时：木梁只能撑 1 分钟，时间到机器人破梁而来 ---- */
let lvl4Timer = -1, lvl4MarkIdx = 0;
const LVL4_MARKS = [
  { t: 45, s: '（木梁在嘎吱作响……）' },
  { t: 30, s: '（火越烧越近了！）' },
  { t: 30, s: '（木梁快断了！快点！）' },
  { t: 10, s: '（它要过来了！）' }
];
function startLvl4Countdown() {
  if (lvl4Timer >= 0) return;
  lvl4Timer = 60;                    // 1:00
  lvl4MarkIdx = 0;
  showObjective('找到下去的逃离方法', '木梁撑不住太久');
  const tEl = document.getElementById('objTimer');
  if (tEl) tEl.classList.add('show');
}
function updateLvl4Timer(dt) {
  if (lvl4Timer < 0 || state !== 'play' || curLevel !== -1) return;
  /* 机器人被击中弱点僵住的那几秒：木梁也获得喘息 —— 倒计时冻结 */
  if (robotStunT > 0) return;
  /* 空调外机交互 CG（攀爬/坠落/钩爪）期间：倒计时与它的旁白全部冻结，
     左上角任务条由 beginAcQte 收起、爬回外机后再恢复 */
  if (acClimbMode || acQte) return;
  lvl4Timer = Math.max(0, lvl4Timer - dt);
  const left = lvl4Timer;
  const tEl = document.getElementById('objTimer');
  if (tEl) {
    const m = Math.floor(left / 60), sec = Math.floor(left % 60);
    tEl.textContent = m + ':' + (sec < 10 ? '0' : '') + sec;
    tEl.classList.toggle('urgent', left <= 30);
  }
  /* 节点旁白 */
  while (lvl4MarkIdx < LVL4_MARKS.length && left <= LVL4_MARKS[lvl4MarkIdx].t) {
    say(LVL4_MARKS[lvl4MarkIdx].s, 2200);
    lvl4MarkIdx++;
  }
  /* 0:00 → 木梁断裂，机器人恢复追杀 */
  if (left <= 0) {
    lvl4Timer = -1;
    lvl4Barred = false;              // 木梁被撞开，玩家可以走回井道（但机器人也来了）
    robotSpeedMul = 1.8;             // 暴怒加速
    say('木梁断了！！', 2500);
    SFX.lvl4Crash();
    /* 视觉：木梁碎裂——把封挡的木梁从 lvl4Grp 里移除（简单做法：整个 lvl4Grp 里
       名字以 b4 开头的网格隐藏掉）。暴怒的机器人从火里冲出来 */
    if (lvl4Grp) {
      lvl4Grp.traverse(function (o) {
        if (o.name && o.name.substring(0, 2) === 'b4') o.visible = false;
      });
    }
    /* 机器人冲进走廊：从井道往走廊方向逼近 */
    robot.position.set(-6.6, -2.90, 3.43);
    hideObjective();
    const tE2 = document.getElementById('objTimer');
    if (tE2) tE2.classList.remove('show', 'urgent');
  }
}
/* 木梁断裂的巨响：低频轰鸣 + 碎裂噪声 */
SFX.lvl4Crash = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.5);
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  s.connect(lp); lp.connect(g); g.connect(master); s.start();
  const o = AC.createOscillator(); o.type = 'triangle';
  o.frequency.setValueAtTime(85, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.35);
  const og = AC.createGain();
  og.gain.setValueAtTime(0.7, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
  o.connect(og); og.connect(master); o.start(); o.stop(t + 0.45);
};
/* 玻璃碎裂：高频噪声爆 + 几声玻璃泛音 */
SFX.glassBreak = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const s = AC.createBufferSource(); s.buffer = SFX.noise(0.35);
  const hp = AC.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2800;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
  s.connect(hp); hp.connect(g); g.connect(master); s.start();
  [2400, 3300, 4100].forEach(function (f, i) {
    const o = AC.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const og = AC.createGain();
    og.gain.setValueAtTime(0.14, t + 0.05 + i * 0.06);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.28 + i * 0.06);
    o.connect(og); og.connect(master); o.start(t + 0.05 + i * 0.06); o.stop(t + 0.4 + i * 0.06);
  });
};
/* 撬门：低频金属呻吟 + 尖啸刮擦 + 最后闷响脱开 */
SFX.pry = function () {
  if (!AC) return;
  const t = AC.currentTime;
  // 呻吟：锯齿波慢扫 + 音量颤抖
  const o = AC.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(52, t);
  o.frequency.linearRampToValueAtTime(78, t + 0.7);
  o.frequency.linearRampToValueAtTime(40, t + 1.6);
  const lfo = AC.createOscillator(); lfo.frequency.value = 9;
  const lg = AC.createGain(); lg.gain.value = 0.16;
  lfo.connect(lg); lg.connect(o.frequency); lfo.start(t); lfo.stop(t + 1.7);
  const og = AC.createGain();
  og.gain.setValueAtTime(0.22, t); og.gain.linearRampToValueAtTime(0.34, t + 0.8);
  og.gain.linearRampToValueAtTime(0.05, t + 1.6);
  const olp = AC.createBiquadFilter(); olp.type = 'lowpass'; olp.frequency.value = 900;
  o.connect(olp); olp.connect(og); og.connect(master); o.start(t); o.stop(t + 1.7);
  // 尖啸：带通噪声上扫
  const s = AC.createBufferSource(); s.buffer = SFX.noise(1.6);
  const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 6;
  bp.frequency.setValueAtTime(700, t);
  bp.frequency.linearRampToValueAtTime(2300, t + 0.9);
  bp.frequency.linearRampToValueAtTime(500, t + 1.6);
  const sg = AC.createGain();
  sg.gain.setValueAtTime(0.1, t); sg.gain.linearRampToValueAtTime(0.3, t + 0.9);
  sg.gain.linearRampToValueAtTime(0.02, t + 1.6);
  s.connect(bp); bp.connect(sg); sg.connect(master); s.start(); s.stop(t + 1.7);
  // 最后的闷响（门脱开）
  const o2 = AC.createOscillator(); o2.type = 'triangle';
  o2.frequency.setValueAtTime(120, t + 1.55);
  o2.frequency.exponentialRampToValueAtTime(38, t + 1.95);
  const o2g = AC.createGain();
  o2g.gain.setValueAtTime(0.55, t + 1.55); o2g.gain.exponentialRampToValueAtTime(0.001, t + 2.1);
  o2.connect(o2g); o2g.connect(master); o2.start(t + 1.55); o2.stop(t + 2.15);
};

/* ---- 撬开电梯门：音效 + 镜头晃动 → 闭眼 → 换门 → 睁眼 ---- */
function animateLidsTo(target, ms, done) {
  const t0 = performance.now();
  const iv = setInterval(function () {
    const k = Math.min(1, (performance.now() - t0) / ms);
    setLids(target * (k * k * (3 - 2 * k)));
    if (k >= 1) { clearInterval(iv); if (done) done(); }
  }, 33);
}
function pryElevator() {
  if (pry4Busy || pry4Done) return;
  if (state !== 'play') return;
  pry4Busy = true;
  SFX.pry();
  /* 力量感：不是持续眩晕抖动，而是一次次发力的冲击 ——
     每一下都是"下坠 + 低头 + 侧倾"的单向猛击，然后快速回弹 */
  jolt4Amp = 0.55;                                 // 第一下：发力别进门缝
  setTimeout(function () { jolt4Amp = 0.8; }, 500);   // 第二下
  setTimeout(function () { jolt4Amp = 1.0; }, 1000);  // 第三下：门框发出呻吟
  setTimeout(function () { jolt4Amp = 1.35; }, 1450); // 最后一下：门脱开，整个人被带得往下一沉
  /* 1.7s 闭眼（0.5s 闭完） */
  setTimeout(function () {
    animateLidsTo(1, 500, function () {
      /* 全黑瞬间：换门 —— 闭合门板隐藏、弯开门板 + 井道显现 */
      if (elev4Doors) elev4Doors.visible = false;
      if (elev4Bent) elev4Bent.visible = true;
      if (elev4Shaft) elev4Shaft.visible = true;
      /* 0.2s 后睁眼（0.7s 睁完） */
      setTimeout(function () {
        animateLidsTo(0, 700, function () {
          jolt4Amp = 0;
          pry4Busy = false;
          pry4Done = true;
          say('（门开了。）', 1800);
        });
      }, 200);
    });
  }, 1700);
}

/* ---- 直升机救援：2 分钟等待 ----
   看完天台那条短信、收起手机后启动。整段由三部分构成：
     ① 旋翼声由远及近（音量/低频随剩余时间推进）
     ② 最后 40 秒探照灯从天上扫过来，0:00 时锁定玩家
     ③ 几个时间节点给旁白，让"熬时间"这件事有推进感
   0:00 之后接什么（得救 / 别的转折）留给你设计，这里停在直升机抵达。 */
let heliSrc = null, heliGain = null, heliLP = null;
let heliBeam = null, heliBeamTgt = null, heliArrived = false;
const HELI_MARKS = [
  { t: 105, s: '（旋翼声……很远。还在山那边。）' },
  { t: 45, s: '（声音近了——真的是直升机。）' },
  { t: 20, s: '（探照灯扫过来了！撑住！）' },
  { t: 6, s: '（就在头顶了！）' }
];
let heliMarkIdx = 0;

/* 旋翼声：低频叶片拍打（方波经低通）+ 涡轮噪声，音量随距离推进 */
function startHeliSound() {
  if (!AC || heliSrc) return;
  heliSrc = AC.createBufferSource();
  heliSrc.buffer = SFX.noise(3); heliSrc.loop = true;
  heliLP = AC.createBiquadFilter(); heliLP.type = 'lowpass'; heliLP.frequency.value = 320;
  heliGain = AC.createGain(); heliGain.gain.value = 0;
  /* 叶片拍打：用一个慢速 LFO 调制音量，做出 "哒哒哒" 的节奏 */
  const lfo = AC.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 11;
  const lfoG = AC.createGain(); lfoG.gain.value = 0.5;
  lfo.connect(lfoG); lfoG.connect(heliGain.gain); lfo.start();
  heliSrc.connect(heliLP); heliLP.connect(heliGain); heliGain.connect(master);
  heliSrc.start();
}
function stopHeliSound() {
  if (heliGain && AC) heliGain.gain.linearRampToValueAtTime(0, AC.currentTime + 0.6);
}
/* 探照灯：从天上斜射下来的一束，最后阶段才出现并扫动 */
function ensureHeliBeam() {
  if (heliBeam || !roofGrp) return;
  heliBeam = new THREE.SpotLight(0xdfeaff, 0, 34, 0.20, 0.45, 1.2);
  heliBeamTgt = new THREE.Object3D();
  roofGrp.add(heliBeam); roofGrp.add(heliBeamTgt);
  heliBeam.target = heliBeamTgt;
}

function startHeliCountdown() {
  if (heliTimer >= 0 || heliArrived) return;
  heliTimer = 120;                              // 2:00
  robotSpeedMul = 1.5;                          // 机器人加速
  heliMarkIdx = 0;
  showObjective('坚持到救援直升机来', '别被它碰到');
  const tEl = document.getElementById('objTimer');
  if (tEl) tEl.classList.add('show');
  startHeliSound();
  ensureHeliBeam();
}
function updateHeliTimer(dt) {
  if (heliTimer < 0 || state !== 'play') return;
  heliTimer = Math.max(0, heliTimer - dt);
  const left = heliTimer;
  /* 最后 8 秒机器人再提速：1.5 × 1.8 = 2.7，逼玩家撑到最后 */
  robotSpeedMul = left <= 8 ? 1.5 * 1.8 : 1.5;
  const tEl = document.getElementById('objTimer');
  if (tEl) {
    const m = Math.floor(left / 60), sec = Math.floor(left % 60);
    tEl.textContent = m + ':' + (sec < 10 ? '0' : '') + sec;
    tEl.classList.toggle('urgent', left <= 30);
  }
  /* ① 旋翼声由远及近：0..1 的接近度 */
  const near = 1 - left / 120;
  if (heliGain && AC) {
    heliGain.gain.setTargetAtTime(0.02 + near * near * 0.30, AC.currentTime, 0.4);
    if (heliLP) heliLP.frequency.setTargetAtTime(260 + near * 900, AC.currentTime, 0.5);
  }
  /* ② 最后 40 秒探照灯扫过来 */
  if (heliBeam) {
    if (left < 40) {
      const k = 1 - left / 40;
      heliBeam.intensity = 0.5 + k * 3.2;
      const sway = Math.sin(elapsed * 0.7) * (1 - k) * 7;
      heliBeam.position.set(playerPos.x + sway * 0.6, 2.90 + 13 - k * 5, playerPos.z - 9 + sway);
      /* 越接近 0:00 越锁定玩家脚下 */
      heliBeamTgt.position.set(playerPos.x + sway * (1 - k) * 2.2, 2.90, playerPos.z + sway * (1 - k));
      heliBeam.angle = 0.30 - k * 0.12;
    } else heliBeam.intensity = 0;
  }
  /* 天台：火灾导致的随机抖动 + 爆炸（炸前有预抖，炸后有余震）*/
  if (curLevel === 1 && state === 'play') {
    if (__hsBootLev !== 1) { __hsBootLev = 1; roofNextBoomIn = 8 + Math.random() * 12; }
    const sec = left <= 10 ? 6 : left <= 30 ? 10 : left <= 60 ? 16 : 25;
    roofNextBoomIn -= dt;
    if (roofNextBoomIn <= 0) {
      SFX.boom(); flash(0.2);
      say('楼下传来一声爆炸……', 1800);
      heliShakeAmt = 1.0;                              // 爆炸瞬间满冲
      roofNextBoomIn = sec * (0.7 + Math.random() * 0.6);
    }
    /* 爆炸前 1.5 秒起预抖：幅度小但频率高，像远处的结构在崩 */
    const preShake = roofNextBoomIn <= 1.5 && roofNextBoomIn > 0 ? (1.5 - roofNextBoomIn) / 1.5 * 0.25 : 0;
    heliShakeAmt = Math.max(heliShakeAmt, preShake);
    heliShakeAmt *= Math.pow(0.08, dt);                // 指数衰减(约0.82^60fps ≈ 0.08/s)
    if (heliShakeAmt < 0.003) heliShakeAmt = 0;
  } else {
    heliShakeAmt *= Math.pow(0.08, dt);
    __hsBootLev = 0;
    if (heliShakeAmt < 0.003) heliShakeAmt = 0;
  }
  /* 坚持满 1 分钟 → 官方发来弱点情报（第二条短信）*/
  if (!phoneWeakMsg && left <= 60) {
    phoneWeakMsg = true;
    phoneNewsRead = false;                 // 重新变成"未读"，消息框和红点再出现
    SFX.buzz();
    refreshPhoneView();
    say('手机又震了一下', 2000);
    showObjective('看手机 · 有新消息', '按' + phoneKeyName() + '查看');
  }
  /* ③ 时间节点旁白 */
  while (heliMarkIdx < HELI_MARKS.length && left <= HELI_MARKS[heliMarkIdx].t) {
    say(HELI_MARKS[heliMarkIdx].s, 2600);
    heliMarkIdx++;
  }
  if (left <= 0) {
    heliTimer = -1;
    heliArrived = true;
    if (tEl) tEl.classList.remove('show');
    /* 直升机抵达：探照灯锁死在玩家身上、旋翼声压满。
       之后接什么（得救 / 转折 / 结局）留给你设计。 */
    if (heliBeam) {
      heliBeam.intensity = 4.2; heliBeam.angle = 0.20;
      heliBeam.position.set(playerPos.x, 2.90 + 8.5, playerPos.z - 1.2);
      heliBeamTgt.position.set(playerPos.x, 2.90, playerPos.z);
    }
    if (heliGain && AC) heliGain.gain.setTargetAtTime(0.42, AC.currentTime, 0.3);
    say('救援直升机到了。', 3000);
    setTimeout(spawnLadder, 2600);
  }
}

/* ==================== 绳梯 + 结尾 CG ====================
   直升机抵达后在玩家脚下放一条绳梯，靠近按 E 攀爬 → 进结尾 CG：
   相机沿绳梯升高并远离，旋翼声压满；机器人留在楼顶一直盯着玩家，
   远景只剩黑漆漆的夜色和楼顶那一双亮眼睛。 */
let ladderGrp = null, ladderReady = false;
let escapeCG = false, escapeT0 = 0, escapeCamFrom = null, escapeEndShown = false, escapeEndT0 = 0;

function spawnLadder() {
  if (ladderGrp) { ladderGrp.visible = true; ladderReady = true; return; }
  ladderGrp = new THREE.Group();
  ladderGrp.position.set(playerPos.x, 2.90, playerPos.z);
  (roofGrp || playerRoom).add(ladderGrp);
  const ropeM = M(0x8a7a5a, { r: 0.95 });
  const rungM = M(0x6b5136, { r: 0.9 });
  /* 两根绳 + 木踏杆，一直伸进夜空（上端超出画面）*/
  for (const rx of [-0.19, 0.19]) {
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 9.0, 5), ropeM);
    rope.position.set(rx, 4.5, 0);
    ladderGrp.add(rope);
  }
  for (let i = 0; i < 22; i++) {
    const rung = put(box(0.46, 0.035, 0.05, rungM), 0, 0.25 + i * 0.4, 0);
    rung.rotation.z = (Math.random() - 0.5) * 0.05;
    ladderGrp.add(rung);
  }
  ladderReady = true;
  say('（一条绳梯放下来了。靠近按 E 爬上去。）', 3200);
  showObjective('爬上绳梯', '靠近后按 E');
}
/* 开始结尾 CG */
function beginEscapeCG(line, name) {
  if (escapeCG) return;
  escapeCG = true;
  escapeEndingLine = line || '结局 2'; escapeEndingName = name || '飞升撤离';
  achUnlock(escapeEndingLine === '结局 6' ? 'end6' : 'end2');   // 结局成就：飞升撤离 / 这次不行
  escapeRescue = !!line;                              // 带字幕参数的调用 = 四楼救援变体
  escapeT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  /* 藏掉一切 HUD 和手上的物品 */
  document.body.classList.add('cg');
  hideObjective(); closePhoneView(); endStairChoice();
  const tEl = document.getElementById('objTimer');
  if (tEl) tEl.classList.remove('show');
  setHeldItemsVisible(false);
  if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  /* 绳梯是直升机放下来的：玩家已经登机离开，楼顶上不能还悬着一条梯子 */
  if (ladderGrp) ladderGrp.visible = false;
  ladderReady = false;
  if (acLadderGrp) acLadderGrp.visible = false;
  acLadderReady = false;
  /* 机器人停在原地，不再追 —— 但会一直转头盯着玩家 */
  robotSpeedMul = 0;
  escapeCamFrom = { x: playerPos.x, y: playerFloorY + 1.58, z: playerPos.z };
  escapeEndShown = false;
  setState('escape');
  say('我逃出来了...', 3000);
  setTimeout(function () { say('他还在说【i will deliver you】', 4000); }, 4200);
}
/* 结尾 CG 每帧：相机沿绳梯升高 + 远离，机器人抬头盯着 */
function updateEscapeCG() {
  const t = (performance.now() - escapeT0) / 1000;
  const k = Math.min(1, t / 14);                 // 14 秒升到最高
  const e = k * k * (3 - 2 * k);
  const f = escapeCamFrom;
  /* 升高 + 往斜后方拉远，越到后面越能看到整个楼顶。
     天台版往北 (+z) 漂：起点在屋顶，不会穿楼。
     四楼救援版起点吊在楼外南墙 —— 必须往南 (-z) 漂，
     否则相机会横穿楼体，墙盒从内侧看全是被剔除的背面（墙体"透明"） */
  const driftZ = escapeRescue ? -10 : 12;
  cam.position.set(PR.x + f.x + e * 3.2, PR.y + f.y + e * 26, PR.z + f.z + e * driftZ);
  /* 一直看向机器人（天台在 2.90 标高；四楼在 -2.90 标高） */
  const lookY = escapeRescue ? PR.y + robot.position.y + 1.4 : PR.y + 2.90 + 1.5;
  const look = new THREE.Vector3(PR.x + robot.position.x, lookY, PR.z + robot.position.z);
  cam.up.set(0, 1, 0);
  cam.lookAt(look);
  /* 视场角略收，让那双眼睛在远景里更显眼 */
  const fov = 52 - 12 * e;
  if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = fov; cam.updateProjectionMatrix(); }
  /* 机器人抬头追着玩家看 */
  if (headGrp) {
    headGrp.rotation.x = 0.12 - e * 0.65;
    headGrp.rotation.y = Math.sin(t * 0.5) * 0.05;
  }
  /* 机体整体缓缓转向镜头：模型的"前"就是局部 +Z（眼睛/电锯都在前），
     不用改模型，直接转现有的 robot，远景里玩家就能正面看到那双眼睛 */
  {
    const cdx = (f.x + e * 3.2) - robot.position.x;
    const cdz = (f.z + e * 12) - robot.position.z;
    const wantYaw = Math.atan2(cdx, cdz);
    let dYaw = (wantYaw - robot.rotation.y) % (Math.PI * 2);
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    robot.rotation.y += dYaw * Math.min(1, t * 0.9) * 0.05;
  }
  /* 玩家登机后，探照灯从"锁住玩家"改成"罩住机器人"：
     光束在它周围小幅扫动，像直升机在打量这个没追上来的东西 */
  if (heliBeam && heliBeamTgt) {
    heliBeam.intensity = 4.2;
    heliBeam.position.set(robot.position.x + Math.sin(t * 0.6) * 1.3, 2.90 + 9.5,
      robot.position.z - 2.2 + Math.cos(t * 0.5) * 0.9);
    heliBeamTgt.position.set(robot.position.x + Math.sin(t * 0.9) * 0.65, 2.90 + 0.3,
      robot.position.z + Math.cos(t * 0.8) * 0.65);
  }
  /* 旋翼声压满 */
  if (heliGain && AC) heliGain.gain.setTargetAtTime(0.5, AC.currentTime, 0.5);
  /* 眼睛在夜色里更亮一点（远景里就剩这两点） */
  if (eyeMatL) eyeMatL.emissiveIntensity = 1.6 + e * 2.2;
  if (eyeLight) eyeLight.intensity = 0.4 + e * 0.5;

  /* 到达最高点后：闭眼 → 黑屏 → 结局 2 字幕 */
  if (k >= 1 && !escapeEndShown) {
    escapeEndShown = true;
    escapeEndT0 = performance.now();
  }
  if (escapeEndShown) {
    const et = (performance.now() - escapeEndT0) / 1000;
    /* 0–1.4s 闭眼（复用开场眼睑）*/
    setLids(Math.min(1, et / 1.4));
    /* 1.2s 起黑屏渐显 */
    const bo = document.getElementById('blackout');
    if (bo) bo.style.opacity = String(Math.min(1, Math.max(0, (et - 1.2) / 1.0)));
    /* 2.6s 上大字幕 */
    if (et > 2.6) {
      const el = document.getElementById('endTitle');
      if (el && !el.classList.contains('show')) {
        el.querySelector('.line').textContent = escapeEndingLine;
        el.querySelector('.name').textContent = escapeEndingName;
        var sub = el.querySelector('.sub');
        if (sub) sub.textContent = '我逃出来了，或许这场灾难会得到终结...';
        el.classList.add('show');
        document.body.classList.add('ending');
      }
    }
  }
}

/* ==================== 劈开木梁后的抉择 CG ====================
   不再让玩家自己走楼梯。木梁一断就进这段 CG：
     · 隐藏所有常驻 HUD（任务栏 / 体力 / 物品栏 / 准星）
     · 相机自动转向身后逼近的机器人，直面它
     · 机器人的位置是真的，仍在按 updateRobot 逼近 —— 碰到就死，
       死亡演出会盖掉这段 CG（beginDeath 里会关掉它）
     · 左「上天台」右「下四楼」，下方"快点抉择吧..."
   选完直接把玩家送到对应楼层，中间不需要走楼梯。 */
let choiceOpen = false, choiceDone = false;
let choiceHover = 0, choiceLean = 0, choiceLookAccum = 0;   // -1 左 / +1 右：悬停侧 / 鼠标滑动累积（锁定时选方向用）
const scEl = document.getElementById('stairChoice');

/* CG 期间藏掉手上握着的物品（抉择 CG 和结尾 CG 共用）*/
function setHeldItemsVisible(v) {
  for (let i = 0; i < worldItems.length; i++) {
    const rec = worldItems[i];
    const m = rec.held || rec.obj;
    if (m && m.parent === handRig) m.visible = v;
  }
  if (!v && phoneLight) phoneLight.intensity = 0;
}
function startStairChoice() {
  if (choiceOpen || choiceDone) return;
  if (state !== 'play') return;
  choiceOpen = true;
  choiceHover = 0; choiceLean = 0; choiceLookAccum = 0;
  setHeldItemsVisible(false);
  clearMoveInput();
  closePhoneView();
  hideObjective();
  document.body.classList.add('cg');
  if (scEl) { scEl.classList.add('show'); scEl.setAttribute('aria-hidden', 'false'); }
  say('该往哪边？', 2000);
}
function endStairChoice() {
  if (choiceOpen && !escapeCG) setHeldItemsVisible(true);
  choiceOpen = false;
  choiceHover = 0; choiceLean = 0; choiceLookAccum = 0;
  if (scEl) scEl.classList.remove('hl-left', 'hl-right');
  document.body.classList.remove('cg');
  if (scEl) { scEl.classList.remove('show'); scEl.setAttribute('aria-hidden', 'true'); }
}
/* 选择：+1 上天台 / -1 下四楼。直接切层并落点，不走楼梯 */
function pickStairs(dir) {
  if (!choiceOpen) return;
  choiceDone = true;
  endStairChoice();
  if (dir > 0) {
    switchLevel(1);
    playerPos.x = -6.10; playerPos.z = 5.75;      // 天台出口门内侧
    say('（上天台。）', 2000);
    /* 机器人被留在楼梯口那一侧：拉开一段距离，别一落地就贴身 */
    robot.position.x = -6.6; robot.position.z = 2.9;
  } else {
    switchLevel(-1);
    playerPos.x = -5.6; playerPos.z = 3.4;         // 四楼走廊内（避开井口，别再卡在可行走区外）
    lvl4Barred = true;                             // 楼梯口木梁封住，机器人被挡在井道里
    /* 机器人留在楼梯井里，被木梁 + 火挡住，透过井口门洞露出剪影 */
    robot.position.set(-7.6, -2.90, 3.43);
    robot.rotation.y = Math.PI / 2;                // 面朝走廊（+x）
    say('（下四楼。）', 2000);
    /* 旁白链：木梁撑住 → 火太大过不去 → 弹出任务 + 倒计时 */
    setTimeout(function () {
      if (state === 'play' && curLevel === -1) say('木梁还能撑住一会……', 2400);
    }, 1800);
    setTimeout(function () {
      if (state === 'play' && curLevel === -1) say('火太大了，过不去。只能找别的路下去。', 3400);
    }, 5000);
    setTimeout(function () {
      if (state === 'play' && curLevel === -1) startLvl4Countdown();
    }, 7500);
  }
  playerFloorY = floorYAt(playerPos.x, playerPos.z);
  /* 把鼠标交回视角 */
  if (state === 'play' && !isTouchMode()) {
    setTimeout(function () { if (!menuOpen && !phoneViewOpen) requestLookLock(); }, 80);
  }
}
/* CG 期间每帧：相机转向机器人（走最短路），并保持锁定移动 */
function updateStairChoice() {
  if (!choiceOpen || state !== 'play') return;
  const dx = robot.position.x - playerPos.x, dz = robot.position.z - playerPos.z;
  const wantYaw = Math.atan2(-dx, -dz) - SIT.yaw;
  let dYaw = (wantYaw - lookYaw) % (Math.PI * 2);
  if (dYaw > Math.PI) dYaw -= Math.PI * 2;
  if (dYaw < -Math.PI) dYaw += Math.PI * 2;
  lookYaw += dYaw * 0.08;
  /* 悬停/预选那一侧时，画面轻微朝那边偏一点（像在朝那个方向瞟）*/
  choiceLean += (choiceHover * 0.13 - choiceLean) * 0.12;
  lookYaw += choiceLean * 0.1;
  lookPitch += (-0.02 - lookPitch) * 0.06;
  clearMoveInput();
}
/* 左右两侧按钮 + A/D、方向键也能选 */
if (scEl) {
  const lb = scEl.querySelector('.sc-left'), rb = scEl.querySelector('.sc-right');
  /* 左键点击确认；悬停只做预览（高亮 + 画面轻微偏移）*/
  if (lb) {
    lb.addEventListener('click', function (e) { if (e.button === 0) { e.stopPropagation(); pickStairs(1); } });
    lb.addEventListener('mouseenter', function () { choiceHover = -1; scEl.classList.add('hl-left'); scEl.classList.remove('hl-right'); });
    lb.addEventListener('mouseleave', function () { choiceHover = 0; scEl.classList.remove('hl-left'); });
  }
  if (rb) {
    rb.addEventListener('click', function (e) { if (e.button === 0) { e.stopPropagation(); pickStairs(-1); } });
    rb.addEventListener('mouseenter', function () { choiceHover = 1; scEl.classList.add('hl-right'); scEl.classList.remove('hl-left'); });
    rb.addEventListener('mouseleave', function () { choiceHover = 0; scEl.classList.remove('hl-right'); });
  }
}
/* A/D、方向键只做"预选高亮"，不直接进入 —— 必须鼠标点击才算确认，
   避免 CG 里手一抖就被带走 */
addEventListener('keydown', function (e) {
  if (!choiceOpen || !scEl) return;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
    e.preventDefault(); choiceHover = -1; scEl.classList.add('hl-left'); scEl.classList.remove('hl-right');
  }
  if (e.code === 'KeyD' || e.code === 'ArrowRight') {
    e.preventDefault(); choiceHover = 1; scEl.classList.add('hl-right'); scEl.classList.remove('hl-left');
  }
});

/* 楼梯井尽头 = 楼层过渡门。
   过渡时把玩家挪到门另一侧，因为两条跑道之间有实体护栏（不然会卡在栏上）。
   左井：run1 顶(5F) ←→ run2 底(4F)；右井：run1 底(5F) ←→ run2 顶(天台)。 */
function updateLevelTransition() {
  if (state !== 'play') return;
  const x = playerPos.x, z = playerPos.z;
  /* 楼梯井内：高度由 floorYAt 按台阶绝对求值，所以这里**完全不做传送**（传送才是瞬移的来源）。
     只做一件事：按玩家所在的跑道决定"他要去哪一层"，提前把楼层切过去。
     这样等他走出井口时，井外的标高已经和跑道末端对上了，接缝处不会有落差。
       B3（下行第二段）→ 目标 4F      B4（上行第二段）→ 目标 天台
       B1 / B2 / 入口平台            → 目标 5F */
  if (inShaft(x, z)) {
    let want = 0;
    if (z > ST.B3[0] && z < ST.B3[1]) want = -1;
    else if (z >= ST.B4[0]) want = 1;
    if (curLevel !== want) switchLevel(want);
    return;
  }
}

/* ---- 静态矩阵冻结 ----
   Three.js 默认每帧为场上每个对象重算局部矩阵与世界矩阵。本场景有 380+ 个
   mesh，其中绝大多数是墙、地板、台阶、家具这类永远不动的东西 ——
   把它们的 matrixAutoUpdate 关掉（先手动 updateMatrix 一次），
   每帧就省下几百次矩阵合成，是不改画面的纯 CPU 收益。
   会动的对象必须排除：门/柜门枢轴、机器人、手上的持物、火焰烟雾（billboard
   要跟镜头转）、掉落物、弹壳、碎料、灯光。 */
let staticsFrozen = false, shadersWarmed = false;
function freezeStatics() {
  if (staticsFrozen) return;
  staticsFrozen = true;
  /* 动态子树的根：这些及其后代一律不冻结 */
  const dynRoots = [robot, handRig, doorPivot, door504, radioGrp,
    phoneObj, towelObj, pistolObj, bulletsObj, axeObj, roofBulletsObj, toolsObj];
  for (let i = 0; i < wardrobeDoors.length; i++) dynRoots.push(wardrobeDoors[i].pivot);
  for (let i = 0; i < barricadePlanks.length; i++) dynRoots.push(barricadePlanks[i].mesh);
  dynRoots.push(keyObj, bullets1Obj, sideDoor1Pivot, ropeTowel);
  const dyn = new Set();
  for (let i = 0; i < dynRoots.length; i++) {
    const rt = dynRoots[i];
    if (rt) rt.traverse(function (o) { dyn.add(o); });
  }
  for (let i = 0; i < flames.length; i++) dyn.add(flames[i]);
  for (let i = 0; i < smokes.length; i++) dyn.add(smokes[i]);
  let frozen = 0;
  [playerRoom, worldSet].forEach(function (root) {
    if (!root) return;
    root.traverse(function (o) {
      if (o === root) return;
      if (o.isLight || o.isPoints || o.isSprite) return;      // 灯光/粒子留着
      if (dyn.has(o)) return;
      if (!o.isMesh && !o.isGroup) return;
      o.updateMatrix();
      o.matrixAutoUpdate = false;
      frozen++;
    });
  });
  if (DBG) console.log('[perf] 冻结静态对象:', frozen,
    '| 材质:', _matCache.size, '| 几何:', _geoCache.size);
}

let dtCam = 1 / 60;
let frameNo = 0;                 // 帧计数：给降频更新用
const _fw = new THREE.Vector3();  // 复用，避免每帧 new             // 供 applyPlayerCam 做帧率归一化用（每帧由主循环写入）
function applyPlayerCam(k) {   // k: 0 躺, 1 坐起
  const e = k * k * (3 - 2 * k);
  let x = LIE.x + (SIT.x - LIE.x) * e;
  let y = LIE.y + (SIT.y - LIE.y) * e;
  let z = LIE.z + (SIT.z - LIE.z) * e;
  let yaw = LIE.yaw + (SIT.yaw - LIE.yaw) * e;
  let pitch = LIE.pitch + (SIT.pitch - LIE.pitch) * e;
  if (k >= 1) {
    yaw += lookYaw;
    pitch += lookPitch;
  }
  /* 死亡演出（death/dead）也要留在玩家当前位置——之前只判断 'play'，
     一死相机就弹回床上，所以既不对着机器人、看着还像卡住了 */
  if (state === 'play' || state === 'death' || state === 'dead') {
    /* 死亡时不要再走"从床上坐起"的插值（setState 把计时清零了，
       否则相机会从床那边慢慢飘过来）——直接锁在玩家脚下 */
    let standK = 1;
    if (state === 'play') {
      const standK0 = Math.min(1, stateSec() / 1.15);
      standK = standK0 * standK0 * (3 - 2 * standK0);
    }
    const eyeY = 1.58 - crouchAmount * 0.56;
    x = SIT.x + (playerPos.x - SIT.x) * standK;
    y = SIT.y + (eyeY - SIT.y) * standK;
    z = SIT.z + (playerPos.z - SIT.z) * standK;
    /* 楼梯：脚下高度平滑跟随。台阶是离散的（每级 0.18m），
       插值太快会一格一格顿、太慢会"飘"。这里按帧率归一化，
       并且下楼比上楼稍快一点（重力感），落差大时（换层传送）直接对齐不插值。 */
    const wantF = floorYAt(playerPos.x, playerPos.z);
    // 外机跳跃期间保留垂直抛物线，避免楼层平滑把“先上后下”抹掉
    if (!acJumpT) {
      const gap = wantF - playerFloorY;
      if (Math.abs(gap) > 1.2) playerFloorY = wantF;
      else {
        const rate = gap < 0 ? 11 : 8;
        playerFloorY += gap * Math.min(1, dtCam * rate);
      }
    }
    y += playerFloorY * standK;
  }
  const br = Math.sin(elapsed * 1.7) * 0.012 + Math.sin(elapsed * 0.9) * 0.008;   // 呼吸
  const bob = Math.sin(walkPhase) * 0.025 * walkAmount * (1 - crouchAmount * 0.45);
  const shX = Math.sin(elapsed * 17.3) * heliShakeAmt * 0.018 + Math.sin(elapsed * 9.7) * heliShakeAmt * 0.012;
  const shY = Math.sin(elapsed * 23.1) * heliShakeAmt * 0.025 + Math.abs(Math.sin(elapsed * 11.3)) * heliShakeAmt * 0.015;
  const shZ = Math.cos(elapsed * 19.1) * heliShakeAmt * 0.014;
  /* 撬门冲击：单方向下坠 + 侧倾，快速衰减 —— 力量感而非高频眩晕 */
  if (jolt4Amp > 0) {
    jolt4Amp *= Math.pow(0.0005, dtCam);
    if (jolt4Amp < 0.004) jolt4Amp = 0;
  }
  cam.position.set(PR.x + x + shX, PR.y + y + br * 0.5 + bob + shY - jolt4Amp * 0.42 - coughShake * 0.05, PR.z + z + shZ);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(pitch + br * 0.1 - jolt4Amp * 0.16 + coughShake * 0.10, yaw, Math.sin(elapsed * 0.6) * 0.006 + jolt4Amp * 0.05 + coughShake * 0.03);
}

function enterPlayerRoom() {
  // 每次重新开始都恢复四楼玻璃/攀爬路线，避免上次调试状态残留导致直接攀爬
  case4Read = false; case4GlassBroken = false; case4FadeAt = 0; acWindowBroken = false; acClimbMode = 0; acClimbIndex = 0; acJumpT = 0; acMountT = 0; glassBreakT = 0;
  acQte = 0; acFloorY = null; acFallVy = 0; hideAcQteDom(); clearAcQteSaw();
  resetAcRescueProps();
  stopGarageRobot();
  for (let ui = 0; ui < acUnitMeshes.length; ui++) {
    const u = acUnitMeshes[ui], h = acUnitHome[ui];
    if (u && h) { u.position.set(h.x, h.y, h.z); u.rotation.set(h.rx, h.ry, h.rz); u.userData.landed = false; }
  }
  if (caseGlass4) caseGlass4.visible = true;
  if (acWindowGlass) acWindowGlass.visible = true;
  for (const sh of glassShards4) if (sh.parent) sh.parent.remove(sh);
  glassShards4 = [];
  worldSet.visible = false;      // 开场场景（含机器人）整体隐藏
  playerRoom.visible = true;
  scene.background = new THREE.Color(0x05040a);
  SFX.setFire(0.07);
  lookYaw = -0.12; lookPitch = 0; lookActive = false; menuOpen = false;
  playerPos.x = -0.25; playerPos.z = -0.35; crouchHeld = false; crouchAmount = 0; clearMoveInput();
  mobileControls.setAttribute('aria-hidden', 'false');
  document.body.classList.add('playing');
  /* 物品状态归位：重进房间时手上/包里清空，物品回原位 */
  for (let i = 0; i < 4; i++) inv[i] = null;
  for (let i = 0; i < worldItems.length; i++) {
    const rec = worldItems[i];
    rec.phys = null; rec.dropped = false;
    if (STACKABLE[rec.id]) rec.count = STACKABLE[rec.id];   // 弹药数量归位
    rec.obj.visible = true; detachFromHand(rec);
  }
  /* 手枪状态归位：空匣、未上膛、套筒复位 */
  magLoaded = 0; chambered = false; slideLocked = false;
  slideT = 0; reloadT = 0; reloadStep = 0;
  magInHand = false; gunDownK = 0;
  if (magObj) magObj.visible = false;
  if (pressBullet) pressBullet.visible = false;
  if (pistolSlide) pistolSlide.position.x = 0;
  for (let i = shellPool.length - 1; i >= 0; i--) { scene.remove(shellPool[i].mesh); }
  shellPool.length = 0;
  stamina = STAM_MAX; sprintHeld = false; sprintLock = false; isSprinting = false;
  doorOpen = false; doorAngle = -0.12; lampOn = true;
  wardrobeOpen = false; wardrobeAngle = 0; pistolSeen = false;
  fallPhase = 0; endTitleShown = false; fallEndingLine='结局 1'; fallEndingName='猎魔人的信仰之跃'; clearAcQteSaw();
  /* 手机 / 收音机状态归位：信号恢复、505 消息未触发、收音机关 */
  closePhoneView();
  phoneHasSignal = true; phoneMsg505 = false;
  refreshPhoneView();
  /* 楼层 / 天台流程复位 */
  curLevel = 0; playerFloorY = 0; robotSpeedMul = 1;
  /* 楼层可见性复位：开局在 5F，4F 与天台整组关掉（省光源和 draw call）*/
  if (lvl4Grp) lvl4Grp.visible = false;
  if (roofGrp) roofGrp.visible = false;
  if (corrGrp) corrGrp.visible = true;
  if (room505Grp) room505Grp.visible = true;
  if (prLights) prLights.visible = true;
  roofSignalDone = false; phoneRoofMsg = false; phoneWeakMsg = false; heliTimer = -1;
  lvl4Timer = -1;
  heliShakeAmt = 0; roofNextBoomIn = -1; __hsBootLev = 0;
  heliArrived = false; heliMarkIdx = 0;
  choiceOpen = false; choiceDone = false; endStairChoice();
  escapeCG = false; ladderReady = false;
  if (ladderGrp) ladderGrp.visible = false;
  if (headGrp) headGrp.rotation.set(0.12, 0, 0);
  if (cam.fov !== 52) { cam.fov = 52; cam.updateProjectionMatrix(); }
  stopHeliSound();
  if (heliBeam) heliBeam.intensity = 0;
  if (roofBulletsObj) roofBulletsObj.visible = false;
  {
    const tEl = document.getElementById('objTimer');
    if (tEl) { tEl.classList.remove('show', 'urgent'); tEl.textContent = '2:00'; }
  }
  if (radioOn) { radioOn = false; if (radioGain) radioGain.gain.value = 0; }
  freezeStatics();          // 首次进房间时冻结静态矩阵（几何此时已全部建好）
  /* 着色器预编译：机器人/天台/4F 的材质如果等到第一次出现在画面里才编译，
     那一帧会明显卡一下。这里在进房间时统一编译一遍（把要用的组临时点亮）。 */
  if (!shadersWarmed) {
    shadersWarmed = true;
    const vis = [];
    [robot, lvl4Grp, roofGrp, lvl1Grp].forEach(function (g) { if (g) { vis.push([g, g.visible]); g.visible = true; } });
    try { renderer.compile(scene, cam); } catch (e) { /* 编译失败也不该拦住游戏 */ }
    vis.forEach(function (p) { p[0].visible = p[1]; });
  }
  /* 剧情链重置：目标/手机/机器人 */
  leftRoomOnce = false; phoneMsg505 = false; phoneNewsRead = false; phoneHasSignal = true;
  robotOut = false; robotWalkT = 0; robotStunT = 0; axeSwingT = 0;
  barricadeHits = 0; barricadeBroken = false;
  lvl4Barred = false;
  /* 四楼电梯/工具箱/房间 状态复位 */
  case4Read = false; case4GlassBroken = false; case4FadeAt = 0;
  pry4Busy = false; pry4Done = false;
  /* 一楼：侧门/滑绳/窒息 状态复位 */
  sideDoor1Open = false;
  if (sideDoor1Pivot) sideDoor1Pivot.rotation.y = 0;
  if (lvl1Grp) lvl1Grp.visible = false;
  ropeCG = false; ropeLanded = false;
  if (ropeCamLight) ropeCamLight.intensity = 0;
  if (ropeTowel) { elev4Shaft.add(ropeTowel); ropeTowel.position.set(0, 1.6, -0.2); ropeTowel.visible = false; }
  if (acUnit) { acUnit.visible = false; acUnit.userData.landed = false; acUnit.position.set(10.0, LVL1_Y, 6.1); acUnit.rotation.set(0, 0, 0); }
  if (acMound) acMound.visible = false;
  acDropped = false;
  suffO2 = 60; suffDead = false; suffHinted = false; suffHinted2 = false;
  inGarage = false; crawlCG = false;
  garageSideHeard = false; garageSideDone = false;
  blackroomPhase = -1; carEscapePhase = -1;
  for (let bci = 0; bci < burnCars.length; bci++) burnCars[bci].exploded = false;
  if (blackRoomGrp) blackRoomGrp.visible = false;
  if (roadGrp) { roadGrp.visible = false; }
  if (roadCar) roadCar.position.z = -20;
  coughIn = 5; coughShake = 0; boom1In = 7;
  if (blurOvEl) { blurOvEl.style.opacity = '0'; blurOvEl.style.backdropFilter = 'blur(0px)'; blurOvEl.style.webkitBackdropFilter = 'blur(0px)'; }
  if (tearsEl) tearsEl.style.opacity = '0';
  if (oxygenEl) oxygenEl.classList.remove('show');
  if (scene.fog === fogLvl1) scene.fog = prevSceneFog;
  const dNm1 = document.querySelector('#deathTitle .name');
  if (dNm1) dNm1.textContent = '你解脱了';
  lvl4RoomHint = false;
  if (elev4Doors) elev4Doors.visible = true;
  if (elev4Bent) elev4Bent.visible = false;
  if (elev4Shaft) elev4Shaft.visible = false;
  if (caseGlass4) caseGlass4.visible = true;
  if (toolsObj) {
    const recT = recOf('tools');
    if (recT) { recT.dropped = false; recT.phys = null; }
    toolsObj.visible = true;                        // 重新摆回玻璃后面（拾取门控看 case4GlassBroken）
    if (toolsObj.parent !== lvl4Grp) lvl4Grp.add(toolsObj);
  }
  /* 四楼木梁重新立起来（name 以 b4 开头的网格恢复显示） */
  if (lvl4Grp) {
    lvl4Grp.traverse(function (o) {
      if (o.name && o.name.substring(0, 2) === 'b4') o.visible = true;
    });
  }
  for (let i = 0; i < barricadePlanks.length; i++) {
    const pl = barricadePlanks[i];
    pl.fallen = false; pl.t = 0; pl.cracked = false; pl.crackT = 0;
    pl.mesh.position.copy(pl.homePos); pl.mesh.rotation.copy(pl.homeRot);
  }
  hideObjective(); hideSideQuest();
  const dEl2 = document.getElementById('deathTitle');
  if (dEl2) dEl2.classList.remove('show');
  if (bloodPts) { cam.remove(bloodPts); bloodPts = null; }
  refreshPhoneView();
  /* 机器人搬进 504（走廊对面），门后藏好；开场场景里它原来的位置不再用 */
  if (robot.parent !== playerRoom) playerRoom.add(robot);
  robot.visible = false;
  if (robotPortraitSprite) robotPortraitSprite.visible = false;
  robot.position.set(3.2, 0, 5.3);
  robot.rotation.set(0, Math.PI, 0);
  if (door504) door504.rotation.y = 0;
  /* 504 门/门楣复原：把破门时挪出去的碎块清掉 */
  for (let i = 0; i < door504Debris.length; i++) {
    const m = door504Debris[i].mesh;
    if (m.parent) m.parent.remove(m);
  }
  door504Debris.length = 0;
  for (let i = 0; i < door504Stumps.length; i++) door504Stumps[i].visible = false;
  if (door504Lintel) door504Lintel.visible = true;
  if (door504) {
    door504.visible = true;
    /* 门板重建（原来那片已经被扔进碎块回收了） */
    if (!door504.children.length) {
      const nd = M(0x241a10, { r: 0.86, m: 0.1 });
      door504.add(put(box(0.96, 2.02, 0.05, nd), 0.46, 1.01, 0));
    }
  }
  const et = document.getElementById('endTitle');
  if (et) et.classList.remove('show');
  if (bloodMesh) { bloodMesh.visible = false; bloodMesh.material.opacity = 0; }
  if (windPts) windPts.material.opacity = 0;
  document.body.classList.remove('ending');
  if (phoneLight) phoneLight.intensity = 0;
  selectInventorySlot(0);
  refreshInventoryHUD();
  /* 机器人此刻在楼里别处继续「救人」：看不见，但电锯声一直隔墙传过来。
     这是玩家的压迫感来源，也是「它还在靠近」的提示。 */
}

const PLAY_CAPS = [
  { t: 1.0, s: '……' },
  { t: 3.0, s: '（咳）……烟已经进屋了。' },
  { t: 7.0, s: '桌上还有我的手机。屏幕能当手电。' },
  { t: 11.0, s: '卫生间有毛巾——弄湿了捂着口鼻，才敢在烟里跑。' },
  { t: 15.0, s: '外面……有金属蹄子踩在地砖上的声音。' }
];
let playCapIdx = 0;

/* 「点击继续」：屏幕任意位置点击、或按空格/回车都能推进，
   免得玩家去瞄那一行小字（那行字本身也仍然可点） */
function advanceFromAwait() {
  if (state !== 'await') return;
  contEl.classList.remove('show');
  clearSay();
  FREEZE = false;          // 定格调试模式下也能看完整的闭眼→睁眼过渡
  setState('closing');
  SFX.heart(4);
}
contEl.addEventListener('click', advanceFromAwait);
/* 任意位置点一下就能推进（免得玩家去瞄那一行小字）。
   手机上只认真正的点击：按下的位置记下来，抬起时如果挪了超过 8px 就算
   拖拽（环视视角），不当成"点击继续"。这样点摇杆、点按钮不会误触发。 */
let _tapDownX = -1, _tapDownY = -1, _tapDownState = '';
addEventListener('pointerdown', function (e) {
  _tapDownX = e.clientX; _tapDownY = e.clientY;
  _tapDownState = state;
});
addEventListener('pointerup', function (e) {
  if (_tapDownX < 0) return;
  const dx = Math.abs(e.clientX - _tapDownX), dy = Math.abs(e.clientY - _tapDownY);
  _tapDownX = -1;
  /* 只认"按下和抬起都在 await 状态、且没拖"的那一次点击 */
  if (dx <= 8 && dy <= 8 && _tapDownState === 'await') advanceFromAwait();
});
addEventListener('keydown', function (e) {
  if (e.code === 'Escape') {
    if (state === 'play') {
      e.preventDefault();
      if (phoneViewOpen) { closePhoneView(); return; }   // 先关手机再开暂停
      setPauseMenu(!menuOpen);
    }
    return;
  }
  /* Tab：手持手机时翻开看（背景虚化 + 放大手机 + 电量/信号） */
  if (e.code === 'Tab') {
    e.preventDefault();
    if (state === 'play' && !menuOpen) togglePhoneView();
    return;
  }
  if (state === 'play' && !menuOpen && !phoneViewOpen) {
    if (e.code === 'KeyW' || e.code === 'ArrowUp') moveKeys.forward = true;
    if (e.code === 'KeyS' || e.code === 'ArrowDown') moveKeys.back = true;
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') moveKeys.left = true;
    if (e.code === 'KeyD' || e.code === 'ArrowRight') moveKeys.right = true;
    if ((e.code === 'KeyC' || e.code === 'ControlLeft') && !e.repeat) {
      crouchHeld = !crouchHeld;
      crouchBtn.classList.toggle('active', crouchHeld);
    }
    if (/^Digit[1-4]$/.test(e.code)) selectInventorySlot(parseInt(e.code.slice(-1), 10) - 1);
    if (/^Numpad[1-4]$/.test(e.code)) selectInventorySlot(parseInt(e.code.slice(-1), 10) - 1);
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sprintHeld = true;
    if (e.code === 'KeyF' && !e.repeat) tryPickup();
    if (e.code === 'KeyE' && !e.repeat) tryInteract();
    if (e.code === 'Space' && acQte===3 && !e.repeat) { e.preventDefault(); if (acQteTap()) return; }
    if (e.code === 'Space' && acClimbMode===1 && !e.repeat) { e.preventDefault(); acClimbJump(); }
    if (e.code === 'KeyQ' && !e.repeat) tryDrop();
    if (e.code === 'KeyV' && !e.repeat) toggleHand();
    if (e.code === 'KeyR' && !e.repeat) startReload();
    if (/^(Key[WASDCFEQVR]|Arrow(Up|Down|Left|Right)|ControlLeft|Shift(Left|Right)|Digit[1-4]|Numpad[1-4])$/.test(e.code)) e.preventDefault();
  }
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') {
    if (state === 'idle') { begin(); } else { advanceFromAwait(); }
  }
});
addEventListener('keyup', function (e) {
  if (e.code === 'KeyW' || e.code === 'ArrowUp') moveKeys.forward = false;
  if (e.code === 'KeyS' || e.code === 'ArrowDown') moveKeys.back = false;
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') moveKeys.left = false;
  if (e.code === 'KeyD' || e.code === 'ArrowRight') moveKeys.right = false;
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') sprintHeld = false;
});
addEventListener('blur', function () { clearMoveInput(); sprintHeld = false; });
/* 滚轮切换物品栏（向下滚 = 下一格，循环） */
addEventListener('wheel', function (e) {
  if (state !== 'play' || menuOpen) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  selectInventorySlot((selectedSlot + dir + 4) % 4);
  e.preventDefault();
}, { passive: false });

/* ==================== 滑绳下一楼 CG + 一楼机制 ====================
   4F 电梯井按 E（背包里有毛巾）：毛巾包绳滑下。
   相机先望电梯井内壁，下滑中缓缓转向电梯门方向；
   到一楼后从绳子上跳进大堂。 */
let ropeCG = false, ropeLanded = false, ropeT0 = 0;
let ropeCamLight = null;
/* 一楼井口垂下来的绳头（绳子本体在 4F 井道里，到一楼后那一组会隐藏） */
const ropeStub1 = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 6), M(0x9a8a6c, { r: 0.9 }));
ropeStub1.position.set(0, LVL1_Y + 1.75, 2.14);
lvl1Grp.add(ropeStub1);

/* ==================== 地下车库章节 ==================== */
var roadGrp = null, roadCar = null, roadHeadlight = null;
const GAR_Y = LVL1_Y - 3.5;   // 车库地面 = 1F 楼板下 3.5m（与车库几何 FG、floorYAt 一致）
/* 逃脱类结局字幕：结局号 + 名字 + 副标题 */
function showEndTitle(line, name, sub) {
  const el = document.getElementById('endTitle');
  if (!el || el.classList.contains('show')) return;
  el.querySelector('.line').textContent = line;
  el.querySelector('.name').textContent = name;
  const sb = el.querySelector('.sub');
  if (sb) sb.textContent = sub || '';
  el.classList.add('show');
  document.body.classList.add('ending');
  if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
}
/* 横死结局字幕（非机器人处决） */
function showDeathTitle(name) {
  const dEl = document.getElementById('deathTitle');
  if (!dEl || dEl.classList.contains('show')) return;
  const nm = dEl.querySelector('.name');
  if (nm) nm.textContent = name;
  dEl.classList.add('show');
  document.body.classList.add('ending');
  if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
}

/* 汽车启动 + 怠速轰鸣（合成：低频锯齿爬升后稳住 + 点火咔哒） */
SFX.carEngine = function () {
  if (!AC) return;
  const t = AC.currentTime;
  const o = AC.createOscillator(); o.type = 'sawtooth';
  o.frequency.setValueAtTime(28, t);
  o.frequency.exponentialRampToValueAtTime(95, t + 0.5);
  o.frequency.exponentialRampToValueAtTime(68, t + 1.6);
  const lp = AC.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 1.1;
  const g = AC.createGain();
  g.gain.setValueAtTime(0.001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.4);
  g.gain.setValueAtTime(0.10, t + 1.6);
  g.gain.exponentialRampToValueAtTime(0.001, t + 3.2);
  o.connect(lp); lp.connect(g); g.connect(master);
  o.start(); o.stop(t + 3.3);
  const s = AC.createBufferSource(); s.buffer = this.noise(0.3);
  const bp = AC.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 2;
  const g2 = AC.createGain();
  g2.gain.setValueAtTime(0.001, t);
  g2.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
  s.connect(bp); bp.connect(g2); g2.connect(master); s.start(); s.stop(t + 0.3);
};

/* ---- 爬过卷帘门底缝 CG ---- */
function beginCrawlCG() {
  if (state !== 'play' || curLevel !== -2) return;
  if (inGarage) { say('（先找到出去的路）', 2000); return; }
  if (crawlCG) return;
  crawlCG = true;
  crawlStage = 0;
  crawlT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  setHeldItemsVisible(false);
  clearMoveInput();
  closePhoneView();
  document.body.classList.add('cg');
  setState('crawlcg');
  say('（从底缝钻进去……）', 2400);
}
function landCrawlCG() {
  inGarage = true;
  playerPos.x = -7.0; playerPos.z = 9.6;
  playerFloorY = GAR_Y;
  /* 车库巡逻机器人开始活动；旁白提示掏手机开手电 */
  startGarageRobot();
  say('（空旷的车库……有东西在动。掏出手机开手电，先照照路。）', 3400);
  lookYaw = Math.PI - SIT.yaw; lookPitch = 0;
  document.body.classList.remove('cg');
  setHeldItemsVisible(true);
  setState('play');
  say('好黑，有手机照着就好了...', 3000);
  setTimeout(function () {
    if (state !== 'play' || !inGarage) return;
    showObjective('寻找出去的路', '地下车库');
  }, 2400);
}
function updateCrawlCG() {
  const t = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - crawlT0) / 1000;
  const PLAT = LVL1_Y - 1.45;                // 楼梯平台标高（卷帘门内侧）
  const standP = PLAT + 1.58, eyeP = PLAT + 0.34;      // 平台上的站高 / 爬高
  const standG = GAR_Y + 1.58, eyeG = GAR_Y + 0.34;    // 车库地坪的站高 / 爬高
  let y = standP, z = 7.7, pitch = -0.05, roll = 0, x = -7.0;
  if (t < 0.8) {
    y = standP; pitch = -0.30;
  } else if (t < 1.6) {
    const k = (t - 0.8) / 0.8, e = k * k * (3 - 2 * k);
    y = standP + (eyeP - standP) * e;
    pitch = -0.30 + e * 0.20;
  } else if (t < 2.8) {
    /* 平台上爬行：从卷帘门底缝钻过去（z 7.7 → 8.75） */
    const k = (t - 1.6) / 1.2, e = k * k * (3 - 2 * k);
    y = eyeP;
    z = 7.7 + (8.75 - 7.7) * e;
    x = -7.0 + Math.sin(t * 6.3) * 0.03;
    pitch = -0.10 + Math.sin(t * 7.0) * 0.05;
    roll = Math.sin(t * 5.2) * 0.06;
  } else if (t < 3.6) {
    /* 过了门缝：掉落到车库地坪（2.05m 落差），顺势蹭着向前 */
    const k = (t - 2.8) / 0.8;
    y = eyeP + (eyeG - eyeP) * (k * k);
    z = 8.75 + (9.6 - 8.75) * k;
    pitch = -0.10 - k * 0.22;
    roll = Math.sin(t * 6.0) * 0.08;
    crawlStage = 3;
  } else if (t < 4.4) {
    /* 落地起身 */
    if (crawlStage < 4) { SFX.thud('soft'); heliShakeAmt = 0.35; }
    crawlStage = 4;
    const k = (t - 3.6) / 0.8, e = k * k * (3 - 2 * k);
    y = eyeG + (standG - eyeG) * e;
    z = 9.6;
    pitch = -0.32 * (1 - e);
  } else {
    landCrawlCG(); return;
  }
  cam.position.set(PR.x + x, PR.y + y, PR.z + z);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(pitch, Math.PI, roll);
}

/* ---- 燃烧的车爆炸（横死结局） ---- */
function beginCarBurnDeath(tgt) {
  if (state !== 'play' || curLevel !== -2 || !inGarage) return;
  const bc = tgt && tgt.ref;
  if (bc && bc.exploded) return;
  if (bc) bc.exploded = true;
  carBurnT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  setHeldItemsVisible(false);
  clearMoveInput();
  closePhoneView();
  document.body.classList.add('cg');
  SFX.boom(); flash(0.5); heliShakeAmt = 1.4;
  if (bc) spawnSparks(PR.x + bc.x, PR.y + GAR_Y + 0.8, PR.z + bc.z, 0xffa04a, 30, 5);
  setState('carburn');
}
function updateCarBurn() {
  const t = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - carBurnT0) / 1000;
  cam.position.set(PR.x + playerPos.x, PR.y + GAR_Y + 1.58 - Math.min(0.9, t * 0.9), PR.z + playerPos.z);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(-0.2 + t * 0.1, Math.PI, Math.min(0.9, t * 1.4));
  if (t < 0.6) { heliShakeAmt = 1.4; if (Math.random() < 0.3) flash(0.2); }
  setLids(Math.min(1, Math.max(0, (t - 0.5) / 1.5)));
  if (t > 2.4) showDeathTitle('我怎么老被炸啊');
}

/* ---- 黑色密室：直接开车库尽头卷帘门的坏结局 ---- */
function beginBlackRoom() {
  if (state !== 'play' || curLevel !== -2 || !inGarage) return;
  blackroomT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  blackroomPhase = 0;
  setHeldItemsVisible(false);
  clearMoveInput();
  closePhoneView();
  document.body.classList.add('cg');
  setState('blackroom');
}
function updateBlackRoom() {
  const t = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - blackroomT0) / 1000;
  if (blackroomPhase === 0) {
    setLids(1);
    if (t > 0.6) {
      blackroomPhase = 1;
      if (lvl1Grp) lvl1Grp.visible = false;
      if (blackRoomGrp) blackRoomGrp.visible = true;
      if (robot.parent !== playerRoom) playerRoom.add(robot);
      robot.visible = true;
      robot.position.set(108, -50, 109.2);
      robot.rotation.set(0, Math.PI, 0);
      robotOut = true;
      playerPos.x = 108; playerPos.z = 106.8;
      playerFloorY = -50;
      lookYaw = Math.PI - SIT.yaw; lookPitch = 0;
      SFX.startChainsaw(); SFX.isChainsawOn = true;
    }
    return;
  }
  cam.position.set(PR.x + 108, PR.y - 50 + 1.58, PR.z + 106.8);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(0, Math.PI, 0);
  if (blackroomPhase === 1) {
    setLids(Math.max(0, 1 - (t - 0.8) / 0.7));
    if (t > 2.2) { blackroomPhase = 2; say('原来不止一只...', 2200); }
  } else if (blackroomPhase === 2) {
    if (t > 3.4) {
      const dNm = document.querySelector('#deathTitle .name');
      if (dNm) dNm.textContent = '旧患未除，新殃又至';
      document.body.classList.remove('cg');
      setState('play');
      beginDeath();
    }
  }
}

/* ---- 汽车逃脱 CG（结局 3 / 4） ---- */
function beginCarEscape() {
  if (state !== 'play' || curLevel !== -2 || !inGarage) return;
  stopGarageRobot();         // 上车逃离：车库巡逻结束
  carEscapeT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  carEscapePhase = 0;
  setHeldItemsVisible(false);
  clearMoveInput();
  closePhoneView();
  document.body.classList.add('cg');
  setState('carescape');
  say('终于...', 2000);
}
function updateCarEscape() {
  let t = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - carEscapeT0) / 1000;
  /* 调试：?cgthold=12 把 CG 定格在第 12 秒（同 ?fallt 的思路），截图/逐帧检查用 */
  const cgthold = parseFloat(QS.get('cgthold'));
  if (!isNaN(cgthold)) t = cgthold;
  const gy = GAR_Y;
  if (t < 1.4) {
    const k = t / 1.4, e = k * k * (3 - 2 * k);
    cam.position.set(PR.x + 0.5 - e * 0.7, PR.y + gy + 1.58 - e * 0.5, PR.z + 17.6 + e * 0.4);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(-0.1 - e * 0.2, Math.PI, 0);
    return;
  }
  if (t < 2.4) {
    const k = (t - 1.4) / 1.0, e = k * k * (3 - 2 * k);
    cam.position.set(PR.x + 0.5, PR.y + gy + 1.08, PR.z + 18.4 + e * 1.0);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(-0.05, Math.PI, 0);
    return;
  }
  if (t < 4.6) {
    setLids(Math.min(1, (t - 2.4) / 0.9));
    if (carEscapePhase === 0) { carEscapePhase = 1; SFX.carEngine(); }
    return;
  }
  if (t < 8.6) {
    if (carEscapePhase === 1) {
      carEscapePhase = 2;
      if (lvl1Grp) lvl1Grp.visible = false;
      if (roofGrp) roofGrp.visible = true;
      ensureHeliBeam();
    }
    setLids(Math.max(0, 1 - (t - 4.6) / 0.8));
    const k = Math.min(1, (t - 4.6) / 4.0);
    cam.position.set(PR.x + 6 + k * 6, PR.y + 2.90 + 15 + k * 6, PR.z + 10 + k * 8);
    cam.up.set(0, 1, 0);
    cam.lookAt(PR.x + 0, PR.y + 2.90 + 1.0, PR.z + 2);
    if (heliBeam && heliBeamTgt) {
      heliBeam.intensity = 4.0;
      heliBeam.position.set(Math.sin(t * 0.6) * 3, 2.90 + 11, Math.cos(t * 0.5) * 3 - 2);
      heliBeamTgt.position.set(Math.sin(t * 0.9) * 1.6, 2.90, Math.cos(t * 0.8) * 1.6);
    }
    return;
  }
  if (t < 9.6) {
    setLids(Math.min(1, (t - 8.6) / 0.9));
    return;
  }
  if (t < 14.6) {
    if (carEscapePhase === 2) {
      carEscapePhase = 3;
      if (roofGrp) roofGrp.visible = false;
      if (roadGrp) roadGrp.visible = true;
      say('起码我活下来了...', 3200);
    }
    setLids(Math.max(0, 1 - (t - 9.6) / 0.8));
    const k = Math.min(1, (t - 9.6) / 5.0);
    if (roadCar) roadCar.position.z = -20 + k * 40;
    const cx = roadGrp.position.x, cy = roadGrp.position.y, cz = roadGrp.position.z;
    const rcz = roadCar ? roadCar.position.z : 0;
    /* 追逐镜头：跟在车后上方（路上没有任何树，两侧燃烧的树只是向后掠过的剪影），
       轻微颠簸 + 前灯照亮前路 + 虚线/火树掠过 —— 行驶感 */
    cam.position.set(cx + 1.2 + Math.sin(t * 1.9) * 0.4, cy + 3.3 + Math.sin(t * 2.7) * 0.1, cz + rcz - 9);
    cam.up.set(0, 1, 0);
    cam.lookAt(cx + Math.sin(t * 0.9) * 0.4, cy + 1.2, cz + rcz + 5);
    return;
  }
  setLids(Math.min(1, (t - 14.6) / 0.9));
  if (t > 15.6 && carEscapePhase === 3) {
    carEscapePhase = 4;
    if (garageSideDone) {
      showEndTitle('结局 4', '火焰并不比太阳闪耀...', '我们一起逃出来了。');
      achUnlock('end4');
    } else {
      showEndTitle('结局 3', '摇扇风甚微...', '起码我活下来了。');
      achUnlock('end3');
    }
  }
}

/* ---- 尽头小门：被困的人 + 支线 ---- */
function garageDoorInteract() {
  if (state !== 'play' || curLevel !== -2 || !inGarage) return;
  if (garageSideDone) { say('（他们会从这儿出去的）', 2200); return; }
  /* 剧情门控：必须先听过被困者的呼救（旁白里点出「用镰刀锤子」），
     之后手上有镰刀锤子才能打开 —— 不存在跳过对话直接开门的路径 */
  if (!garageSideHeard) {
    garageSideHeard = true;
    say('打不开...', 1600);
    setTimeout(function () { say('【咳咳...救救我们...咳咳...也带我们走...】', 3600); }, 1800);
    setTimeout(function () { say('...', 1100); }, 5600);
    setTimeout(function () { say('还有孩子这里...', 2200); }, 7000);
    setTimeout(function () {
      say('（这锁扣……也许镰刀与锤子能砸开。）', 3000);
      showSideQuest('用镰刀锤子试着救出人民', '小门后有人被困');
    }, 9400);
    return;
  }
  if (itemInHand('tools')) {
    garageSideDone = true;
    SFX.glassBreak();
    say('【谢谢...谢谢】', 2400);
    setTimeout(function () { say('（继续寻找出去的方法，他们会一起逃出去）', 3200); }, 2600);
    hideSideQuest();
    return;
  }
  say('（旁白说过——镰刀与锤子也许能砸开这锁扣。）', 2600);
}

/* 森林公路（汽车逃脱 CG 的上帝视角场景，加载时建好隐藏，火焰才能拿到 invQ） */
roadGrp = new THREE.Group();
roadGrp.position.set(200, -60, 240);
{
  /* 地面：之前漏了，只有 5m 宽的路面悬在虚空——公路外的大地补回来 */
  roadGrp.add(put(box(90, 0.2, 120, M(0x111318, { r: 1.0 })), 0, -0.12, 0));
  const rdM = M(0x24272d, { r: 0.94, m: 0.02 });   // 沥青本色偏暗灰：无灯仍黑，受前照灯时能自然显形
  roadGrp.add(put(box(5.0, 0.2, 70, rdM), 0, 0, 0));
  /* 中央虚线 + 路肩实线：向后掠过的速度感 */
  const dashM = M(0x6a6a5a, { r: 0.8 }), shoulderM = M(0x3a3a32, { r: 0.9 });
  for (let di = 0; di < 18; di++) roadGrp.add(put(box(0.18, 0.02, 1.8, dashM), 0, 0.11, -31.5 + di * 3.8));
  roadGrp.add(put(box(0.1, 0.02, 70, shoulderM), -2.4, 0.11, 0));
  roadGrp.add(put(box(0.1, 0.02, 70, shoulderM), 2.4, 0.11, 0));
  const trunkM = M(0x0a0806, { r: 0.92 });
  const leafM = M(0x0c1410, { r: 0.95 });
  for (let ti = 0; ti < 22; ti++) {
    const side = (ti % 2) ? 1 : -1;
    const tx = side * (4.6 + Math.random() * 4.5);
    const tz = -32 + ti * 3.0 + Math.random() * 1.5;
    const th = 2.4 + Math.random() * 2.2;
    roadGrp.add(put(box(0.32, th, 0.32, trunkM), tx, th / 2, tz));
    /* 树冠：两层锥体剪影——之前只剩光秃秃的树干 */
    roadGrp.add(put(new THREE.Mesh(new THREE.ConeGeometry(1.15, 1.7, 6), leafM), tx, th + 0.7, tz));
    roadGrp.add(put(new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.2, 6), leafM), tx, th + 1.5, tz));
    addFlame(roadGrp, tx, th + 1.6, tz, 0.9 + Math.random() * 0.5, 1.5 + Math.random() * 0.8);
    if (ti % 3 === 0) roadGrp.add(put(new THREE.PointLight(0xff6a24, 1.3, 11, 2), tx, th + 0.9, tz));
  }
  roadCar = makeCar(0, -20, 0, 0x1c2c4a, false);
  roadCar.position.y = 0.1;
  roadGrp.add(roadCar);
  /* 前大灯 ×2：挂在车身上跟着车走。
     SpotLight 负责真实照亮道路/树干；贴地渐变光斑保证 ACES 暗调下仍能看见自然光锥。 */
  const hlM = M(0xffe6b8, { e: 0xffe6b8, ei: 3.2 });
  roadCar.add(put(box(0.22, 0.12, 0.06, hlM), -0.62, 0.72, 2.16));
  roadCar.add(put(box(0.22, 0.12, 0.06, hlM), 0.62, 0.72, 2.16));
  roadHeadlight = new THREE.SpotLight(0xffe8c4, 52, 38, 0.36, 0.72, 1.0);
  roadHeadlight.position.set(-0.62, 0.78, 2.05);
  const rdTgt = new THREE.Object3D(); rdTgt.position.set(-0.62, 0.08, 20);
  roadCar.add(roadHeadlight); roadCar.add(rdTgt); roadHeadlight.target = rdTgt;
  const roadHeadlight2 = new THREE.SpotLight(0xffe8c4, 52, 38, 0.36, 0.72, 1.0);
  roadHeadlight2.position.set(0.62, 0.78, 2.05);
  const rdTgt2 = new THREE.Object3D(); rdTgt2.position.set(0.62, 0.08, 20);
  roadCar.add(roadHeadlight2); roadCar.add(rdTgt2); roadHeadlight2.target = rdTgt2;
  /* 近场补光：照出保险杠前 3~6 米，避免两个锥体从车头处产生黑色死区 */
  roadCar.add(put(new THREE.PointLight(0xffdfaa, 4.2, 9.5, 2), 0, 0.72, 3.2));
  /* 中/远场填充：低位布在车前，随车移动。路面形成连续暖色亮区，
     同时轻微照出路肩树干；强度逐级衰减，避免出现两个圆形灯斑。 */
  roadCar.add(put(new THREE.PointLight(0xffd49a, 3.0, 14, 2), 0, 1.3, 8.5));
  roadCar.add(put(new THREE.PointLight(0xffc77d, 1.6, 18, 2), 0, 2.0, 17));
  /* 长距离贴地柔光：Canvas 椭圆渐变，前端亮、远端与两侧自然消散。
     它是纯视觉光斑，不投射阴影，不增加每个材质的灯光计算。 */
  const beamCv = document.createElement('canvas'); beamCv.width = 256; beamCv.height = 512;
  const beamCx = beamCv.getContext('2d');
  const beamG = beamCx.createRadialGradient(128, 475, 8, 128, 270, 250);
  beamG.addColorStop(0, 'rgba(255,238,202,0.56)');
  beamG.addColorStop(0.22, 'rgba(255,225,174,0.34)');
  beamG.addColorStop(0.58, 'rgba(255,210,145,0.13)');
  beamG.addColorStop(1, 'rgba(255,196,120,0)');
  beamCx.fillStyle = beamG; beamCx.fillRect(0, 0, 256, 512);
  const beamTex = new THREE.CanvasTexture(beamCv);
  if (THREE.sRGBEncoding) beamTex.encoding = THREE.sRGBEncoding;
  const beamMat = new THREE.MeshBasicMaterial({
    map: beamTex, color: 0xffe4b5, transparent: true, opacity: 1.0, depthWrite: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false
  });
  const beamPatch = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 30), beamMat);
  beamPatch.rotation.x = -Math.PI / 2;
  beamPatch.position.set(0, 0.055, 16.5);
  beamPatch.renderOrder = 3;
  roadCar.add(beamPatch);
  /* 可见空气光束 ×2：用从灯口斜落到远处路面的渐隐光幕，而不是实体圆锥壳。
     后方追逐镜头能看到光束越过车身；边缘/远端由贴图渐隐，不会出现多边形“伞盖”。 */
  for (const vx of [-0.62, 0.62]) {
    const airGeo = new THREE.BufferGeometry();
    airGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      vx - 0.11, 0.66, 2.2,  vx + 0.11, 0.66, 2.2,  vx + 1.8, 0.08, 30,
      vx - 0.11, 0.66, 2.2,  vx + 1.8, 0.08, 30,   vx - 1.8, 0.08, 30
    ]), 3));
    airGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0.46,1, 0.54,1, 1,0,
      0.46,1, 1,0, 0,0
    ]), 2));
    const airMat = new THREE.MeshBasicMaterial({
      map: beamTex,
      color: 0xffe7bf,
      transparent: true,
      opacity: 0.13,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false
    });
    const airBeam = new THREE.Mesh(airGeo, airMat);
    airBeam.renderOrder = 4;
    roadCar.add(airBeam);
  }
  /* 保底的扇形分段光斑：十段轻微重叠的暖色梯形，越远越宽、越淡。
     单段透明度很低，叠起来是连续衰减，不会出现一块生硬的白色矩形。 */
  for (let bi = 0; bi < 10; bi++) {
    const z0 = 2.4 + bi * 2.7, z1 = z0 + 3.0;
    const w0 = 0.95 + bi * 0.22, w1 = 1.25 + bi * 0.30;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -w0, 0, z0,  w0, 0, z0,  w1, 0, z1,
      -w0, 0, z0,  w1, 0, z1, -w1, 0, z1
    ]), 3));
    const bm = new THREE.MeshBasicMaterial({
      color: bi < 4 ? 0xffe6bd : 0xffd28f,
      transparent: true,
      opacity: 0.18 * Math.pow(1 - bi / 11, 1.25),
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    const seg = new THREE.Mesh(bg, bm);
    seg.position.y = 0.06 + bi * 0.0005;
    seg.renderOrder = 2;
    roadCar.add(seg);
  }
  /* 尾灯 ×2：后视角下车身轮廓可读 */
  const tlM = M(0xff2a1a, { e: 0xff2a1a, ei: 2.2 });
  roadCar.add(put(box(0.26, 0.1, 0.05, tlM), -0.62, 0.74, -2.16));
  roadCar.add(put(box(0.26, 0.1, 0.05, tlM), 0.62, 0.74, -2.16));
  roadGrp.add(new THREE.HemisphereLight(0x2a1408, 0x040302, 0.5));
  const moon = new THREE.DirectionalLight(0x8fa3c8, 0.55);
  moon.position.set(-20, 30, -10); roadGrp.add(moon);
}
roadGrp.visible = false;
scene.add(roadGrp);
function beginRopeCG() {
  if (ropeCG) return;
  ropeCG = true; ropeLanded = false;
  ropeT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  document.body.classList.add('cg');
  hideObjective(); closePhoneView(); endStairChoice();
  const tEl = document.getElementById('objTimer');
  if (tEl) tEl.classList.remove('show');
  lvl4Timer = -1;                                   // 木梁倒计时到此为止
  setHeldItemsVisible(false);
  clearMoveInput();
  if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  /* 消耗毛巾：从手上/背包里彻底移除（不能用 detachFromHand——它会把毛巾放回世界原位） */
  const ti = invFind('towel');
  if (ti >= 0) {
    const rec = recOf('towel');
    if (rec) {
      const m = rec.held || rec.obj;
      if (m && m.parent === handRig) handRig.remove(m);
      if (rec.held) rec.held.visible = false;
      rec.obj.visible = false;
      rec.phys = null; rec.dropped = false;
    }
    inv[ti] = null;
    refreshInventoryHUD();
  }
  /* 毛巾包到绳子上（先回到 4F 井道顶端，CG 里跟着手滑下来） */
  if (ropeTowel) { elev4Shaft.add(ropeTowel); ropeTowel.position.set(0, 1.8, -0.2); ropeTowel.visible = true; }
  /* 井道里很黑：CG 期间给相机挂一盏小灯，照出毛巾/绳子/井壁 */
  if (!ropeCamLight) {
    ropeCamLight = new THREE.PointLight(0xffd9b0, 0.0, 3.2, 2);
    cam.add(ropeCamLight);
  }
  ropeCamLight.intensity = 0.55;
  setState('ropecg');
  say('（把毛巾缠上绳子，抓紧了……）', 2800);
}
/* 落地：切楼层、放玩家进大堂、弹任务 */
function landRopeCG() {
  ropeLanded = true;
  switchLevel(-2);
  playerPos.x = 0; playerPos.z = 3.5;
  playerFloorY = LVL1_Y;
  lookYaw = Math.PI - SIT.yaw; lookPitch = 0;       // 面向大堂深处
  document.body.classList.remove('cg');
  setHeldItemsVisible(true);
  if (ropeCamLight) ropeCamLight.intensity = 0;
  /* 毛巾留在绳底（一楼井口） */
  if (ropeTowel) {
    lvl1Grp.add(ropeTowel);
    ropeTowel.position.set(0, LVL1_Y + 1.02, 2.14);
    ropeTowel.visible = true;
  }
  heliShakeAmt = 0.55;                              // 落地一震
  SFX.thud('soft');
  setState('play');
  say('（到一楼了……）', 2200);
  setTimeout(function () {
    if (state !== 'play' || curLevel !== -2) return;
    say('正门被阻挡了，看来我们得去侧门了', 3400);
    showObjective('寻找侧门钥匙与侧门', '保安亭里也许有钥匙');
  }, 2600);
}
/* 滑绳 CG 每帧：下坠 + 转向 + 跳离，相机完全接管 */
function updateRopeCG() {
  const t = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - ropeT0) / 1000;
  const Y0 = -1.45, Y1 = LVL1_Y + 1.58;             // 起滑视高 → 一楼视高
  let y = Y0, z = 2.14, yaw = 0, pitch = -0.12;
  if (t < 1.3) {
    /* 抓紧：望着眼前的井壁 */
    pitch = -0.12 + Math.sin(t * 2.2) * 0.02;
  } else if (t < 8.4) {
    const k = (t - 1.3) / 7.1;
    const e = k * k * (3 - 2 * k);
    y = Y0 + (Y1 - Y0) * e;
    /* 缓慢从井壁转向电梯门方向，转到一半抬眼看一楼门洞透出的火光 */
    const tk = Math.max(0, Math.min(1, (t - 2.8) / 5.0));
    const te = tk * tk * (3 - 2 * tk);
    yaw = Math.PI * te;
    pitch = -0.12 + Math.sin(te * Math.PI) * 0.30;
  } else {
    /* 跳离绳子：往大堂里落，脚下顿一下再弹回 */
    const k = Math.min(1, (t - 8.4) / 1.3);
    const e = k * k * (3 - 2 * k);
    z = 2.14 + (3.5 - 2.14) * e;
    y = Y1 - Math.sin(k * Math.PI) * 0.34;
    yaw = Math.PI;
    pitch = -0.12 + e * 0.06;
    if (k >= 1 && !ropeLanded) { landRopeCG(); return; }
  }
  /* 快到一楼井口时提前把一楼点亮（隔着井壁，看不见切换） */
  if (t > 6.8 && lvl1Grp && !lvl1Grp.visible) lvl1Grp.visible = true;
  /* 毛巾跟着手一路滑到绳底 */
  if (ropeTowel && !ropeLanded) ropeTowel.position.y = Math.max(-7.6, y + 3.25);
  const swX = Math.sin(t * 1.9) * 0.035, swZ = Math.sin(t * 1.3) * 0.02;
  cam.position.set(PR.x + swX, PR.y + y, PR.z + z + swZ);
  cam.rotation.order = 'YXZ';
  cam.rotation.set(pitch, yaw, Math.sin(t * 1.6) * 0.03);
}
/* ---- 侧门空调外机坠落：开门后 1.4s 竖直砸进门外泥土 ---- */
let acDropped = false, acDropT0 = 0;
function dropACUnit() {
  if (acDropped || !acUnit) return;
  acDropped = true;
  acUnit.visible = true;
  acUnit.position.set(10.0, LVL1_Y + 3.6, 6.1);
  acDropT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
}
function updateACUnit() {
  if (!acDropped || !acUnit || acUnit.userData.landed) return;
  const t = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - acDropT0) / 1000;
  if (t < 0.55) {
    const k = t / 0.55;
    acUnit.position.y = LVL1_Y + 3.6 - 3.88 * k * k;
  } else {
    acUnit.userData.landed = true;
    acUnit.position.y = LVL1_Y - 0.28;
    if (acMound) acMound.visible = true;
    heliShakeAmt = 1.0;
    SFX.thud('metal');
    setTimeout(function () { SFX.boom(); }, 60);
    spawnSparks(PR.x + 10.0, PR.y + LVL1_Y + 0.3, PR.z + 6.1, 0xffc06a, 18, 3.5);
    setTimeout(function () {
      say('...去地下车库，还有一条路', 3200);
      showObjective('寻找通往地下车库的楼梯', '它在大堂的西侧');
    }, 900);
  }
}
/* ---- 一楼：窒息值 / 咳嗽 / 视野模糊 / 泪滴 / 远处爆炸 ---- */
const blurOvEl = document.getElementById('blurOv');
const tearsEl = document.getElementById('tears');
const oxygenEl = document.getElementById('oxygen');
const oxygenFill = oxygenEl ? oxygenEl.querySelector('.fill') : null;
let suffO2 = 60, suffDead = false, suffDeadT0 = 0;
let suffHinted = false, suffHinted2 = false;
let coughIn = 5, coughShake = 0, boom1In = 7;
function updateFloor1(dt) {
  /* 侧门开合动画（任何状态都平滑） */
  if (sideDoor1Pivot) {
    const wantSD = sideDoor1Open ? 1.5 : 0;
    sideDoor1Pivot.rotation.y += (wantSD - sideDoor1Pivot.rotation.y) * Math.min(1, dt * 4);
  }
  if (coughShake > 0) { coughShake *= Math.pow(0.02, dt); if (coughShake < 0.005) coughShake = 0; }
  updateACUnit();
  if (curLevel !== -2) { if (oxygenEl) oxygenEl.classList.remove('show'); return; }
  if (inGarage) { if (oxygenEl) oxygenEl.classList.remove('show'); return; }   // 车库里有空气，暂停窒息
  /* 窒息条：一楼期间常驻，低于 7s 变红 */
  if (oxygenEl) {
    oxygenEl.classList.add('show');
    if (oxygenFill) oxygenFill.style.width = (suffO2 / 60 * 100).toFixed(1) + '%';
    oxygenEl.classList.toggle('low', suffO2 < 12);
  }
  /* 窒息死亡演出：视野渐黑，字幕升起 */
  if (suffDead) {
    const dts = ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - suffDeadT0) / 1000;
    setLids(Math.min(1, dts / 2.2));
    if (dts > 2.8) {
      const dEl = document.getElementById('deathTitle');
      if (dEl && !dEl.classList.contains('show')) {
        const nm = dEl.querySelector('.name');
        if (nm) nm.textContent = '你倒在了浓烟里';
        dEl.classList.add('show');
        document.body.classList.add('ending');
      }
    }
    return;
  }
  if (state !== 'play') return;
  /* 一分钟耗尽 */
  suffO2 = Math.max(0, suffO2 - dt);
  const k = 1 - suffO2 / 60;                        // 0 清新 → 1 窒息
  /* 视野越来越模糊（平方曲线：后段急剧恶化） */
  if (blurOvEl) {
    const blpx = Math.round(k * k * 7 * 2) / 2;
    const bf = 'blur(' + blpx + 'px)';
    if (blurOvEl.style.backdropFilter !== bf) {
      blurOvEl.style.backdropFilter = bf;
      blurOvEl.style.webkitBackdropFilter = bf;
    }
    blurOvEl.style.opacity = k > 0.12 ? '1' : '0';
  }
  /* 泪滴 */
  if (tearsEl) tearsEl.style.opacity = String(Math.max(0, Math.min(0.85, (k - 0.35) / 0.5 * 0.85)));
  /* 咳嗽：间隔随窒息缩短（9s → 2.2s），咳时视角一沉 */
  coughIn -= dt;
  if (coughIn <= 0) {
    coughIn = 9 - k * 6.8;
    SFX.cough();
    coughShake = 0.45 + k * 0.8;
  }
  if (!suffHinted && k > 0.3) { suffHinted = true; say('烟太浓了……咳、咳……得尽快找到侧门。', 3000); }
  if (!suffHinted2 && k > 0.6) { suffHinted2 = true; say('快喘不上气了……', 2600); }
  /* 时不时远处爆炸：只有震响、闪光和抖动，没有旁白 */
  boom1In -= dt;
  if (boom1In <= 0) {
    boom1In = 9 + Math.random() * 13;
    SFX.boom();
    flash(0.15);
    heliShakeAmt = Math.max(heliShakeAmt, 0.85);
  }
  /* 窒息归零：倒在浓烟里 */
  if (suffO2 <= 0) {
    suffDead = true;
    suffDeadT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    clearMoveInput();
    SFX.cough();
    setState('dead');
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  }
}
/* ==================== 主循环 ==================== */
const clock = new THREE.Clock();
let running = false;
let introT0 = 0;   // 开场时间轴的挂钟起点

/* ---- 开场白快进/跳过按钮：单击 2 倍速（箭头变两个），再点整段跳过 ---- */
let introSpeed = 1, introSkipping = false;
const introFfEl = document.getElementById('introFf');
function introNow() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()); }
/* 换速时平移挂钟起点，保证 elapsed 连续不跳变 */
function setIntroSpeed(s) {
  introT0 = introNow() - (elapsed / s) * 1000;
  introSpeed = s;
}
function showIntroFf() { introFfEl.classList.add('show'); }
function hideIntroFf() { introFfEl.classList.remove('show', 'fast'); setIntroSpeed(1); }
/* 跳过：把剩下的事件一口气跑完（字幕/闪光/单次音效静音，状态类音效保留），直接进 await */
function skipIntro() {
  if (state !== 'intro' || introSkipping) return;
  introSkipping = true;
  const _say = say, _flash = flash;
  const _boom = SFX.boom, _scream = SFX.scream, _voice = SFX.voice, _whoosh = SFX.whoosh;
  say = function () {}; flash = function () {};
  SFX.boom = function () {}; SFX.scream = function () {};
  SFX.voice = function () {}; SFX.whoosh = function () {};
  try {
    while (evIdx < EV.length) { EV[evIdx].f(); evIdx++; }
    introT0 = introNow() - (EV[EV.length - 1].t / introSpeed) * 1000;
  } finally {
    say = _say; flash = _flash;
    SFX.boom = _boom; SFX.scream = _scream; SFX.voice = _voice; SFX.whoosh = _whoosh;
    introSkipping = false;
  }
}
introFfEl.addEventListener('click', function (ev) {
  ev.stopPropagation();
  if (state !== 'intro') return;
  if (introSpeed === 1) { setIntroSpeed(2); introFfEl.classList.add('fast'); }
  else skipIntro();
});

/* 调试：时间轴定格 */
const QS = new URLSearchParams(location.search);
const SCRUB = QS.has('t') ? parseFloat(QS.get('t')) : null;
const DBG = QS.has('dbg');
let FREEZE = false;

/* 面片朝向修正：火焰/烟雾的父节点可能带旋转（随机转向的树），
   预存父节点世界旋转的逆，billboard 时补偿掉 */
scene.updateMatrixWorld(true);
{
  const q = new THREE.Quaternion();
  const all = flames.concat(smokes);
  for (let i = 0; i < all.length; i++) {
    all[i].parent.getWorldQuaternion(q);
    all[i].userData.invQ = q.clone().invert();
  }
}

/* file:// 打开时 window.onerror 只能拿到 "Script error." 没有堆栈，
   所以把主循环包起来 —— 这里的 catch 能拿到真实 Error 对象和行号。
   出错只报一次，避免每帧刷屏；报完继续跑，不让画面直接死掉。 */
let loopErrShown = false;
/* 通用错误上报：file:// 下 window.onerror 只给 "Script error." 没有堆栈，
   所以在 JS 内部自己 catch —— 这里能拿到真实 Error 对象。
   主循环、事件回调、定时器都走这一个出口。 */
function guard(fn, tag) {
  return function () {
    try { return fn.apply(this, arguments); }
    catch (e) { e.__tag = tag; reportLoopError(e); }
  };
}
/* 把 setTimeout / setInterval 的回调统一包起来 —— 定时器里抛的错
   会直接冒到 window.onerror，file:// 下拿不到任何细节。包一层就能拿到真实 Error。 */
(function () {
  const _st = window.setTimeout, _si = window.setInterval;
  window.setTimeout = function (fn, d) {
    if (typeof fn !== 'function') return _st.apply(window, arguments);
    const rest = Array.prototype.slice.call(arguments, 2);
    return _st(function () {
      try { fn.apply(null, rest); } catch (e) { e.__tag = 'setTimeout'; reportLoopError(e); }
    }, d);
  };
  window.setInterval = function (fn, d) {
    if (typeof fn !== 'function') return _si.apply(window, arguments);
    const rest = Array.prototype.slice.call(arguments, 2);
    return _si(function () {
      try { fn.apply(null, rest); } catch (e) { e.__tag = 'setInterval'; reportLoopError(e); }
    }, d);
  };
})();
function reportLoopError(e) {
  if (loopErrShown) return;
  loopErrShown = true;
  let box = document.getElementById('jsErr');
  if (!box) {
    box = document.createElement('div');
    box.id = 'jsErr';
    box.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#600;color:#fff;' +
      'font:11px/1.5 monospace;padding:6px 9px;white-space:pre-wrap;max-height:50vh;overflow:auto;';
    document.body.appendChild(box);
  }
  box.textContent = '运行异常' + (e && e.__tag ? '[' + e.__tag + ']' : '') + '：' + (e && e.message ? e.message : e) + '\n\n' +
    ((e && e.stack) ? e.stack : '(无堆栈)').slice(0, 1200);
  try { console.error(e); } catch (_) {}
}
function animate() {
  try { animateBody(); } catch (e) { reportLoopError(e); }
}
function animateBody() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  if (menuOpen) {
    renderer.render(scene, cam);
    return;
  }
  if (running && !FREEZE) { elapsed = ((nowMs - introT0) / 1000) * introSpeed; }   // 挂钟驱动 × 快进倍率
  const t = elapsed;
  const sT = stateSec();

  if (state === 'intro') {
    while (evIdx < EV.length && t >= EV[evIdx].t) { EV[evIdx].f(); evIdx++; }
  }
  updateGlassBreak(dt);
  updatePlayerMovement(dt);
  dtCam = dt;                       // 相机里的平滑要按帧率归一化
  updateAim();
  updateStory(dt);
  updateStairChoice();
  updateLevelTransition();
  updateHeliTimer(dt);
  updateLvl4Timer(dt);
  updateFloor1(dt);
  if (state === 'death') updateDeath();
  updateDroppedItems(dt);
  updateSparks(dt);
  updateShells(dt);
  updateReload(dt);
  updateBarricade(dt);
  updateDoorDebris(dt);
  updateBGM();
  if (acFireLights.length) acFireLights.forEach(function(l,i){ l.intensity=((i%2)?1.1:3.0)*(0.78+0.22*Math.sin(elapsed*(8+i*0.4)+i)); });
  /* 套筒动画：开枪后坐复进 / 打空后停在后方 */
  if (pistolSlide) {
    let back = 0;
    if (slideT > 0) {
      slideT -= dt;
      const k = Math.max(0, slideT) / 0.1;
      back = Math.sin(k * Math.PI) * 0.026;       // 快速后退再复进
    }
    if (slideLocked) back = Math.max(back, 0.024);  // 后定：一直停在后方
    pistolSlide.position.x = -back;
  }
  /* 枪口火光 / 曳光消退 */
  if (muzzleT > 0) { muzzleT -= dt; if (muzzleT <= 0) muzzleLight.intensity = 0; }
  if (tracerT > 0) {
    tracerT -= dt; tracer.material.opacity = Math.max(0, tracerT / 0.07) * 0.9;
    if (tracerT <= 0) tracer.visible = false;
  }
  /* 挥斧动画：斧头绕手抡一圈（在持握姿态上叠加）*/
  if (axeSwingT > 0) {
    axeSwingT -= dt;
    const recA = recOf('axe');
    if (recA) {
      const mA = recA.held || recA.obj;
      const pose = HAND_POSE.axe && HAND_POSE.axe.R;
      if (mA && pose) {
        const k = 1 - Math.max(0, axeSwingT) / 0.42;
        const swing = Math.sin(k * Math.PI);
        mA.rotation.set(pose.r[0] - swing * 1.35, pose.r[1], pose.r[2] + swing * 0.3);
        if (axeSwingT <= 0) mA.rotation.set(pose.r[0], pose.r[1], pose.r[2]);
      }
    }
  }
  /* 双手物品（斧头 / 镰刀锤子）在手时：左手物品隐藏、失效 */
  {
    const th = twoHandedHeld();
    const ls = handSlot('L');
    if (ls >= 0 && inv[ls]) {
      const recL = recOf(inv[ls].id);
      const mm = recL && (recL.held || recL.obj);
      if (mm && mm.parent === handRig) mm.visible = !th;
    }
  }
  /* 收音机静电：按与收音机的距离衰减 */
  if (radioOn && radioGain && AC && radioGrp) {
    radioGrp.getWorldPosition(_wp);
    const rd = Math.hypot(playerPos.x - _wp.x, playerPos.z - _wp.z);
    const vol = 0.085 * Math.max(0, Math.min(1, 1.15 - rd / 7));
    radioGain.gain.setTargetAtTime(vol, AC.currentTime, 0.15);
  }
  /* 门开合 / 台灯 / 手机手电，全部按帧平滑 */
  if (doorPivot) {
    const want = doorOpen ? -1.62 : -0.12;
    doorAngle += (want - doorAngle) * Math.min(1, dt * 5.5);
    doorPivot.rotation.y = doorAngle;
  }
  if (lampLight) {
    const wantI = lampOn ? 0.85 : 0.0;
    lampLight.intensity += (wantI - lampLight.intensity) * Math.min(1, dt * 8);
    if (lampMat) lampMat.emissiveIntensity = lampOn ? 0.5 : 0.03;
  }
  /* 衣柜门：两扇向外开，铰链在外侧竖边，所以左右转向相反 */
  if (wardrobeDoors.length) {
    const wantA = wardrobeOpen ? 1.15 : 0.0;
    wardrobeAngle += (wantA - wardrobeAngle) * Math.min(1, dt * 6);
    for (let i = 0; i < wardrobeDoors.length; i++) {
      const wd = wardrobeDoors[i];
      wd.pivot.rotation.y = -wd.side * wardrobeAngle;
    }
  }
  if (phoneLight) {
    const th = twoHandedHeld();
    const on = itemInHand('phone') && !th;       // 双手物品在手时手机手电筒关闭
    const wantI = on ? 1.15 : 0.0;
    phoneLight.intensity += (wantI - phoneLight.intensity) * Math.min(1, dt * 9);
    /* 手机拿在手上：有未读消息时屏幕脉冲发光（不打开也能注意到） */
    if (on && phoneScreenMat) {
      phoneScreenMat.emissiveIntensity = (phoneMsg505 && !phoneNewsRead)
        ? 1.1 + Math.sin(t * 7) * 0.55 : 1.5;
    }
  }
  /* 走廊：505 洞口的火光跳动，楼梯口应急灯将坏未坏地闪 */
  if (corrFireLight) {
    corrFireLight.intensity = 1.05 + Math.sin(t * 5.3) * 0.22 + Math.random() * 0.16;
  }
  if (corrLight) {
    const flick = (Math.sin(t * 2.1) > 0.82 || Math.random() < 0.015) ? 0.08 : 0.42;
    corrLight.intensity += (flick - corrLight.intensity) * Math.min(1, dt * 14);
  }

  /* 相机 */
  if (state === 'intro' || state === 'await' || state === 'closing') {
    sampleCam(Math.min(t, KEYS[KEYS.length - 1].t));
    cam.position.copy(_a);
    const shake = t < 26 ? 0.005 : 0.012;
    cam.position.x += Math.sin(t * 12.9) * shake + Math.sin(t * 7.1) * shake * 0.6;
    cam.position.y += Math.sin(t * 16.3) * shake * 0.7;
    cam.rotation.order = 'XYZ';
    cam.up.set(0, 1, 0);
    cam.lookAt(_b);
    // 终场变焦推近：镜头不再前进（否则会穿过锯条），改为收窄视场角把羊头放大
    const z = Math.max(0, Math.min(1, (t - 39.5) / 7.5));
    const fov = 52 - 16 * (z * z * (3 - 2 * z));
    if (Math.abs(cam.fov - fov) > 0.02) { cam.fov = fov; cam.updateProjectionMatrix(); }
  } else if (state === 'black' || state === 'opening') {
    if (cam.fov !== 52) { cam.fov = 52; cam.updateProjectionMatrix(); }
    applyPlayerCam(0);
  } else if (state === 'fall') {
    if (cam.fov !== 52) { cam.fov = 52; cam.updateProjectionMatrix(); }
    updateFallEnding();          // 结局 1：运镜完全由它接管
  } else if (state === 'wake') {
    applyPlayerCam(Math.min(1, sT / 4.2));
  } else if (state === 'crawlcg') {
    updateCrawlCG();
  } else if (state === 'carburn') {
    updateCarBurn();
  } else if (state === 'blackroom') {
    updateBlackRoom();
  } else if (state === 'carescape') {
    updateCarEscape();
  } else if (state === 'ropecg') {
    updateRopeCG();                       // 滑绳 CG：相机完全接管
  } else if (state === 'escape') {
    updateEscapeCG();                       // 结尾 CG：相机升高远离，完全接管
  } else if (state === 'death' || state === 'dead') {
    applyPlayerCam(1);                      // 被举起时视角由 updateDeath 接管
  } else if (state === 'play') {
    applyPlayerCam(1);
  } else if (acQte) {
    applyPlayerCam(1);
  }

  /* 状态推进（全部按挂钟秒数） */
  if (state === 'closing') {
    const p = Math.min(1, sT / 1.5);
    setLids(p * p);
    if (p >= 1) { enterPlayerRoom(); setState('black'); }
  } else if (state === 'black') {
    setLids(1);
    if (sT > 1.6) { setState('opening'); SFX.breath(); }
  } else if (state === 'opening') {
    const p = Math.min(1, sT / 2.4);
    const v = 1 - p + Math.sin(p * 15) * 0.16 * (1 - p);   // 眼皮颤动
    setLids(Math.max(0, Math.min(1, v)));
    if (p >= 1) { setLids(0); setState('wake'); }
  } else if (state === 'wake') {
    if (sT > 4.2) { setState('play'); playCapIdx = 0; }
  } else if (state === 'play') {
    while (playCapIdx < PLAY_CAPS.length && sT >= PLAY_CAPS[playCapIdx].t) {
      say(PLAY_CAPS[playCapIdx].s, 2600); playCapIdx++;
    }
    if (sT > 5 && !hudEl.classList.contains('show')) hudEl.classList.add('show');
  }

  /* 进入实战状态（开场结束 / CG 结束）时：桌面端自动尝试重新捕获鼠标。
     CG 期间会主动释放指针锁定，如果不锁回，鼠标移出窗口就收不到视角输入。 */
  if (state === 'play' && !prevFramePlay && !isTouchMode()) requestLookLock();
  prevFramePlay = (state === 'play');
  updateMouseLockHint();
  updateRobotPortraitVisibility();
  /* 触屏实战竖屏时阻断操作；暂停/形象面板本身允许在竖屏打开 */
  updateOrientationGate();
  /* 调试：?dbg=1 时把状态写进标签页标题，便于外部检查 */
  if (DBG) { document.title = state + ' t=' + t.toFixed(1) + ' s=' + sT.toFixed(1) +
    ' pos=' + playerPos.x.toFixed(1) + ',' + playerPos.z.toFixed(1) +
    ' sig=' + (phoneHasSignal ? 'Y' : 'N') + ' pv=' + (phoneViewOpen ? 'Y' : 'N'); }

  /* 火焰 / 烟 / 灯光。
     优化点：① 不可见（被楼层剔除掉）的直接跳过；
             ② 距离淡出用的 getWorldPosition 每 4 帧算一次（它会强制刷矩阵，最贵）；
             ③ 复用一个 Vector3，别每帧 new。 */
  const camPos = cam.position;
  frameNo++;
  const slowTick = (frameNo & 3) === 0;
  for (let i = 0; i < flames.length; i++) {
    const f = flames[i];
    if (!f.visible || (f.parent && !f.parent.visible)) continue;
    f.material.uniforms.t.value = t;
    f.quaternion.copy(f.userData.invQ).multiply(cam.quaternion);
    if (slowTick) {
      f.getWorldPosition(_fw);
      const d = _fw.distanceTo(camPos);
      f.material.uniforms.fade.value = Math.max(0, Math.min(1, (d - 0.7) / 1.6));
    }
    const sc = 0.9 + 0.14 * Math.sin(t * 6 + i * 1.7) + 0.06 * Math.sin(t * 13 + i);
    f.scale.set(sc, 0.94 + 0.12 * Math.sin(t * 5 + i * 2.3), 1);
  }
  for (let i = 0; i < smokes.length; i++) {
    const sm = smokes[i], u = sm.userData;
    if (!sm.visible || (sm.parent && !sm.parent.visible)) continue;
    sm.quaternion.copy(u.invQ).multiply(cam.quaternion);
    /* 烟的漂移很慢，每 4 帧更新一次位置/透明度看不出差别 */
    if (slowTick) {
      sm.position.x = u.ox + Math.sin(t * 0.22 * u.sp + u.ph) * 0.9;
      sm.position.y = u.oy + Math.sin(t * 0.17 + u.ph) * 0.16;
      sm.position.z = u.oz + Math.cos(t * 0.19 * u.sp + u.ph) * 0.7;
      sm.material.opacity = 0.34 + 0.16 * Math.sin(t * 0.4 + u.ph);
    }
  }
  fireWallMat.uniforms.t.value = t;
  for (let i = 0; i < outFireWalls.length; i++) outFireWalls[i].uniforms.t.value = t;

  fireGlow.intensity = 2.0 + Math.sin(t * 7.9) * 0.4 + Math.sin(t * 21) * 0.18;
  fireGlow2.intensity = 1.3 + Math.sin(t * 5.7 + 2) * 0.3;
  bFire.intensity = 0.9 + Math.sin(t * 9.1) * 0.26;
  roomFireA.intensity = 0.9 + Math.sin(t * 11.3) * 0.28 + Math.random() * 0.08;
  roomFireB.intensity = 0.36 + Math.sin(t * 8.1 + 1) * 0.14;
  roomRim.intensity = 0.4 + Math.sin(t * 6.3) * 0.14;
  corridorFire.intensity = 1.65 + Math.sin(t * 9.4) * 0.4 + Math.random() * 0.14;
  for (let i = 0; i < flickerWins.length; i++) {
    const w = flickerWins[i];
    w.mat.emissiveIntensity = 1.3 * (0.72 + 0.28 * Math.sin(t * w.sp + w.ph)) + Math.random() * 0.07;
  }
  elevLight.intensity = (Math.sin(t * 0.85) > 0.985) ? 0 : 0.45 + 0.3 * Math.sin(t * 2.2);
  elevPanelMat.emissiveIntensity = elevLight.intensity > 0 ? 1.3 : 0.2;

  riseEmbers(outEmbers, dt);
  riseEmbers(roomGrp.userData.embers, dt);

  /* 玩家房间：电视雪花 + 灯光 */
  if (playerRoom.visible) {
    if (tvCtx) {
      const w = tvCtx.canvas.width, h = tvCtx.canvas.height, img = tvCtx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const v = Math.random() * 255 * (0.35 + 0.65 * Math.random());
        img.data[i * 4] = v * 0.8; img.data[i * 4 + 1] = v * 0.9;
        img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      tvCtx.putImageData(img, 0, 0);
      tvTex.needsUpdate = true;
    }
    tvLight.intensity = 0.3 + Math.random() * 0.3;
    doorLight.intensity = 0.3 + Math.sin(t * 7.3) * 0.14;
    if (prWinLight) prWinLight.intensity = 0.8 + Math.sin(t * 6.1) * 0.24 + Math.random() * 0.08;
  }

  /* 机器人：原型机的不稳、眼睛脉冲、电锯
     注意：判断要用"是否开场运镜阶段"，不能写 state !== 'play' ——
     死亡演出的状态是 death/dead，会误走开场分支，把机器人挪到 ROOM.y0(=12.8) 去。 */
  const cineStage = (state === 'idle' || state === 'intro' || state === 'await' ||
    state === 'closing' || state === 'black' || state === 'opening' || state === 'wake');
  if (cineStage) {
    // 开场阶段：机器人站在室内场景里
    robot.rotation.z = Math.sin(t * 1.05) * 0.005;
    robot.position.y = ROOM.y0 + Math.abs(Math.sin(t * 2.1)) * 0.008;
    headGrp.rotation.y = Math.sin(t * 0.55) * 0.028;
    if (t > 38 && t < 40.5) headGrp.rotation.y *= (1 - (t - 38) / 2.5);   // 缓缓转正对镜头
  } else {
    // 玩家视角下：头部缓慢呼吸；走动时的上下起伏交给 updateRobot，别覆盖它
    headGrp.rotation.y = Math.sin(t * 0.35) * 0.04;
    if (!robotOut) robot.position.y = Math.abs(Math.sin(t * 0.0018)) * 0.012;
  }
  const eyePulse = Math.sin(t * 6.2);
  /* 眼睛是机器人身上唯一的光。收敛到暗处只见两点冷光，
     终场（t>38）稍微提一点，但不再是原来那种发光体 */
  eyeMatL.emissiveIntensity = 1.4 + eyePulse * 0.25 + (t > 38 ? 0.45 : 0);
  eyeLight.intensity = 0.40 + eyePulse * 0.10 + (t > 38 ? 0.20 : 0);
  for (let i = 0; i < eyeGlows.length; i++) {          // 光晕跟着脉冲一起呼吸
    const g = eyeGlows[i];
    const s = 0.16 + eyePulse * 0.016 + (t > 38 ? 0.02 : 0);
    g.scale.set(s, s, 1);
    g.material.opacity = 0.48 + eyePulse * 0.08 + (t > 38 ? 0.10 : 0);
  }
  /* 压力罐：常态缓慢呼吸；被打中瘫痪时交给 updateRobot 做乱闪，这里不覆盖 */
  if (!(robotStunT > 0)) {
    /* 常态不发光：机器人整体保持黑暗剪影，只有眼睛有光 */
    tankMat.emissiveIntensity = 0;
    tankGlow.intensity = 0;
  }

  if (cineStage) {
    const pose = swingPose(t);
    chainsaw.rotation.x = pose.rot;
    chainsaw.rotation.z = pose.roll;
    robot.rotation.x = pose.lean;
    if (t > 32.4) {
      const rev = t > 40.6 ? 1 : (t > 37.4 ? 0.55 : 0.22);
      chainsaw.position.x = (Math.random() - 0.5) * 0.012 * rev * 2;
      chainsaw.position.y = 1.50 + (Math.random() - 0.5) * 0.012 * rev * 2;
      sawLight.intensity = (0.12 + Math.random() * 0.22) * rev;
      // 齿尖沿链节方向飞速平移产生旋转错觉（保持低开销）
      sawTeeth.position.z = ((t * 28 * rev) % 0.0436);
    } else {
      chainsaw.position.set(0, 1.50, 0.36); sawLight.intensity = 0;
    }
  } else {
    // 玩家视角下：链齿继续转，声音透过窗户
    sawTeeth.position.z = ((t * 18) % 0.0436);
    sawLight.intensity = 0.08;
    // 归位：开场运镜里 chainsaw 会被抖动偏移，进游戏必须复位，否则锯和身体脱开
    chainsaw.position.set(0, 1.50, 0.36);
    chainsaw.rotation.set(0.02, 0, 0.0);
  }

  /* 真实电锯音：根据状态机和镜头距离自动调控 */
  if (state === 'intro' || state === 'await' || state === 'closing' || state === 'black' || state === 'opening' || state === 'wake') {
    if (t > 32.4) {
      if (!SFX.isChainsawOn) { SFX.startChainsaw(); SFX.isChainsawOn = true; }
      const dxz = Math.hypot(cam.position.x - robot.position.x, cam.position.z - robot.position.z);
      const wall01 = t < 36 ? 1 : Math.max(0, 1 - (t - 36) / 4);
      SFX.updateChainsawDist(dxz, wall01);
    } else if (SFX.isChainsawOn) {
      SFX.stopChainsaw(); SFX.isChainsawOn = false;
    }
  } else if (state === 'play' || state === 'death' || state === 'dead') {
    if (state === 'death' || state === 'dead') {
      SFX.updateChainsawDist(1.2, 0);       // 贴脸了
    } else if (curLevel === -2) {
      // 一楼：机器人困在四楼，电锯声闷在楼板上面
      SFX.updateChainsawDist(22, 1);
    } else if (robotOut && robotStunT > 0) {
      // 瘫痪中：电锯怠速，隔着几米闷响
      SFX.updateChainsawDist(6.0, 0.85);
    } else if (robotOut) {
      // 出来了：按真实距离衰减（没墙了）
      if (!SFX.isChainsawOn) { SFX.startChainsaw(); SFX.isChainsawOn = true; }
      const dxz = Math.hypot(playerPos.x - robot.position.x, playerPos.z - robot.position.z);
      SFX.updateChainsawDist(Math.max(1.0, dxz), 0);
    } else {
      // 还在 504 门后：隔墙约 6m
      if (!SFX.isChainsawOn) { SFX.startChainsaw(); SFX.isChainsawOn = true; }
      SFX.updateChainsawDist(6.0, 0.75);
    }
  }

  renderer.render(scene, cam);
}

/* 调试给物的小工具（?give / ?pv 共用） */
function giveDebugItem(id, hand) {
  const rec = recOf(id);
  if (!rec) return;
  const si = invFirstFree();
  if (si < 0) return;
  const amount = STACKABLE[id] || 1;
  inv[si] = { id: rec.id, name: rec.name, hand: null, count: amount };
  if (!NO_HAND[id]) equipToHand(si, hand || 'R');
}

/* ==================== 启动 ==================== */
function begin() {
  if (running) return;
  try { SFX.init(); } catch (e) { /* 无音频也要能跑 */ }
  achLocalLoad();
  if (vibeUser) achSyncFromCloud();   // 已登录就从云端合并（不阻塞开场）
  /* 形象纹理在玩家点击开始时才加载，避免首页无谓请求；面板打开前也会按需加载。 */
  document.getElementById('start').classList.add('gone');
  running = true;
  setState('intro');
  introT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  elapsed = 0;
  showIntroFf();
}
document.getElementById('start').addEventListener('click', begin);
addEventListener('keydown', function (e) {
  if (state === 'idle' && (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter')) begin();
});
addEventListener('pointerdown', function () { if (state === 'idle') begin(); });

if (SCRUB !== null && !isNaN(SCRUB)) {
  document.getElementById('start').classList.add('gone');
  running = true; setState('intro'); elapsed = SCRUB; FREEZE = true;
  // 让挂钟起点与定格点对齐，解冻（点继续）后时间轴才不会跳到一个巨大的值
  introT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - SCRUB * 1000;
  while (evIdx < EV.length && EV[evIdx].t <= SCRUB) { EV[evIdx].f(); evIdx++; }
  if (state === 'await') contEl.classList.add('show'); else showIntroFf();
}
if (QS.get('scene') === 'play') {
  document.getElementById('start').classList.add('gone');
  running = true; enterPlayerRoom(); setLids(0);
  setState('play', 6); elapsed = 6; playCapIdx = PLAY_CAPS.length;
  hudEl.classList.add('show');
  /* 调试：?at=x,z 落点，?look=yaw,pitch 朝向（弧度），方便直接看某个角落 */
  if (QS.has('at')) {
    const a = QS.get('at').split(',').map(Number);
    if (a.length === 2 && !isNaN(a[0]) && !isNaN(a[1])) { playerPos.x = a[0]; playerPos.z = a[1]; }
  }
  if (QS.has('look')) {
    const l = QS.get('look').split(',').map(Number);
    if (!isNaN(l[0])) lookYaw = l[0];
    if (l.length > 1 && !isNaN(l[1])) lookPitch = l[1];
  }
  /* 调试：?give=phone 或 ?give=phone,towel —— 直接塞进背包并上手
     （第一件右手，第二件左手，前提是它允许左手握持），调持物姿态时很方便 */
  if (QS.has('give')) {
    const want = QS.get('give').split(',').map(function (s) { return s.trim(); });
    const hands = ['R', 'L'];
    for (let i = 0; i < want.length; i++) giveDebugItem(want[i], hands[Math.min(i, 1)]);
    refreshInventoryHUD();
  }
  /* 调试：?end=fall 直接播结局 1（翻窗坠落），省得走过去开窗
     配合 ?fallt=2.5 可以定格在坠落的第 2.5 秒 */
  if (QS.get('end') === 'fall') {
    if (QS.has('fallt')) {
      const ft = parseFloat(QS.get('fallt'));
      if (!isNaN(ft)) FALL_FREEZE = ft;
    }
    setTimeout(beginFallEnding, 400);
  }
  /* 调试：?open=wardrobe 进来就把衣柜打开 */
  if (QS.get('open') === 'wardrobe') { wardrobeOpen = true; wardrobeAngle = 1.15; }
  /* 调试：?pv=1 直接翻开手机视图（配 ?give=phone 用，调界面省按键） */
  if (QS.has('pv')) {
    giveDebugItem('phone');
    setTimeout(function () { if (state === 'play') togglePhoneView(); }, 600);
  }
  /* 调试：?sig=off 一进来就是无信号状态 */
  if (QS.get('sig') === 'off') { phoneHasSignal = false; refreshPhoneView(); }
  /* 调试：?cg=choice 直接进抉择 CG；?cg=roof 直接上天台并跳到倒计时；
     ?cg=ladder 直接放绳梯（配合 ?cg=roof 用） */
  if (QS.get('cg') === 'choice') {
    leftRoomOnce = true; phoneMsg505 = true; phoneNewsRead = true; phoneHasSignal = false;
    barricadeBroken = true; barricadeHits = 3;
    for (let i = 0; i < barricadePlanks.length; i++) barricadePlanks[i].fallen = true;
    robotOut = true; robot.visible = true; breakDoor504();
    playerPos.x = -5.2; playerPos.z = 3.4;
    setTimeout(startStairChoice, 600);
  }
  if (QS.get('cg') === 'roof' || QS.get('cg') === 'ladder') {
    switchLevel(1);
    playerPos.x = -4.0; playerPos.z = 3.0;
    robotOut = true; robot.visible = true;
    robot.position.set(-1.0, 2.90, 3.0);
    giveDebugItem('phone');
    setTimeout(function () {
      phoneRoofMsg = true; phoneNewsRead = true; refreshPhoneView();
      if (QS.get('cg') === 'ladder') { heliArrived = true; spawnLadder(); }
      else startHeliCountdown();
    }, 700);
  }
  /* 调试：?cg=lvl4 直接跳到四楼（复刻 pickStairs(-1) 的落点与封挡状态）；
     ?t=秒数 设定木梁倒计时起始值（默认 120），方便测破门/撬门竞速 */
  if (QS.get('cg') === 'lvl4') {
    leftRoomOnce = true; phoneMsg505 = true; phoneNewsRead = true; phoneHasSignal = false;
    barricadeBroken = true; barricadeHits = 3;
    for (let i = 0; i < barricadePlanks.length; i++) barricadePlanks[i].fallen = true;
    robotOut = true; robot.visible = true; breakDoor504();
    switchLevel(-1);
    if (!QS.has('at')) { playerPos.x = -5.6; playerPos.z = 3.4; }   // ?at 与 ?cg=lvl4 可组合（at 优先）
    playerFloorY = floorYAt(playerPos.x, playerPos.z);
    lvl4Barred = true;
    robot.position.set(-7.6, -2.90, 3.43);
    robot.rotation.y = Math.PI / 2;
    giveDebugItem('phone');
    setTimeout(function () {
      startLvl4Countdown();
      if (QS.get('t')) lvl4Timer = Math.max(1, parseFloat(QS.get('t')) || 60);
    }, 1200);
  }
  /* 调试：?cg=lvl1 直接跳到一楼大堂（模拟滑绳落地后的状态） */
  /* 调试：?cg=garage 直接进地下车库（爬过卷帘门后的状态） */
  if (QS.get('cg') === 'garage') {
    barricadeBroken = true; barricadeHits = 3;
    robotOut = true; robot.visible = true;
    pry4Done = true;
    if (elev4Doors) elev4Doors.visible = false;
    if (elev4Bent) elev4Bent.visible = true;
    if (elev4Shaft) elev4Shaft.visible = true;
    switchLevel(-2);
    inGarage = true;
    if (!QS.has('at')) { playerPos.x = -7.0; playerPos.z = 9.6; }
    playerFloorY = GAR_Y;
    lookYaw = Math.PI - SIT.yaw; lookPitch = 0;
    startGarageRobot();               // 调试直达：车库巡逻机器人同步开动
    giveDebugItem('phone'); giveDebugItem('tools');
    refreshInventoryHUD();
    setTimeout(function () { showObjective('寻找出去的路', '地下车库'); }, 800);
  }
  /* 调试：?cg=road 直接播公路逃离段（配合 ?cgthold=秒 定格截图） */
  if (QS.get('cg') === 'road') {
    barricadeBroken = true; barricadeHits = 3;
    robotOut = true; robot.visible = true;
    switchLevel(-2);
    inGarage = true;
    if (!QS.has('at')) { playerPos.x = 4.6; playerPos.z = 19.55; }
    playerFloorY = GAR_Y;
    giveDebugItem('phone');
    setTimeout(function () {
      beginCarEscape();
      /* ?roadnear=1：仅供软件渲染截图，把远坐标公路搬到原点并直接预置公路阶段 */
      if (QS.has('roadnear')) roadGrp.position.set(0, 0, 0);
      carEscapePhase = 2;
    }, 400);
  }
  if (QS.get('cg') === 'lvl1') {
    barricadeBroken = true; barricadeHits = 3;
    robotOut = true; robot.visible = true;
    pry4Done = true;
    if (elev4Doors) elev4Doors.visible = false;
    if (elev4Bent) elev4Bent.visible = true;
    if (elev4Shaft) elev4Shaft.visible = true;
    switchLevel(-2);
    if (!QS.has('at')) { playerPos.x = 0; playerPos.z = 3.5; }
    playerFloorY = LVL1_Y;
    lookYaw = Math.PI - SIT.yaw; lookPitch = 0;
    setTimeout(function () {
      say('正门被阻挡了，看来我们得去侧门了', 3400);
      showObjective('寻找侧门钥匙与侧门', '保安亭里也许有钥匙');
    }, 1200);
  }
  /* 调试：?cg=ropecg 直接播滑绳 CG（4F 井道已撬开、背包有毛巾） */
  if (QS.get('cg') === 'ropecg') {
    barricadeBroken = true; barricadeHits = 3;
    robotOut = true; robot.visible = true;
    pry4Done = true;
    if (elev4Doors) elev4Doors.visible = false;
    if (elev4Bent) elev4Bent.visible = true;
    if (elev4Shaft) elev4Shaft.visible = true;
    switchLevel(-1);
    playerPos.x = 0; playerPos.z = 3.3;
    playerFloorY = floorYAt(0, 3.3);
    giveDebugItem('towel');
    refreshInventoryHUD();
    setTimeout(beginRopeCG, 800);
  }
  /* 调试：?robot=1 跳过前置，直接站到卧室门口触发机器人破门 */
  if (QS.has('robot')) {
    leftRoomOnce = true; phoneMsg505 = true; phoneNewsRead = true; phoneHasSignal = false;
    refreshPhoneView();
    playerPos.x = 0; playerPos.z = 2.0;
  }
  FREEZE = true;
}

addEventListener('resize', function () {
  cam.aspect = innerWidth / innerHeight;
  cam.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resetOrientationGateAfterResize();
});
addEventListener('orientationchange', resetOrientationGateAfterResize);
/* 某些移动浏览器旋转时只更新 visual viewport，不可靠地派发 resize；
   250ms 轮询只读方向/状态，参考 cs1.6 的实现，避免竖屏漏掉阻断提示。 */
setInterval(updateOrientationGate, 250);
updateOrientationGate();
/* 调试句柄：?dbg=1 时暴露机器人/形象状态，供外部验证与截图排查 */
if (DBG) {
  window.__TH_DEBUG = {
    get robot() { return robot; },
    get portrait() { return robotPortraitSprite; },
    get portraitReady() { return robotPortraitReady; },
    get state() { return state; }
  };
}
animate();
}
