<template>
  <div ref="containerRef" class="moon-physics" :class="{ grabbing: isGrabbing }">
    <!-- 操作提示不在这里显示:按要求挪到「关于」页兑换成功后那行绿色小字
         (文案见 redeem.ts 的 MOON_HINT) -->
    <!-- 陀螺仪没有开关:默认就是开的(见 autoEnableGyro)。 -->
    <p v-if="error" class="error">{{ error }}</p>
    <div
      v-if="menu.open"
      class="ctx-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @contextmenu.prevent
    >
      <button type="button" :disabled="!menu.hasTarget" @click="onMenuCopy">复制</button>
      <button type="button" :disabled="!menu.hasTarget" @click="onMenuDelete">删除</button>
      <button type="button" @click="onMenuClear">清空</button>
    </div>
  </div>
</template>

<script setup lang="ts">
// @ts-nocheck
// ↑ 本体是**逐行照搬**的 moon 项目源码(那边是纯 JS 工程),刻意不做 TS 化:
//   改一行就少一行可对照,而这份代码迟早整块删掉(见同目录 README.md)。
//   只加 lang="ts" + @ts-nocheck,是为了让 TS 能解析这个 .vue 模块(否则从
//   MoonEgg.vue 里 import 会报 TS7016「找不到声明文件」)。
// =============================================================================
// ⛔ 临时彩蛋:月亮(本体)
// -----------------------------------------------------------------------------
// 从独立小应用 moon 整体移植(three.js + cannon-es):
//   拖动甩出会弹跳 / 滚轮·双指缩放 / 右键·长按菜单(复制·删除·清空),上限 20 个。
// 除本文件所在的 src/easteregg/moon/ 与 public/easteregg/moon/(模型 + draco)之外,
// 产品代码里只有 App.vue 那两行带 ⛔ 标记的接线。删除步骤见同目录 README.md。
//
// 相对 moon 原版,**为"融进网站"改了这几处**(其余逐行一致,便于日后对照):
//   1. 渲染器开 alpha、去掉黑背景 —— 月亮浮在网站上面,不是独立黑页;
//   2. 事件从 canvas 改挂到 window,并且**每一条都先做射线命中**:
//      只有指针真压在月亮上时才 preventDefault / stopPropagation 接管,
//      否则原样放过 —— 整层是 pointer-events: none,网站照常可点可滚;
//   3. 因此光标改设在 body 上(canvas 已不接收悬停);
//   4. 全部月亮睡着且没人拖动时不 step / 不 render —— 闲着的时候不吃 GPU。
//   5. 资源地址改到彩蛋自己的目录,且挂在 BASE_URL 上
//      (vite base 是 './',写死 '/xxx' 在子路径 / file:// 打包环境下会 404)。
// =============================================================================
import { ref, onMounted, onBeforeUnmount } from 'vue'
import * as THREE from 'three'
import * as CANNON from 'cannon-es'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { devError, devInfo } from '../../utils/logger'

/** 彩蛋自己的资源目录(public/easteregg/moon/) */
const ASSET_BASE = `${import.meta.env.BASE_URL}easteregg/moon/`
const MODEL_URL = `${ASSET_BASE}moon_small.glb`

const BALL_DIAMETER = 1.5 // 皮球直径（世界单位，缩小后的模型）
const BASE_RADIUS = BALL_DIAMETER / 2
const CAMERA_Z = 8
const FOV = 45
const GRAVITY = -22
const RESTITUTION = 0.78 // 弹性
const FRICTION = 0.35
const MAX_THROW_SPEED = 32
const FOLLOW_SPEED = 14 // 拖动跟随刚度
const MAX_BALLS = 20
const MIN_SCALE = 0.4
const MAX_SCALE = 3
const LONG_PRESS_MS = 500

// ---- 命中判定与陀螺仪(手机适配) ------------------------------------------
/**
 * 抓取余量(屏幕像素,加在月亮投影半径之外)
 *
 * 月亮在手机上只有几十像素,要求手指精准压在球面上几乎抓不住 ——
 * 触摸给一圈明显的余量,鼠标只给一点点(鼠标本来就准)。
 */
const PICK_SLOP_TOUCH = 10
const PICK_SLOP_MOUSE = 3
/** 触摸时的最小命中半径(px):哪怕月亮很小,手指落在它附近也算抓住它 */
const PICK_MIN_R_TOUCH = 32

/** 重力大小(陀螺仪用它做向量长度;静止时就是 GRAVITY) */
const GRAVITY_MAG = Math.abs(GRAVITY)
/** 陀螺仪重力的平滑系数(每帧向目标靠这么多,防止抖动) */
const GYRO_SMOOTH = 0.12
/** 挂上监听后等这么久还没数据,就把 gyroOn 落回 false(不判死刑,数据一到就转正) */
const GYRO_PROBE_MS = 1800

const containerRef = ref(null)
const error = ref('')
const isGrabbing = ref(false)
const menu = ref({ open: false, x: 0, y: 0, hasTarget: false })
let menuTarget = null // 菜单目标球（不能放进 ref，否则被包成 Proxy 后 ballList.includes 永远不匹配）

let renderer = null
let camera = null
let scene = null
let world = null
let model = null // 加载的月球模型模板
const ballList = [] // { body, holder, model, scale, radius }
let grabbed = null // 当前被拖动的球
let wallBodies = []
let bounds = { minX: -3, maxX: 3, minY: -3, maxY: 3, minZ: -1.5, maxZ: 1.5 }

let dracoLoader = null
let animationId = 0
let resizeHandler = null
let disposeListeners = []

let clock = null
const raycaster = new THREE.Raycaster()
const pointerNdc = new THREE.Vector2()
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
const hitPoint = new THREE.Vector3()
const targetPos = new THREE.Vector3()
const targetRaw = new THREE.Vector3() // 指针原始目标（未钳制），用于计算甩出速度
const grabOffset = new THREE.Vector3()
const throwVel = new THREE.Vector3()
const tmpV = new THREE.Vector3()
let activePointerId = null
let samples = []
/** 拖拽刚结束的这段时间里,吞掉紧随其后的 click(见 endDrag / 监听注册) */
let suppressClickUntil = 0

// 命中判定的临时向量(避免每帧 new)
const pickRight = new THREE.Vector3()
const pickCenter = new THREE.Vector3()
const pickProj = new THREE.Vector3()
const pickEdge = new THREE.Vector3()

// ---- 陀螺仪状态 ------------------------------------------------------------
/**
 * 陀螺仪是否已开
 *
 * 没有开关:出场(挂上 MoonViewer)就自动挂传感器监听,默认就是开的。
 * 这个标记只用于「渲染循环要不要按倾斜算重力」与调试钩子。
 */
const gyroOn = ref(false)
/** 目标重力方向(由设备倾斜算出,单位向量 × GRAVITY_MAG);未开陀螺仪时不用 */
const gyroTargetG = { x: 0, y: GRAVITY }
/** 当前重力(平滑跟随目标) */
const gyroCurrentG = { x: 0, y: GRAVITY }
/** 监听是否已挂上 */
let gyroAttached = false
/** 是否真的收到过传感器数据(收不到就是"这台设备/这个环境给不了") */
let gyroGotData = false
/** 探针计时器:挂上监听后这么久还没数据就把 gyroOn 落回 false(不判死刑,数据一来就转正) */
let gyroProbeTimer = undefined
/** 最近一次 devicemotion 的时刻:它比 deviceorientation 可靠,有它就优先采信 */
let lastMotionAt = 0

// 多指捏合与长按菜单的状态
const pointers = new Map() // pointerId -> { x, y }（客户端坐标）
let pinchDist = 0
let pinchBall = null // 捏合手势所针对的月亮
let longPressTimer = null
let lpStart = null // 长按起点（用于移动阈值取消）

function addListener(target, type, fn, opts) {
  target.addEventListener(type, fn, opts)
  disposeListeners.push(() => target.removeEventListener(type, fn, opts))
}

function setPointerNdc(e) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
}

function pushSample() {
  samples.push({ t: performance.now(), p: targetRaw.clone() })
  if (samples.length > 12) samples.shift()
}

function computeThrowVelocity() {
  const now = performance.now()
  throwVel.set(0, 0, 0)
  if (samples.length < 2) return
  const a = samples[samples.length - 2]
  const b = samples[samples.length - 1]
  const dt = (b.t - a.t) / 1000
  const age = (now - b.t) / 1000 // 最后一次指针运动距松手的时长
  if (dt > 0.008 && age < 0.35) {
    throwVel.set(
      (b.p.x - a.p.x) / dt,
      (b.p.y - a.p.y) / dt,
      (b.p.z - a.p.z) / dt
    )
    const decay = 1 - age / 0.35
    throwVel.multiplyScalar(Math.max(0, decay))
  }
  if (throwVel.length() > MAX_THROW_SPEED) throwVel.setLength(MAX_THROW_SPEED)
}

function clampBody(ball) {
  const r = ball.radius
  ball.body.position.x = THREE.MathUtils.clamp(ball.body.position.x, bounds.minX + r, bounds.maxX - r)
  ball.body.position.y = THREE.MathUtils.clamp(ball.body.position.y, bounds.minY + r, bounds.maxY - r)
  ball.body.position.z = THREE.MathUtils.clamp(ball.body.position.z, bounds.minZ + r, bounds.maxZ - r)
}

function clampAllBalls() {
  for (const b of ballList) clampBody(b)
}

// ---------- 缩放月亮本体 ----------
function setBallScale(ball, newScale) {
  const s = THREE.MathUtils.clamp(newScale, MIN_SCALE, MAX_SCALE)
  if (Math.abs(s - ball.scale) < 1e-3) return
  ball.scale = s
  const r = BASE_RADIUS * s
  ball.radius = r
  ball.body.removeShape(ball.body.shapes[0])
  ball.body.mass = THREE.MathUtils.clamp(s * s * s, 0.1, 12)
  ball.body.addShape(new CANNON.Sphere(r)) // addShape 内部会更新质量属性与包围半径
  ball.holder.scale.setScalar(s)
  ball.body.wakeUp()
  clampBody(ball)
}

function onWheel(e) {
  // 先命中再接管:滚轮没压在月亮上就原样放过(网站照常滚动)
  if (!model || !findBallAt(e)) return
  e.preventDefault()
  const ball = findBallAt(e) // 只缩放光标悬停的月亮
  if (!ball) return
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
  // 上滚放大该月亮，下滚缩小
  setBallScale(ball, ball.scale * Math.exp(-dy * 0.0012))
}

function updatePinch() {
  if (pointers.size < 2 || !pinchBall) return
  if (!ballList.includes(pinchBall)) return
  const [a, b] = [...pointers.values()]
  const dist = Math.hypot(a.x - b.x, a.y - b.y)
  if (dist < 1 || pinchDist < 1) return
  setBallScale(pinchBall, pinchBall.scale * (dist / pinchDist))
  pinchDist = dist
}

// ---------- 长按 / 菜单 ----------
function cancelLongPress() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function startLongPress(e) {
  if (e.pointerType === 'mouse') return
  // 只有按在月亮上才谈长按:整层是点得穿的,别把网站里的长按也吃掉
  if (!findBallAt(e)) return
  cancelLongPress()
  const x = e.clientX
  const y = e.clientY
  longPressTimer = setTimeout(() => {
    longPressTimer = null
    if (pointers.size > 1) return
    releaseGrabSilently()
    openMenu(x, y)
  }, LONG_PRESS_MS)
}

function openMenu(clientX, clientY) {
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect) return
  const target = model ? findBallAt({ clientX, clientY }) : null
  menuTarget = target
  menu.value = {
    open: true,
    x: THREE.MathUtils.clamp(clientX - rect.left, 0, Math.max(0, rect.width - 96)),
    y: THREE.MathUtils.clamp(clientY - rect.top, 0, Math.max(0, rect.height - 120)),
    hasTarget: !!target
  }
}

function closeMenu() {
  if (menu.value.open) {
    menu.value = { open: false, x: 0, y: 0, hasTarget: false }
    menuTarget = null
  }
}

function onMenuCopy() {
  const t = menuTarget
  closeMenu()
  duplicateMoon(t)
}

function onMenuDelete() {
  const t = menuTarget
  closeMenu()
  if (t) removeBall(t)
}

function onMenuClear() {
  closeMenu()
  while (ballList.length) removeBall(ballList[ballList.length - 1])
}

// ---- 陀螺仪:让重力跟着手机倾斜 --------------------------------------------
/**
 * 设备倾斜 → 屏幕坐标系里的重力方向
 *
 * 公式按 W3C DeviceOrientation 的旋转约定(Z-X'-Y'' 内旋序列)推导:
 *   设备坐标系 = x 向右、y 向上(屏幕)、z 垂直屏幕向外;
 *   重力在设备坐标系里的分量 = Rᵀ·(0,0,−1),展开后:
 *       gx = sin(gamma)·cos(beta)
 *       gy = −sin(beta)
 *   再乘上 |G| 就是物理世界要的重力向量(世界 y 向上,默认 (0, −22))。
 *
 * 三个校验点:
 *   竖持(β=90, γ=0) → (0,−1)  和原来的固定重力完全一致 ✓
 *   平放(β=0)        → (0, 0)  失重,月亮会飘着 ✓
 *   侧倾(β=60,γ=−90) → (−0.5,−0.87)  往左下滚 ✓
 *
 * ⚠️ 曾经的写法是 `−sin(beta−90)`:竖持时算出 0(等于失重),平放时反而算出满重力,
 *    正好反了 —— 已按上面的推导改正。
 */
function onDeviceOrientation(e) {
  const beta = e.beta
  const gamma = e.gamma
  if (beta === null && gamma === null) return
  // 有 devicemotion 数据时以它为准:不少安卓机上 deviceorientation 只发一次且可能是
  // 旧值(Chromium 已知问题),继续采信会把重力瞬间拽回一个错误方向。
  if (performance.now() - lastMotionAt < 1000) return
  applyTilt(beta, gamma)
}

/** 由 beta/gamma 写入目标重力 */
function applyTilt(beta, gamma) {
  const d = Math.PI / 180
  const b = THREE.MathUtils.clamp(beta ?? 90, -180, 180)
  const g = THREE.MathUtils.clamp(gamma ?? 0, -90, 90)
  gyroTargetG.x = Math.sin(g * d) * Math.cos(b * d) * GRAVITY_MAG
  gyroTargetG.y = -Math.sin(b * d) * GRAVITY_MAG
  markGyroData()
}

/**
 * 来源二:devicemotion 的加速度计(**优先**)
 *
 * 屏幕坐标系下加速度计读的就是"向上的反作用力":竖持 y ≈ +9.8、平放 z ≈ +9.8。
 * 取负即重力方向,与上面的公式同号:竖持 → (0,−22) ✓。
 * 安卓上它比 deviceorientation 可靠得多(后者常常只触发一次)。
 */
function onDeviceMotion(e) {
  const a = e.accelerationIncludingGravity
  if (!a || a.x === null || a.y === null) return
  const mag = Math.hypot(a.x, a.y, a.z || 0) || 1
  gyroTargetG.x = (a.x / mag) * GRAVITY_MAG
  gyroTargetG.y = (-a.y / mag) * GRAVITY_MAG
  lastMotionAt = performance.now()
  markGyroData()
}

/** 收到第一帧有效数据:陀螺仪就算真的可用 */
function markGyroData() {
  if (!gyroGotData) {
    gyroGotData = true
    gyroOn.value = true
  }
}

/** 挂上传感器监听(不需要授权的那条路) */
function attachGyroListeners() {
  if (gyroAttached) return
  gyroAttached = true
  // 三个都挂上:deviceorientationabsolute 是部分安卓唯一会发的方向事件
  window.addEventListener('deviceorientation', onDeviceOrientation)
  window.addEventListener('deviceorientationabsolute', onDeviceOrientation)
  window.addEventListener('devicemotion', onDeviceMotion)
  gyroGotData = false
  gyroOn.value = true // 先乐观打开:一旦下面探针超时又没数据,会自己落回 false
  if (gyroProbeTimer !== undefined) window.clearTimeout(gyroProbeTimer)
  gyroProbeTimer = window.setTimeout(() => {
    gyroProbeTimer = undefined
    if (gyroGotData) return
    // 挂了监听却没有数据:可能是页面不是 HTTPS(这类接口在非安全上下文里根本不发事件)、
    // 系统把"运动与方向"权限关了、或这台设备确实没有传感器。
    // 不下结论、也不停止监听 —— 数据一到 markGyroData 会自动转正。
    gyroOn.value = false
    if (!window.isSecureContext) {
      devInfo('[moon] 陀螺仪不可用:页面不是 HTTPS(传感器接口要求安全上下文)')
    }
  }, GYRO_PROBE_MS)
  // 立刻把睡着的月亮叫醒,不然倾斜了它们也不动
  for (const b of ballList) b.body.wakeUp()
}

/**
 * 需要授权时的自动尝试(iOS 等)
 *
 * 没有开关,所以授权也不能靠玩家点某个按钮:
 *   1. 挂载后先直接请求一次(桌面 Chrome / 安卓会立刻 resolve);
 *   2. 若被拒(iOS:必须在用户手势里请求),就等**出现后的第一次点击/触摸**
 *      再补一次 —— 那一下本身就是手势,足够弹授权框。
 */
function tryGyroPermission(): void {
  const DOE = window.DeviceOrientationEvent
  const DME = window.DeviceMotionEvent
  const ask = async () => {
    try {
      if (DOE && typeof DOE.requestPermission === 'function') {
        const res = await DOE.requestPermission()
        if (res !== 'granted') return false
      }
      if (DME && typeof DME.requestPermission === 'function') {
        try { await DME.requestPermission() } catch { /* 忽略 */ }
      }
    } catch {
      return false
    }
    attachGyroListeners()
    return true
  }
  void ask().then((ok) => {
    if (ok || gyroGotData) return
    // 没成 → 挂一次性手势补授权(用户接下来随手一点就会触发)
    const once = () => {
      window.removeEventListener('pointerdown', once, true)
      window.removeEventListener('touchend', once, true)
      void ask()
    }
    window.addEventListener('pointerdown', once, true)
    window.addEventListener('touchend', once, true)
  })
}

/** 关掉(只给卸载时收尾用;平时没有开关,不需要玩家操作) */
function disableGyro() {
  if (gyroAttached) {
    window.removeEventListener('deviceorientation', onDeviceOrientation)
    window.removeEventListener('deviceorientationabsolute', onDeviceOrientation)
    window.removeEventListener('devicemotion', onDeviceMotion)
    gyroAttached = false
  }
  if (gyroProbeTimer !== undefined) {
    window.clearTimeout(gyroProbeTimer)
    gyroProbeTimer = undefined
  }
  gyroOn.value = false
  gyroTargetG.x = 0
  gyroTargetG.y = GRAVITY
  gyroCurrentG.x = 0
  gyroCurrentG.y = GRAVITY
}

/**
 * 出场即开(没有开关,默认就是开的)
 *
 * 只在触摸设备上开:桌面浏览器没有传感器,挂了也只会多两个空监听。
 * 有权限 API 的环境走 tryGyroPermission(它内部会先试、失败再等第一次点击)。
 */
function autoEnableGyro() {
  if (typeof window.DeviceOrientationEvent === 'undefined' && typeof window.DeviceMotionEvent === 'undefined') return
  const coarse = window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches
  if (!coarse) return
  const needsPerm =
    (typeof window.DeviceOrientationEvent !== 'undefined' &&
      typeof window.DeviceOrientationEvent.requestPermission === 'function') ||
    (typeof window.DeviceMotionEvent !== 'undefined' &&
      typeof window.DeviceMotionEvent.requestPermission === 'function')
  if (needsPerm) tryGyroPermission()
  else attachGyroListeners()
}

function duplicateMoon(target) {
  if (!target || !ballList.includes(target) || ballList.length >= MAX_BALLS) return
  const p = new THREE.Vector3(
    target.body.position.x,
    target.body.position.y + target.radius * 1.7,
    target.body.position.z
  )
  // 避免与已有月亮重叠：继续向上错开
  let tries = 0
  while (
    tries++ < 12 &&
    ballList.some(
      (b) =>
        b !== target &&
        Math.hypot(
          b.body.position.x - p.x,
          b.body.position.y - p.y,
          b.body.position.z - p.z
        ) <
          (b.radius + target.radius) * 0.95
    )
  ) {
    p.y += target.radius * 0.6
  }
  const r = target.radius
  p.x = THREE.MathUtils.clamp(p.x, bounds.minX + r, bounds.maxX - r)
  p.y = THREE.MathUtils.clamp(p.y, bounds.minY + r, bounds.maxY - r)
  p.z = THREE.MathUtils.clamp(p.z, bounds.minZ + r, bounds.maxZ - r)
  createBall(p, target.scale)
}

// ---------- 拖动 ----------
/**
 * 找出指针下的月亮
 *
 * 判定在**屏幕空间**做:把球心投影成像素坐标,再按"投影半径 + 余量"比距离。
 * 不再只认网格命中 —— 月亮在手机上只有几十像素,要求手指精准压在球面上
 * 几乎抓不住;触摸给一圈明显余量(PICK_SLOP_TOUCH),并且保证最小命中半径
 * PICK_MIN_R_TOUCH,手指落在它附近就算抓住。
 */
function findBallAt(e) {
  if (!model || !renderer) return null
  const rect = renderer.domElement.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const px = e.clientX - rect.left
  const py = e.clientY - rect.top
  const touch = e.pointerType && e.pointerType !== 'mouse'
  const slop = touch ? PICK_SLOP_TOUCH : PICK_SLOP_MOUSE
  const minR = touch ? PICK_MIN_R_TOUCH : 0
  pickRight.setFromMatrixColumn(camera.matrixWorld, 0)

  let best = null
  let bestDist = Infinity
  for (const ball of ballList) {
    pickCenter.set(ball.body.position.x, ball.body.position.y, ball.body.position.z)
    pickProj.copy(pickCenter).project(camera)
    const cx = ((pickProj.x + 1) / 2) * rect.width
    const cy = ((1 - pickProj.y) / 2) * rect.height
    // 投影半径:球心沿相机右方向偏一个半径后再投影,取屏幕横向差
    pickEdge.copy(pickCenter).addScaledVector(pickRight, ball.radius).project(camera)
    const radiusPx = Math.abs(((pickEdge.x + 1) / 2) * rect.width - cx)
    const hitR = Math.max(radiusPx + slop, minR)
    const d = Math.hypot(px - cx, py - cy)
    if (d <= hitR && d < bestDist) {
      bestDist = d
      best = ball
    }
  }
  return best
}

// ---- 触摸手势拦截 ----------------------------------------------------------
/**
 * 这一层是 pointer-events: none,拿不到 `touch-action` 的保护:
 * 手指一移动,浏览器就可能把这一串手势判成页面滚动/缩放,随即甩一个
 * pointercancel 过来 —— 表现就是"拖着拖着月亮就丢了、很不灵敏"。
 * 所以触摸必须在 touchstart / touchmove 上 preventDefault 把它按住。
 */
function touchPointHitsMoon(e) {
  const t = e.touches && e.touches[0]
  if (!t) return false
  return !!findBallAt({ clientX: t.clientX, clientY: t.clientY, pointerType: 'touch' })
}

function onTouchStart(e) {
  if (grabbed || touchPointHitsMoon(e)) e.preventDefault()
}

function onTouchMove(e) {
  // 正在拖着月亮、或两根手指都压在月亮附近(捏合缩放)→ 不让页面跟着滚/缩放
  if (grabbed || e.touches.length >= 2) e.preventDefault()
}

/** 事件是不是落在彩蛋自己的 DOM 上(右键菜单) */
function isOwnChrome(e) {
  const root = containerRef.value
  return !!root && e.target instanceof Node && root.contains(e.target)
}

function onPointerDown(e) {
  // 落在自己的菜单上 → 整条逻辑都不参与。
  // 尤其是**不能 closeMenu()**:监听挂在 window 上,点菜单项的那一下也会经过这里,
  // 先把菜单拆掉的话,按钮随之从 DOM 消失,它的 click 永远不会触发 ——
  // 「复制/删除/清空点了没反应」就是这么来的(原版监听挂在 canvas 上,菜单不是
  //  canvas 的子节点,所以没这个问题)。
  if (isOwnChrome(e)) return

  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

  // 右键(button === 2):直接开菜单。
  // 这是一条**保底路径** —— 有些环境里网站会把 contextmenu 整个吃掉
  // (网页版右键菜单、长按菜单等),那时只靠 contextmenu 事件就弹不出来。
  // 挂在捕获阶段 + 命中月亮才接管,所以没点月亮时网站自己的右键照旧。
  if (e.button === 2) {
    if (findBallAt(e)) {
      e.preventDefault()
      e.stopPropagation()
      openMenu(e.clientX, e.clientY)
    } else {
      closeMenu() // 右键点到空白:收掉菜单,把右键让给网站
    }
    return
  }

  if (pointers.size === 1) {
    lpStart = { id: e.pointerId, x: e.clientX, y: e.clientY }
    startLongPress(e)
  }

  if (pointers.size === 2) {
    // 双指：转为捏合缩放，取消长按与拖动
    cancelLongPress()
    lpStart = null
    releaseGrabSilently()
    closeMenu()
    const [a, b] = [...pointers.values()]
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
    pinchBall = findBallAt({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 })
    return
  }
  if (pointers.size > 2) return

  closeMenu()

  if (!model || grabbed || e.button > 0) return
  const ball = findBallAt(e)
  if (!ball) return

  // 命中月亮:从这里开始这一串手势归月亮 —— 截住事件,别让网站也收到
  // (pointerdown 挂在 window 的捕获阶段,所以能先于网站的处理函数拦下)
  e.preventDefault()
  e.stopPropagation()
  activePointerId = e.pointerId
  // 不用 setPointerCapture:canvas 是 pointer-events:none 收不到事件,
  // 而监听已经挂在 window 上,后续 move/up 本来就会送到这里
  grabbed = ball
  isGrabbing.value = true
  document.body.style.cursor = 'grabbing'

  // 保持 DYNAMIC，逐帧用指针速度驱动；重力与碰撞仍在物理世界中生效
  ball.body.allowSleep = false
  ball.body.wakeUp()
  ball.body.angularVelocity.setZero()

  camera.getWorldDirection(tmpV)
  dragPlane.setFromNormalAndCoplanarPoint(tmpV, ball.body.position)

  if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
    grabOffset.set(
      ball.body.position.x - hitPoint.x,
      ball.body.position.y - hitPoint.y,
      ball.body.position.z - hitPoint.z
    )
  } else {
    grabOffset.set(0, 0, 0)
  }
  targetPos.copy(ball.body.position)
  targetRaw.copy(ball.body.position)
  samples = []
  pushSample()
}

function onPointerMove(e) {
  if (isOwnChrome(e)) return // 悬停在自家菜单上,别去改光标
  if (pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  }

  // 双指捏合缩放优先
  if (pointers.size >= 2) {
    cancelLongPress()
    lpStart = null
    updatePinch()
    return
  }

  if (lpStart && e.pointerId === lpStart.id) {
    if (Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 8) {
      cancelLongPress()
      lpStart = null
    }
  }

  if (!model) return

  if (grabbed && e.pointerId === activePointerId) {
    const r = grabbed.radius
    setPointerNdc(e)
    raycaster.setFromCamera(pointerNdc, camera)
    if (raycaster.ray.intersectPlane(dragPlane, hitPoint)) {
      targetRaw.copy(hitPoint).add(grabOffset)
      // 限制在视口范围内（仅用于驱动，甩出速度用未钳制的 targetRaw）
      targetPos.set(
        THREE.MathUtils.clamp(targetRaw.x, bounds.minX + r, bounds.maxX - r),
        THREE.MathUtils.clamp(targetRaw.y, bounds.minY + r, bounds.maxY - r),
        THREE.MathUtils.clamp(targetRaw.z, bounds.minZ + r, bounds.maxZ - r)
      )
      pushSample()
    }
    return
  }

  // 悬停光标:canvas 已不接收悬停(整层点得穿),所以光标设在 body 上
  setPointerNdc(e)
  raycaster.setFromCamera(pointerNdc, camera)
  const over = ballList.some((b) => raycaster.intersectObject(b.holder, true).length > 0)
  document.body.style.cursor = over ? 'grab' : ''
}

function releaseGrabSilently() {
  if (!grabbed) return
  grabbed.body.allowSleep = true
  grabbed = null
  isGrabbing.value = false
  activePointerId = null
  document.body.style.cursor = ''
}

function endDrag(e) {
  if (isOwnChrome(e)) return // 在自家菜单上松手 → 与月亮无关
  if (grabbed && e.pointerId === activePointerId) {
    isGrabbing.value = false
    const ball = grabbed
    grabbed = null
    activePointerId = null

    computeThrowVelocity()
    document.body.style.cursor = 'grab'
    ball.body.allowSleep = true
    ball.body.wakeUp()
    if (throwVel.length() > 1) {
      ball.body.velocity.set(throwVel.x, throwVel.y, throwVel.z)
      ball.body.angularVelocity.set(throwVel.z / ball.radius, 0, -throwVel.x / ball.radius)
    }
    // 指针基本没动时保留当前速度，避免抹掉正在发生的弹跳

    // 这一次拖拽结束后的 click 要吞掉:否则在网站按钮上松手会"顺手点一下"
    suppressClickUntil = performance.now() + 350
    e.preventDefault()
    e.stopPropagation()
  }

  pointers.delete(e.pointerId)
  if (pointers.size < 2) {
    pinchDist = 0
    pinchBall = null
  }
  if (pointers.size === 0) {
    cancelLongPress()
    lpStart = null
  }
}

// ---------- 生成 / 删除 ----------
function createBall(pos, scale = 1) {
  const m = model.clone(true)
  const h = new THREE.Group()
  h.add(m)
  h.scale.setScalar(scale)
  scene.add(h)

  const r = BASE_RADIUS * scale
  const body = new CANNON.Body({
    mass: THREE.MathUtils.clamp(scale * scale * scale, 0.1, 12),
    shape: new CANNON.Sphere(r),
    linearDamping: 0.02,
    angularDamping: 0.25,
    allowSleep: true,
    sleepSpeedLimit: 1.2,
    sleepTimeLimit: 0.6,
    position: new CANNON.Vec3(pos.x, pos.y, pos.z)
  })
  world.addBody(body)

  const ball = { body, holder: h, model: m, scale, radius: r }
  ballList.push(ball)
  return ball
}

function removeBall(ball) {
  const i = ballList.indexOf(ball)
  if (i === -1) return
  if (grabbed === ball) releaseGrabSilently()
  if (menuTarget === ball) closeMenu()
  world.removeBody(ball.body)
  scene.remove(ball.holder)
  ballList.splice(i, 1)
}

function buildWalls() {
  for (const b of wallBodies) world.removeBody(b)
  wallBodies = []

  const halfH = Math.tan((FOV * Math.PI) / 360) * camera.position.z
  const halfW = halfH * camera.aspect
  const depth = 1.6
  bounds = {
    minX: -halfW,
    maxX: halfW,
    minY: -halfH,
    maxY: halfH,
    minZ: -depth,
    maxZ: depth
  }

  const add = (posX, posY, posZ, eulX, eulY, eulZ) => {
    const b = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() })
    b.position.set(posX, posY, posZ)
    b.quaternion.setFromEuler(eulX, eulY, eulZ)
    world.addBody(b)
    wallBodies.push(b)
  }

  // 地面（页面底端）、天花板、左右、前后
  add(0, -halfH, 0, -Math.PI / 2, 0, 0)
  add(0, halfH, 0, Math.PI / 2, 0, 0)
  add(-halfW, 0, 0, 0, Math.PI / 2, 0)
  add(halfW, 0, 0, 0, -Math.PI / 2, 0)
  add(0, 0, -depth, 0, 0, 0)
  add(0, 0, depth, 0, Math.PI, 0)
}

function syncBall(ball) {
  ball.holder.position.set(ball.body.position.x, ball.body.position.y, ball.body.position.z)
  ball.model.quaternion.set(
    ball.body.quaternion.x,
    ball.body.quaternion.y,
    ball.body.quaternion.z,
    ball.body.quaternion.w
  )
}

onMounted(() => {
  const container = containerRef.value
  if (!container) return

  scene = new THREE.Scene()
  // 刻意不设 scene.background:月亮要浮在网站上面,画布本身是透明的

  camera = new THREE.PerspectiveCamera(
    FOV,
    container.clientWidth / container.clientHeight,
    0.1,
    1000
  )
  camera.position.set(0, 0, CAMERA_Z)

  // alpha: true —— 画布透明,露出下面的网站
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setClearAlpha(0)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(container.clientWidth, container.clientHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  container.appendChild(renderer.domElement)

  scene.add(new THREE.AmbientLight(0xffffff, 0.4))
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.5)
  keyLight.position.set(5, 3, 5)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0x88aaff, 0.5)
  fillLight.position.set(-5, -2, -5)
  scene.add(fillLight)

  // 物理世界
  world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) })
  world.broadphase = new CANNON.SAPBroadphase(world)
  world.allowSleep = true
  world.defaultContactMaterial.restitution = RESTITUTION
  world.defaultContactMaterial.friction = FRICTION

  buildWalls()

  // ---- 事件:挂 window 而不是 canvas -----------------------------------------
  // 整层是 pointer-events: none(canvas 收不到事件),所以监听改挂 window,
  // 并且每条都**先做一次射线命中**:指针压在月亮上才接管(阻止默认 + 阻止冒泡),
  // 没压上就原样放过 —— 网站照常可点、可滚、可右键、可长按。
  // pointerdown / pointerup 用捕获阶段:命中时先于网站的处理函数把事件截住,
  // 这样"在按钮上甩月亮"不会顺手把按钮点掉。
  addListener(window, 'pointerdown', onPointerDown, true)
  addListener(window, 'pointermove', onPointerMove)
  addListener(window, 'pointerup', endDrag, true)
  addListener(window, 'pointercancel', endDrag, true)
  addListener(window, 'wheel', onWheel, { passive: false })
  // contextmenu 必须挂**捕获**阶段:网站自己的右键菜单挂在更深的元素上,
  // 冒泡阶段先经过它,它会 stopPropagation —— 挂在冒泡上的话这里永远收不到,
  // 表现就是"右键月亮弹不出来"。
  addListener(
    window,
    'contextmenu',
    (e) => {
      // 只有点在月亮上才接管右键;否则放过(网站自己的右键菜单照常弹)
      if (!findBallAt(e)) return
      e.preventDefault()
      e.stopPropagation()
      openMenu(e.clientX, e.clientY)
    },
    true
  )
  // 拖完那一下可能还会补一个 click:在按钮上松手会误点,这里吞掉
  addListener(
    window,
    'click',
    (e) => {
      if (suppressClickUntil > performance.now()) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    true
  )
  addListener(document, 'gesturestart', (e) => e.preventDefault())
  // 触摸:把这一串手势从浏览器的滚动/缩放手里抢过来(见 onTouchStart 的注释)
  addListener(window, 'touchstart', onTouchStart, { passive: false, capture: true })
  addListener(window, 'touchmove', onTouchMove, { passive: false, capture: true })
  addListener(document, 'keydown', (e) => {
    if (e.key === 'Escape') closeMenu()
  })

  // 加载模型，缩小为皮球大小
  dracoLoader = new DRACOLoader()
  dracoLoader.setDecoderPath(`${ASSET_BASE}draco/`)
  const loader = new GLTFLoader()
  loader.setDRACOLoader(dracoLoader)
  loader.load(
    MODEL_URL,
    (gltf) => {
      model = gltf.scene

      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const maxDim = Math.max(size.x, size.y, size.z)
      const s = maxDim > 0 ? BALL_DIAMETER / maxDim : 1
      model.scale.setScalar(s)
      model.position.copy(center).multiplyScalar(-s) // 缩放后再居中

      createBall(new THREE.Vector3(0, bounds.maxY * 0.55, 0))
    },
    undefined,
    (err) => {
      devError('模型加载失败', err)
      error.value = '模型加载失败：' + MODEL_URL
    }
  )

  resizeHandler = () => {
    const w = container.clientWidth
    const h = container.clientHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
    buildWalls()
    clampAllBalls()
  }
  addListener(window, 'resize', resizeHandler)

  clock = new THREE.Clock()

  // 调试钩子：供自动化测试观测物理状态
  const projVec = new THREE.Vector3()
  window.__moonDebug = {
    get state() {
      const ball = grabbed || ballList[0]
      if (!ball) return null
      projVec
        .set(ball.body.position.x, ball.body.position.y, ball.body.position.z)
        .project(camera)
      return {
        x: ball.body.position.x,
        y: ball.body.position.y,
        z: ball.body.position.z,
        vy: ball.body.velocity.y,
        speed: ball.body.velocity.length(),
        grabbing: !!grabbed,
        ballCount: ballList.length,
        scale: ball.scale,
        radius: ball.radius,
        floorY: bounds.minY + ball.radius,
        screenX: ((projVec.x + 1) / 2) * container.clientWidth,
        screenY: ((1 - projVec.y) / 2) * container.clientHeight,
        // 陀螺仪状态(验收/自动化用)
        gyro: gyroOn.value,
        gyroGotData,
        gravity: { x: +world.gravity.x.toFixed(2), y: +world.gravity.y.toFixed(2) }
      }
    }
  }

  // 陀螺仪默认开启(没有开关):触摸设备出场即挂监听;需要授权的手势环境自动补授权
  autoEnableGyro()

  const animate = () => {
    animationId = requestAnimationFrame(animate)
    const dt = Math.min(clock.getDelta(), 0.05)

    // 陀螺仪:重力平滑跟随设备倾斜(未开时这里恒等于固定向下重力)
    if (world) {
      if (gyroOn.value && gyroAttached) {
        gyroCurrentG.x += (gyroTargetG.x - gyroCurrentG.x) * GYRO_SMOOTH
        gyroCurrentG.y += (gyroTargetG.y - gyroCurrentG.y) * GYRO_SMOOTH
        const dx = Math.abs(world.gravity.x - gyroCurrentG.x)
        const dy = Math.abs(world.gravity.y - gyroCurrentG.y)
        world.gravity.set(gyroCurrentG.x, gyroCurrentG.y, 0)
        // 重力方向变了要把睡着的月亮叫醒,否则倾斜了它们纹丝不动
        if (dx > 0.05 || dy > 0.05) {
          for (const b of ballList) {
            if (b.body.sleepState === CANNON.Body.SLEEPING) b.body.wakeUp()
          }
        }
      } else if (world.gravity.x !== 0 || world.gravity.y !== GRAVITY) {
        world.gravity.set(0, GRAVITY, 0)
        gyroCurrentG.x = 0
        gyroCurrentG.y = GRAVITY
      }
    }

    if (ballList.length) {
      if (grabbed) {
        // 指针拖动：速度 = 跟随刚度 × 误差
        tmpV.set(
          targetPos.x - grabbed.body.position.x,
          targetPos.y - grabbed.body.position.y,
          targetPos.z - grabbed.body.position.z
        )
        if (tmpV.length() > 0.02) {
          // 只在有明确跟随目标时接管速度；误差接近 0（如已压在地面）时
          // 不覆盖速度，让碰撞冲量正常产生弹跳
          tmpV.multiplyScalar(FOLLOW_SPEED)
          if (tmpV.length() > MAX_THROW_SPEED) tmpV.setLength(MAX_THROW_SPEED)
          grabbed.body.velocity.set(tmpV.x, tmpV.y, tmpV.z)
        }
      }

      // 全部睡着、又没人拖着、也没有菜单挂着 → 这一步物理与这一帧渲染都省掉。
      // 它是浮在网站上面的一层,不能闲着也一直吃 GPU(见文件头第 4 条)。
      const idle =
        !grabbed &&
        !menu.value.open &&
        ballList.every((b) => b.body.sleepState === CANNON.Body.SLEEPING)
      if (idle) {
        clock.getDelta() // 丢掉这段时间,免得醒来时补一大步
        return
      }

      world.step(1 / 60, dt, 3)

      clampAllBalls()
      for (const b of ballList) syncBall(b)
      renderer.render(scene, camera)
      return
    }

    // 一个月亮都没有(清空后):还是画一帧,把最后一颗从画面上抹掉
    renderer.render(scene, camera)
  }
  animate()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  delete window.__moonDebug
  disableGyro() // 摘掉 deviceorientation / devicemotion 监听 + 清探针
  cancelLongPress()
  for (const fn of disposeListeners) fn()
  disposeListeners = []
  if (dracoLoader) dracoLoader.dispose()
  if (renderer) {
    renderer.dispose()
    renderer.forceContextLoss()
    if (renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }
})
</script>

<style scoped>
/* 整层:铺满窗口、完全透明、**点得穿** —— 网站照常可用,
   只有真点在月亮上时那一串手势才被接管(命中测试在脚本里) */
.moon-physics {
  position: relative;
  width: 100%;
  height: 100%;
  background: transparent;
  overflow: hidden;
  pointer-events: none;
}
.moon-physics :deep(canvas) {
  display: block;
  /* 不设 touch-action: none —— 那会吃掉网站上的滑动;拖动时靠 preventDefault 拦 */
  pointer-events: none;
}
/* 操作提示已挪到「关于」页(见 redeem.ts 的 MOON_HINT),月亮这层不再画文字;
   陀螺仪也没有开关(默认开启),所以这里没有任何额外 UI */

.error {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #ff6b6b;
  font-family: sans-serif;
  font-size: 14px;
}
/* 右键/长按菜单:它得能点,所以单独把命中打开 */
.ctx-menu {
  position: absolute;
  z-index: 10;
  display: flex;
  flex-direction: column;
  min-width: 96px;
  padding: 4px;
  background: rgba(24, 24, 28, 0.96);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
  font-family: sans-serif;
  pointer-events: auto;
}
.ctx-menu button {
  padding: 7px 12px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ctx-menu button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.12);
}
.ctx-menu button:disabled {
  color: rgba(255, 255, 255, 0.28);
  cursor: default;
}
</style>
