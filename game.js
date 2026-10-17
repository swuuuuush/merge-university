(() => {
  "use strict";

  /* ============================================================
     合成大学校徽 · 游戏引擎
     参考 https://yhsome.github.io/BigNaiWa/ 玩法与数值链
     ============================================================ */

  /* ============================================================
     985 高校池
     ============================================================ */
  const PICK_KEY = "mergeUniv_lastSchool";
  const POOL = (window.SCHOOLS985 || []).slice();
  const POOL_BY_ID = new Map(POOL.map(s => [s.id, s]));
  const MAX_TIER = 10;   // 固定 11 级（0..10），下标越大校徽越大
  const RANKED = POOL.filter(s => s.rank > 0).sort((a, b) => a.rank - b.rank);
  // 数组下标 = 层级 tier：0 号最小（北航），MAX_TIER 号最大（清华）。
  // 排名越靠前层级越高，所以这里要按「排名由低到高」排。
  const BASE_IDS = RANKED.slice(0, 11).map(s => s.id).reverse();
  const TOP_ID = BASE_IDS[MAX_TIER];                          // 层级最高 = 清华大学
  const LAST_ID = BASE_IDS[0];                                // 层级最低 = 北京航空航天大学
  const SUB_ID = RANKED[11]?.id;                              // 北航后一位（rank 12）= 中山大学，用于递补

  /* ----------------------------------------------------------
     碰撞形状：校徽自己的轮廓

     shapes.js 里存的是从贴图 alpha 提取出来的真实轮廓，简化后做凸分解
     得到的一组凸多边形。坐标是「局部坐标」——球心为原点，1 = 球半径 r，
     与 drawBall 里 drawImage 的缩放完全一致，所以碰撞体与画面严格重合。

     每个凸块预先算好顶点和外法线（形状不旋转，法线可以复用）。
     若 shapes.js 缺失（比如只拷了部分文件），退化成一个正 N 边形，
     至少还是按轮廓级别在算，不会退回圆。
     ---------------------------------------------------------- */
  function buildShape(list) {
    const rings = (list && list.length) ? list : fallbackRing();
    const blocks = [];
    let lTop = Infinity, lBottom = -Infinity, lLeft = Infinity, lRight = -Infinity;
    let bound = 0;

    for (let bi = 0; bi < rings.length; bi++) {
      const ring = rings[bi];
      const n = ring.length;
      if (n < 3) continue;
      const vx = new Float64Array(n), vy = new Float64Array(n);
      const nx = new Float64Array(n), ny = new Float64Array(n);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < n; i++) {
        const px = ring[i][0], py = ring[i][1];
        vx[i] = px; vy[i] = py;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
        if (px < lLeft) lLeft = px;
        if (px > lRight) lRight = px;
        if (py < lTop) lTop = py;
        if (py > lBottom) lBottom = py;
        const d = Math.sqrt(px * px + py * py);
        if (d > bound) bound = d;
      }
      // 外法线：环按数学正序给出，边 (i → i+1) 的外法线是 (ey, -ex)
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ex = vx[j] - vx[i], ey = vy[j] - vy[i];
        const L = Math.sqrt(ex * ex + ey * ey) || 1e-9;
        nx[i] = ey / L; ny[i] = -ex / L;
      }
      // 本块在「自己每条边的外法线」上的投影极值。
      // 形状不旋转，这两个数组是常量，SAT 里直接当标量用，省掉逐顶点扫描。
      const psup = new Float64Array(n), pinf = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let hi = -Infinity, lo = Infinity;
        for (let k = 0; k < n; k++) {
          const d = vx[k] * nx[i] + vy[k] * ny[i];
          if (d > hi) hi = d;
          if (d < lo) lo = d;
        }
        psup[i] = hi; pinf[i] = lo;
      }
      blocks.push({ n, vx, vy, nx, ny, x0, y0, x1, y1, psup, pinf });
    }
    if (!blocks.length) blocks.push(...buildShapeFallback());
    return { blocks, lTop, lBottom, lLeft, lRight, bound: bound || 1 };
  }

  function fallbackRing() {
    const n = 16, ring = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      ring.push([Math.cos(a), Math.sin(a)]);
    }
    return [ring];
  }

  function buildShapeFallback() {
    const ring = fallbackRing()[0], n = ring.length;
    const vx = new Float64Array(n), vy = new Float64Array(n);
    const nx = new Float64Array(n), ny = new Float64Array(n);
    const psup = new Float64Array(n), pinf = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      vx[i] = ring[i][0]; vy[i] = ring[i][1];
      nx[i] = vx[i]; ny[i] = vy[i];
      psup[i] = 1; pinf[i] = -1;
    }
    return [{ n, vx, vy, nx, ny, x0: -1, y0: -1, x1: 1, y1: 1, psup, pinf }];
  }

  // 每个 985 校徽的轮廓只建一次；当前本局的 11 级合成表在 applyRoster 里再指过来。
  const SHAPE_CACHE = {};
  function getShape(id) {
    if (SHAPE_CACHE[id]) return SHAPE_CACHE[id];
    const list = (window.SHAPES985 || {})[id];
    const shape = buildShape(list);
    SHAPE_CACHE[id] = shape;
    return shape;
  }
  for (const s of POOL) s.shape = getShape(s.id);

  let SCHOOLS = [];            // 本局 11 级合成表（由 applyRoster 生成）
  let images = [];             // 与 SCHOOLS 对应的 11 张 Image

  // 与原版一致的尺寸 / 物理常量链
  const W = 420;
  const H = 700;
  const WALL = 10;
  const DROP_Y = 74;
  const DANGER_Y = 142;
  const GRAVITY = 1500;
  const ITER = 10;

  const RESTITUTION = 0.38;
  const WALL_RESTITUTION = 0.45;
  const REST_THRESHOLD = 55;
  const MERGE_PAD = 0.8;

  const RADII = [17, 23, 31, 39, 48, 58, 69, 81, 94, 108, 124];
  // 素材里校徽轮廓的等效半径占画布半径的比例，需与 tools/fetch_badges.py 的 FILL 一致
  const ASSET_FILL = 0.92;
  const MERGE_SCORE = [0, 1, 3, 6, 10, 15, 21, 28, 36, 45, 55];
  const SPAWN_TIERS = [0, 1, 2, 3, 4];
  const SPAWN_WEIGHTS = [0.28, 0.24, 0.20, 0.16, 0.12];

  const MAX_BONUS = 500;
  const REVIVE_STEP = 2000;
  const OVER_LIMIT = 1.5;
  const REST_SPEED = 140;
  const FREEZE_MS = 70;

  // ---- 投放节流：限制下落频率 ----
  // 连点 / 连按空格时，不做节流会一两秒内堆出几十个校徽，后果有两个：
  //   1) 物理是 O(n²)，帧率立刻被拖垮（卡）；
  //   2) 新的校徽会直接生成在还没落下去的那颗身上，深度重叠被约束一次性弹开，
  //      画面上就是「闪现」。
  // 所以这里上两道闸：
  //   · DROP_COOLDOWN —— 硬性冷却，连点也最多每秒 3 次；
  //   · 投放口净空检查 —— 上一颗还没让开就不放下一颗（原版合成大西瓜同款规则）；
  //     顶部真堵死时超过 DROP_MAX_WAIT 强制放行，避免完全按不动。
  const DROP_COOLDOWN = 300;    // 毫秒，硬性冷却（≈ 3 次/秒）—— 想更慢就把这个值改大
  const DROP_CLEAR_GAP = 18;    // 上一颗要落到投放口下方这么多像素才算让开
  const DROP_MAX_WAIT = 1200;   // 毫秒，兜底强制放行
  const MAX_PARTICLES = 200;    // 粒子上限：每个都是一次 arc+fill，太多会拖慢绘制

  // 复合圆贴边时，多个子圆可能同时与墙 / 其他球接触，约束互相打架会让
  // 位置在一帧内被反复修正；再由「位置差 / dt」推导速度就会被放大成巨大的
  // 横向速度，表现为校徽贴边下落时突然飞向另一边。这两道上限用来兜底。
  const BAUMGARTE = 0.55;       // 位置修正比例：一帧只推开一部分，不会瞬移
  const MAX_CORR = 12;          // 单次轮廓穿透修正的上限（像素）
  const SLOP = 0.4;             // 允许的静止穿透量，免得静止时来回抖
  const MU = 0.22;              // 校徽之间的切向摩擦：搓一下就会转起来（数值小=更滑更快）
  const INERTIA_K = 0.5;        // 转动惯量系数：I = INERTIA_K · m · r²（均质圆盘是 0.5）
  const ANG_DRAG = 0.997;       // 自转阻尼（空气），防止越转越快
  const ANG_CONTACT_DAMP = 0.99;// 有接触时的自转阻尼，免得停下来还在原地打转
  const MAX_AV = 7;             // 角速度上限（rad/s），约 1.1 转/秒
  const AIR_DRAG = 0.999;       // 极轻空气阻尼，抑制能量累积
  const GROUND_FRICTION = 1;    // 地面保持光滑：1 = 完全不做横向阻尼
  const MAX_PUSH = 12;          // 单帧墙约束最大修正量（像素）
  const MAX_SPEED = 1500;       // 速度总闸（≈25px/帧），杜绝乱飞
  const SLEEP_SPEED = 26;       // 低于此速度且有接触就继续衰减
  const SLEEP_DAMP = 0.55;

  const BEST_KEY = "merge_university.best.v1";
  const MUTE_KEY = "merge_university.mute.v1";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const nextCanvas = document.getElementById("next");
  const nextCtx = nextCanvas.getContext("2d");
  const chainEl = document.getElementById("chain");
  const scoreEl = document.getElementById("score");
  const bestEl = document.getElementById("best");
  const finalScoreEl = document.getElementById("finalScore");
  const finalBestEl = document.getElementById("finalBest");
  const reviveBadge = document.getElementById("reviveBadge");
  const reviveCountEl = document.getElementById("reviveCount");
  const overlay = document.getElementById("overlay");
  const revivePrompt = document.getElementById("revivePrompt");
  const overPanel = document.getElementById("overPanel");
  const reviveScoreEl = document.getElementById("reviveScore");
  const reviveLeftEl = document.getElementById("reviveLeft");
  const stage = document.getElementById("stage");

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const rand = (a, b) => a + Math.random() * (b - a);

  // 画布逻辑尺寸 → 游戏坐标的比例，由 resizeCanvas 维护
  let viewScale = 1;

  // ---------------------------------------------------------
  //  图像预加载
  // ---------------------------------------------------------
  const imgById = {};
  function fileSrc(id) { return "assets/badges985/" + id + ".png"; }

  function loadAllImages() {
    return Promise.all(POOL.map(s => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(s.id);
      img.onerror = () => {
        if (img.src.indexOf("data:") !== 0) { resolve(s.id); return; }
        const fb = new Image();
        fb.onload = () => { imgById[s.id] = fb; resolve(s.id); };
        fb.onerror = () => resolve(s.id);
        fb.src = fileSrc(s.id);
      };
      img.src = (window.BADGES985 || {})[s.id] || fileSrc(s.id);
      imgById[s.id] = img;
    })));
  }

  // ---------------------------------------------------------
  //  音效（WebAudio，无外部资源）
  // ---------------------------------------------------------
  const Sound = {
    ctx: null,
    muted: localStorage.getItem(MUTE_KEY) === "1",
    ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { this.ctx = new AC(); } catch (e) { this.ctx = null; }
      return this.ctx;
    },
    tone(freq, dur, type = "sine", vol = 0.12, slideTo = null) {
      if (this.muted) return;
      const c = this.ensure();
      if (!c) return;
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, c.currentTime);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
      g.gain.setValueAtTime(vol, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
      o.connect(g).connect(c.destination);
      o.start(c.currentTime);
      o.stop(c.currentTime + dur + 0.05);
    },
    merge(tier) {
      const base = 200 + tier * 70;
      this.tone(base, 0.14, "sine", 0.12, base * 1.6);
      this.tone(base * 0.5, 0.18, "triangle", 0.08);
    },
    drop() { this.tone(260, 0.08, "triangle", 0.06, 180); },
    bonus() {
      const c = this.ensure(); if (!c) return;
      [440, 554, 659, 880].forEach((f, i) => setTimeout(() => this.tone(f, 0.35, "sine", 0.08), i * 70));
    },
    over() { this.tone(150, 0.5, "sawtooth", 0.08, 80); }
  };

  function updateSoundBtn() {
    const btn = document.getElementById("soundBtn");
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(!Sound.muted));
    btn.querySelector(".ico").textContent = Sound.muted ? "🔇" : "🔊";
    btn.querySelector(".lbl").textContent = Sound.muted ? "音效关" : "音效开";
  }
  updateSoundBtn();

  // ---------------------------------------------------------
  //  状态
  // ---------------------------------------------------------
  const state = {
    balls: [],
    particles: [],
    floats: [],
    nextTier: 0,
    currentTier: 0,
    aimX: W / 2,
    holding: true,
    score: 0,
    best: +(localStorage.getItem(BEST_KEY) || 0),
    revives: 0,
    reviveGiven: 0,
    flash: 0,
    freeze: 0,
    gameOver: false,
    reviveAsk: false,
    picking: false,
    dangerTime: 0,
    started: false,
    lastTs: 0,
    lastDropAt: -1e9,
    dropCooldown: DROP_COOLDOWN   // 运行时可调：__MERGE_UNIV__.state.dropCooldown = 800
  };

  function reset() {
    state.balls = [];
    state.particles = [];
    state.floats = [];
    state.score = 0;
    state.revives = 0;
    state.reviveGiven = 0;
    state.flash = 0;
    state.freeze = 0;
    state.gameOver = false;
    state.reviveAsk = false;
    state.dangerTime = 0;
    state.holding = true;
    state.lastDropAt = -1e9;
    state.nextTier = pickSpawnTier();
    state.currentTier = pickSpawnTier();
    state.aimX = W / 2;
    overlay.hidden = true;
    revivePrompt.hidden = true;
    overPanel.hidden = false;
    paintScore();
    paintRevives(false);
    drawNext();
    drawChain();
  }

  // ---------------------------------------------------------
  //  学校选择：每次重新开始时弹出
  // ---------------------------------------------------------
  // 返回下标 0..10 的 id 列表：0 号最小，10 号最大。
  // 规则：被选中的学校顶替清华，占据最高层级；
  //      如果它原本就在合成表里，就由「排名在北航后一位」的学校（中山大学）递补，
  //      递补校排在最低层级（它排名最靠后），其余学校的相对顺序不变。
  function buildRoster(pickedId) {
    if (!POOL_BY_ID.has(pickedId)) pickedId = TOP_ID;
    const pickedInBase = BASE_IDS.indexOf(pickedId) !== -1;
    // 去掉清华（被顶替）和被选学校后的其余 9~10 所，仍按「排名由低到高」
    const rest = BASE_IDS.filter(id => id !== TOP_ID && id !== pickedId);
    // 被选学校本来就在表里 → 空出来的位置由中山大学递补（它排名最靠后，放最低层级）
    if (pickedInBase && pickedId !== TOP_ID && SUB_ID) rest.unshift(SUB_ID);
    return rest.concat([pickedId]);
  }

  function applyRoster(pickedId) {
    const ids = buildRoster(pickedId);
    SCHOOLS = ids.map(id => POOL_BY_ID.get(id));
    images = ids.map(id => imgById[id]);
  }

  function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }

  // 学校选择弹窗
  const picker = document.getElementById("picker");
  const pickerGrid = document.getElementById("pickerGrid");
  const pickerSearch = document.getElementById("pickerSearch");
  const pickerChain = document.getElementById("pickerChain");
  const pickerStart = document.getElementById("pickerStart");
  const pickerRandom = document.getElementById("pickerRandom");
  let pickerSelectedId = TOP_ID;
  let pickerBuilt = false;

  function formatMotto(s) {
    return s.motto && s.mottoType === "校训" ? "“" + s.motto + "”" : "";
  }

  function buildPicker() {
    if (pickerBuilt) return;
    pickerBuilt = true;
    pickerGrid.innerHTML = "";
    const ordered = RANKED.concat(POOL.filter(s => s.rank === 0));
    for (const s of ordered) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "picker-item";
      item.dataset.id = s.id;
      const motto = formatMotto(s);
      item.title = s.name + (motto ? " · 校训：" + motto : "");
      item.innerHTML = '<img src="' + ((window.BADGES985 || {})[s.id] || "") + '" alt="" loading="lazy">' +
                       '<span class="picker-name">' + escapeHtml(s.name) + '</span>' +
                       (motto ? '<span class="picker-motto">' + escapeHtml(motto) + '</span>' : "");
      item.addEventListener("click", () => selectSchool(s.id));
      pickerGrid.appendChild(item);
    }
    pickerSearch.addEventListener("input", () => filterPicker(pickerSearch.value.trim()));
  }

  function filterPicker(q) {
    const lower = q.toLowerCase();
    for (const it of pickerGrid.querySelectorAll(".picker-item")) {
      const s = POOL_BY_ID.get(it.dataset.id);
      const hit = !q || s.name.indexOf(q) !== -1 || s.short.indexOf(q) !== -1 || s.id.toLowerCase().indexOf(lower) !== -1;
      it.hidden = !hit;
    }
  }

  function updatePickerPreview() {
    const ids = buildRoster(pickerSelectedId);
    pickerChain.innerHTML = "";
    for (let i = 0; i < ids.length; i++) {
      const s = POOL_BY_ID.get(ids[i]);
      const img = document.createElement("img");
      img.src = (window.BADGES985 || {})[s.id] || "";
      img.title = s.name;
      // 尺寸随层级递增，直观体现「左小右大」的升级方向
      const px = 14 + i * 3;
      img.style.width = px + "px";
      img.style.height = px + "px";
      pickerChain.appendChild(img);
      if (i < ids.length - 1) {
        const ar = document.createElement("span");
        ar.className = "picker-arrow";
        ar.textContent = "→";
        pickerChain.appendChild(ar);
      }
    }
  }

  function selectSchool(id) {
    pickerSelectedId = id;
    localStorage.setItem(PICK_KEY, id);
    for (const it of pickerGrid.querySelectorAll(".picker-item")) {
      it.classList.toggle("selected", it.dataset.id === id);
      it.setAttribute("aria-pressed", String(it.dataset.id === id));
    }
    updatePickerPreview();
    if (pickerStart) pickerStart.focus();
  }

  function openPicker() {
    let id = localStorage.getItem(PICK_KEY) || TOP_ID;
    if (!POOL_BY_ID.has(id)) id = TOP_ID;
    buildPicker();
    selectSchool(id);
    picker.hidden = false;
    state.picking = true;
    overlay.hidden = true;
  }

  function closePickerAndStart() {
    if (!pickerSelectedId) pickerSelectedId = TOP_ID;
    applyRoster(pickerSelectedId);
    picker.hidden = true;
    state.picking = false;
    reset();
  }

  function restartWithPicker() {
    openPicker();
  }

  function rollSpawnTier() {
    let r = Math.random(), acc = 0;
    for (let i = 0; i < SPAWN_TIERS.length; i++) {
      acc += SPAWN_WEIGHTS[i];
      if (r <= acc) return SPAWN_TIERS[i];
    }
    return SPAWN_TIERS[0];
  }

  function pickSpawnTier(avoid) {
    if (avoid === undefined) return rollSpawnTier();
    for (let i = 0; i < 6; i++) {
      const t = rollSpawnTier();
      if (t !== avoid) return t;
    }
    return rollSpawnTier();
  }

  function makeBall(x, y, tier, vx = 0, vy = 0, angle = 0, av = 0) {
    const r = RADII[tier];
    const shape = SCHOOLS[tier].shape;
    const b = {
      x, y, vx, vy,
      px: x, py: y,
      r, tier,
      mass: r * r,
      invMass: 1 / (r * r),
      angle, av,                       // 自转角度 / 角速度
      // 转动惯量按均质圆盘近似 I = 0.5·m·r²，而 m = r²
      invI: 1 / (INERTIA_K * r * r * r * r),
      ca: 1, sa: 0,
      extTop: 0, extBottom: 0, extLeft: 0, extRight: 0,
      bornAt: performance.now(),
      landed: false,
      dead: false,
      merged: false,
      contacts: 0,
      ballContacts: 0,   // 只统计「和别的校徽」的接触，地面/墙不算（地面是光滑的）
      popAt: 0,
      pvx: 0, pvy: 0,
      blocks: shape.blocks,
      boundR: shape.bound
    };
    updateExtents(b);   // 按当前角度算出上下左右最远轮廓的偏移
    return b;
  }

  // 待投放的那颗每帧都要画一次，缓存住避免每帧新建对象（GC 抖动也会掉帧）
  let previewBall = null;
  function getPreview(tier, x, y) {
    if (!previewBall || previewBall.tier !== tier) previewBall = makeBall(x, y, tier);
    previewBall.x = x; previewBall.y = y;
    return previewBall;
  }

  // ---------------------------------------------------------
  //  SAT：凸多边形精确相交测试
  // ---------------------------------------------------------
  // a / b 的某两个凸块是否相交；pad 是额外的「接触容差」（允许这点间隙也算碰上）。
  // 相交时把穿透深度和分离法线（由 a 指向 b）写进 out，返回 true。
  //
  /* 校徽会自转，所以不能再用「相对朝向固定」的预计算表，SAT 必须带旋转。
     好在每个凸块在自己边法线上的投影极值（psup/pinf）与旋转无关，仍是常量；
     只有「对方形状在这条轴上的投影」需要按相对角 dθ 现算 —— 一次 O(V) 扫描。
     实测 17~20 顶点的情况下单次 SAT 只要几微秒，一帧完全够用。 */
  const satOut = { depth: 0, nx: 0, ny: 0, cx: 0, cy: 0 };

  // 凸块 Blk（角度 ang、缩放 r、中心 cx,cy）在世界轴 (ux,uy) 上的投影区间。
  // 技巧：不旋转顶点，而是把轴反向旋回局部坐标，省掉逐顶点三角函数。
  const _rg = new Float64Array(2);
  function projRange(Blk, ca, sa, r, cx, cy, ux, uy) {
    const lx = ux * ca + uy * sa;    // R(-ang) 作用在 u 上
    const ly = -ux * sa + uy * ca;
    let lo = Infinity, hi = -Infinity;
    const vx = Blk.vx, vy = Blk.vy;
    for (let k = 0; k < Blk.n; k++) {
      const d = vx[k] * lx + vy[k] * ly;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const c = cx * ux + cy * uy;
    _rg[0] = c + lo * r;
    _rg[1] = c + hi * r;
  }

  // 支撑点：凸块沿世界方向 (ux,uy) 最远的那个顶点，返回世界坐标
  function supportPt(Blk, ca, sa, r, cx, cy, ux, uy, out) {
    const lx = ux * ca + uy * sa;
    const ly = -ux * sa + uy * ca;
    let best = -Infinity, bi = 0;
    const vx = Blk.vx, vy = Blk.vy;
    for (let k = 0; k < Blk.n; k++) {
      const d = vx[k] * lx + vy[k] * ly;
      if (d > best) { best = d; bi = k; }
    }
    out[0] = cx + (vx[bi] * ca - vy[bi] * sa) * r;
    out[1] = cy + (vx[bi] * sa + vy[bi] * ca) * r;
  }

  const _sp = new Float64Array(2);

  function satBlocks(a, b, ia, ib, pad) {
    const A = a.blocks[ia], B = b.blocks[ib];
    const ar = a.r, br = b.r;
    const dxc = b.x - a.x, dyc = b.y - a.y;

    // 粗筛一：外接圆
    const reach = a.boundR * ar + b.boundR * br + pad;
    if (dxc * dxc + dyc * dyc > reach * reach) return false;
    // 粗筛二：世界系 AABB（ext* 每帧按当前角度算好）
    if (a.x + a.extRight + pad < b.x + b.extLeft) return false;
    if (b.x + b.extRight + pad < a.x + a.extLeft) return false;
    if (a.y + a.extBottom + pad < b.y + b.extTop) return false;
    if (b.y + b.extBottom + pad < a.y + a.extTop) return false;

    const ca = a.ca, sa = a.sa, cb = b.ca, sb = b.sb;
    // 相对角：把 A 的局部法线转到 B 的局部系（以及反向）只需一次三角函数
    const dth = a.angle - b.angle;
    const cd = Math.cos(dth), sd = Math.sin(dth);
    const limit = -pad;
    let best = Infinity, bnx = 0, bny = 0;

    // ---- 轴取自 A 的边法线（世界系 = R(aAngle) · A.n_local）----
    for (let i = 0; i < A.n; i++) {
      const lx = A.nx[i], ly = A.ny[i];                 // A 局部的法线
      const ux = lx * ca - ly * sa, uy = lx * sa + ly * ca;   // 世界系
      const cA = a.x * ux + a.y * uy;
      const aHi = cA + ar * A.psup[i], aLo = cA + ar * A.pinf[i];
      // 同一条轴在 B 的局部系里 = R(aθ - bθ) · A.n_local
      const blx = lx * cd - ly * sd, bly = lx * sd + ly * cd;
      let lo = Infinity, hi = -Infinity;
      const bvx = B.vx, bvy = B.vy;
      for (let k = 0; k < B.n; k++) {
        const d = bvx[k] * blx + bvy[k] * bly;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      const cB = b.x * ux + b.y * uy;
      const bHi = cB + br * hi, bLo = cB + br * lo;
      // 沿这条轴分开有两条路：把 B 往 +u 推（o1），或往 -u 推（o2），取近的那条
      const o1 = aHi - bLo, o2 = bHi - aLo;
      const o = o1 < o2 ? o1 : o2;
      if (o <= limit) return false;
      if (o < best) {
        best = o;
        const s = o1 < o2 ? 1 : -1;                 // 法线由 A 指向 B
        bnx = ux * s; bny = uy * s;
      }
    }

    // ---- 轴取自 B 的边法线 ----
    for (let j = 0; j < B.n; j++) {
      const lx = B.nx[j], ly = B.ny[j];
      const ux = lx * cb - ly * sb, uy = lx * sb + ly * cb;
      const cB = b.x * ux + b.y * uy;
      const bHi = cB + br * B.psup[j], bLo = cB + br * B.pinf[j];
      // 同一条轴在 A 的局部系里 = R(bθ - aθ) · B.n_local
      const alx = lx * cd + ly * sd, aly = -lx * sd + ly * cd;
      let lo = Infinity, hi = -Infinity;
      const avx = A.vx, avy = A.vy;
      for (let k = 0; k < A.n; k++) {
        const d = avx[k] * alx + avy[k] * aly;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      const cA = a.x * ux + a.y * uy;
      const aHi = cA + ar * hi, aLo = cA + ar * lo;
      const o1 = aHi - bLo, o2 = bHi - aLo;
      const o = o1 < o2 ? o1 : o2;
      if (o <= limit) return false;
      if (o < best) {
        best = o;
        // B 的外法线是朝外的，A→B 的方向要按分离方向取（o1 小就沿 +u，否则 -u）
        const s = o1 < o2 ? 1 : -1;
        bnx = ux * s; bny = uy * s;
      }
    }

    // 兜底：法线必须指向 a→b（深穿透时上面的判据可能不稳）
    if (bnx * dxc + bny * dyc < 0) { bnx = -bnx; bny = -bny; }
    satOut.depth = best + pad;
    satOut.nx = bnx; satOut.ny = bny;

    // 接触点：A 沿 +n 的最远点 与 B 沿 -n 的最远点 的中点（用来算力矩）
    supportPt(A, a.ca, a.sa, ar, a.x, a.y, bnx, bny, _sp);
    const ax2 = _sp[0], ay2 = _sp[1];
    supportPt(B, b.ca, b.sa, br, b.x, b.y, -bnx, -bny, _sp);
    satOut.cx = (ax2 + _sp[0]) * 0.5;
    satOut.cy = (ay2 + _sp[1]) * 0.5;
    return true;
  }

  // 每帧按当前角度重算「球心到上下左右最远轮廓」的偏移，
  // 旋转后这四个值不再是常量，墙 / 地面 / 越线判定都得用新的。
  function updateExtents(b) {
    const ca = Math.cos(b.angle), sa = Math.sin(b.angle);
    b.ca = ca; b.sa = sa;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < b.blocks.length; i++) {
      const B = b.blocks[i], vx = B.vx, vy = B.vy;
      for (let k = 0; k < B.n; k++) {
        const px = vx[k] * ca - vy[k] * sa;
        const py = vx[k] * sa + vy[k] * ca;
        if (px < xMin) xMin = px;
        if (px > xMax) xMax = px;
        if (py < yMin) yMin = py;
        if (py > yMax) yMax = py;
      }
    }
    b.extLeft = xMin * b.r; b.extRight = xMax * b.r;
    b.extTop = yMin * b.r; b.extBottom = yMax * b.r;
  }

  // ---------------------------------------------------------
  //  计分 & 复活币
  // ---------------------------------------------------------
  function addScore(n, x, y, text) {
    state.score += n;
    if (x !== undefined && y !== undefined && text) {
      state.floats.push({ x, y: y - state.floats.length * 6, text, life: 1.2, big: n >= 100 });
    }
    grantRevives();
    paintScore();
  }

  function paintScore() {
    scoreEl.textContent = String(state.score);
    if (state.score > state.best) {
      state.best = state.score;
      localStorage.setItem(BEST_KEY, String(state.best));
    }
    bestEl.textContent = String(state.best);
    finalScoreEl.textContent = String(state.score);
    finalBestEl.textContent = String(state.best);
  }

  function paintRevives(pop) {
    if (reviveCountEl) reviveCountEl.textContent = "×" + state.revives;
    if (state.revives > 0) {
      reviveBadge.hidden = false;
      if (pop) {
        reviveBadge.classList.remove("pop");
        void reviveBadge.offsetWidth;
        reviveBadge.classList.add("pop");
      }
    } else {
      reviveBadge.hidden = true;
      reviveBadge.classList.remove("pop");
    }
  }

  function grantRevives() {
    let got = 0;
    while (state.reviveGiven < Math.floor(state.score / REVIVE_STEP)) {
      state.reviveGiven++;
      state.revives++;
      got++;
    }
    if (got) paintRevives(true);
  }

  // ---------------------------------------------------------
  //  特效
  // ---------------------------------------------------------
  function burst(x, y, tier, n, speed) {
    const color = SCHOOLS[tier].color;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = rand(speed * 0.25, speed);
      state.particles.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 70,
        r: rand(2, 5),
        life: 1,
        decay: rand(1.5, 2.5),
        color
      });
    }
    if (state.particles.length > MAX_PARTICLES) state.particles.splice(0, state.particles.length - MAX_PARTICLES);
  }

  // ---------------------------------------------------------
  //  物理
  // ---------------------------------------------------------
  /* 接触缓存：一帧只做一次完整 SAT，之后的迭代复用接触点与法线，
     只沿缓存法线重算当前穿透量（两次 O(V) 投影，比整轮 SAT 便宜一个量级）。 */
  const contactPool = [];
  let contactCount = 0;

  function pushContact(a, b, nx, ny, depth, cx, cy) {
    let c = contactPool[contactCount];
    if (!c) { c = { a: null, b: null, nx: 0, ny: 0, depth: 0, cx: 0, cy: 0 }; contactPool[contactCount] = c; }
    c.a = a; c.b = b; c.nx = nx; c.ny = ny; c.depth = depth; c.cx = cx; c.cy = cy;
    contactCount++;
  }

  // 沿缓存法线 n（a→b）重算当前穿透量：A 在 +n 上的最大值 减去 B 在 +n 上的最小值
  function depthAlong(c) {
    const a = c.a, b = c.b, nx = c.nx, ny = c.ny;
    let aMax = -Infinity, bMin = Infinity;
    for (let i = 0; i < a.blocks.length; i++) {
      projRange(a.blocks[i], a.ca, a.sa, a.r, a.x, a.y, nx, ny);
      if (_rg[1] > aMax) aMax = _rg[1];
    }
    for (let i = 0; i < b.blocks.length; i++) {
      projRange(b.blocks[i], b.ca, b.sa, b.r, b.x, b.y, nx, ny);
      if (_rg[0] < bMin) bMin = _rg[0];
    }
    return aMax - bMin;
  }

  function stepPhysics(dt) {
    const balls = state.balls;
    const merges = [];
    contactCount = 0;

    // ---- 1. 积分：半隐式欧拉（线速度 + 角速度都是显式状态）----
    // 速度不再由「位置差 / dt」反推，约束修正因此不会变成速度 —— 这是根治
    // 「乱飞 / 闪现」的关键。
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead) continue;
      b.vy += GRAVITY * dt;
      b.vx *= AIR_DRAG; b.vy *= AIR_DRAG;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.av *= ANG_DRAG;
      if (b.av > MAX_AV) b.av = MAX_AV; else if (b.av < -MAX_AV) b.av = -MAX_AV;
      if (b.av) { b.angle += b.av * dt; updateExtents(b); }
      b.pvx = b.vx; b.pvy = b.vy;   // 求解前的速度，用来判断该不该弹
      b.contacts = 0;
      b.ballContacts = 0;
    }

    // ---- 2. 一次完整 SAT，建立这一帧的接触表 ----
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.dead) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.dead) continue;

        let bestDepth = -Infinity, bnx = 0, bny = 0, bcx = 0, bcy = 0, hit = false;
        for (let p = 0; p < a.blocks.length; p++) {
          for (let q = 0; q < b.blocks.length; q++) {
            if (!satBlocks(a, b, p, q, MERGE_PAD)) continue;
            hit = true;
            if (satOut.depth > bestDepth) {
              bestDepth = satOut.depth; bnx = satOut.nx; bny = satOut.ny;
              bcx = satOut.cx; bcy = satOut.cy;
            }
          }
        }
        if (!hit) continue;

        // 合成判定：同 tier 轮廓碰上就合并
        if (a.tier === b.tier && !a.merged && !b.merged) {
          merges.push([a, b]);
          a.merged = true; b.merged = true;
          continue;
        }
        pushContact(a, b, bnx, bny, bestDepth, bcx, bcy);
      }
    }

    // ---- 3. 迭代求解：位置 Baumgarte 慢推 + 速度顺序冲量（含力矩 → 会自转）----
    for (let it = 0; it < ITER; it++) {
      const first = it === 0;

      // 墙 / 地面 / 天花板：用当前角度下的四向最远轮廓偏移
      for (let i = 0; i < balls.length; i++) {
        const b = balls[i];
        if (b.dead) continue;
        const pushL = WALL - (b.x + b.extLeft);
        if (pushL > 0) {
          b.x += Math.min(pushL, MAX_PUSH);
          if (b.vx < 0) b.vx = (first && -b.vx > REST_THRESHOLD) ? -b.vx * WALL_RESTITUTION : 0;
          b.contacts++;
        }
        const pushR = (b.x + b.extRight) - (W - WALL);
        if (pushR > 0) {
          b.x -= Math.min(pushR, MAX_PUSH);
          if (b.vx > 0) b.vx = (first && b.vx > REST_THRESHOLD) ? -b.vx * WALL_RESTITUTION : 0;
          b.contacts++;
        }
        const pushFloor = (b.y + b.extBottom) - (H - WALL);
        if (pushFloor > 0) {
          b.y -= Math.min(pushFloor, MAX_PUSH);
          if (b.vy > 0) b.vy = (first && b.vy > REST_THRESHOLD) ? -b.vy * WALL_RESTITUTION : 0;
          b.vx *= GROUND_FRICTION;   // 地面光滑：这里是 1，不做横向阻尼
          b.contacts++;
        }
        const pushCeil = -(b.y + b.extTop);
        if (pushCeil > 0) {
          b.y += Math.min(pushCeil, MAX_PUSH);
          if (b.vy < 0) b.vy = 0;
          b.contacts++;
        }
      }

      // 校徽之间
      for (let k = 0; k < contactCount; k++) {
        const c = contactPool[k];
        const a = c.a, b = c.b;
        if (a.dead || b.dead || a.merged || b.merged) continue;
        const nx = c.nx, ny = c.ny;

        // 位置修正：留 SLOP 免得静止时来回抖，一帧只推 BAUMGARTE 比例，避免瞬移
        const corr = Math.min(Math.max(c.depth - MERGE_PAD - SLOP, 0), MAX_CORR) * BAUMGARTE;
        if (corr > 0) {
          const invSum = a.invMass + b.invMass;
          const wa = a.invMass / invSum, wb = b.invMass / invSum;
          a.x -= nx * corr * wa; a.y -= ny * corr * wa;
          b.x += nx * corr * wb; b.y += ny * corr * wb;
          a.contacts++; b.contacts++;
          a.ballContacts++; b.ballContacts++;
          c.depth = depthAlong(c) + MERGE_PAD;   // 位置动了，穿透量跟着更新
        }

        // 接触点相对各自球心的力臂
        const rax = c.cx - a.x, ray = c.cy - a.y;
        const rbx = c.cx - b.x, rby = c.cy - b.y;
        // 接触点速度 = v + ω × r
        const avx = a.vx - a.av * ray, avy = a.vy + a.av * rax;
        const bvx = b.vx - b.av * rby, bvy = b.vy + b.av * rbx;
        const rvx = bvx - avx, rvy = bvy - avy;
        const vn = rvx * nx + rvy * ny;
        if (vn >= 0) continue;   // 已经在分开

        // 法向冲量：有效质量要把「力矩臂」算进去，偏心撞击才会转起来
        const ran = rax * ny - ray * nx, rbn = rbx * ny - rby * nx;
        const kn = a.invMass + b.invMass + a.invI * ran * ran + b.invI * rbn * rbn;
        const vnPreRaw = (b.pvx - a.pvx) * nx + (b.pvy - a.pvy) * ny;
        const e = (first && -vnPreRaw > REST_THRESHOLD) ? RESTITUTION : 0;
        const j = -(1 + e) * vn / kn;
        if (j <= 0) continue;
        const jnx = j * nx, jny = j * ny;
        a.vx -= jnx * a.invMass; a.vy -= jny * a.invMass;
        a.av -= a.invI * (rax * jny - ray * jnx);
        b.vx += jnx * b.invMass; b.vy += jny * b.invMass;
        b.av += b.invI * (rbx * jny - rby * jnx);

        // 切向摩擦：校徽之间互相「搓」，这就是自转的主要来源
        const tx = -ny, ty = nx;
        const rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
        const kt = a.invMass + b.invMass + a.invI * rat * rat + b.invI * rbt * rbt;
        const vt = (b.vx - b.av * rby - (a.vx - a.av * ray)) * tx +
                   (b.vy + b.av * rbx - (a.vy + a.av * rax)) * ty;
        const jt = clamp(-vt / kt, -j * MU, j * MU);
        const jtx = jt * tx, jty = jt * ty;
        a.vx -= jtx * a.invMass; a.vy -= jty * a.invMass;
        a.av -= a.invI * (rax * jty - ray * jtx);
        b.vx += jtx * b.invMass; b.vy += jty * b.invMass;
        b.av += b.invI * (rbx * jty - rby * jtx);
      }
    }

    // ---- 4. 收尾：夹回场地内 + 限速总闸 + 静置阻尼 ----
    for (let i = 0; i < balls.length; i++) {
      const b = balls[i];
      if (b.dead) continue;
      b.x = clamp(b.x, WALL - b.extLeft, W - WALL - b.extRight);
      b.y = Math.min(b.y, H - WALL - b.extBottom);
      if (b.y + b.extTop < 0) b.y = -b.extTop;

      // 速度总闸：任何情况下都不许超过 MAX_SPEED（≈25px/帧），彻底杜绝乱飞
      const sp2 = b.vx * b.vx + b.vy * b.vy;
      if (sp2 > MAX_SPEED * MAX_SPEED) {
        const k = MAX_SPEED / Math.sqrt(sp2);
        b.vx *= k; b.vy *= k;
      }
      // 只在校徽互相接触、而且速度已经很小时才继续衰减（消掉堆叠的微抖）。
      // 单靠地面支撑的球不受这条影响 —— 地面是光滑的，会一直滑到底。
      if (b.ballContacts > 0 && sp2 < SLEEP_SPEED * SLEEP_SPEED) {
        b.vx *= SLEEP_DAMP; b.vy *= SLEEP_DAMP;
      }
      // 自转阻尼：只要碰到东西就慢慢停下来，不会一直原地打转
      if (b.contacts > 0) b.av *= ANG_CONTACT_DAMP;
      if (!b.landed) {
        if (b.contacts > 0 || performance.now() - b.bornAt > 900) b.landed = true;
      }
    }

    if (merges.length) processMerges(merges);
  }

  function processMerges(merges) {
    for (let k = 0; k < merges.length; k++) {
      const a = merges[k][0], b = merges[k][1];
      if (a.dead || b.dead) continue; // 已被处理或无效
      a.dead = true; b.dead = true;
      const mx = (a.x + b.x) * 0.5;
      const my = (a.y + b.y) * 0.5;
      const tier = a.tier;

      if (tier >= MAX_TIER) {
        addScore(MAX_BONUS, mx, my, "+" + MAX_BONUS);
        burst(mx, my, MAX_TIER, 46, 560);
        burst(mx, my, MAX_TIER - 2, 22, 340);
        Sound.bonus();
        state.flash = 0.5;
        state.freeze = FREEZE_MS / 1000;
        state.floats.push({ x: mx, y: my - 74, text: "两个" + SCHOOLS[MAX_TIER].name + " 💥", life: 1.6 });
        state.revives++;
        paintRevives(true);
      } else {
        const nt = tier + 1;
        // 合成后的新校徽继承两颗的姿态：角度取平均，角速度取一部分，
        // 这样视觉上是「转着合在一起」，不会突然摆正。
        const na = (a.angle + b.angle) * 0.5;
        const nav = (a.av + b.av) * 0.25;
        const nb = makeBall(mx, my, nt, (a.vx + b.vx) * 0.5, (a.vy + b.vy) * 0.5 - 60, na, nav);
        nb.x = clamp(nb.x, WALL - nb.extLeft, W - WALL - nb.extRight);
        nb.y = Math.min(nb.y, H - WALL - nb.extBottom);
        if (nb.y + nb.extTop < 0) nb.y = -nb.extTop;
        nb.px = nb.x; nb.py = nb.y;
        nb.landed = true;
        nb.popAt = performance.now();
        state.balls.push(nb);
        addScore(MERGE_SCORE[nt], mx, my, "+" + MERGE_SCORE[nt]);
        burst(mx, my, nt, 8 + nt * 2, 140 + nt * 22);
        Sound.merge(nt);
        if (nt === MAX_TIER) state.flash = 0.35;
      }
      a.dead = true; b.dead = true;
    }

    state.balls = state.balls.filter(b => !b.dead);
  }

  // ---------------------------------------------------------
  //  投放 & 交互
  // ---------------------------------------------------------
  // 投放口是否净空：只要还有校徽挡在即将落下的那颗的出生位置上，就不能投。
  // 这一条是「闪现」的直接解药 —— 重叠出生会被约束一趟弹开，看起来就是瞬移。
  function spawnAreaClear() {
    const t = state.currentTier;
    const rNew = RADII[t];
    const top = DROP_Y - rNew;                 // 新生校徽占据的竖直范围
    const bottom = DROP_Y + rNew + DROP_CLEAR_GAP;
    for (let i = 0; i < state.balls.length; i++) {
      const b = state.balls[i];
      if (b.dead) continue;
      if (b.y + b.extBottom < top || b.y + b.extTop > bottom) continue;  // 高度不重叠
      const half = b.boundR * b.r + rNew;
      if (Math.abs(b.x - state.aimX) < half) return false;               // 横向也撞上了
    }
    return true;
  }

  // 冷却进度：0 = 可以投，1 = 刚投完（完全冷却中）
  // 用 state.dropCooldown 而不是常量，方便运行时调：控制台里
  // __MERGE_UNIV__.state.dropCooldown = 800 就能把冷却改成 800ms。
  function dropCooling() {
    const since = performance.now() - state.lastDropAt;
    const cd = state.dropCooldown;
    return since >= cd ? 0 : 1 - since / cd;
  }

  function dropCurrent() {
    if (!state.holding || state.gameOver) return;
    const now = performance.now();
    // 闸一：硬性冷却，连点 / 连按空格都只能按这个频率出
    if (now - state.lastDropAt < state.dropCooldown) return;
    // 闸二：投放口净空；堵太久则强制放行，不然会完全按不动
    if (!spawnAreaClear() && now - state.lastDropAt < DROP_MAX_WAIT) return;
    state.lastDropAt = now;

    const b = makeBall(state.aimX, DROP_Y, state.currentTier, 0, 0);
    state.balls.push(b);
    Sound.drop();
    state.currentTier = state.nextTier;
    state.nextTier = pickSpawnTier(state.currentTier);
    state.holding = true;
    drawNext();
  }

  function clearAboveDanger() {
    state.balls = state.balls.filter(b => b.y + b.extTop >= DANGER_Y + 12);
    state.particles = [];
    state.dangerTime = 0;
  }

  function askRevive() {
    if (state.reviveAsk) return;
    state.reviveAsk = true;
    reviveScoreEl.textContent = state.score;
    reviveLeftEl.textContent = "还剩 " + state.revives + " 枚";
    revivePrompt.hidden = false;
    overPanel.hidden = true;
    overlay.hidden = false;
  }

  function doRevive() {
    if (state.revives <= 0) return;
    state.revives--;
    paintRevives(false);
    clearAboveDanger();
    state.reviveAsk = false;
    overlay.hidden = true;
  }

  function gameOver() {
    if (state.gameOver) return;
    state.gameOver = true;
    state.holding = false;
    Sound.over();
    overlay.hidden = false;
    revivePrompt.hidden = true;
    overPanel.hidden = false;
  }

  // ---------------------------------------------------------
  //  渲染
  // ---------------------------------------------------------
  function drawBall(ctx, b) {
    const img = images[b.tier];
    if (!img || !img.complete) return;
    // 素材里轮廓等效直径占画布直径的 ASSET_FILL；
    // 把画布放大到逻辑直径 2r/ASSET_FILL，轮廓就正好等于 2r。
    const s = (b.r * 2) / ASSET_FILL;
    if (b.angle) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.angle);
      ctx.drawImage(img, -s / 2, -s / 2, s, s);
      ctx.restore();
    } else {
      ctx.drawImage(img, b.x - s / 2, b.y - s / 2, s, s);
    }
  }

  function render(ts) {
    const now = performance.now();
    const dt = Math.min(0.033, (state.lastTs ? (now - state.lastTs) / 1000 : 0.016));
    state.lastTs = now;

    if (!state.gameOver && !state.reviveAsk && !state.picking) {
      const freeze = state.freeze > 0;
      if (freeze) state.freeze = Math.max(0, state.freeze - dt);
      else {
        stepPhysics(dt);

        // 越线判定（取复合圆最上点）
        let danger = false;
        for (let i = 0; i < state.balls.length; i++) {
          const b = state.balls[i];
          if (!b.landed) continue;
          const v2 = b.vx * b.vx + b.vy * b.vy;
          if (b.y + b.extTop < DANGER_Y && v2 < REST_SPEED * REST_SPEED) {
            danger = true; break;
          }
        }
        if (danger) state.dangerTime += dt;
        else state.dangerTime = Math.max(0, state.dangerTime - dt * 0.5);

        if (state.dangerTime >= OVER_LIMIT) {
          if (state.revives > 0) askRevive();
          else gameOver();
        }
      }

      // 粒子
      for (let i = state.particles.length - 1; i >= 0; i--) {
        const p = state.particles[i];
        p.vy += GRAVITY * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.life -= p.decay * dt;
        if (p.life <= 0) state.particles.splice(i, 1);
      }

      // 飘字
      for (let i = state.floats.length - 1; i >= 0; i--) {
        const f = state.floats[i];
        f.y -= 30 * dt;
        f.life -= dt;
        if (f.life <= 0) state.floats.splice(i, 1);
      }

      if (state.flash > 0) state.flash = Math.max(0, state.flash - dt * 1.8);
    }

    // ---- 绘制 ----
    const cssW = W * viewScale;      // 画布的逻辑尺寸（CSS 像素）
    const cssH = H * viewScale;
    ctx.clearRect(0, 0, cssW, cssH);

    // 警戒线
    const scale = viewScale;
    ctx.save();
    ctx.scale(scale, scale);

    ctx.beginPath();
    ctx.moveTo(WALL, DANGER_Y);
    ctx.lineTo(W - WALL, DANGER_Y);
    ctx.strokeStyle = state.dangerTime > 0 ? "rgba(231,76,60," + (0.4 + 0.4 * Math.min(1, state.dangerTime)) + ")" : "rgba(231,76,60,0.35)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.stroke();
    ctx.setLineDash([]);

    // 球
    for (let i = 0; i < state.balls.length; i++) drawBall(ctx, state.balls[i]);

    // 调试：把底层碰撞多边形描出来，用来核对是否与校徽轮廓重合
    if (window.DEBUG_SHAPE) {
      ctx.strokeStyle = "rgba(255,0,0,0.9)";
      ctx.lineWidth = 1.5;
      for (let i = 0; i < state.balls.length; i++) {
        const b = state.balls[i];
        for (let k = 0; k < b.blocks.length; k++) {
          const B = b.blocks[k];
          ctx.beginPath();
          for (let v = 0; v < B.n; v++) {
            const x = b.x + (B.vx[v] * b.ca - B.vy[v] * b.sa) * b.r;
            const y = b.y + (B.vx[v] * b.sa + B.vy[v] * b.ca) * b.r;
            if (v === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }
    }

    // 当前待投放
    if (state.holding && !state.gameOver && !state.reviveAsk && !state.picking) {
      const cool = dropCooling();            // 1 = 刚投完（完全冷却中），0 = 可投
      const pr = getPreview(state.currentTier, state.aimX, DROP_Y);

      // 瞄准虚线（冷却时淡一点）
      ctx.globalAlpha = 1 - cool * 0.6;
      ctx.beginPath();
      ctx.moveTo(state.aimX, DROP_Y - RADII[state.currentTier]);
      ctx.lineTo(state.aimX, DANGER_Y);
      ctx.strokeStyle = "rgba(100,80,60,0.25)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      // 校徽本体：冷却中半透明，表示「还没准备好」
      ctx.globalAlpha = 0.35 + 0.65 * (1 - cool);
      drawBall(ctx, pr);
      ctx.globalAlpha = 1;

      // 冷却进度环：转满一圈才能再投一颗，让「限流」看得见
      if (cool > 0) {
        const ringR = RADII[state.currentTier] + 9;
        ctx.beginPath();
        ctx.arc(state.aimX, DROP_Y, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(120,96,72,0.18)";
        ctx.lineWidth = 3.5;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(state.aimX, DROP_Y, ringR, -Math.PI / 2, -Math.PI / 2 + (1 - cool) * Math.PI * 2);
        ctx.strokeStyle = "rgba(214,146,42,0.9)";
        ctx.lineWidth = 3.5;
        ctx.lineCap = "round";
        ctx.stroke();
      }
    }

    // 粒子
    for (const p of state.particles) {
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 飘字
    for (const f of state.floats) {
      ctx.globalAlpha = Math.max(0, f.life);
      ctx.font = (f.big ? "bold 26px" : "bold 18px") + " system-ui, Microsoft YaHei, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "#4a3325";
      ctx.fillText(f.text, f.x, f.y);
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // 全屏闪
    if (state.flash > 0) {
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255," + state.flash + ")";
      ctx.fillRect(0, 0, cssW, cssH);
      ctx.restore();
    }

    requestAnimationFrame(render);
  }

  function drawNext() {
    const c = nextCtx;
    const w = nextCanvas.width, h = nextCanvas.height;
    c.clearRect(0, 0, w, h);
    const img = images[state.currentTier];
    if (!img || !img.complete) return;
    const s = Math.min(w, h) * 0.86;
    c.drawImage(img, (w - s) / 2, (h - s) / 2, s, s);
  }

  function drawChain() {
    chainEl.innerHTML = SCHOOLS.map(s =>
      '<div class="school-chain-item" role="listitem" title="' + escapeHtml(s.name) + '">' +
      '<img src="' + ((window.BADGES985 || {})[s.id] || "") + '" alt="">' +
      '<span>' + escapeHtml(s.name) + '</span></div>'
    ).join("");
  }

  // ---------------------------------------------------------
  //  Canvas 尺寸 & 事件
  // ---------------------------------------------------------
  function resizeCanvas() {
    fitScale();
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // 缓冲区按「屏幕上真实的 CSS 尺寸 × dpr」分配，缩放后依然清晰；
    // 显示尺寸交给 CSS（#game 是 100%/100%），不要再写 canvas.style.width，
    // 否则会被 .app 的 transform 再放大一次，画面就撑出棋盘了。
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 逻辑尺寸 → 游戏坐标(420×700)的比例。
    // 注意不能用 canvas.width（物理像素）来算：ctx 已经套了 dpr 变换，
    // 再乘一次会把画面放大 dpr 倍，高分屏上就只看到左上角一块。
    viewScale = rect.width / W;
  }

  /* 桌面端整体等比缩放：保证窗口再矮再小也能看到完整界面。
     窄屏（≤860px）交给 CSS 的手机布局，不做缩放。 */
  const DESIGN_W = 740;   // 棋盘 420 + 间隙 20 + 面板 300
  const DESIGN_H = 700;
  const appEl = document.querySelector(".app");

  function fitScale() {
    if (!appEl) return;
    if (window.innerWidth <= 860) { appEl.style.transform = ""; return; }
    const pad = 24;
    const s = Math.min((window.innerWidth - pad) / DESIGN_W,
                       (window.innerHeight - pad) / DESIGN_H);
    appEl.style.transform = "translate(-50%, -50%) scale(" + (s > 0 ? s.toFixed(4) : 0.1) + ")";
  }

  function pointerToX(e) {
    const rect = canvas.getBoundingClientRect();
    const scale = W / rect.width;
    return (e.clientX - rect.left) * scale;
  }

  function bindInput() {
    window.addEventListener("resize", resizeCanvas);

    stage.addEventListener("pointermove", e => {
      e.preventDefault();
      if (!state.started || state.gameOver || state.picking) return;
      state.aimX = clamp(pointerToX(e), WALL + RADII[state.currentTier], W - WALL - RADII[state.currentTier]);
    });

    stage.addEventListener("pointerdown", e => {
      e.preventDefault();
      if (!state.started || state.gameOver || state.picking) return;
      state.aimX = clamp(pointerToX(e), WALL + RADII[state.currentTier], W - WALL - RADII[state.currentTier]);
    });

    stage.addEventListener("pointerup", e => {
      e.preventDefault();
      if (!state.started || state.picking) return;
      dropCurrent();
    });

    window.addEventListener("keydown", e => {
      if (state.picking) {
        if (e.key === "Enter") { e.preventDefault(); closePickerAndStart(); }
        return;
      }
      if (e.key === "r" || e.key === "R") { restartWithPicker(); return; }
      if (!state.started || state.gameOver) return;
      const step = 12;
      if (e.key === "ArrowLeft") state.aimX = Math.max(WALL + RADII[state.currentTier], state.aimX - step);
      if (e.key === "ArrowRight") state.aimX = Math.min(W - WALL - RADII[state.currentTier], state.aimX + step);
      if (e.code === "Space") { e.preventDefault(); dropCurrent(); }
    });

    document.getElementById("resetBtn").addEventListener("click", restartWithPicker);
    document.getElementById("restartBtn").addEventListener("click", restartWithPicker);
    pickerStart.addEventListener("click", closePickerAndStart);
    pickerRandom.addEventListener("click", () => {
      const ids = POOL.map(s => s.id);
      selectSchool(ids[Math.floor(Math.random() * ids.length)]);
    });
    document.getElementById("giveUpBtn").addEventListener("click", () => {
      state.reviveAsk = false;
      gameOver();
    });
    document.getElementById("reviveBtn").addEventListener("click", doRevive);
    document.getElementById("soundBtn").addEventListener("click", () => {
      Sound.muted = !Sound.muted;
      localStorage.setItem(MUTE_KEY, Sound.muted ? "1" : "0");
      updateSoundBtn();
    });
  }

  // ---------------------------------------------------------
  //  启动
  // ---------------------------------------------------------
  async function init() {
    resizeCanvas();
    await loadAllImages();
    Sound.ensure();  // 提前创建 AudioContext，避免第一次投放时触发一次性的创建卡顿
    bindInput();
    state.started = true;
    openPicker();    // 先让用户选择学校，再 applyRoster + reset
    requestAnimationFrame(render);
    // SCHOOLS / images 每局都会随选择重建，用 getter 暴露，避免拿到旧引用
    window.__MERGE_UNIV__ = {
      state, reset, dropCurrent, stepPhysics, makeBall, satBlocks, satOut,
      buildRoster, applyRoster,
      get SCHOOLS() { return SCHOOLS; },
      get images() { return images; }
    };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
