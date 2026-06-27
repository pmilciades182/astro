import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { setupWorld } from './world.js';
import { GamepadController } from './controls.js';
import { addOutline, addRimGlow, pulseRim } from './characterShader.js';
import { createMinimap } from './minimap.js';
import { createFogOfWar } from './fogOfWar.js';
import { setupLighting, createMapLights } from './lighting.js';
import { loadWeapon } from './weapon.js';

// ─── Renderer ───────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
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

// Iluminación (ambiente bajo + luz del jugador + luces por mapa)
const lights = setupLighting(scene);
const mapLights = createMapLights(scene, getGroundHeight);

// Niebla de guerra + minimapa (oculto hasta pulsar el botón abajo)
const fog = createFogOfWar();
const minimap = createMinimap();

let mapNumber = 1;   // contador de mapas completados

// Colisión contra muros: bloquea el movimiento por eje si el destino (con un
// radio alrededor del jugador) cae en una celda-muro.
const PLAYER_RADIUS = 1.1;
function blocked(x, z) {
  const r = PLAYER_RADIUS;
  return isWall(x - r, z - r) || isWall(x + r, z - r) ||
         isWall(x - r, z + r) || isWall(x + r, z + r);
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
  world.generate();
  applyMap();
  mapNumber++;
  spawnAtStart();
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
  // Items y UI (cosméticos, sin lógica de gameplay)
  isHealing: false, healTimer: 0,
  mixer: null,
  actions: {},
  currentAction: null,
  weapon: null,
};
scene.add(player.mesh);

// La lámpara del jugador lo acompaña (revela el entorno → niebla de guerra 3D)
lights.playerLight.position.set(0, 3.2, 0);
player.mesh.add(lights.playerLight);

// Primer mapa: niebla, minimapa, luces y spawn en A
applyMap();
spawnAtStart();

// Temporales reutilizables para orientar al jugador según la pendiente (sin GC)
const _up        = new THREE.Vector3(0, 1, 0);
const _normal    = new THREE.Vector3();
const _tiltQuat  = new THREE.Quaternion();
const _yawQuat   = new THREE.Quaternion();
const _targetQ   = new THREE.Quaternion();

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
  // LB — Curar  (keyboard: Q)
  // ────────────────────────────────────────────────────────────────────────────
  if ((gamepad.justPressed(4) || keys['KeyQ']) && !player.isHealing) {
    player.isHealing = true;
    player.healTimer  = 0.6;
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
  // LLEGADA A B — completa el mapa y genera el siguiente
  // ────────────────────────────────────────────────────────────────────────────
  {
    const b = world.map.exit;
    const dx = player.mesh.position.x - b.x;
    const dz = player.mesh.position.z - b.z;
    if (dx * dx + dz * dz < 2.0 * 2.0) nextMap();
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ANCLAR AL SUELO + INCLINAR SEGÚN PENDIENTE
  // Muestrea la altura bajo el jugador (planta los pies) y las alturas vecinas
  // para estimar la normal del terreno e inclinar el cuerpo en las cuestas.
  // ────────────────────────────────────────────────────────────────────────────
  if (getGroundHeight) {
    const px = player.mesh.position.x, pz = player.mesh.position.z;

    // Altura: suavizado para que las ondulaciones no produzcan saltos bruscos
    const groundY = getGroundHeight(px, pz);
    player.mesh.position.y += (groundY - player.mesh.position.y) * Math.min(15 * dt, 1);

    // Normal por diferencias finitas de la altura (heightfield)
    const e   = 0.7;
    const dHx = getGroundHeight(px + e, pz) - getGroundHeight(px - e, pz);
    const dHz = getGroundHeight(px, pz + e) - getGroundHeight(px, pz - e);
    _normal.set(-dHx, 2 * e, -dHz).normalize();

    // Orientación final = inclinación (up→normal) compuesta con el giro (facing)
    _tiltQuat.setFromUnitVectors(_up, _normal);
    _yawQuat.setFromAxisAngle(_up, player.facing);
    _targetQ.copy(_tiltQuat).multiply(_yawQuat);
    player.mesh.quaternion.slerp(_targetQ, Math.min(10 * dt, 1));
  } else {
    player.mesh.rotation.y = player.facing;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // CÁMARA — solo sigue posición, ángulo completamente fijo
  // ────────────────────────────────────────────────────────────────────────────
  const targetCamPos = player.mesh.position.clone().add(CAM_OFFSET);
  camera.position.lerp(targetCamPos, 8 * dt);
  camera.lookAt(player.mesh.position.clone().add(new THREE.Vector3(0, 1.5, 0)));

  // Sombra sigue al jugador
  lights.dir.target.position.copy(player.mesh.position);
  lights.dir.target.updateMatrixWorld();

  // Rim glow pulsante
  if (player.model) pulseRim(player.model, elapsed);

  // Niebla de guerra: descubre el entorno del jugador, y refresca el minimapa
  fog.reveal(player.mesh.position.x, player.mesh.position.z, 2);
  minimap.update(player.mesh.position.x, player.mesh.position.z, player.facing);

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
