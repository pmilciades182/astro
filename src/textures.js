import * as THREE from 'three';

// Generadores de texturas procedurales (canvas) para los muros + carteles.
// Paleta espacial: acero azul oscuro con acentos cian/cobre.

function makeCanvas(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}
function toTexture(c, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

// ── Patrón 1: paneles metálicos con remaches ──────────────────────────────────
function panelTexture() {
  const S = 256, c = makeCanvas(S), x = c.getContext('2d');
  x.fillStyle = '#283655'; x.fillRect(0, 0, S, S);
  // grandes paneles (2x2) con bisel
  const half = S / 2;
  for (let gy = 0; gy < 2; gy++) for (let gx = 0; gx < 2; gx++) {
    x.fillStyle = (gx + gy) % 2 ? '#2c3b5d' : '#243150';
    x.fillRect(gx * half + 3, gy * half + 3, half - 6, half - 6);
    // bisel claro arriba/izq
    x.strokeStyle = 'rgba(120,160,220,0.25)'; x.lineWidth = 2;
    x.strokeRect(gx * half + 4, gy * half + 4, half - 8, half - 8);
  }
  // costuras
  x.strokeStyle = '#161f36'; x.lineWidth = 4;
  x.strokeRect(2, 2, S - 4, S - 4);
  x.beginPath(); x.moveTo(half, 0); x.lineTo(half, S); x.moveTo(0, half); x.lineTo(S, half); x.stroke();
  // remaches
  x.fillStyle = '#10182c';
  const rivets = [12, half - 12, half + 12, S - 12];
  for (const ry of rivets) for (const rx of rivets) {
    x.beginPath(); x.arc(rx, ry, 3, 0, Math.PI * 2); x.fill();
  }
  return toTexture(c, 1);
}

// ── Patrón 2: costillas verticales ────────────────────────────────────────────
function ribTexture() {
  const S = 256, c = makeCanvas(S), x = c.getContext('2d');
  x.fillStyle = '#22305250'.slice(0, 7); x.fillStyle = '#223052'; x.fillRect(0, 0, S, S);
  const ribs = 8, w = S / ribs;
  for (let i = 0; i < ribs; i++) {
    x.fillStyle = i % 2 ? '#2e4068' : '#26345a';
    x.fillRect(i * w + 2, 0, w - 4, S);
    x.fillStyle = 'rgba(120,170,230,0.18)';     // brillo lateral
    x.fillRect(i * w + 2, 0, 3, S);
    x.fillStyle = 'rgba(8,12,24,0.55)';          // sombra lateral
    x.fillRect(i * w + w - 5, 0, 3, S);
  }
  return toTexture(c, 1);
}

// ── Patrón 3: variante de paneles — rejilla 3x3 con remaches en esquinas ──────
function gridPanelTexture() {
  const S = 256, c = makeCanvas(S), x = c.getContext('2d');
  x.fillStyle = '#25334f'; x.fillRect(0, 0, S, S);
  const N = 3, cell = S / N;
  for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
    // placa con leve variación de tono
    x.fillStyle = (gx + gy) % 2 ? '#293a5c' : '#223049';
    x.fillRect(gx * cell + 3, gy * cell + 3, cell - 6, cell - 6);
    // bisel claro arriba/izq
    x.strokeStyle = 'rgba(125,170,235,0.22)'; x.lineWidth = 2;
    x.beginPath();
    x.moveTo(gx * cell + 4, gy * cell + cell - 4);
    x.lineTo(gx * cell + 4, gy * cell + 4);
    x.lineTo(gx * cell + cell - 4, gy * cell + 4); x.stroke();
    // sombra abajo/der
    x.strokeStyle = 'rgba(6,10,22,0.5)';
    x.beginPath();
    x.moveTo(gx * cell + cell - 4, gy * cell + 4);
    x.lineTo(gx * cell + cell - 4, gy * cell + cell - 4);
    x.lineTo(gx * cell + 4, gy * cell + cell - 4); x.stroke();
  }
  // costuras de la rejilla
  x.strokeStyle = '#141d33'; x.lineWidth = 3;
  for (let i = 1; i < N; i++) {
    x.beginPath(); x.moveTo(i * cell, 0); x.lineTo(i * cell, S);
    x.moveTo(0, i * cell); x.lineTo(S, i * cell); x.stroke();
  }
  x.strokeRect(2, 2, S - 4, S - 4);
  // remaches en las esquinas de cada celda
  x.fillStyle = '#0e1528';
  for (let gy = 0; gy <= N; gy++) for (let gx = 0; gx <= N; gx++) {
    const px = Math.min(Math.max(gx * cell, 8), S - 8);
    const py = Math.min(Math.max(gy * cell, 8), S - 8);
    x.beginPath(); x.arc(px, py, 3, 0, Math.PI * 2); x.fill();
  }
  return toTexture(c, 1);
}

// Conjunto de texturas de muro (el dungeon elige una por mapa para variar)
export function makeWallTextures() {
  return [panelTexture(), ribTexture(), gridPanelTexture()];
}

// ── Textura de metal opaco con desgaste (para remates, ductos y cables) ───────
export function makeMetalTexture() {
  const S = 256, c = makeCanvas(S), x = c.getContext('2d');
  // base de acero
  x.fillStyle = '#2a2f3a'; x.fillRect(0, 0, S, S);
  // cepillado horizontal (líneas finas claras/oscuras)
  for (let i = 0; i < 220; i++) {
    const y = Math.random() * S;
    x.strokeStyle = Math.random() < 0.5
      ? 'rgba(180,195,215,0.05)' : 'rgba(8,10,16,0.06)';
    x.lineWidth = Math.random() < 0.85 ? 1 : 2;
    x.beginPath(); x.moveTo(0, y); x.lineTo(S, y); x.stroke();
  }
  // grano / suciedad (puntitos)
  for (let i = 0; i < 2600; i++) {
    const px = Math.random() * S, py = Math.random() * S;
    const d = Math.random();
    x.fillStyle = d < 0.5 ? 'rgba(0,0,0,0.12)' : 'rgba(170,185,205,0.07)';
    x.fillRect(px, py, 1, 1);
  }
  // manchas de óxido/desgaste (cobre apagado)
  for (let k = 0; k < 14; k++) {
    const px = Math.random() * S, py = Math.random() * S, rad = 8 + Math.random() * 26;
    const g = x.createRadialGradient(px, py, 0, px, py, rad);
    const tone = Math.random() < 0.6 ? '120,78,42' : '90,96,108';
    g.addColorStop(0, `rgba(${tone},0.32)`);
    g.addColorStop(1, `rgba(${tone},0)`);
    x.fillStyle = g; x.beginPath(); x.arc(px, py, rad, 0, Math.PI * 2); x.fill();
  }
  // rayones diagonales
  for (let i = 0; i < 26; i++) {
    const px = Math.random() * S, py = Math.random() * S, len = 6 + Math.random() * 30;
    const a = (Math.random() - 0.5) * 1.2;
    x.strokeStyle = 'rgba(20,24,32,0.4)'; x.lineWidth = 1;
    x.beginPath(); x.moveTo(px, py);
    x.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); x.stroke();
  }
  return toTexture(c, 2);
}

// ── Carteles con mensajes espaciales (opacos) ─────────────────────────────────
const SIGN_MESSAGES = [
  'SECTOR 7', 'O₂ ESTABLE', 'PELIGRO', 'ZONA DE CARGA', 'REACTOR',
  'CUARENTENA', 'BAHÍA 12', 'NO ENTRAR', 'ESTACIÓN K-9', 'SALIDA',
  'NIVEL -3', 'PRESIÓN OK', 'ZONA RESTRINGIDA', 'AIRLOCK',
];
const _signCache = new Map();

export function getSignTexture(message) {
  if (_signCache.has(message)) return _signCache.get(message);
  const W = 256, H = 128, c = makeCanvas();
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  // fondo opaco
  x.fillStyle = '#0b1124'; x.fillRect(0, 0, W, H);
  // marco
  x.strokeStyle = '#2cc6ff'; x.lineWidth = 5;
  if (x.roundRect) { x.beginPath(); x.roundRect(6, 6, W - 12, H - 12, 10); x.stroke(); }
  else x.strokeRect(6, 6, W - 12, H - 12);
  // barra superior de "estado" (puntos)
  for (let i = 0; i < 4; i++) {
    x.fillStyle = i === 0 ? '#ff8a2e' : '#2cc6ff';
    x.beginPath(); x.arc(24 + i * 16, 24, 4, 0, Math.PI * 2); x.fill();
  }
  // texto con glow
  x.font = '700 30px Orbitron, "Arial Black", sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = '#2cc6ff'; x.shadowBlur = 12;
  x.fillStyle = '#dff2ff';
  x.fillText(message, W / 2, H / 2 + 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  _signCache.set(message, t);
  return t;
}

export function randomSignMessage() {
  return SIGN_MESSAGES[(Math.random() * SIGN_MESSAGES.length) | 0];
}
