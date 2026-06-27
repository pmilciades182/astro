import * as THREE from 'three';

// Sistema de chispas (Points aditivos) para el fogonazo del disparo. Pool
// circular reutilizable; cada chispa se desvanece atenuando su color (con
// blending aditivo, ir a negro = desaparecer).
export function createSparks(scene, max = 400) {
  // Textura radial suave (chispa redonda brillante)
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = 64;
  const cx = cnv.getContext('2d');
  const g = cx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,190,90,1)');
  g.addColorStop(1.0, 'rgba(255,120,0,0)');
  cx.fillStyle = g;
  cx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(cnv);

  const positions = new Float32Array(max * 3);
  const colors    = new Float32Array(max * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.6, map: tex, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  const vel     = new Float32Array(max * 3);
  const life    = new Float32Array(max);
  const maxLife = new Float32Array(max);
  let cursor = 0;
  const BASE = [1.0, 0.55, 0.14];   // naranja

  // Estallido de `count` chispas en `p`, sesgadas hacia `dir`
  function burst(p, dir, count = 16) {
    for (let i = 0; i < count; i++) {
      const idx = cursor; cursor = (cursor + 1) % max;
      const j = idx * 3;
      positions[j] = p.x; positions[j + 1] = p.y; positions[j + 2] = p.z;
      const spread = 7;
      vel[j]     = dir.x * 7 + (Math.random() - 0.5) * spread;
      vel[j + 1] = (Math.random() - 0.15) * 4;
      vel[j + 2] = dir.z * 7 + (Math.random() - 0.5) * spread;
      const lf = 0.22 + Math.random() * 0.25;
      life[idx] = lf; maxLife[idx] = lf;
      colors[j] = BASE[0]; colors[j + 1] = BASE[1]; colors[j + 2] = BASE[2];
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  function update(dt) {
    let dirty = false;
    for (let idx = 0; idx < max; idx++) {
      if (life[idx] <= 0) continue;
      dirty = true;
      const j = idx * 3;
      life[idx] -= dt;
      const t = Math.max(life[idx] / maxLife[idx], 0);
      positions[j]     += vel[j] * dt;
      positions[j + 1] += vel[j + 1] * dt;
      positions[j + 2] += vel[j + 2] * dt;
      vel[j] *= 0.88;
      vel[j + 1] = vel[j + 1] * 0.88 - 7 * dt;   // amortiguación + leve gravedad
      vel[j + 2] *= 0.88;
      colors[j] = BASE[0] * t; colors[j + 1] = BASE[1] * t; colors[j + 2] = BASE[2] * t;
    }
    if (dirty) {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    }
  }

  return { burst, update };
}
