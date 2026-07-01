import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { setupWorld } from './world.js';
import { createShip } from './ship.js';
import { GamepadController } from './controls.js';
import { addOutline, addRimGlow, pulseRim } from './characterShader.js';
import { createMinimap } from './minimap.js';
import { createFogOfWar } from './fogOfWar.js';
import { setupLighting, createMapLights } from './lighting.js';
import { loadWeapon } from './weapon.js';
import { createLasers } from './projectiles.js';
import { createSparks, createBlood } from './particles.js';
import { createEnemies } from './enemies.js';

// ─── Renderer ───────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
// MSAA activo + pixel ratio limitado a 2: bordes nítidos sin sobre-render en 4K
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

// ─── Scene ──────────────────────────────────────────────────────────────────
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x070b18);  // vacío espacial oscuro
scene.fog = new THREE.Fog(0x0a1024, 38, 96);   // niebla azul profunda

// ─── Camera — Minecraft Dungeons style ──────────────────────────────────────
// Completamente fija: solo sigue la posición del jugador, sin rotación.
// ~55° elevación, ligeramente detrás del jugador.
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 200);
const CAM_OFFSET = new THREE.Vector3(0, 14, 12);
camera.position.copy(CAM_OFFSET);
camera.lookAt(0, 0, 0);

// ─── World ──────────────────────────────────────────────────────────────────
const world = setupWorld(scene);
const { getGroundHeight, isWall } = world;

// La nave: hub seguro, lejos del dungeon (solo se alterna su visibilidad)
const ship = createShip(scene);

// ─── Estado del juego — lore: viajero interdimensional ──────────────────────
// Vives en tu nave. Cada portal te lanza a una realidad distinta: roba su
// maná (cofres) y alcanza la salida. Si caes en combate, lo pierdes todo y
// reapareces en la nave. Escapa de REALITIES_TO_ESCAPE realidades seguidas
// para volver a casa con tu botín.
const REALITIES_TO_ESCAPE = 5;
const MAX_HP = 3;
const game = { state: 'ship', hp: MAX_HP, mana: 0, realities: 0, invuln: 0 };

const hudHearts    = document.querySelectorAll('#hp-hearts .heart');
const hudMana      = document.getElementById('mana-count');
const hudRealities = document.getElementById('realities-count');
const hudMessage   = document.getElementById('message');
let messageTimer = null;

function updateHUD() {
  hudHearts.forEach((h, i) => h.classList.toggle('empty', i >= game.hp));
  hudMana.textContent = game.mana;
  hudRealities.textContent = `${game.realities}/${REALITIES_TO_ESCAPE}`;
  ship.setMana(game.mana);
}

function showMessage(text, seconds = 2.5) {
  hudMessage.textContent = text;
  hudMessage.classList.add('show');
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => hudMessage.classList.remove('show'), seconds * 1000);
}

// Suelo/colisión activos según dónde esté el jugador (nave o realidad actual)
function currentGroundY(x, z) { return game.state === 'ship' ? ship.groundY(x, z) : getGroundHeight(x, z); }
function currentIsWall(x, z)  { return game.state === 'ship' ? ship.isWall(x, z)  : isWall(x, z); }

// Iluminación (ambiente bajo + luz del jugador + luces por mapa)
const lights = setupLighting(scene);
const mapLights = createMapLights(scene, getGroundHeight);

// Niebla de guerra + minimapa (oculto hasta pulsar el botón abajo)
const fog = createFogOfWar();
const minimap = createMinimap();

// Láseres del jugador (rebotan en muros, munición infinita)
const lasers = createLasers(scene, isWall);
const sparks = createSparks(scene);
const blood = createBlood(scene);   // salpicaduras de sangre para golpes melee
const _fwd = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _impactPt = new THREE.Vector3();
const _deathUp = new THREE.Vector3(0, 1, 0);

let mapNumber = 1;       // contador de mapas completados (= nivel del mapa)
let openingChests = [];  // cofres/pociones recién recogidos, animando su desaparición
let potions = [];        // pociones de vida caídas, pendientes de recoger

// Poción de vida: pequeño vial que un enemigo puede soltar al morir (10%).
// Cuelga del grupo del dungeon → se limpia sola al regenerar/cambiar de realidad.
const potionMat = new THREE.MeshToonMaterial({
  color: 0xff5a7a, emissive: 0xff2d55, emissiveIntensity: 0.85, transparent: true, opacity: 0.92,
});
function dropPotion(x, z) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.24, 0.46, 10), potionMat);
  body.position.y = 0.32;
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), potionMat);
  cap.position.y = 0.56;
  g.add(body, cap);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  g.position.set(x, getGroundHeight(x, z), z);
  world.addToDungeon(g);
  potions.push({ mesh: g, x, z });
}

// Enemigos: se reparten por los pasillos tras generar cada mapa. Al morir,
// fogonazo de partículas en su posición y 10% de soltar una poción de vida.
const POTION_DROP_CHANCE = 0.10;
const enemies = createEnemies(scene, { getGroundHeight, isWall }, {
  onKill: (pos) => {
    sparks.burst(pos, _deathUp, 22);
    if (Math.random() < POTION_DROP_CHANCE) dropPotion(pos.x, pos.z);
  },
  // Golpe enemigo (punch/kick): sangre siempre, daño real con i-frames
  onHitPlayer: (dmg) => {
    _impactPt.set(player.mesh.position.x, player.mesh.position.y + 1.2, player.mesh.position.z);
    blood.burst(_impactPt, 14);
    if (game.invuln > 0) return;
    game.invuln = 0.8;
    game.hp -= dmg;
    updateHUD();
    if (game.hp <= 0) die();
  },
});

// Colisión contra muros: bloquea el movimiento por eje si el destino (con un
// radio alrededor del jugador) cae en una celda-muro.
const PLAYER_RADIUS = 1.1;
function blocked(x, z) {
  const r = PLAYER_RADIUS;
  return currentIsWall(x - r, z - r) || currentIsWall(x + r, z - r) ||
         currentIsWall(x - r, z + r) || currentIsWall(x + r, z + r);
}

// Aplica el mapa actual a niebla, minimapa y luces (al iniciar y al regenerar)
function applyMap() {
  fog.setMap(world.map);
  minimap.setMap(world.map, fog);
  mapLights.rebuild(world.map);
}

// Coloca al jugador en el punto A del mapa actual
function spawnAtStart() {
  const s = world.map.spawn;
  player.mesh.position.set(s.x, getGroundHeight(s.x, s.z), s.z);
  camera.position.copy(player.mesh.position).add(CAM_OFFSET);
}

// Genera el siguiente mapa y reposiciona al jugador en su nuevo A
function nextMap() {
  world.generate();   // también descarta cualquier poción sin recoger del mapa anterior
  potions = [];
  applyMap();
  mapNumber++;
  spawnAtStart();
  enemies.populate(world.map, mapNumber);   // nivel del mapa superior → enemigos más fuertes
}

// Pisar el portal de la nave: arranca una nueva incursión desde la realidad 1
function enterDungeon() {
  game.state = 'dungeon';
  game.hp = MAX_HP;
  game.invuln = 0;
  mapNumber = 1;
  world.generate();
  potions = [];
  applyMap();
  spawnAtStart();
  enemies.populate(world.map, mapNumber);
  world.setVisible(true);
  ship.setVisible(false);
  updateHUD();
}

// Vuelve al jugador a la nave (por muerte o por escape) y limpia el dungeon
function returnToShip() {
  game.state = 'ship';
  game.hp = MAX_HP;
  game.invuln = 0;
  enemies.clear();
  world.setVisible(false);
  ship.setVisible(true);
  player.mesh.position.set(ship.spawn.x, 0, ship.spawn.z);
  camera.position.copy(player.mesh.position).add(CAM_OFFSET);
}

// Muerte: pierdes todo el maná robado y la racha de realidades, reapareces en la nave
function die() {
  game.mana = 0;
  game.realities = 0;
  returnToShip();
  updateHUD();
  showMessage('Has caído. Pierdes todo tu maná robado y despiertas en la nave.', 3);
}

// Escape: sobreviviste a REALITIES_TO_ESCAPE realidades seguidas, vuelves con tu botín
function escape() {
  const stolen = game.mana;
  game.realities = 0;
  returnToShip();
  updateHUD();
  showMessage(`¡Escapaste de vuelta a la nave con ${stolen} de maná robado!`, 3.5);
}

// ─── Player state ───────────────────────────────────────────────────────────
const player = {
  mesh: new THREE.Group(),
  model: null,
  speed: 7,
  facing: 0,
  // Combate
  isMeleeAttacking: false,  meleeTimer: 0,
  punchSide: 'left',        // alterna L → R → L → R ...
  isRangedAttacking: false, shootCadence: 0,
  // Roll — se activa con R3 (clic stick derecho)
  isRolling: false, rollTimer: 0, rollCooldown: 0,
  // Curación (LB) — restaura 1 vida real, con cooldown
  isHealing: false, healTimer: 0, healCooldown: 0,
  mixer: null,
  actions: {},
  currentAction: null,
  weapon: null,
};
scene.add(player.mesh);

// La lámpara del jugador lo acompaña (revela el entorno → niebla de guerra 3D)
lights.playerLight.position.set(0, 3.2, 0);
player.mesh.add(lights.playerLight);

// Estado inicial: el viajero despierta en su nave. El dungeon ya está
// generado pero oculto; el primer viaje se activa al pisar el portal.
world.setVisible(false);
ship.setVisible(true);
player.mesh.position.set(ship.spawn.x, 0, ship.spawn.z);
camera.position.copy(player.mesh.position).add(CAM_OFFSET);
updateHUD();

// Temporales reutilizables para orientar al jugador según la pendiente (sin GC)
const _up        = new THREE.Vector3(0, 1, 0);
const _normal    = new THREE.Vector3();
const _tiltQuat  = new THREE.Quaternion();
const _yawQuat   = new THREE.Quaternion();
const _targetQ   = new THREE.Quaternion();
const _occTarget = new THREE.Vector3();
const _occHead   = new THREE.Vector3(0, 1.4, 0);

// ─── Load GLB ───────────────────────────────────────────────────────────────
const loader = new GLTFLoader();
loader.load(
  '/Astronaut.glb',
  (gltf) => {
    const model = gltf.scene;
    model.scale.setScalar(1.5);
    model.traverse((node) => {
      if (node.isMesh) { node.castShadow = true; node.receiveShadow = true; }
    });
    player.mesh.add(model);
    player.model = model;

    // Shaders de destacado cartoon
    addOutline(model, 0x111111, 0.05);       // borde negro
    addRimGlow(model, 0x00eeff, 2.2, 1.6);  // rim cyan pulsante

    if (gltf.animations.length > 0) {
      player.mixer = new THREE.AnimationMixer(model);
      gltf.animations.forEach((clip) => {
        player.actions[clip.name.toLowerCase()] = player.mixer.clipAction(clip);
      });

      // Definimos explícitamente el tren SUPERIOR (torso, brazos, manos, cabeza).
      // Todo lo demás —incluida la raíz "Body", piernas, pies y targets IK— es
      // tren inferior y queda controlado por la locomoción (run/idle).
      const UPPER_KW = ['torso', 'chest', 'spine', 'neck', 'head',
                        'shoulder', 'arm', 'wrist', 'hand',
                        'index', 'middle', 'ring', 'pinky', 'thumb'];
      const isLower = (boneName) => {
        const n = boneName.toLowerCase();
        return !UPPER_KW.some((k) => n.includes(k));
      };

      // Crea un clip clonado conservando solo huesos de tren inferior o superior
      const filteredClip = (clip, keepLower) => {
        const c = clip.clone();
        c.tracks = clip.tracks.filter((t) => {
          const bone = t.name.split('.')[0];
          return keepLower ? isLower(bone) : !isLower(bone);
        });
        return c;
      };

      // Variantes de base solo con tren inferior (para usar mientras se ataca)
      const runClip  = player.actions['characterarmature|run']?.getClip();
      const idleClip = player.actions['characterarmature|idle']?.getClip();

      if (runClip) {
        const c = filteredClip(runClip, true);
        c.name = 'run_lower';
        const a = player.mixer.clipAction(c);
        a.setLoop(THREE.LoopRepeat, Infinity);
        player.actions['characterarmature|run_lower'] = a;
      }
      if (idleClip) {
        const c = filteredClip(idleClip, true);
        c.name = 'idle_lower';
        const a = player.mixer.clipAction(c);
        a.setLoop(THREE.LoopRepeat, Infinity);
        player.actions['characterarmature|idle_lower'] = a;
      }

      // Variantes de ataque solo con tren superior (se superponen al base inferior)
      ['punch_left', 'punch_right', 'gun_shoot'].forEach((suffix) => {
        const key  = `characterarmature|${suffix}`;
        const base = player.actions[key];
        if (!base) return;
        const c = filteredClip(base.getClip(), false);
        c.name = `${suffix}_upper`;
        const a = player.mixer.clipAction(c);
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;   // mantiene la última pose para hacer un crossfade limpio
        player.actions[`${key}_upper`] = a;
      });

      // Velocidades: golpe y roll más ágiles que el resto
      ['characterarmature|punch_left_upper', 'characterarmature|punch_right_upper']
        .forEach((k) => player.actions[k]?.setEffectiveTimeScale(1.6));
      player.actions['characterarmature|roll']?.setEffectiveTimeScale(1.8);

      playAnim('characterarmature|idle');
    }

    // ── Arma: pistola sci-fi adjunta a la mano derecha ──────────────────────
    loadWeapon(model, player);
  },
  undefined,
  (err) => console.error('Error loading model:', err)
);

// ─── Controls ───────────────────────────────────────────────────────────────
const gamepad = new GamepadController();

// Teclado como fallback
const keys = {};
window.addEventListener('keydown', (e) => (keys[e.code] = true));
window.addEventListener('keyup',   (e) => (keys[e.code] = false));

// ─── Resize ─────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ─── Animation helpers ───────────────────────────────────────────────────────
function playAnim(name) {
  const action = player.actions[name];
  if (!action || player.currentAction === action) return;
  if (player.currentAction) player.currentAction.fadeOut(0.15);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.reset().fadeIn(0.15).play();
  player.currentAction = action;
}

// Reproduce solo el tren superior del ataque; el tren inferior sigue corriendo/idle
function playUpperBody(name, onFinish) {
  const action = player.actions[`${name}_upper`];
  if (!action) { onFinish?.(); return; }
  action.setEffectiveWeight(1);
  action.reset().fadeIn(0.12).play();
  const onEnd = (e) => {
    if (e.action !== action) return;
    player.mixer.removeEventListener('finished', onEnd);
    action.fadeOut(0.25);   // desvanece desde la pose final, sin saltar al frame 0
    onFinish?.();
  };
  player.mixer.addEventListener('finished', onEnd);
}

// Reproduce una animación una sola vez y llama a onFinish al terminar
function playOnce(name, onFinish) {
  const action = player.actions[name];
  if (!action) { onFinish?.(); return; }
  if (player.currentAction) player.currentAction.fadeOut(0.1);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.reset().fadeIn(0.1).play();
  player.currentAction = action;

  const onEnd = (e) => {
    if (e.action !== action) return;
    player.mixer.removeEventListener('finished', onEnd);
    onFinish?.();
  };
  player.mixer.addEventListener('finished', onEnd);
}

// ─── Game loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock();
let elapsed = 0;

function update(dt) {
  elapsed += dt;
  gamepad.update();
  const gp = gamepad.state;
  game.invuln = Math.max(0, game.invuln - dt);   // i-frames tras recibir un golpe

  // ────────────────────────────────────────────────────────────────────────────
  // MOVIMIENTO — Left Stick / WASD
  // El movimiento es relativo a la cámara fija (siempre la misma orientación)
  // ────────────────────────────────────────────────────────────────────────────
  let mx = gp.leftX;
  let mz = gp.leftY;
  if (keys['KeyA'] || keys['ArrowLeft'])  mx = -1;
  if (keys['KeyD'] || keys['ArrowRight']) mx =  1;
  if (keys['KeyW'] || keys['ArrowUp'])    mz = -1;
  if (keys['KeyS'] || keys['ArrowDown'])  mz =  1;

  const moveLen = Math.sqrt(mx * mx + mz * mz);
  const moving  = moveLen > 0.15;

  // ────────────────────────────────────────────────────────────────────────────
  // A — Punch L/R intercalado, aditivo sobre walk  (keyboard: Space)
  // ────────────────────────────────────────────────────────────────────────────
  if ((gamepad.justPressed(0) || keys['Space']) && !player.isMeleeAttacking) {
    player.isMeleeAttacking = true;
    const side = player.punchSide;
    player.punchSide = side === 'left' ? 'right' : 'left';
    playUpperBody(`characterarmature|punch_${side}`, () => { player.isMeleeAttacking = false; });
    // Salpicadura de sangre solo en cada enemigo realmente golpeado
    enemies.meleeStrike(player.mesh.position, player.facing, (x, y, z) => {
      _impactPt.set(x, y + 1.2, z);
      blood.burst(_impactPt, 18);
    });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // RT — Disparo automático con cadencia  (keyboard: F)
  // Mientras se mantiene presionado, dispara en ráfaga rítmica a intervalo fijo
  // en vez de encadenar la animación sin ritmo (evita el loop/parpadeo).
  // ────────────────────────────────────────────────────────────────────────────
  const SHOOT_INTERVAL = 0.32;   // segundos entre disparos
  player.shootCadence = Math.max(0, player.shootCadence - dt);
  const shootHeld = gp.rt > 0.5 || keys['KeyF'];
  player.isRangedAttacking = shootHeld;   // mantiene la base inferior mientras se dispara
  if (player.weapon && !player.weaponDebug) player.weapon.visible = shootHeld;   // arma visible solo al disparar
  if (shootHeld && player.shootCadence <= 0) {
    player.shootCadence = SHOOT_INTERVAL;
    playUpperBody('characterarmature|gun_shoot');   // relanza el swing del brazo en cada disparo

    // Auto-apuntado: si hay un enemigo dentro del rango, encara y dispara hacia él
    // (facilita el run & shoot). Si no, dispara según el frente actual.
    const AIM_RANGE = 22;
    const AIM_CONE = Math.PI / 6;   // ±30° al frente: no auto-apunta hacia atrás
    const target = enemies.nearest(player.mesh.position.x, player.mesh.position.z, AIM_RANGE, player.facing, AIM_CONE);
    if (target) {
      player.facing = Math.atan2(target.x - player.mesh.position.x, target.z - player.mesh.position.z);
    }
    // Dirección de apuntado (frente = +Z local del modelo)
    _fwd.set(Math.sin(player.facing), 0, Math.cos(player.facing));
    // Origen = boca real del arma (posición mundial del arma), no un offset
    // centrado: así no se desplaza al rotar el personaje. Fallback si aún no carga.
    if (player.weapon) {
      player.weapon.getWorldPosition(_muzzle);
      _muzzle.addScaledVector(_fwd, 0.5);   // un poco al frente, hacia la punta del cañón
    } else {
      _muzzle.copy(player.mesh.position).addScaledVector(_fwd, 1.1);
      _muzzle.y += 1.1;
    }
    lasers.spawn(_muzzle, _fwd);
    sparks.burst(_muzzle, _fwd);   // fogonazo de partículas
  }

  // ────────────────────────────────────────────────────────────────────────────
  // R3 (clic stick derecho) — Roll hacia adelante  (keyboard: Shift)
  // ────────────────────────────────────────────────────────────────────────────
  player.rollCooldown = Math.max(0, player.rollCooldown - dt);
  if ((gamepad.justPressed(11) || keys['ShiftLeft']) &&
      !player.isRolling && player.rollCooldown <= 0 && moving) {
    player.isRolling    = true;
    player.rollCooldown = 0.8;
    playOnce('characterarmature|roll', () => { player.isRolling = false; });
  }

  // ────────────────────────────────────────────────────────────────────────────
  // LB — Curar (recupera 1 vida, con cooldown)  (keyboard: Q)
  // ────────────────────────────────────────────────────────────────────────────
  const HEAL_COOLDOWN = 4;
  player.healCooldown = Math.max(0, player.healCooldown - dt);
  if ((gamepad.justPressed(4) || keys['KeyQ']) && !player.isHealing &&
      game.state === 'dungeon' && game.hp < MAX_HP && player.healCooldown <= 0) {
    player.isHealing = true;
    player.healTimer  = 0.6;
    player.healCooldown = HEAL_COOLDOWN;
    game.hp = Math.min(MAX_HP, game.hp + 1);
    updateHUD();
  }
  if (player.isHealing) {
    player.healTimer -= dt;
    if (player.healTimer <= 0) player.isHealing = false;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // D-pad ABAJO — Mostrar/ocultar minimapa  (keyboard: M)
  // ────────────────────────────────────────────────────────────────────────────
  if (gamepad.justPressed(13) || keys['KeyM'] && !player._mPrev) minimap.toggle();
  player._mPrev = keys['KeyM'];

  // P — Debug: mostrar/ocultar líneas de visión de los enemigos
  if (keys['KeyP'] && !player._pPrev) enemies.toggleDebug();
  player._pPrev = keys['KeyP'];

  // ────────────────────────────────────────────────────────────────────────────
  // X/Y/B — Usar objetos 1/2/3  (keyboard: 1/2/3) — cosmético
  // LT — Rueda de chat  (keyboard: Tab) — cosmético
  // D-pad ↑/→ — Inventario/Emote — cosmético
  // ────────────────────────────────────────────────────────────────────────────

  // ────────────────────────────────────────────────────────────────────────────
  // MOVER JUGADOR
  // ────────────────────────────────────────────────────────────────────────────
  if (moving) {
    const normX = mx / moveLen;
    const normZ = mz / moveLen;
    const spd   = player.speed;

    // Movimiento con colisión contra muros, resuelto por eje (permite deslizar)
    const px = player.mesh.position.x, pz = player.mesh.position.z;
    const nx = px + normX * spd * dt;
    const nz = pz + normZ * spd * dt;
    if (!blocked(nx, pz)) player.mesh.position.x = nx;
    if (!blocked(player.mesh.position.x, nz)) player.mesh.position.z = nz;

    const targetAngle = Math.atan2(normX, normZ);
    player.facing = lerpAngle(player.facing, targetAngle, 12 * dt);
  }

  // ────────────────────────────────────────────────────────────────────────────
  // LLEGADA A B (en una realidad) o AL PORTAL (en la nave)
  // ────────────────────────────────────────────────────────────────────────────
  if (game.state === 'dungeon') {
    const b = world.map.exit;
    const dx = player.mesh.position.x - b.x;
    const dz = player.mesh.position.z - b.z;
    if (dx * dx + dz * dz < 2.0 * 2.0) {
      game.realities++;
      if (game.realities >= REALITIES_TO_ESCAPE) escape();
      else { nextMap(); updateHUD(); }
    }

    // Cofres: robar su maná al pasar cerca (una vez por cofre)
    for (const ch of world.map.chests) {
      if (ch.opened) continue;
      const cdx = player.mesh.position.x - ch.x;
      const cdz = player.mesh.position.z - ch.z;
      if (cdx * cdx + cdz * cdz < 1.8 * 1.8) {
        ch.opened = true;
        game.mana++;
        updateHUD();
        openingChests.push({ mesh: ch.mesh, t: 0.45 });
        sparks.burst(new THREE.Vector3(ch.x, getGroundHeight(ch.x, ch.z) + 0.9, ch.z), _deathUp, 26);
      }
    }

    // Pociones de vida caídas: recuperan 1 corazón al recogerlas (si no está lleno)
    for (let i = potions.length - 1; i >= 0; i--) {
      const p = potions[i];
      const pdx = player.mesh.position.x - p.x;
      const pdz = player.mesh.position.z - p.z;
      if (pdx * pdx + pdz * pdz < 1.6 * 1.6) {
        if (game.hp < MAX_HP) { game.hp++; updateHUD(); }
        openingChests.push({ mesh: p.mesh, t: 0.35 });
        sparks.burst(new THREE.Vector3(p.x, getGroundHeight(p.x, p.z) + 0.7, p.z), _deathUp, 18);
        potions.splice(i, 1);
      }
    }
  } else if (game.state === 'ship') {
    const dx = player.mesh.position.x - ship.portal.x;
    const dz = player.mesh.position.z - ship.portal.z;
    if (dx * dx + dz * dz < ship.portal.radius * ship.portal.radius) enterDungeon();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ANCLAR AL SUELO + INCLINAR SEGÚN PENDIENTE
  // Muestrea la altura bajo el jugador (planta los pies) y las alturas vecinas
  // para estimar la normal del terreno e inclinar el cuerpo en las cuestas.
  // ────────────────────────────────────────────────────────────────────────────
  {
    const px = player.mesh.position.x, pz = player.mesh.position.z;

    // Altura: suavizado para que las ondulaciones no produzcan saltos bruscos
    const groundY = currentGroundY(px, pz);
    player.mesh.position.y += (groundY - player.mesh.position.y) * Math.min(15 * dt, 1);

    // Normal por diferencias finitas de la altura (heightfield)
    const e   = 0.7;
    const dHx = currentGroundY(px + e, pz) - currentGroundY(px - e, pz);
    const dHz = currentGroundY(px, pz + e) - currentGroundY(px, pz - e);
    _normal.set(-dHx, 2 * e, -dHz).normalize();

    // Orientación final = inclinación (up→normal) compuesta con el giro (facing)
    _tiltQuat.setFromUnitVectors(_up, _normal);
    _yawQuat.setFromAxisAngle(_up, player.facing);
    _targetQ.copy(_tiltQuat).multiply(_yawQuat);
    player.mesh.quaternion.slerp(_targetQ, Math.min(10 * dt, 1));
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CÁMARA — solo sigue posición, ángulo completamente fijo
  // ────────────────────────────────────────────────────────────────────────────
  const targetCamPos = player.mesh.position.clone().add(CAM_OFFSET);
  camera.position.lerp(targetCamPos, 8 * dt);
  camera.lookAt(player.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0)));

  // Láseres (avance + rebote en muros) y chispas del disparo
  lasers.update(dt);
  sparks.update(dt);
  blood.update(dt);    // salpicaduras de sangre de golpes melee
  ship.update(dt, elapsed);   // portal/cristal de maná (solo anima si está visible)

  // Cofres recién robados: se hunden/encogen hasta desaparecer
  for (let i = openingChests.length - 1; i >= 0; i--) {
    const o = openingChests[i];
    o.t -= dt;
    o.mesh.scale.setScalar(Math.max(o.t / 0.45, 0));
    if (o.t <= 0) { o.mesh.visible = false; openingChests.splice(i, 1); }
  }

  // Lo siguiente solo aplica dentro de una realidad (no en la nave): enemigos,
  // oclusión de muros y niebla de guerra/minimapa.
  if (game.state === 'dungeon') {
    // Enemigos: persecución/flotación + colisión con láseres (mueren de un tiro)
    enemies.update(dt, player);
    enemies.handleLasers(lasers);

    // Muros que tapan al jugador → semitransparentes (oclusión de cámara).
    // Apuntamos al torso (no a los pies) para detectar bien lo que cubre.
    _occTarget.copy(player.mesh.position).add(_occHead);
    world.updateOcclusion(camera, _occTarget);

    // Niebla de guerra: descubre el entorno del jugador, y refresca el minimapa
    fog.reveal(player.mesh.position.x, player.mesh.position.z, 2);
    minimap.update(player.mesh.position.x, player.mesh.position.z, player.facing);
  }

  // Sombra sigue al jugador
  lights.dir.target.position.copy(player.mesh.position);
  lights.dir.target.updateMatrixWorld();

  // Rim glow pulsante
  if (player.model) pulseRim(player.model, elapsed);

  // ────────────────────────────────────────────────────────────────────────────
  // ANIMACIONES
  // ────────────────────────────────────────────────────────────────────────────
  if (player.mixer) {
    const attacking = player.isMeleeAttacking || player.isRangedAttacking;
    if (player.isRolling) {
      // playOnce ya fue lanzado en el trigger, no relanzar
    } else if (moving) {
      // Al atacar usa solo el tren inferior para que punch/shoot controlen el superior
      playAnim(attacking ? 'characterarmature|run_lower' : 'characterarmature|run');
    } else {
      playAnim(attacking ? 'characterarmature|idle_lower' : 'characterarmature|idle');
    }
    player.mixer.update(dt);
  }
}

function lerpAngle(a, b, t) {
  let diff = b - a;
  while (diff >  Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * Math.min(t, 1);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  update(dt);
  renderer.render(scene, camera);
}

animate();
