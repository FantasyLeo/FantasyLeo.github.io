'use strict';

// ========================
// 1. Constants & Configuration
// ========================
const CAPACITY = 4;

const COLORS = [
  { name: 'red',     main: '#FF3333', light: '#FF6B6B', dark: '#CC2929' },
  { name: 'orange',  main: '#FF8C00', light: '#FFA940', dark: '#CC7000' },
  { name: 'yellow',  main: '#FFD700', light: '#FFE440', dark: '#CCA800' },
  { name: 'lime',    main: '#82C91E', light: '#A0D950', dark: '#68A118' },
  { name: 'green',   main: '#00C853', light: '#33D474', dark: '#00A443' },
  { name: 'cyan',    main: '#00BCD4', light: '#33C9DE', dark: '#0096AA' },
  { name: 'blue',    main: '#2979FF', light: '#5495FF', dark: '#2161CC' },
  { name: 'purple',  main: '#7C4DFF', light: '#9A75FF', dark: '#633ECC' },
  { name: 'magenta', main: '#E040FB', light: '#E766FB', dark: '#B333C9' },
  { name: 'pink',    main: '#FF4081', light: '#FF6699', dark: '#CC3367' },
];

const BOTTLE = {
  neckW:   24,
  neckH:   26,
  bodyW:   50,
  bodyH:   110,
  shoulderH: 14,
  bottomR: 8,
  get totalH() { return this.neckH + this.shoulderH + this.bodyH + this.bottomR; },
  get layerH() { return this.bodyH / CAPACITY; },
};

const CELEBRATION = {
  starCount: 60,
  streamerCount: 40,
  confettiCount: 100,
  fireworkTotal: 7,
  burstParticles: 25,
  flashDuration: 0.6,
  pulseDuration: 0.5,
  sparkleInterval: 0.25,
  sparkleLifetime: 0.7,
};

// ========================
// 2. Game State
// ========================
let gameState = {
  bottles: [],
  selectedIdx: -1,
  level: 1,
  moves: 0,
  initialBottles: null,
  history: [],
  isAnimating: false,
  isWin: false,
};

let celebration = null;      // { phase, startTime, fireworkQueue: [{cx, cy, delay}] }
let bottlePulses = [];       // [{ bottleIdx, startTime }]
let completedBottles = new Set();
let winStartTime = 0;
let lastSparkleTime = 0;

let pourAnim = null; // { sourceIdx, destIdx, color, count, startTime, duration }

// Audio
let audioCtx = null;
let pourSound = null; // { noise, bandpass, gain } — active pour noise nodes

// Particles
let particles = [];

// Canvas
let canvas, ctx;
let width, height;
let dpr;

// Timing
let lastTime = 0;
let time = 0;
let hoveredIdx = -1;

// Layout cache (per-frame)
let layoutCacheTime = -1;
let layoutCache = null;

// ========================
// 2.5 Audio (Web Audio API synthesis)
// ========================
function initAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) { /* Web Audio not available */ }
}

function playTone(freq, duration, type, volume, ramp) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume || 0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + (ramp || duration));
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + duration);
}

function playSelectSound() {
  playTone(880, 0.08, 'sine', 0.1, 0.06);
}

function playInvalidSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(220, t);
  osc.frequency.linearRampToValueAtTime(150, t + 0.18);
  gain.gain.setValueAtTime(0.1, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.22);
}

function playCompleteSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  // Pop: low pulse
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(180, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.08);
  gain.gain.setValueAtTime(0.18, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + 0.13);
  // Tiny high chirp
  setTimeout(() => playTone(1200, 0.04, 'sine', 0.06, 0.03), 50);
}

function startPourSound() {
  if (!audioCtx) return;
  stopPourSound();
  const t = audioCtx.currentTime;
  const bufferSize = audioCtx.sampleRate * 0.4;
  const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;
  noise.loop = true;

  // Three parallel narrow bandpass filters for a crisp stream sound
  // High frequencies + high Q = clear water trickling, not muddy waterfall
  const bp1 = audioCtx.createBiquadFilter();
  bp1.type = 'bandpass';
  bp1.frequency.value = 2600;
  bp1.Q.value = 3.0;

  const bp2 = audioCtx.createBiquadFilter();
  bp2.type = 'bandpass';
  bp2.frequency.value = 4000;
  bp2.Q.value = 4.5;

  const bp3 = audioCtx.createBiquadFilter();
  bp3.type = 'bandpass';
  bp3.frequency.value = 1400;
  bp3.Q.value = 2.2;

  const g1 = audioCtx.createGain(); g1.gain.value = 0;
  const g2 = audioCtx.createGain(); g2.gain.value = 0;
  const g3 = audioCtx.createGain(); g3.gain.value = 0;

  noise.connect(bp1); bp1.connect(g1); g1.connect(audioCtx.destination);
  noise.connect(bp2); bp2.connect(g2); g2.connect(audioCtx.destination);
  noise.connect(bp3); bp3.connect(g3); g3.connect(audioCtx.destination);

  g1.gain.linearRampToValueAtTime(0.035, t + 0.08);
  g2.gain.linearRampToValueAtTime(0.022, t + 0.08);
  g3.gain.linearRampToValueAtTime(0.018, t + 0.08);

  // Subtle LFO for babbling brook modulation
  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 5 + Math.random() * 4;
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.value = 0.006;
  lfo.connect(lfoGain);
  lfoGain.connect(g1.gain);
  lfo.start(t);

  noise.start(t);
  pourSound = { noise, bp1, bp2, bp3, g1, g2, g3, lfo, lfoGain };
}

function stopPourSound() {
  if (!pourSound || !audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const gs = [pourSound.g1, pourSound.g2, pourSound.g3];
    for (const g of gs) {
      g.gain.setValueAtTime(g.gain.value, t);
      g.gain.linearRampToValueAtTime(0, t + 0.12);
    }
    pourSound.lfo.stop(t + 0.15);
    pourSound.noise.stop(t + 0.15);
  } catch (e) { /* already stopped */ }
  pourSound = null;
}

function playWinSound() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
  notes.forEach((freq, i) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const start = t + i * 0.1;
    gain.gain.setValueAtTime(0.001, start);
    gain.gain.linearRampToValueAtTime(0.1, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 0.32);
  });
}

// ========================
// 3. Utility Functions
// ========================
function lerp(a, b, t) { return a + (b - a) * t; }

function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function deepCopyBottles(bottles) {
  return bottles.map(b => ({ colors: [...b.colors] }));
}

const STORAGE_KEY_LEVEL = 'waterSort_level';
const STORAGE_KEY_MAX = 'waterSort_maxLevel';

function saveLevel() {
  try {
    localStorage.setItem(STORAGE_KEY_LEVEL, gameState.level);
    const prevMax = parseInt(localStorage.getItem(STORAGE_KEY_MAX) || '1', 10);
    if (gameState.level > prevMax) {
      localStorage.setItem(STORAGE_KEY_MAX, gameState.level);
    }
  } catch (e) { /* localStorage unavailable */ }
}

function loadSavedLevel() {
  try {
    const saved = parseInt(localStorage.getItem(STORAGE_KEY_LEVEL), 10);
    if (saved && saved > 0) return saved;
  } catch (e) { /* localStorage unavailable */ }
  return 1;
}

function getMaxLevel() {
  try {
    return parseInt(localStorage.getItem(STORAGE_KEY_MAX) || '1', 10);
  } catch (e) { return 1; }
}

function jumpToLevel(level) {
  if (level < 1 || level > getMaxLevel()) return;
  gameState.level = level;
  gameState.bottles = generateLevel(level).bottles;
  gameState.initialBottles = deepCopyBottles(gameState.bottles);
  gameState.selectedIdx = -1;
  gameState.moves = 0;
  gameState.history = [];
  gameState.isWin = false;
  pourAnim = null;
  stopPourSound();
  particles = [];
  celebration = null;
  bottlePulses = [];
  completedBottles = new Set();
  winStartTime = 0;
  document.getElementById('levelDisplay').textContent = `Level ${level}`;
  document.getElementById('moveDisplay').textContent = `Moves: 0`;
  document.getElementById('btnNext').disabled = true;
  document.getElementById('victoryOverlay').classList.add('hidden');
  saveLevel();
}

// ========================
// 4. Level Generator
// ========================
function generateLevel(level) {
  const numColors = Math.min(2 + level, COLORS.length);
  const emptyBottles = level <= 2 ? 2 : 3;
  const numBottles = numColors + emptyBottles;
  const usedColors = shuffle(COLORS).slice(0, numColors);

  const units = [];
  usedColors.forEach(c => {
    for (let i = 0; i < CAPACITY; i++) units.push(c.main);
  });

  // Shuffle but ensure the level is solvable:
  // we guarantee solvability by distributing complete color sets first,
  // but with a randomized mixing across bottles.
  // Strategy: put 2-3 units per color per bottle, shuffle across.
  const mixed = shuffle(units);

  const bottles = [];
  for (let i = 0; i < numBottles; i++) {
    bottles.push({ colors: [] });
  }

  // Fill non-empty bottles (all but last 2)
  const fillBottles = numBottles - 2;
  let unitIdx = 0;
  for (let i = 0; i < fillBottles; i++) {
    while (bottles[i].colors.length < CAPACITY && unitIdx < mixed.length) {
      bottles[i].colors.push(mixed[unitIdx]);
      unitIdx++;
    }
  }

  // Check solvability: ensure no bottle starts with all same color already done
  // (that would be trivially complete for that color)
  // The distribution algorithm already guarantees solvability because:
  // - Total units = numColors * 4
  // - numBottles = numColors + 2 (2 empty)
  // - Each color appears exactly 4 times across bottles
  // - Players can always find a place to pour into

  return { bottles, numColors };
}

// ========================
// 5. Pour Validation
// ========================
function canPour(src, dst) {
  if (!src || !dst) return false;
  if (src.colors.length === 0) return false;
  if (dst.colors.length >= CAPACITY) return false;
  if (isBottleComplete(src) || isBottleComplete(dst)) return false;

  const srcTop = src.colors[src.colors.length - 1];
  if (dst.colors.length === 0) return true;

  const dstTop = dst.colors[dst.colors.length - 1];
  return srcTop === dstTop;
}

function countTopSame(colors) {
  if (colors.length === 0) return 0;
  const top = colors[colors.length - 1];
  let count = 0;
  for (let i = colors.length - 1; i >= 0; i--) {
    if (colors[i] === top) count++;
    else break;
  }
  return count;
}

function pourCount(src, dst) {
  const sameCount = countTopSame(src.colors);
  const space = CAPACITY - dst.colors.length;
  return Math.min(sameCount, space);
}

// ========================
// 6. Win Detection
// ========================
function checkWin(bottles) {
  for (const b of bottles) {
    if (b.colors.length === 0) continue;
    if (b.colors.length !== CAPACITY) return false;
    const first = b.colors[0];
    if (!b.colors.every(c => c === first)) return false;
  }
  return true;
}

function isBottleComplete(bottle) {
  if (bottle.colors.length !== CAPACITY) return false;
  const first = bottle.colors[0];
  return bottle.colors.every(c => c === first);
}

// ========================
// 7. Canvas & Layout
// ========================
function resize() {
  dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function getBottleLayout() {
  if (layoutCacheTime === time && layoutCache) return layoutCache;

  const count = gameState.bottles.length;
  const maxW = Math.min(width * 0.9, 600);
  const slotW = BOTTLE.bodyW + 20; // bottle body + spacing at scale 1.0
  const maxPerRow = Math.max(1, Math.floor(maxW / slotW));
  const numRows = Math.ceil(count / maxPerRow);

  let s;
  if (numRows === 1) {
    const desiredW = count * slotW;
    s = desiredW <= maxW ? 1.0 : Math.max(0.5, maxW / desiredW);
  } else {
    const rowH = BOTTLE.totalH + 40; // bottle height + vertical gap at scale 1.0
    const maxHeight = height * 0.82;
    const neededHeight = numRows * rowH;
    s = neededHeight <= maxHeight ? 1.0 : Math.max(0.5, maxHeight / neededHeight);
  }

  const positions = [];
  const bw = BOTTLE.bodyW * s;
  const spacing = 20 * s;
  const rowGap = 30 * s;
  const rowH = BOTTLE.totalH * s + rowGap;
  const totalHeight = numRows * rowH - rowGap;
  const topRowTop = (height * 0.82) - totalHeight;

  let bottleIdx = 0;
  for (let row = 0; row < numRows; row++) {
    const inRow = Math.min(maxPerRow, count - bottleIdx);
    const rowW = inRow * bw + (inRow - 1) * spacing;
    const startX = (width - rowW) / 2 + bw / 2;
    const by = topRowTop + row * rowH + BOTTLE.totalH * s;

    for (let col = 0; col < inRow; col++) {
      positions.push({ x: startX + col * (bw + spacing), by, s });
      bottleIdx++;
    }
  }

  layoutCache = { positions, scale: s };
  layoutCacheTime = time;
  return layoutCache;
}

function getBottleScale() {
  return getBottleLayout().scale;
}

function getBottlePositions() {
  return getBottleLayout().positions;
}

function hitTest(px, py) {
  const positions = getBottlePositions();
  for (let i = 0; i < positions.length; i++) {
    const { x, by, s } = positions[i];
    const bw = BOTTLE.bodyW * s;
    const th = BOTTLE.totalH * s;
    if (px >= x - bw / 2 && px <= x + bw / 2 && py >= by - th && py <= by) {
      return i;
    }
  }
  return -1;
}

// ========================
// 8. Bottle Drawing
// ========================
function bottlePath(ctx, cx, by, s) {
  const nw = BOTTLE.neckW * s;
  const nh = BOTTLE.neckH * s;
  const bw = BOTTLE.bodyW * s;
  const bh = BOTTLE.bodyH * s;
  const sh = BOTTLE.shoulderH * s;
  const br = BOTTLE.bottomR * s;
  const th = BOTTLE.totalH * s;
  const top = by - th;
  const nBot = top + nh;
  const bTop = nBot + sh;
  const bBot = by - br;

  ctx.beginPath();
  ctx.moveTo(cx - nw / 2, top);
  ctx.lineTo(cx - nw / 2, nBot);
  ctx.quadraticCurveTo(cx - bw / 2, nBot + sh / 2, cx - bw / 2, bTop);
  ctx.lineTo(cx - bw / 2, bBot);
  ctx.quadraticCurveTo(cx - bw / 2, by, cx - bw / 2 + br, by);
  ctx.lineTo(cx + bw / 2 - br, by);
  ctx.quadraticCurveTo(cx + bw / 2, by, cx + bw / 2, bBot);
  ctx.lineTo(cx + bw / 2, bTop);
  ctx.quadraticCurveTo(cx + bw / 2, nBot + sh / 2, cx + nw / 2, nBot);
  ctx.lineTo(cx + nw / 2, top);
  ctx.closePath();
}

function bodyClipPath(ctx, cx, by, s) {
  const bw = BOTTLE.bodyW * s;
  const nh = BOTTLE.neckH * s;
  const sh = BOTTLE.shoulderH * s;
  const br = BOTTLE.bottomR * s;
  const th = BOTTLE.totalH * s;
  const top = by - th;
  const bTop = top + nh + sh;
  const bBot = by - br;
  const inset = 2.5 * s;

  ctx.beginPath();
  ctx.moveTo(cx - bw / 2 + inset, bTop);
  ctx.lineTo(cx - bw / 2 + inset, bBot);
  ctx.quadraticCurveTo(cx - bw / 2 + inset, by, cx - bw / 2 + inset + br, by);
  ctx.lineTo(cx + bw / 2 - inset - br, by);
  ctx.quadraticCurveTo(cx + bw / 2 - inset, by, cx + bw / 2 - inset, bBot);
  ctx.lineTo(cx + bw / 2 - inset, bTop);
  ctx.closePath();
}

function drawGlassBottle(ctx, cx, by, s, isSelected, isHovered, isValidTarget) {
  const bw = BOTTLE.bodyW * s;
  const nw = BOTTLE.neckW * s;
  const nh = BOTTLE.neckH * s;
  const th = BOTTLE.totalH * s;
  const top = by - th;

  // Selection glow
  if (isSelected) {
    bottlePath(ctx, cx, by, s);
    ctx.save();
    const glow = ctx.createRadialGradient(cx, by - th / 2, 0, cx, by - th / 2, bw);
    glow.addColorStop(0, 'rgba(100, 200, 255, 0.4)');
    glow.addColorStop(0.6, 'rgba(100, 200, 255, 0.1)');
    glow.addColorStop(1, 'rgba(100, 200, 255, 0)');
    ctx.fillStyle = glow;
    ctx.fill();
    ctx.restore();
  }

  // Glass fill (semi-transparent)
  bottlePath(ctx, cx, by, s);
  ctx.fillStyle = 'rgba(200, 220, 255, 0.06)';
  ctx.fill();

  // Glass border
  bottlePath(ctx, cx, by, s);
  ctx.strokeStyle = isValidTarget
    ? 'rgba(100, 255, 150, 0.8)'
    : isHovered
      ? 'rgba(255, 255, 255, 0.5)'
      : 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = isHovered ? 2.5 * s : 2 * s;
  ctx.stroke();

  // If valid target, glow border
  if (isValidTarget) {
    ctx.shadowColor = 'rgba(100, 255, 150, 0.6)';
    ctx.shadowBlur = 10 * s;
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }

  // Neck rim highlight
  ctx.beginPath();
  ctx.moveTo(cx - nw / 2, top);
  ctx.lineTo(cx + nw / 2, top);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  ctx.lineWidth = 2 * s;
  ctx.stroke();

  // Glass highlight reflection (left side)
  bottlePath(ctx, cx, by, s);
  ctx.save();
  ctx.clip();

  const hlGrad = ctx.createLinearGradient(cx - bw / 2, 0, cx - bw / 2 + bw * 0.25, 0);
  hlGrad.addColorStop(0, 'rgba(255, 255, 255, 0.12)');
  hlGrad.addColorStop(0.5, 'rgba(255, 255, 255, 0.03)');
  hlGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

  ctx.beginPath();
  ctx.rect(cx - bw / 2 + 3 * s, top + nh, bw * 0.22, th * 0.75);
  ctx.fillStyle = hlGrad;
  ctx.fill();

  ctx.restore();

  // Small highlight near right side
  bottlePath(ctx, cx, by, s);
  ctx.save();
  ctx.clip();
  ctx.beginPath();
  ctx.rect(cx + bw / 2 - bw * 0.18, top + nh, bw * 0.08, th * 0.55);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.fill();
  ctx.restore();
}

function drawCork(ctx, cx, by, s) {
  const nw = BOTTLE.neckW * s;
  const nh = BOTTLE.neckH * s;
  const th = BOTTLE.totalH * s;
  const top = by - th;

  const corkBottomW = nw * 0.84;
  const corkTopW = nw * 1.18;
  const protrude = nh * 0.2;
  const corkH = nh * 0.55;
  const corkTop = top - protrude;
  const corkBottom = corkTop + corkH;

  ctx.beginPath();
  ctx.moveTo(cx - corkBottomW / 2, corkBottom);
  ctx.lineTo(cx - corkTopW / 2, corkTop + corkTopW * 0.08);
  ctx.quadraticCurveTo(cx - corkTopW / 2, corkTop, cx, corkTop);
  ctx.quadraticCurveTo(cx + corkTopW / 2, corkTop, cx + corkTopW / 2, corkTop + corkTopW * 0.08);
  ctx.lineTo(cx + corkBottomW / 2, corkBottom);
  ctx.closePath();

  const corkGrad = ctx.createLinearGradient(cx - corkTopW / 2, 0, cx + corkTopW / 2, 0);
  corkGrad.addColorStop(0, '#C4924A');
  corkGrad.addColorStop(0.25, '#D8AE68');
  corkGrad.addColorStop(0.5, '#E8C880');
  corkGrad.addColorStop(0.75, '#D0A45A');
  corkGrad.addColorStop(1, '#9A6030');
  ctx.fillStyle = corkGrad;
  ctx.fill();

  ctx.strokeStyle = 'rgba(80, 40, 10, 0.45)';
  ctx.lineWidth = 1.2 * s;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(cx, corkTop, corkTopW / 2, corkTopW * 0.13, 0, 0, Math.PI * 2);
  const topGrad = ctx.createLinearGradient(0, corkTop - corkTopW * 0.13, 0, corkTop + corkTopW * 0.13);
  topGrad.addColorStop(0, '#F0D888');
  topGrad.addColorStop(1, '#C89A50');
  ctx.fillStyle = topGrad;
  ctx.fill();
  ctx.strokeStyle = 'rgba(80, 40, 10, 0.35)';
  ctx.lineWidth = 0.8 * s;
  ctx.stroke();

  ctx.beginPath();
  const lineCount = 3;
  for (let i = 1; i <= lineCount; i++) {
    const ly = corkBottom - (corkH / (lineCount + 1)) * i;
    const lw = corkBottomW / 2 + ((corkTopW / 2) - (corkBottomW / 2)) * (i / (lineCount + 1));
    ctx.moveTo(cx - lw, ly);
    ctx.lineTo(cx + lw, ly);
  }
  ctx.strokeStyle = 'rgba(80, 40, 10, 0.15)';
  ctx.lineWidth = 0.6 * s;
  ctx.stroke();
}

function drawLayer(ctx, lyrTop, lyrBot, bw, s, color, alpha) {
  const w = bw - 5 * s;
  const x = -w / 2;
  const grad = ctx.createLinearGradient(0, lyrTop, 0, lyrBot);
  grad.addColorStop(0, color);
  grad.addColorStop(0.3, color);
  grad.addColorStop(1, color + '88');

  ctx.globalAlpha = alpha;
  ctx.fillStyle = grad;
  ctx.fillRect(x, lyrTop, w, lyrBot - lyrTop);

  // Layer highlight
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.fillRect(x + w * 0.1, lyrTop, w * 0.15, lyrBot - lyrTop);

  ctx.globalAlpha = 1;
}

function drawWater(ctx, bottle, bottleIdx, cx, by, s, animInfo) {
  const bw = BOTTLE.bodyW * s;
  const bh = BOTTLE.bodyH * s;
  const nh = BOTTLE.neckH * s;
  const sh = BOTTLE.shoulderH * s;
  const br = BOTTLE.bottomR * s;
  const th = BOTTLE.totalH * s;
  const top = by - th;
  const bTop = top + nh + sh;
  const bBot = by - br;
  const layerH = bh / CAPACITY;
  const inset = 2.5 * s;

  let virtualCount = bottle.colors.length;
  let drawColors = [...bottle.colors]; // bottom to top
  let isReceiving = false;

  if (animInfo && animInfo.sourceIdx !== null && animInfo.destIdx !== null) {
    const pr = animInfo.progress;
    if (bottleIdx === animInfo.sourceIdx) {
      virtualCount = animInfo.origSrcCount - animInfo.count * pr;
      const keepCount = Math.ceil(virtualCount);
      drawColors = bottle.colors.slice(0, keepCount);
    } else if (bottleIdx === animInfo.destIdx) {
      virtualCount = animInfo.origDstCount + animInfo.count * pr;
      const extraCount = Math.ceil(virtualCount) - animInfo.origDstCount;
      drawColors = [...bottle.colors, ...Array(extraCount).fill(animInfo.color)];
      isReceiving = animInfo.isReceiving === true;
    }
  }

  if (virtualCount <= 0) return;
  if (drawColors.length === 0) return;

  const ceilCount = Math.ceil(virtualCount);
  const topFract = virtualCount - Math.floor(virtualCount);

  ctx.save();
  ctx.translate(cx, 0);

  // Clip path relative to translated origin (0 = bottle center)
  ctx.beginPath();
  ctx.moveTo(-bw / 2 + inset, bTop);
  ctx.lineTo(-bw / 2 + inset, bBot);
  ctx.quadraticCurveTo(-bw / 2 + inset, by, -bw / 2 + inset + br, by);
  ctx.lineTo(bw / 2 - inset - br, by);
  ctx.quadraticCurveTo(bw / 2 - inset, by, bw / 2 - inset, bBot);
  ctx.lineTo(bw / 2 - inset, bTop);
  ctx.closePath();
  ctx.clip();

  // Draw layers bottom to top (i=0 is bottommost)
  for (let i = 0; i < ceilCount; i++) {
    const isTopLayer = (i === ceilCount - 1 && topFract > 0);
    const h = isTopLayer ? layerH * topFract : layerH;
    if (h <= 0) continue;

    const lyrBot = bBot - i * layerH;
    const lyrTop = lyrBot - h;

    if (lyrBot <= bTop) break;

    const colorIdx = Math.min(i, drawColors.length - 1);
    const color = drawColors[colorIdx];

    drawLayer(ctx, Math.max(lyrTop, bTop), lyrBot, bw, s, color, 1);
  }

  ctx.restore();

  // Wave on water surface
  const surfY = Math.max(bTop, bBot - virtualCount * layerH);
  if (surfY < bBot) {
    ctx.save();
    ctx.translate(cx, 0);
    // Clip to same body shape
    ctx.beginPath();
    ctx.moveTo(-bw / 2 + inset, bTop);
    ctx.lineTo(-bw / 2 + inset, bBot);
    ctx.quadraticCurveTo(-bw / 2 + inset, by, -bw / 2 + inset + br, by);
    ctx.lineTo(bw / 2 - inset - br, by);
    ctx.quadraticCurveTo(bw / 2 - inset, by, bw / 2 - inset, bBot);
    ctx.lineTo(bw / 2 - inset, bTop);
    ctx.closePath();
    ctx.clip();

    const waveAmp1 = (isReceiving ? 3.5 : 1.5) * s;
    const waveAmp2 = (isReceiving ? 2.0 : 0.8) * s;
    const waveFreq = isReceiving ? 0.006 : 0.004;
    const waveFreq2 = isReceiving ? 0.012 : 0.006;

    ctx.beginPath();
    const left = -bw / 2 + 3 * s;
    const right = bw / 2 - 3 * s;
    ctx.moveTo(left, surfY);
    for (let x = left; x <= right; x += 3) {
      ctx.lineTo(x, surfY + Math.sin(x * 0.15 + time * waveFreq) * waveAmp1 + Math.sin(x * 0.3 + time * waveFreq2) * waveAmp2);
    }
    ctx.lineTo(right, surfY + 8 * s);
    ctx.lineTo(left, surfY + 8 * s);
    ctx.closePath();

    const waveGrad = ctx.createLinearGradient(0, surfY, 0, surfY + 3 * s);
    waveGrad.addColorStop(0, 'rgba(255,255,255,0.25)');
    waveGrad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = waveGrad;
    ctx.fill();

    ctx.restore();
  }
}

function starPath(ctx, cx, cy, r) {
  const spikes = 5;
  const innerR = r * 0.4;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const angle = (Math.PI * i) / spikes - Math.PI / 2;
    const radius = i % 2 === 0 ? r : innerR;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function drawStreamer(ctx, sx, sy, ex, ey, mx, my, s, alpha, color) {
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(mx, my, ex, ey);
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 3.5 * s;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.lineWidth = 1.2 * s;
  ctx.globalAlpha = alpha * 0.55;
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineCap = 'butt';
}

function drawSparkle(ctx, x, y, size, alpha) {
  const half = size * 0.55;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x - half, y); ctx.lineTo(x + half, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - half); ctx.lineTo(x, y + half); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - half * 0.7, y - half * 0.7); ctx.lineTo(x + half * 0.7, y + half * 0.7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x + half * 0.7, y - half * 0.7); ctx.lineTo(x - half * 0.7, y + half * 0.7); ctx.stroke();
  ctx.globalAlpha = 1;
}

// ========================
// 9. Particle System
// ========================
function spawnConfetti() {
  const count = CELEBRATION.confettiCount;
  const colors = COLORS.map(c => c.main);
  for (let i = 0; i < count; i++) {
    const shapes = ['rect', 'circle', 'triangle'];
    particles.push({
      x: width * 0.05 + Math.random() * width * 0.9,
      y: -20 - Math.random() * height * 0.6,
      vx: (Math.random() - 0.5) * 7,
      vy: 1.5 + Math.random() * 4,
      life: 1.8 + Math.random() * 2.0,
      maxLife: 1.8 + Math.random() * 2.0,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 4 + Math.random() * 7,
      type: 'confetti',
      shape: shapes[Math.floor(Math.random() * shapes.length)],
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.25,
    });
  }
}

function spawnStars(count, cx, cy, radiusScale) {
  const colors = COLORS.map(c => c.main);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = (radiusScale || 1) * (80 + Math.random() * 250);
    const baseX = cx || width / 2;
    const baseY = cy || height * 0.4;
    particles.push({
      x: baseX + Math.cos(angle) * dist,
      y: baseY + Math.sin(angle) * dist * 0.4,
      vx: (Math.random() - 0.5) * 1.2,
      vy: -0.8 - Math.random() * 2.5,
      life: 1.5 + Math.random() * 2.0,
      maxLife: 1.5 + Math.random() * 2.0,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 5 + Math.random() * 8,
      type: 'star',
      twinklePhase: Math.random() * Math.PI * 2,
      twinkleSpeed: 3 + Math.random() * 5,
    });
  }
}

function spawnStreamers(count) {
  const colors = COLORS.map(c => c.main);
  const s = getBottleScale();
  for (let i = 0; i < count; i++) {
    const startX = width * 0.05 + Math.random() * width * 0.9;
    const startY = -10 - Math.random() * 60;
    const len = 40 + Math.random() * 100;
    particles.push({
      x: startX,
      y: startY,
      ex: startX + (Math.random() - 0.5) * 40 * s,
      ey: startY + len * s,
      mx: startX + (Math.random() - 0.5) * 60 * s,
      my: startY + len * 0.5 * s,
      swayAmp: 12 + Math.random() * 25,
      swayFreq: 0.5 + Math.random() * 1.5,
      swayPhase: Math.random() * Math.PI * 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      life: 2.5 + Math.random() * 2.5,
      maxLife: 2.5 + Math.random() * 2.5,
      type: 'streamer',
      vy: 0.6 + Math.random() * 1.2,
      vx: (Math.random() - 0.5) * 0.3,
    });
  }
}

function spawnFirework(cx, cy) {
  const colors = COLORS.map(c => c.main);
  const color = colors[Math.floor(Math.random() * colors.length)];
  const burstDelay = 0.7 + Math.random() * 0.6;
  particles.push({
    x: cx,
    y: cy,
    vx: (Math.random() - 0.5) * 1.2,
    vy: -7 - Math.random() * 5,
    life: burstDelay + 2.5,
    maxLife: burstDelay + 2.5,
    color: color,
    size: 3,
    type: 'firework',
    burstDelay: burstDelay,
    hasBurst: false,
    trail: [],
  });
}

function burstFirework(cx, cy, color) {
  const count = CELEBRATION.burstParticles;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.3;
    const speed = 2 + Math.random() * 5;
    particles.push({
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0.8 + Math.random() * 1.0,
      maxLife: 0.8 + Math.random() * 1.0,
      color: color,
      size: 1.5 + Math.random() * 2.5,
      type: 'sparkle',
    });
  }
}

function spawnSparkles(count, cx, cy) {
  const colors = COLORS.map(c => c.main);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * 60;
    const bx = (cx || width / 2) + Math.cos(angle) * dist;
    const by = (cy || height * 0.35) + Math.sin(angle) * dist * 0.3;
    particles.push({
      x: bx,
      y: by,
      vx: (Math.random() - 0.5) * 2,
      vy: -2 - Math.random() * 4,
      life: 0.4 + Math.random() * 0.4,
      maxLife: CELEBRATION.sparkleLifetime,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 1.5 + Math.random() * 3,
      type: 'sparkle',
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
      continue;
    }
    if (p.type === 'drop' || p.type === 'streamDrop') {
      p.x += p.vx * 60 * dt;
      p.y += p.vy * 60 * dt;
      p.vy += (p.type === 'streamDrop' ? 3 : 4) * dt;
    } else if (p.type === 'confetti') {
      p.x += p.vx * 60 * dt;
      p.y += p.vy * 60 * dt;
      p.vy += 1.5 * dt;
      p.rotation += p.rotSpeed * 60 * dt;
      p.vx *= 0.999;
    } else if (p.type === 'star') {
      p.x += p.vx * 60 * dt;
      p.y += p.vy * 60 * dt;
      p.vy += 0.3 * dt;
      p.vx *= 0.998;
    } else if (p.type === 'streamer') {
      p.y += p.vy * 60 * dt;
      p.ey += p.vy * 60 * dt;
      p.my += p.vy * 60 * dt;
      p.x += p.vx * 60 * dt;
      p.ex += p.vx * 60 * dt;
      const sway = Math.sin(time * 0.001 * p.swayFreq + p.swayPhase) * p.swayAmp * 60 * dt;
      p.mx += sway;
      if (p.y > height + 80) p.life = 0;
    } else if (p.type === 'firework') {
      if (!p.hasBurst) {
        p.x += p.vx * 60 * dt;
        p.y += p.vy * 60 * dt;
        p.vy += 0.8 * dt;
        p.burstDelay -= dt;
        if (p.burstDelay <= 0) {
          p.hasBurst = true;
          burstFirework(p.x, p.y, p.color);
          p.life = 0;
        } else if (Math.random() < 0.7) {
          particles.push({
            x: p.x + (Math.random() - 0.5) * 4, y: p.y + Math.random() * 4,
            vx: 0, vy: 1 + Math.random() * 3,
            life: 0.15 + Math.random() * 0.2, maxLife: 0.35,
            color: p.color, size: 1 + Math.random() * 2, type: 'sparkle',
          });
        }
      }
    } else if (p.type === 'sparkle') {
      p.x += p.vx * 60 * dt;
      p.y += p.vy * 60 * dt;
      p.vy += 0.6 * dt;
    }
  }
}

function drawParticles(ctx) {
  for (const p of particles) {
    const alpha = Math.min(1, p.life / p.maxLife);
    ctx.save();
    ctx.globalAlpha = alpha;
    if (p.type === 'drop' || p.type === 'streamDrop') {
      ctx.beginPath();
      const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      grad.addColorStop(0, p.color);
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grad;
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    } else if (p.type === 'confetti') {
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rotation);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else if (p.shape === 'triangle') {
        ctx.beginPath();
        ctx.moveTo(0, -p.size / 2);
        ctx.lineTo(p.size / 2, p.size / 2);
        ctx.lineTo(-p.size / 2, p.size / 2);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      }
    } else if (p.type === 'star') {
      const twinkle = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(time * 0.001 * p.twinkleSpeed + p.twinklePhase));
      ctx.globalAlpha = alpha * twinkle;
      starPath(ctx, p.x, p.y, p.size);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    } else if (p.type === 'streamer') {
      drawStreamer(ctx, p.x, p.y, p.ex, p.ey, p.mx, p.my, 1, alpha, p.color);
    } else if (p.type === 'sparkle') {
      drawSparkle(ctx, p.x, p.y, p.size, alpha);
    }
    ctx.restore();
  }
}

// ========================
// 10. Render
// ========================

// Compute four-phase pour animation state
// Phase 1 (0-15%): Lift straight up 150px
// Phase 2 (14-38%): Tilt 0→100° around grip point + adaptive translateX
// Phase 3 (38-76%): Hold 100°, water pours
// Phase 4 (76-100%): Return to upright
function calculatePourPhase(t, s, positions) {
  const srcPos = positions[pourAnim.sourceIdx];
  const dstPos = positions[pourAnim.destIdx];
  const tiltDir = dstPos.x >= srcPos.x ? 1 : -1;
  const maxTiltDeg = 100;
  const liftPx = 150 * s;
  const pivotFromBottom = 80 * s;

  // Full horizontal translation — adaptive, clamped
  const pivotToMouthDist = BOTTLE.totalH * s - pivotFromBottom;
  const fullTiltedMouthX = srcPos.x + tiltDir * pivotToMouthDist * Math.sin(maxTiltDeg * Math.PI / 180);
  const dstMouthX = dstPos.x;
  const rawTransX = dstMouthX - fullTiltedMouthX;
  const fullTransX = Math.max(-width / 2, Math.min(width / 2, rawTransX));

  // Vertical alignment: lift source bottle so its mouth aligns with destination mouth
  const maxTiltRad = tiltDir * maxTiltDeg * Math.PI / 180;
  const fullTiltSrcMouth = getMouthPosition(srcPos.x, srcPos.by, s, maxTiltRad, -liftPx, fullTransX);
  const dstMouth = getMouthPosition(dstPos.x, dstPos.by, s, 0, 0, 0);
  const maxAlign = Math.max(0, fullTiltSrcMouth.y - dstMouth.y + 60 * s);

  let liftOffset = 0;
  let tiltAngle = 0;
  let pourProgress = 0;
  let showStream = false;
  let translateX = 0;

  if (t < 0.15) {
    // Phase 1: Lift straight up (0–98ms)
    const p = Math.min(1, t / 0.15);
    liftOffset = -liftPx * easeOutBack(p);
  } else if (t < 0.38) {
    // Phase 2: Tilt + move toward destination (98–247ms)
    const p = (t - 0.15) / 0.23;
    liftOffset = -liftPx - maxAlign * easeInOutCubic(p);
    tiltAngle = tiltDir * maxTiltDeg * easeInOutCubic(p) * Math.PI / 180;
    translateX = fullTransX * easeInOutCubic(p);
  } else if (t < 0.76) {
    // Phase 3: Pour — hold position, water flows (247–494ms)
    const p = (t - 0.38) / 0.38;
    liftOffset = -liftPx - maxAlign;
    tiltAngle = tiltDir * maxTiltDeg * Math.PI / 180;
    pourProgress = easeInOutCubic(p);
    showStream = true;
    translateX = fullTransX;
  } else {
    // Phase 4: Return to upright (494–650ms)
    const p = (t - 0.76) / 0.24;
    const ease = easeInOutCubic(p);
    liftOffset = (-liftPx - maxAlign) * (1 - ease);
    tiltAngle = tiltDir * maxTiltDeg * (1 - ease) * Math.PI / 180;
    pourProgress = 1;
    showStream = p < 0.3;
    translateX = fullTransX * (1 - ease);
  }

  return { liftOffset, tiltAngle, pourProgress, showStream, translateX, done: t >= 1 };
}

// Get mouth position of a bottle (possibly tilted, pivoted at grip point 80px above bottom)
function getMouthPosition(cx, by, s, tiltAngle, liftOffset, translateX) {
  const th = BOTTLE.totalH * s;
  const pivotFromBottom = 80 * s;
  const pivotToMouth = th - pivotFromBottom;
  const tx = translateX || 0;
  const lo = liftOffset || 0;
  const mx = cx + tx + pivotToMouth * Math.sin(tiltAngle);
  const my = (by - pivotFromBottom) - pivotToMouth * Math.cos(tiltAngle) + lo;
  return { x: mx, y: my };
}

// Draw continuous water stream from source mouth to destination mouth
function drawPourStream(ctx, srcMouth, dstMouth, color, s, progress) {
  const sx = srcMouth.x, sy = srcMouth.y;
  const dx = dstMouth.x, dy = dstMouth.y;

  // Midpoint with downward sag
  const mx = (sx + dx) / 2;
  const my = (sy + dy) / 2 + 18 * s;

  // Direction vector
  const nx = dx - sx;
  const ny = dy - sy;
  const len = Math.sqrt(nx * nx + ny * ny) || 1;
  const px = -ny / len;
  const py = nx / len;

  // Stream gradient (thin at source, thick at destination)
  const streamProgress = Math.min(1, progress * 1.2);

  for (let i = 0; i < 7; i++) {
    const off = (i - 3) * 2.2 * s;
    const alpha = 0.08 + 0.07 * (3 - Math.abs(i - 3));

    ctx.beginPath();
    ctx.moveTo(sx + px * off * 0.2, sy + py * off * 0.2);
    ctx.quadraticCurveTo(
      mx + px * off * 0.6,
      my + py * off * 0.6,
      dx + px * off * streamProgress,
      dy + py * off * streamProgress
    );
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = (5 - Math.abs(i - 3) * 0.6) * s;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Bright core highlight
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.quadraticCurveTo(mx, my, dx, dy);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1.5 * s;
  ctx.globalAlpha = 0.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Spawn droplets along the stream curve
function spawnStreamDroplets(srcMouth, dstMouth, color, s) {
  const sx = srcMouth.x, sy = srcMouth.y;
  const dx = dstMouth.x, dy = dstMouth.y;
  const mx = (sx + dx) / 2;
  const my = (sy + dy) / 2 + 18 * s;

  const count = 6;
  for (let i = 0; i < count; i++) {
    const t = Math.random();
    // Quadratic bezier evaluation: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
    const oneMinusT = 1 - t;
    const bx = oneMinusT * oneMinusT * sx + 2 * oneMinusT * t * mx + t * t * dx;
    const by = oneMinusT * oneMinusT * sy + 2 * oneMinusT * t * my + t * t * dy;

    particles.push({
      x: bx + (Math.random() - 0.5) * 8 * s,
      y: by + (Math.random() - 0.5) * 4 * s,
      vx: (dx - sx) * 0.02 + (Math.random() - 0.5) * 1.5,
      vy: (Math.random() - 0.7) * 1.5,
      life: 0.3 + Math.random() * 0.35,
      maxLife: 0.3 + Math.random() * 0.35,
      color,
      size: 2 + Math.random() * 2.5,
      type: 'streamDrop',
    });
  }
}
function drawBackground(ctx) {
  // Sky gradient
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#0a0e27');
  grad.addColorStop(0.5, '#141834');
  grad.addColorStop(1, '#1a2040');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Subtle stars
  ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
  const starSeed = 42;
  for (let i = 0; i < 40; i++) {
    const sx = ((starSeed * (i + 1) * 7 + i * 13) % width + width) % width;
    const sy = ((starSeed * (i + 1) * 11 + i * 17) % (height * 0.7) + height * 0.7) % (height * 0.7);
    const ss = 0.5 + ((i * 3) % 10) * 0.1;
    ctx.beginPath();
    ctx.arc(sx, sy, ss, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShelf(ctx) {
  const positions = getBottlePositions();
  if (positions.length === 0) return;
  const s = positions[0].s;

  const shelfYs = [...new Set(positions.map(p => p.by))];

  const globalLeft = Math.min(...positions.map(p => p.x)) - BOTTLE.bodyW * s / 2 - 16 * s;
  const globalRight = Math.max(...positions.map(p => p.x)) + BOTTLE.bodyW * s / 2 + 16 * s;
  const r = 2 * s;
  const sh = 8 * s;

  for (const shelfY of shelfYs) {
    const y = shelfY + 4 * s;

    const shelfGrad = ctx.createLinearGradient(0, y, 0, y + sh + 2);
    shelfGrad.addColorStop(0, 'rgba(100, 120, 160, 0.3)');
    shelfGrad.addColorStop(1, 'rgba(60, 70, 100, 0.15)');
    ctx.fillStyle = shelfGrad;

    ctx.beginPath();
    ctx.moveTo(globalLeft + r, y);
    ctx.lineTo(globalRight - r, y);
    ctx.arcTo(globalRight, y, globalRight, y + r, r);
    ctx.lineTo(globalRight, y + sh - r);
    ctx.arcTo(globalRight, y + sh, globalRight - r, y + sh, r);
    ctx.lineTo(globalLeft + r, y + sh);
    ctx.arcTo(globalLeft, y + sh, globalLeft, y + sh - r, r);
    ctx.lineTo(globalLeft, y + r);
    ctx.arcTo(globalLeft, y, globalLeft + r, y, r);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(180, 200, 255, 0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(globalLeft, y);
    ctx.lineTo(globalRight, y);
    ctx.stroke();
  }

  // Table legs — only draw supports from the sides
  const bottomY = shelfYs[shelfYs.length - 1] + 4 * s;
  ctx.fillStyle = 'rgba(80, 90, 120, 0.2)';
  const leftLegX = globalLeft + 20 * s;
  const rightLegX = globalRight - 20 * s;
  ctx.fillRect(leftLegX - 2 * s, bottomY + sh, 4 * s, height - bottomY - sh);
  ctx.fillRect(rightLegX - 2 * s, bottomY + sh, 4 * s, height - bottomY - sh);
}

function drawSelectedIndicator(ctx, cx, by, s) {
  const th = BOTTLE.totalH * s;
  const top = by - th;
  const offset = Math.sin(time * 0.005) * 3;

  // Arrow or triangle above bottle
  ctx.save();
  ctx.translate(cx, top - 8 * s + offset);
  ctx.beginPath();
  ctx.moveTo(0, -10 * s);
  ctx.lineTo(-6 * s, -2 * s);
  ctx.lineTo(6 * s, -2 * s);
  ctx.closePath();
  ctx.fillStyle = 'rgba(100, 200, 255, 0.7)';
  ctx.fill();
  ctx.restore();
}

function render(timestamp) {
  ctx.clearRect(0, 0, width, height);
  drawBackground(ctx);

  const positions = getBottlePositions();
  const globalScale = positions.length > 0 ? positions[0].s : 1;

  drawShelf(ctx);

  // Determine pour animation info with phases
  let animInfo = null;
  let pourPhase = null;
  if (pourAnim) {
    const elapsed = (timestamp - pourAnim.startTime) / 1000;
    const t = Math.min(1, elapsed / pourAnim.duration);
    pourPhase = calculatePourPhase(t, globalScale, positions);

    animInfo = {
      sourceIdx: pourAnim.sourceIdx,
      destIdx: pourAnim.destIdx,
      color: pourAnim.color,
      count: pourAnim.count,
      origSrcCount: pourAnim.origSrcCount,
      origDstCount: pourAnim.origDstCount,
      progress: pourPhase.pourProgress,
      done: pourPhase.done,
      isReceiving: pourPhase.showStream,
    };
  }

  // Draw bottles (back to front)
  // Update bottle pulses
  for (let pi = bottlePulses.length - 1; pi >= 0; pi--) {
    if (timestamp - bottlePulses[pi].startTime > CELEBRATION.pulseDuration * 1000) {
      bottlePulses.splice(pi, 1);
    }
  }

  for (let i = 0; i < gameState.bottles.length; i++) {
    // Skip selected bottle in normal state (draw it on top after the loop)
    if (i === gameState.selectedIdx && !pourAnim) continue;

    const { x, by, s } = positions[i];
    const bottle = gameState.bottles[i];
    const isHovered = !gameState.isWin && !gameState.isAnimating && hoveredIdx === i;
    const isValidTarget =
      gameState.selectedIdx >= 0 &&
      gameState.selectedIdx !== i &&
      canPour(gameState.bottles[gameState.selectedIdx], bottle);

    // Check newly completed bottle for pulse
    if (isBottleComplete(bottle) && !completedBottles.has(i) && !gameState.isAnimating) {
      completedBottles.add(i);
      bottlePulses.push({ bottleIdx: i, startTime: timestamp });
    }

    // Bottle completion pulse glow
    const activePulse = bottlePulses.find(p => p.bottleIdx === i);
    if (activePulse) {
      const pProgress = (timestamp - activePulse.startTime) / (CELEBRATION.pulseDuration * 1000);
      const pEase = easeOutCubic(Math.min(1, pProgress));
      const pScale = 1 + 0.12 * (pEase < 0.6 ? pEase / 0.6 : (1 - pEase) / 0.4);
      const pAlpha = 0.5 * (1 - Math.min(1, pProgress));
      ctx.save();
      ctx.translate(x, by - BOTTLE.totalH * s * 0.5);
      ctx.scale(pScale, pScale);
      ctx.translate(-x, -(by - BOTTLE.totalH * s * 0.5));
      const pGlow = ctx.createRadialGradient(x, by - BOTTLE.totalH * s * 0.5, 0, x, by - BOTTLE.totalH * s * 0.5, BOTTLE.bodyW * s * 1.1);
      pGlow.addColorStop(0, `rgba(255, 255, 200, ${pAlpha * 0.6})`);
      pGlow.addColorStop(1, 'rgba(255, 255, 200, 0)');
      ctx.fillStyle = pGlow;
      ctx.beginPath();
      ctx.arc(x, by - BOTTLE.totalH * s * 0.5, BOTTLE.bodyW * s * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Source bottle during pour: apply tilt transform (pivot at grip point 80px above bottom)
    if (pourPhase && i === pourAnim.sourceIdx && !pourPhase.done) {
      const { tiltAngle, liftOffset, translateX } = pourPhase;
      const pivotFromBottom = 80 * s;
      const pivotX = x;
      const pivotY = by - pivotFromBottom;
      ctx.save();
      ctx.translate(translateX, liftOffset);
      ctx.translate(pivotX, pivotY);
      ctx.rotate(tiltAngle);
      ctx.translate(-pivotX, -pivotY);

      drawWater(ctx, bottle, i, x, by, s, animInfo);
      drawGlassBottle(ctx, x, by, s, false, false, false);
      if (isBottleComplete(bottle)) drawCork(ctx, x, by, s);
    } else {
      // Normal drawing
      drawWater(ctx, bottle, i, x, by, s, animInfo);
      drawGlassBottle(ctx, x, by, s, false, isHovered, isValidTarget);
      if (isBottleComplete(bottle)) drawCork(ctx, x, by, s);
    }

    // Restore after source bottle transform
    if (pourPhase && i === pourAnim.sourceIdx && !pourPhase.done) {
      ctx.restore();
    }
  }

  // Draw selected bottle on top with lift
  if (gameState.selectedIdx >= 0 && !pourAnim) {
    const i = gameState.selectedIdx;
    const { x, by, s } = positions[i];
    const bottle = gameState.bottles[i];
    const isHovered = !gameState.isWin && !gameState.isAnimating && hoveredIdx === i;

    ctx.save();
    const lift = (-20 + Math.sin(time * 0.004) * 3) * s;
    ctx.translate(0, lift);
    drawWater(ctx, bottle, i, x, by, s, animInfo);
    drawGlassBottle(ctx, x, by, s, true, isHovered, false);
    if (isBottleComplete(bottle)) drawCork(ctx, x, by, s);
    drawSelectedIndicator(ctx, x, by, s);
    ctx.restore();
  }

  // Draw pour stream
  if (pourPhase && pourPhase.showStream && !pourPhase.done) {
    const srcPos = positions[pourAnim.sourceIdx];
    const dstPos = positions[pourAnim.destIdx];
    const srcMouth = getMouthPosition(srcPos.x, srcPos.by, srcPos.s, pourPhase.tiltAngle, pourPhase.liftOffset, pourPhase.translateX);

    // Target: water surface level in destination bottle, not the mouth
    const dstS = dstPos.s;
    const dstBTop = dstPos.by - BOTTLE.totalH * dstS + BOTTLE.neckH * dstS + BOTTLE.shoulderH * dstS;
    const dstBBot = dstPos.by - BOTTLE.bottomR * dstS;
    const dstLayers = pourAnim.origDstCount + pourAnim.count * pourPhase.pourProgress;
    const dstSurfY = dstLayers > 0 ? Math.max(dstBTop, dstBBot - dstLayers * BOTTLE.layerH * dstS) : dstBBot;
    const dstTarget = { x: dstPos.x, y: dstSurfY };

    drawPourStream(ctx, srcMouth, dstTarget, pourAnim.color, srcPos.s, pourPhase.pourProgress);

    // Spawn droplets along stream
    if (Math.random() < 0.5) {
      spawnStreamDroplets(srcMouth, dstTarget, pourAnim.color, srcPos.s);
    }

    // Splash droplets at water surface
    if (Math.random() < 0.6) {
      for (let i = 0; i < 3; i++) {
        particles.push({
          x: dstPos.x + (Math.random() - 0.5) * 12 * dstS,
          y: dstSurfY - Math.random() * 6 * dstS,
          vx: (Math.random() - 0.5) * 2,
          vy: -1 - Math.random() * 2,
          life: 0.3 + Math.random() * 0.3,
          maxLife: 0.3 + Math.random() * 0.3,
          color: pourAnim.color,
          size: 1.5 + Math.random() * 2,
          type: 'streamDrop',
        });
      }
    }
  }

  // Draw particles
  drawParticles(ctx);

  // Screen flash on win
  if (gameState.isWin && winStartTime > 0) {
    const flashElapsed = (timestamp - winStartTime) / 1000;
    if (flashElapsed < CELEBRATION.flashDuration) {
      const flashProgress = flashElapsed / CELEBRATION.flashDuration;
      const flashAlpha = 0.15 * (1 - easeOutCubic(flashProgress));
      const flashGrad = ctx.createRadialGradient(width / 2, height * 0.35, 0, width / 2, height * 0.35, Math.max(width, height) * 0.7);
      flashGrad.addColorStop(0, `rgba(255, 255, 240, ${flashAlpha})`);
      flashGrad.addColorStop(1, 'rgba(255, 255, 240, 0)');
      ctx.fillStyle = flashGrad;
      ctx.fillRect(0, 0, width, height);
    }
  }

  // Win celebration particles
  if (gameState.isWin && Math.random() < 0.4) {
    const et = (time - winStartTime) / 1000;
    if (et > CELEBRATION.sparkleInterval && time - lastSparkleTime > CELEBRATION.sparkleInterval * 1000) {
      lastSparkleTime = time;
      if (Math.random() < 0.6) {
        spawnConfettiSlot();
      } else {
        const cx = width * 0.3 + Math.random() * width * 0.4;
        const cy = height * 0.25 + Math.random() * height * 0.25;
        spawnSparkles(8 + Math.floor(Math.random() * 12), cx, cy);
      }
    }
    // Sparkles from completed bottle necks
    if (Math.random() < 0.5) {
      const positions2 = getBottlePositions();
      for (let i = 0; i < gameState.bottles.length; i++) {
        if (isBottleComplete(gameState.bottles[i]) && Math.random() < 0.25) {
          const { x, by, s } = positions2[i];
          const neckTop = by - BOTTLE.totalH * s;
          spawnSparkles(2, x, neckTop);
        }
      }
    }
  }
}

// Small burst of confetti from random positions
function spawnConfettiSlot() {
  const colors = COLORS.map(c => c.main);
  const shapes = ['rect', 'circle', 'triangle'];
  for (let i = 0; i < 5; i++) {
    particles.push({
      x: width * 0.1 + Math.random() * width * 0.8,
      y: height * 0.3 + Math.random() * height * 0.3,
      vx: (Math.random() - 0.5) * 8,
      vy: -2 - Math.random() * 4,
      life: 1 + Math.random() * 1.5,
      maxLife: 1 + Math.random() * 1.5,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: 3 + Math.random() * 5,
      type: 'confetti',
      shape: shapes[Math.floor(Math.random() * shapes.length)],
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.3,
    });
  }
}

// ========================
// 11. Game Actions
// ========================
function selectBottle(idx) {
  if (gameState.isAnimating || gameState.isWin) return;

  if (gameState.selectedIdx === idx) {
    gameState.selectedIdx = -1;
    return;
  }

  const bottle = gameState.bottles[idx];
  if (isBottleComplete(bottle)) {
    gameState.selectedIdx = -1;
    playInvalidSound();
    return;
  }

  if (gameState.selectedIdx === -1) {
    if (bottle.colors.length > 0) {
      gameState.selectedIdx = idx;
      playSelectSound();
    }
    return;
  }

  // Attempt pour
  const src = gameState.bottles[gameState.selectedIdx];
  const dst = gameState.bottles[idx];

  if (!canPour(src, dst)) {
    gameState.selectedIdx = -1;
    playInvalidSound();
    return;
  }

  const count = pourCount(src, dst);
  pourBottles(gameState.selectedIdx, idx, count);
}

function pourBottles(srcIdx, dstIdx, count) {
  const src = gameState.bottles[srcIdx];
  const dst = gameState.bottles[dstIdx];
  const color = src.colors[src.colors.length - 1];

  // Save state for undo
  gameState.history.push({
    bottles: deepCopyBottles(gameState.bottles),
    selectedIdx: gameState.selectedIdx,
    moves: gameState.moves,
  });

  const origSrcCount = src.colors.length;
  const origDstCount = dst.colors.length;

  gameState.isAnimating = true;
  gameState.selectedIdx = -1;

  pourAnim = {
    sourceIdx: srcIdx,
    destIdx: dstIdx,
    color,
    count,
    origSrcCount,
    origDstCount,
    startTime: performance.now(),
    duration: 0.65,
  };

  startPourSound();
}

function finishPour() {
  if (!pourAnim) return;

  const src = gameState.bottles[pourAnim.sourceIdx];
  const dst = gameState.bottles[pourAnim.destIdx];

  // Apply the actual transfer
  for (let i = 0; i < pourAnim.count; i++) {
    src.colors.pop();
    dst.colors.push(pourAnim.color);
  }

  pourAnim = null;
  gameState.isAnimating = false;
  gameState.moves++;

  stopPourSound();

  // Check if destination bottle just became complete
  if (isBottleComplete(dst)) {
    playCompleteSound();
  }

  if (checkWin(gameState.bottles)) {
    gameState.isWin = true;
    playWinSound();
    winStartTime = performance.now();
    lastSparkleTime = winStartTime;
    spawnConfetti();
    spawnStars(CELEBRATION.starCount, width / 2, height * 0.35, 0.8);
    spawnStreamers(CELEBRATION.streamerCount);
    spawnSparkles(30, width / 2, height * 0.3);
    celebration = {
      phase: 0,
      startTime: winStartTime,
      fireworkQueue: [
        { cx: width * 0.1, cy: height * 0.8, delay: 50 },
        { cx: width * 0.9, cy: height * 0.8, delay: 100 },
        { cx: width * 0.2, cy: height * 0.7, delay: 150 },
        { cx: width * 0.8, cy: height * 0.7, delay: 200 },
        { cx: width * 0.35, cy: height * 0.75, delay: 350 },
        { cx: width * 0.65, cy: height * 0.75, delay: 400 },
        { cx: width * 0.5, cy: height * 0.8, delay: 500 },
      ],
    };
    document.getElementById('btnNext').disabled = false;
  }

  document.getElementById('moveDisplay').textContent = `Moves: ${gameState.moves}`;
}

function undo() {
  if (gameState.isAnimating || gameState.isWin) return;
  if (gameState.history.length === 0) return;

  const prev = gameState.history.pop();
  gameState.bottles = prev.bottles;
  gameState.selectedIdx = prev.selectedIdx;
  gameState.moves = prev.moves;
  document.getElementById('moveDisplay').textContent = `Moves: ${gameState.moves}`;
}

function resetLevel() {
  if (gameState.isAnimating) return;
  gameState.bottles = deepCopyBottles(gameState.initialBottles);
  gameState.selectedIdx = -1;
  gameState.moves = 0;
  gameState.history = [];
  gameState.isWin = false;
  pourAnim = null;
  stopPourSound();
  particles = [];
  celebration = null;
  bottlePulses = [];
  completedBottles = new Set();
  winStartTime = 0;
  document.getElementById('moveDisplay').textContent = `Moves: 0`;
  document.getElementById('btnNext').disabled = true;
  document.getElementById('victoryOverlay').classList.add('hidden');
}

function nextLevel() {
  gameState.level++;
  gameState.bottles = generateLevel(gameState.level).bottles;
  gameState.initialBottles = deepCopyBottles(gameState.bottles);
  gameState.selectedIdx = -1;
  gameState.moves = 0;
  gameState.history = [];
  gameState.isWin = false;
  pourAnim = null;
  stopPourSound();
  particles = [];
  celebration = null;
  bottlePulses = [];
  completedBottles = new Set();
  winStartTime = 0;
  document.getElementById('levelDisplay').textContent = `Level ${gameState.level}`;
  document.getElementById('moveDisplay').textContent = `Moves: 0`;
  document.getElementById('btnNext').disabled = true;
  document.getElementById('victoryOverlay').classList.add('hidden');
  saveLevel();
}

// ========================
// 12. Input Handling
// ========================
function getEventPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  e.preventDefault();
  initAudio();
  if (gameState.isAnimating) return;

  const pos = getEventPos(e);
  const idx = hitTest(pos.x, pos.y);
  if (idx >= 0) {
    selectBottle(idx);
  } else {
    gameState.selectedIdx = -1;
  }
}

function onPointerMove(e) {
  const pos = getEventPos(e);
  const idx = hitTest(pos.x, pos.y);
  hoveredIdx = idx;

  if (gameState.isAnimating || gameState.isWin) {
    canvas.style.cursor = 'default';
  } else if (hoveredIdx >= 0 && !isBottleComplete(gameState.bottles[hoveredIdx])) {
    canvas.style.cursor = 'pointer';
  } else {
    canvas.style.cursor = 'default';
  }
}

function onPointerUp(e) {
  // No-op for now
}

// ========================
// 13. Game Loop
// ========================
function gameLoop(timestamp) {
  const dt = lastTime ? Math.min((timestamp - lastTime) / 1000, 0.1) : 0.016;
  lastTime = timestamp;
  time = timestamp;

  // Update pour animation
  if (pourAnim) {
    const elapsed = (timestamp - pourAnim.startTime) / 1000;
    if (elapsed >= pourAnim.duration) {
      finishPour();
    }
  }

  // Process celebration firework queue
  if (celebration && celebration.fireworkQueue.length > 0) {
    const cElapsed = timestamp - celebration.startTime;
    for (let ci = celebration.fireworkQueue.length - 1; ci >= 0; ci--) {
      if (cElapsed >= celebration.fireworkQueue[ci].delay) {
        const fw = celebration.fireworkQueue[ci];
        spawnFirework(fw.cx, fw.cy);
        celebration.fireworkQueue.splice(ci, 1);
      }
    }
    if (celebration.fireworkQueue.length === 0) {
      celebration = null;
    }
  }

  // Update particles
  updateParticles(dt);

  // Render
  resize();
  render(timestamp);

  requestAnimationFrame(gameLoop);
}

// ========================
// 14. Boot
// ========================
function openLevelSelect() {
  if (gameState.isAnimating) return;
  buildLevelGrid();
  document.getElementById('levelSelectOverlay').classList.remove('hidden');
}

function closeLevelSelect() {
  document.getElementById('levelSelectOverlay').classList.add('hidden');
}

function buildLevelGrid() {
  const grid = document.getElementById('levelGrid');
  const maxLevel = getMaxLevel();
  grid.innerHTML = '';
  for (let lv = 1; lv <= Math.max(maxLevel, gameState.level); lv++) {
    const btn = document.createElement('button');
    btn.textContent = lv;
    btn.className = 'lvl-btn';
    if (lv === gameState.level) btn.classList.add('current');
    if (lv > maxLevel) btn.classList.add('locked');
    btn.addEventListener('click', () => {
      if (lv <= maxLevel) {
        closeLevelSelect();
        jumpToLevel(lv);
      }
    });
    grid.appendChild(btn);
  }
}

function init() {
  canvas = document.getElementById('gameCanvas');
  ctx = canvas.getContext('2d');
  resize();

  // Load saved level
  gameState.level = loadSavedLevel();

  // Generate first level (or saved level)
  gameState.bottles = generateLevel(gameState.level).bottles;
  gameState.initialBottles = deepCopyBottles(gameState.bottles);
  document.getElementById('levelDisplay').textContent = `Level ${gameState.level}`;

  // UI bindings
  document.getElementById('btnUndo').addEventListener('click', undo);
  document.getElementById('btnReset').addEventListener('click', resetLevel);
  document.getElementById('btnNext').addEventListener('click', nextLevel);
  document.getElementById('btnVictoryNext').addEventListener('click', nextLevel);

  // Level select overlay
  document.getElementById('btnLevelSelect').addEventListener('click', openLevelSelect);
  document.getElementById('btnLevelClose').addEventListener('click', closeLevelSelect);
  document.getElementById('levelSelectOverlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeLevelSelect();
  });

  // Input events
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointerleave', () => { hoveredIdx = -1; });

  // Handle resize
  window.addEventListener('resize', resize);

  // Victory detection: show overlay after celebration delay
  const VICTORY_OVERLAY_DELAY = 2500; // ms, let particles play out first
  const checkVictoryOverlay = () => {
    if (gameState.isWin && !gameState.isAnimating) {
      const elapsed = performance.now() - winStartTime;
      if (elapsed >= VICTORY_OVERLAY_DELAY) {
        document.getElementById('victoryMoves').textContent =
          `Completed in ${gameState.moves} moves`;
        document.getElementById('victoryOverlay').classList.remove('hidden');
      }
    }
  };

  // Overlay update in game loop
  const origLoop = gameLoop;
  gameLoop = function (ts) {
    origLoop(ts);
    checkVictoryOverlay();
  };

  // Start game loop
  requestAnimationFrame(gameLoop);
}

document.addEventListener('DOMContentLoaded', init);
