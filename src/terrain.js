import * as THREE from 'three';

// ── Ruido procedural (value noise + fBm) ──────────────────────────────────────
const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const smooth = (t) => t * t * (3 - 2 * t);
const wrap = (v, p) => ((v % p) + p) % p;

// Value noise bilineal. Con `period`, envuelve las esquinas → tileable.
function valueNoise(x, y, period = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi,        yf = y - yi;
  const x0 = period ? wrap(xi,     period) : xi;
  const x1 = period ? wrap(xi + 1, period) : xi + 1;
  const y0 = period ? wrap(yi,     period) : yi;
  const y1 = period ? wrap(yi + 1, period) : yi + 1;
  const a = hash(x0, y0), b = hash(x1, y0), c = hash(x0, y1), d = hash(x1, y1);
  const ux = smooth(xf), uy = smooth(yf);
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(a, b, ux),
    THREE.MathUtils.lerp(c, d, ux),
    uy
  );
}

// fBm: octavas con frecuencia ×2 y amplitud ×0.5. Con `period` → tileable.
function fbm(x, y, octaves = 5, period = 0) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum  += amp * valueNoise(x * freq, y * freq, period ? period * freq : 0);
    norm += amp;
    amp  *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ── Textura del suelo: casco metálico de estación espacial ────────────────────
function buildGroundTexture() {
  const texSize = 512;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = texSize;
  const ctx = cnv.getContext('2d');
  const img = ctx.createImageData(texSize, texSize);

  const metalDark  = [0x10, 0x16, 0x26];
  const metalA     = [0x1a, 0x24, 0x3c];
  const metalB     = [0x27, 0x35, 0x56];
  const metalLight = [0x37, 0x4a, 0x72];
  const CELLS = 8, GRAIN_CELLS = 32;

  for (let py = 0; py < texSize; py++) {
    for (let px = 0; px < texSize; px++) {
      const n = fbm(px / texSize * CELLS, py / texSize * CELLS, 5, CELLS);
      const grain = valueNoise(px / texSize * GRAIN_CELLS, py / texSize * GRAIN_CELLS, GRAIN_CELLS) * 0.16;
      let t = THREE.MathUtils.clamp(n + grain - 0.09, 0, 1);
      t = Math.round(t * 4) / 4;            // cel bands
      const col = t < 0.25 ? metalDark : t < 0.5 ? metalA : t < 0.75 ? metalB : metalLight;
      const i = (py * texSize + px) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Rejilla de paneles (costuras cian tenues, tileables)
  const PANELS = 8, step = texSize / PANELS;
  ctx.strokeStyle = 'rgba(60, 200, 255, 0.16)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= PANELS; i++) {
    const p = Math.round(i * step) + 0.5;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, texSize); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(texSize, p); ctx.stroke();
  }
  // Acentos: algunos paneles con borde brillante (cian o cobre)
  for (let gy = 0; gy < PANELS; gy++) {
    for (let gx = 0; gx < PANELS; gx++) {
      const h = valueNoise(gx + 0.5, gy + 0.5, PANELS);
      if (h > 0.82) {
        ctx.strokeStyle = h > 0.91 ? 'rgba(255, 150, 60, 0.55)' : 'rgba(60, 220, 255, 0.5)';
        ctx.lineWidth = 2;
        const m = 5;
        ctx.strokeRect(gx * step + m, gy * step + m, step - 2 * m, step - 2 * m);
      }
    }
  }

  const tex = new THREE.CanvasTexture(cnv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// Crea el suelo (relieve fBm + textura) y devuelve el sampler de altura.
export function createTerrain(scene) {
  const groundTex = buildGroundTexture();
  const groundGeo = new THREE.PlaneGeometry(100, 100, 200, 200);
  const groundMat = new THREE.MeshToonMaterial({ map: groundTex });

  // Relieve — misma fórmula que el muestreo de altura (sin desfases).
  const terrainDisp = (lx, ly) => {
    const big    = Math.sin(lx * 0.12) * Math.cos(ly * 0.12) * 0.35;
    const detail = (fbm(lx * 0.15 + 50, ly * 0.15 + 50, 5) - 0.5) * 0.9;
    return big + detail;
  };
  // El plano se rota -90° en X → coord local Y = -Z mundo.
  const groundY = (worldX, worldZ) => terrainDisp(worldX, -worldZ);

  const pos = groundGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setZ(i, terrainDisp(pos.getX(i), pos.getY(i)));
  }
  pos.needsUpdate = true;
  groundGeo.computeVertexNormals();

  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  return { groundY, mesh: ground };
}
