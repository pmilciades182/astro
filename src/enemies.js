import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';

// Enemigos: reutilizan el modelo riggeado del personaje (Astronaut.glb) teñido
// por nivel, así caminan/idle con animaciones REALES. Cada enemigo es un clon
// con su propio AnimationMixer. Mueren de un solo disparo o golpe. Nivel 0–100
// según el nº de mapa (sube techo, piso y probabilidad de enemigos fuertes).

const TIERS = [
  { max: 25,  color: 0x3ad17a },  // verde
  { max: 50,  color: 0xe8d24a },  // amarillo
  { max: 75,  color: 0xff8a2e },  // naranja
  { max: 100, color: 0xff4d6d },  // rojo
];
const tierFor = (lvl) => TIERS.find((t) => lvl <= t.max) || TIERS[TIERS.length - 1];

function rollLevel(mapNumber) {
  const ceil  = Math.min(100, 5 + mapNumber * 7);
  const floor = Math.min(ceil, Math.max(0, mapNumber * 3 - 5));
  const strongChance = Math.min(0.9, 0.1 + mapNumber * 0.07);
  const frac = Math.random() < strongChance
    ? 0.6 + Math.random() * 0.4
    : Math.random();
  return Math.round(floor + (ceil - floor) * frac);
}

export function createEnemies(scene, world, opts = {}) {
  const { getGroundHeight, isWall } = world;
  const onKill = opts.onKill || null;

  const enemies = [];
  let template = null;            // escena del astronauta (para clonar)
  let idleClip = null, runClip = null;
  let pending = null;

  // Carga del modelo una sola vez; busca clips de idle y run por nombre.
  new GLTFLoader().load('/Astronaut.glb', (gltf) => {
    template = gltf.scene;
    const find = (kw) => gltf.animations.find((a) => a.name.toLowerCase().includes(kw));
    idleClip = find('idle') || gltf.animations[0];
    runClip  = find('run')  || find('walk') || idleClip;
    if (pending) { const p = pending; pending = null; populate(p.map, p.mapNumber); }
  }, undefined, (err) => console.error('Error cargando Astronaut.glb:', err));

  function addEnemy(x, z, level) {
    const model = cloneSkinned(template);     // clona malla + esqueleto
    model.scale.setScalar(1.5);               // mismo tamaño que el personaje

    // Teñido por nivel: color de tramo en el cuerpo + leve emisivo (glow oscuro)
    const tint = new THREE.Color(tierFor(level).color);
    const mats = [];
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.material = o.material.clone();
        o.material.color.copy(tint);
        if ('emissive' in o.material) {
          o.material.emissive = tint.clone().multiplyScalar(0.35);
          o.material.emissiveIntensity = 0.5 + (level / 100) * 0.6;
        }
        mats.push(o.material);
      }
    });

    const group = new THREE.Group();
    group.add(model);
    group.position.set(x, getGroundHeight(x, z), z);
    scene.add(group);

    // Mixer propio: arranca en idle
    const mixer = new THREE.AnimationMixer(model);
    const actions = {
      idle: mixer.clipAction(idleClip),
      run:  mixer.clipAction(runClip),
    };
    actions.idle.play();

    enemies.push({
      group, model, mats, mixer, actions, current: actions.idle,
      level, alive: true, radius: 1.0, speed: 2.2 + level * 0.02,
    });
  }

  function playState(e, name) {
    const next = e.actions[name];
    if (e.current === next) return;
    e.current?.fadeOut(0.2);
    next.reset().fadeIn(0.2).play();
    e.current = next;
  }

  function disposeEnemy(e) {
    e.mixer.stopAllAction();
    scene.remove(e.group);
    e.mats.forEach((m) => m.dispose());
  }

  function clear() {
    for (const e of enemies) disposeEnemy(e);
    enemies.length = 0;
  }

  function populate(map, mapNumber) {
    if (!template) { pending = { map, mapNumber }; return; }
    clear();
    const { grid, GW, GH, cellSize, originX, originZ } = map;
    const cellToWorld = (c, r) => [originX + (c + 0.5) * cellSize, originZ + (r + 0.5) * cellSize];
    const key = (c, r) => r * GW + c;

    const banned = new Set();
    const ban = (c, r) => { if (c >= 0 && c < GW && r >= 0 && r < GH) banned.add(key(c, r)); };
    for (const ch of map.chests) {
      const [c, r] = ch.cell;
      ban(c, r); ban(c + 1, r); ban(c - 1, r); ban(c, r + 1); ban(c, r - 1);
    }
    { const [cc, cr] = map.challenge.cell;
      for (let r = cr - 1; r <= cr + 1; r++) for (let c = cc - 1; c <= cc + 1; c++) ban(c, r); }
    { const [c, r] = map.exit.cell; ban(c, r); }

    const aC = Math.floor((map.spawn.x - originX) / cellSize);
    const aR = Math.floor((map.spawn.z - originZ) / cellSize);
    const A_SAFE = 3;

    const cands = [];
    for (let r = 1; r < GH - 1; r++) {
      for (let c = 1; c < GW - 1; c++) {
        if (grid[r][c] !== 0) continue;
        if (banned.has(key(c, r))) continue;
        if (Math.abs(c - aC) + Math.abs(r - aR) < A_SAFE) continue;
        cands.push([c, r]);
      }
    }
    for (let i = cands.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [cands[i], cands[j]] = [cands[j], cands[i]];
    }

    if (!cands.length) return;
    // ×20 enemigos para un ritmo frenético (tope alto por rendimiento). Se reparten
    // por las celdas de pasillo con repetición + dispersión dentro de cada celda.
    const count = Math.min(500, (6 + Math.floor(mapNumber * 1.5)) * 20);
    for (let i = 0; i < count; i++) {
      const [c, r] = cands[(Math.random() * cands.length) | 0];
      const [cx, cz] = cellToWorld(c, r);
      const x = cx + (Math.random() - 0.5) * cellSize * 0.6;
      const z = cz + (Math.random() - 0.5) * cellSize * 0.6;
      addEnemy(x, z, rollLevel(mapNumber));
    }
  }

  function kill(e) {
    e.alive = false;
    disposeEnemy(e);
    onKill?.(e.group.position.clone(), e.level);
  }

  // Colisión contra muros con radio (4 esquinas) — como el jugador.
  const ECR = 0.7;   // radio de colisión del enemigo
  const wallBlocked = (x, z) =>
    isWall(x - ECR, z - ECR) || isWall(x + ECR, z - ECR) ||
    isWall(x - ECR, z + ECR) || isWall(x + ECR, z + ECR);

  // Persecución + colisión con muros y entre enemigos (separación). Reparto en
  // buckets espaciales para que la separación sea ~O(n) aun con cientos.
  const SEPR = 1.5;            // distancia mínima entre centros de enemigos
  const _buckets = new Map();
  function update(dt, player) {
    const px = player.mesh.position.x, pz = player.mesh.position.z;
    const AGGRO = 16, STOP = 1.4;

    // 1) Movimiento de persecución (colisión con muros por eje)
    for (const e of enemies) {
      if (!e.alive) continue;
      const ex = e.group.position.x, ez = e.group.position.z;
      const dx = px - ex, dz = pz - ez, d = Math.hypot(dx, dz);
      let moving = false;
      if (d < AGGRO && d > STOP) {
        const step = e.speed * dt, ux = dx / d, uz = dz / d;
        const nx = ex + ux * step, nz = ez + uz * step;
        if (!wallBlocked(nx, e.group.position.z)) { e.group.position.x = nx; moving = true; }
        if (!wallBlocked(e.group.position.x, nz)) { e.group.position.z = nz; moving = true; }
      }
      if (d < AGGRO) e.group.rotation.y = Math.atan2(dx, dz);   // encara al jugador
      e.moving = moving;
    }

    // 2) Separación entre enemigos (buckets espaciales + colisión con muros)
    _buckets.clear();
    for (const e of enemies) {
      if (!e.alive) continue;
      e.pushX = 0; e.pushZ = 0;
      const bx = Math.floor(e.group.position.x / SEPR), bz = Math.floor(e.group.position.z / SEPR);
      const k = bx + ',' + bz;
      (_buckets.get(k) || _buckets.set(k, []).get(k)).push(e);
    }
    for (const e of enemies) {
      if (!e.alive) continue;
      const bx = Math.floor(e.group.position.x / SEPR), bz = Math.floor(e.group.position.z / SEPR);
      for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
        const list = _buckets.get((bx + gx) + ',' + (bz + gz));
        if (!list) continue;
        for (const o of list) {
          if (o === e) continue;
          const dx = e.group.position.x - o.group.position.x;
          const dz = e.group.position.z - o.group.position.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > 0 && d2 < SEPR * SEPR) {
            const d = Math.sqrt(d2), f = (SEPR - d) / d * 0.5;
            e.pushX += dx * f; e.pushZ += dz * f;
          }
        }
      }
    }
    for (const e of enemies) {
      if (!e.alive) continue;
      if (e.pushX || e.pushZ) {
        const tx = e.group.position.x + e.pushX, tz = e.group.position.z + e.pushZ;
        if (!wallBlocked(tx, e.group.position.z)) { e.group.position.x = tx; e.moving = true; }
        if (!wallBlocked(e.group.position.x, tz)) { e.group.position.z = tz; e.moving = true; }
      }
      playState(e, e.moving ? 'run' : 'idle');
      e.group.position.y = getGroundHeight(e.group.position.x, e.group.position.z);
      e.mixer.update(dt);
    }
  }

  // Enemigo vivo más cercano a (x,z) dentro de maxDist → para el auto-apuntado
  function nearest(x, z, maxDist) {
    let best = null, bd = maxDist * maxDist;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.group.position.x - x, dz = e.group.position.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best ? { x: best.group.position.x, z: best.group.position.z, dist: Math.sqrt(bd) } : null;
  }

  function handleLasers(lasers) {
    for (const b of lasers.getActive()) {
      for (const e of enemies) {
        if (!e.alive) continue;
        const dx = b.position.x - e.group.position.x;
        const dz = b.position.z - e.group.position.z;
        const rr = e.radius + 0.35;
        if (dx * dx + dz * dz < rr * rr) { kill(e); lasers.deactivate(b); break; }
      }
    }
  }

  function meleeStrike(pos, facing) {
    const RANGE = 3.0;
    const fx = Math.sin(facing), fz = Math.cos(facing);
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.group.position.x - pos.x, dz = e.group.position.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > RANGE + e.radius) continue;
      const dot = (dx * fx + dz * fz) / (d || 1);
      if (d < 1.6 || dot > 0.35) kill(e);
    }
  }

  return {
    populate, update, handleLasers, meleeStrike, nearest, clear,
    get count() { return enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0); },
  };
}
