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

  // ── Debug de línea de visión (toggle) ────────────────────────────────────
  const DBG_MAX = 520;
  const _dbgPos = new Float32Array(DBG_MAX * 2 * 3);
  const _dbgCol = new Float32Array(DBG_MAX * 2 * 3);
  const _dbgGeo = new THREE.BufferGeometry();
  _dbgGeo.setAttribute('position', new THREE.BufferAttribute(_dbgPos, 3));
  _dbgGeo.setAttribute('color', new THREE.BufferAttribute(_dbgCol, 3));
  const _dbgLines = new THREE.LineSegments(
    _dbgGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false })
  );
  _dbgLines.visible = false;
  _dbgLines.frustumCulled = false;
  _dbgLines.renderOrder = 999;
  scene.add(_dbgLines);
  const toggleDebug = () => { _dbgLines.visible = !_dbgLines.visible; };
  let idleClip = null, runClip = null, hitClip = null, deathClip = null, deathDur = 1.2;
  let attackClips = [];
  const onHitPlayer = opts.onHitPlayer || null;
  let pending = null;

  // Carga del modelo una sola vez; busca clips por nombre.
  new GLTFLoader().load('/Astronaut.glb', (gltf) => {
    template = gltf.scene;
    const find = (kw) => gltf.animations.find((a) => a.name.toLowerCase().includes(kw));
    idleClip  = find('idle') || gltf.animations[0];
    runClip   = find('run')  || find('walk') || idleClip;
    hitClip   = find('hitrecieve') || find('hit') || idleClip;
    deathClip = find('death') || find('die') || idleClip;
    deathDur  = deathClip.duration || 1.2;
    // Ataques cuerpo a cuerpo: puñetazos y patadas
    attackClips = ['punch_left', 'punch_right', 'kick_left', 'kick_right']
      .map((kw) => gltf.animations.find((a) => a.name.toLowerCase().includes(kw)))
      .filter(Boolean);
    if (!attackClips.length) attackClips = [idleClip];
    if (pending) { const p = pending; pending = null; populate(p.map, p.mapNumber); }
  }, undefined, (err) => console.error('Error cargando Astronaut.glb:', err));

  function addEnemy(x, z, level) {
    const model = cloneSkinned(template);     // clona malla + esqueleto
    model.scale.setScalar(1.5);               // mismo tamaño que el personaje

    // Teñido por nivel: color de tramo en el cuerpo + leve emisivo (glow oscuro)
    const tint = new THREE.Color(tierFor(level).color);
    const baseEmis = 0.5 + (level / 100) * 0.6;
    const mats = [];
    model.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.material = o.material.clone();
        o.material.color.copy(tint);
        if ('emissive' in o.material) {
          o.material.emissive = tint.clone().multiplyScalar(0.35);
          o.material.emissiveIntensity = baseEmis;
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
      idle:  mixer.clipAction(idleClip),
      run:   mixer.clipAction(runClip),
      hit:   mixer.clipAction(hitClip),
      death: mixer.clipAction(deathClip),
      attacks: attackClips.map((c) => mixer.clipAction(c)),
    };
    actions.idle.play();

    enemies.push({
      group, model, mats, mixer, actions, current: actions.idle,
      level, alive: true, dying: false, radius: 1.0, speed: 2.2 + level * 0.02,
      wander: Math.random() * Math.PI * 2, t: Math.random() * 10,   // deriva idle
      hp: 2 + Math.floor(level / 25),     // vida mínima 2 disparos, +1 por tramo
      baseEmis, flash: 0, hitT: 0, deathT: 0, knockVX: 0, knockVZ: 0,
      attackCD: Math.random() * 0.6, attacking: false, attackT: 0,
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
    const count = Math.min(250, (6 + Math.floor(mapNumber * 1.5)) * 10);
    for (let i = 0; i < count; i++) {
      const [c, r] = cands[(Math.random() * cands.length) | 0];
      const [cx, cz] = cellToWorld(c, r);
      const x = cx + (Math.random() - 0.5) * cellSize * 0.6;
      const z = cz + (Math.random() - 0.5) * cellSize * 0.6;
      addEnemy(x, z, rollLevel(mapNumber));
    }
  }

  // Reproduce una acción una sola vez (con crossfade), guardándola como actual.
  function playOnceAction(e, action, clampEnd) {
    if (e.current && e.current !== action) e.current.fadeOut(0.1);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = clampEnd;
    action.fadeIn(0.1).play();
    e.current = action;
  }

  // Inicia la muerte: deja de ser objetivo, reproduce Death y se elimina al terminar.
  function startDeath(e) {
    if (e.dying) return;
    e.alive = false; e.dying = true;
    e.deathT = deathDur + 0.25;
    playOnceAction(e, e.actions.death, true);
    onKill?.(e.group.position.clone(), e.level);
  }

  // Colisión contra muros con radio (4 esquinas) — como el jugador.
  const ECR = 0.7;   // radio de colisión del enemigo
  const wallBlocked = (x, z) =>
    isWall(x - ECR, z - ECR) || isWall(x + ECR, z - ECR) ||
    isWall(x - ECR, z + ECR) || isWall(x + ECR, z + ECR);

  // Línea de visión: muestrea el segmento enemigo→jugador; si cruza un muro, no ve.
  function hasLineOfSight(ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const steps = Math.ceil(Math.hypot(dx, dz) / 1.0);   // ~1 muestra por unidad
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (isWall(ax + dx * t, az + dz * t)) return false;
    }
    return true;
  }

  // Persecución + colisión con muros y entre enemigos (separación). Reparto en
  // buckets espaciales para que la separación sea ~O(n) aun con cientos.
  const SEPR = 1.5;            // distancia mínima entre centros de enemigos
  const _buckets = new Map();
  function update(dt, player) {
    const px = player.mesh.position.x, pz = player.mesh.position.z;
    // Detección: rango LARGO si hay línea de visión despejada (pasillos largos),
    // y un rango CORTO de proximidad que dispara aunque haya un muro (esquinas).
    const LOS_RANGE = 70, NEAR_RANGE = 5, STOP = 1.4;

    // 0) Enemigos muriendo: solo reproducen Death y se eliminan al terminar
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i];
      if (!e.dying) continue;
      e.deathT -= dt;
      if (e.knockVX || e.knockVZ) {                 // deslizamiento de retroceso restante
        const kx = e.group.position.x + e.knockVX * dt;
        const kz = e.group.position.z + e.knockVZ * dt;
        if (!wallBlocked(kx, e.group.position.z)) e.group.position.x = kx;
        if (!wallBlocked(e.group.position.x, kz)) e.group.position.z = kz;
        const dc = Math.exp(-dt * 9);
        e.knockVX *= dc; e.knockVZ *= dc;
      }
      e.group.position.y = getGroundHeight(e.group.position.x, e.group.position.z);
      e.mixer.update(dt);
      if (e.deathT <= 0) { disposeEnemy(e); enemies.splice(i, 1); }
    }

    // 1) Movimiento de persecución (colisión con muros por eje)
    const ATTACK_RANGE = 2.4, ATTACK_CD = 1.1, ATTACK_DMG = 1;
    for (const e of enemies) {
      if (!e.alive) continue;
      const ex = e.group.position.x, ez = e.group.position.z;
      const dx = px - ex, dz = pz - ez, d = Math.hypot(dx, dz);
      const sees = d < NEAR_RANGE || (d < LOS_RANGE && hasLineOfSight(ex, ez, px, pz));

      // Ataque cuerpo a cuerpo: si lo ve y está a su alcance, golpea (punch/kick)
      e.attackCD = Math.max(0, e.attackCD - dt);
      if (e.attacking) {
        e.attackT -= dt;
        e.group.rotation.y = Math.atan2(dx, dz);
        if (e.attackT <= 0) e.attacking = false;
        e.moving = false; e.sees = sees; e.distToPlayer = d;
        continue;
      }
      if (sees && d < ATTACK_RANGE && e.attackCD <= 0 && e.hitT <= 0) {
        const a = e.actions.attacks[(Math.random() * e.actions.attacks.length) | 0];
        playOnceAction(e, a, false);
        e.attacking = true;
        e.attackT = a.getClip().duration;
        e.attackCD = ATTACK_CD;
        e.group.rotation.y = Math.atan2(dx, dz);
        onHitPlayer?.(ATTACK_DMG, e);        // golpe al jugador (listo para sistema de vida)
        e.moving = false; e.sees = sees; e.distToPlayer = d;
        continue;
      }

      let moving = false;
      if (sees && d > STOP) {
        const step = e.speed * dt, ux = dx / d, uz = dz / d;
        const nx = ex + ux * step, nz = ez + uz * step;
        if (!wallBlocked(nx, e.group.position.z)) { e.group.position.x = nx; moving = true; }
        if (!wallBlocked(e.group.position.x, nz)) { e.group.position.z = nz; moving = true; }
      }
      if (sees) {
        e.group.rotation.y = Math.atan2(dx, dz);   // solo encara si lo ve
      } else {
        // Idle "vivo": pequeño vaivén lateral lento (sin pasar a run)
        e.t += dt;
        const ang = e.wander + Math.sin(e.t * 0.7) * 0.9;
        const SWAY = 0.45;   // unidades/s
        const vx = Math.sin(ang) * SWAY, vz = Math.cos(ang) * SWAY;
        const sx = e.group.position.x + vx * dt, sz = e.group.position.z + vz * dt;
        if (!wallBlocked(sx, e.group.position.z)) e.group.position.x = sx;
        if (!wallBlocked(e.group.position.x, sz)) e.group.position.z = sz;
        e.group.rotation.y += (ang - e.group.rotation.y) * Math.min(2 * dt, 1);
      }
      e.moving = moving;
      e.sees = sees;
      e.distToPlayer = d;
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
      // Retroceso por impacto (decae rápido, respeta muros)
      if (e.knockVX || e.knockVZ) {
        const kx = e.group.position.x + e.knockVX * dt;
        const kz = e.group.position.z + e.knockVZ * dt;
        if (!wallBlocked(kx, e.group.position.z)) e.group.position.x = kx;
        if (!wallBlocked(e.group.position.x, kz)) e.group.position.z = kz;
        const decay = Math.exp(-dt * 9);
        e.knockVX *= decay; e.knockVZ *= decay;
        if (Math.abs(e.knockVX) + Math.abs(e.knockVZ) < 0.4) { e.knockVX = 0; e.knockVZ = 0; }
      }
      // Destello al recibir daño
      if (e.flash > 0) {
        e.flash = Math.max(0, e.flash - dt);
        const boost = e.baseEmis + (e.flash / 0.12) * 2.5;
        for (const m of e.mats) if ('emissiveIntensity' in m) m.emissiveIntensity = boost;
      }
      // Mientras está aturdido (HitRecieve) o atacando no cambia a idle/run
      if (e.hitT > 0) e.hitT -= dt;
      else if (!e.attacking) playState(e, e.moving ? 'run' : 'idle');
      e.group.position.y = getGroundHeight(e.group.position.x, e.group.position.z);
      e.mixer.update(dt);
    }

    // 3) Debug: línea enemigo→jugador. Verde = lo ve (en rango); rojo = no.
    if (_dbgLines.visible) {
      const Y = 1.2;
      let n = 0;
      for (const e of enemies) {
        if (!e.alive || n >= DBG_MAX) continue;
        const i = n * 6;
        _dbgPos[i] = e.group.position.x; _dbgPos[i + 1] = Y; _dbgPos[i + 2] = e.group.position.z;
        _dbgPos[i + 3] = px;             _dbgPos[i + 4] = Y; _dbgPos[i + 5] = pz;
        const g = e.sees ? 1 : 0;   // verde si lo detecta, rojo si no
        _dbgCol[i] = 1 - g; _dbgCol[i + 1] = g; _dbgCol[i + 2] = 0;
        _dbgCol[i + 3] = 1 - g; _dbgCol[i + 4] = g; _dbgCol[i + 5] = 0;
        n++;
      }
      _dbgGeo.setDrawRange(0, n * 2);
      _dbgGeo.attributes.position.needsUpdate = true;
      _dbgGeo.attributes.color.needsUpdate = true;
    }
  }

  // Enemigo vivo más cercano a (x,z) dentro de maxDist y, si se pasa `facing`,
  // dentro de un cono de ±coneRad alrededor del frente (no auto-apunta hacia atrás).
  function nearest(x, z, maxDist, facing, coneRad) {
    const useCone = facing != null && coneRad != null;
    const fx = useCone ? Math.sin(facing) : 0, fz = useCone ? Math.cos(facing) : 0;
    const minDot = useCone ? Math.cos(coneRad) : -1;
    let best = null, bd = maxDist * maxDist;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.group.position.x - x, dz = e.group.position.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bd) continue;
      if (useCone) {
        const d = Math.sqrt(d2) || 1;
        if ((dx * fx + dz * fz) / d < minDot) continue;   // fuera del cono frontal
      }
      bd = d2; best = e;
    }
    return best ? { x: best.group.position.x, z: best.group.position.z, dist: Math.sqrt(bd) } : null;
  }

  // Aplica daño + retroceso (en la dirección de la fuerza) + breve destello.
  const KNOCK_LASER = 11, KNOCK_MELEE = 16;
  function applyHit(e, dmg, dirX, dirZ, knock) {
    if (e.dying) return;
    e.hp -= dmg;
    e.knockVX += dirX * knock;
    e.knockVZ += dirZ * knock;
    e.flash = 0.12;
    e.attacking = false;                          // un golpe interrumpe su ataque
    if (e.hp <= 0) {
      startDeath(e);
    } else {
      e.hitT = 0.4;                              // aturdido: reproduce HitRecieve
      playOnceAction(e, e.actions.hit, false);
    }
  }

  function handleLasers(lasers) {
    for (const b of lasers.getActive()) {
      for (const e of enemies) {
        if (!e.alive) continue;
        const dx = b.position.x - e.group.position.x;
        const dz = b.position.z - e.group.position.z;
        const rr = e.radius + 0.35;
        if (dx * dx + dz * dz < rr * rr) {
          const v = b.userData.vel;                    // empuja según la velocidad de la bala
          const len = Math.hypot(v.x, v.z) || 1;
          applyHit(e, 1, v.x / len, v.z / len, KNOCK_LASER);
          lasers.deactivate(b);
          break;
        }
      }
    }
  }

  // Golpe a UN SOLO objetivo: el enemigo más cercano al frente cuyo modelo esté
  // en contacto con el del personaje (sin daño en área ni a distancia).
  const PLAYER_REACH = 1.0;     // mitad del "cuerpo" del personaje + brazo
  function meleeStrike(pos, facing, onHit) {
    const fx = Math.sin(facing), fz = Math.cos(facing);
    let best = null, bestD = Infinity, bdx = 0, bdz = 0;
    for (const e of enemies) {
      if (!e.alive) continue;
      const dx = e.group.position.x - pos.x, dz = e.group.position.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > e.radius + PLAYER_REACH) continue;          // deben estar tocándose
      if ((dx * fx + dz * fz) / (d || 1) < 0.2) continue; // y al frente
      if (d < bestD) { best = e; bestD = d; bdx = dx; bdz = dz; }
    }
    if (best) {
      const inv = 1 / (bestD || 1);
      applyHit(best, 2, bdx * inv, bdz * inv, KNOCK_MELEE);
      onHit?.(best.group.position.x, best.group.position.y, best.group.position.z);
    }
  }

  return {
    populate, update, handleLasers, meleeStrike, nearest, toggleDebug, clear,
    get count() { return enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0); },
  };
}
