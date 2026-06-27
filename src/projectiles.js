import * as THREE from 'three';

// Láseres naranjas que rebotan en los muros. Pool reutilizable; núcleo brillante
// + halo aditivo para un look muy visual en la escena oscura. Munición infinita.
export function createLasers(scene, isWall) {
  const SPEED = 44;          // unidades/s
  let lifetime = 1;          // segundos de vida (estándar; subible con power-ups)
  const MAX_BOUNCE = 6;      // rebotes antes de extinguirse
  const RADIUS = 0.12;

  // Geometrías compartidas; materiales clonados por-bolt para degradar su color
  const coreGeo = new THREE.CylinderGeometry(RADIUS, RADIUS, 1.6, 8);
  const glowGeo = new THREE.CylinderGeometry(RADIUS * 2.6, RADIUS * 2.6, 2.1, 8);

  // Degradado por edad: caliente (recién disparado) → frío/apagado al morir
  const CORE_HOT  = new THREE.Color(0xfff0b0);
  const CORE_COLD = new THREE.Color(0x7a1500);
  const GLOW_HOT  = new THREE.Color(0xff8a1e);
  const GLOW_COLD = new THREE.Color(0x551200);

  const pool = [];
  const _up = new THREE.Vector3(0, 1, 0);
  const _dir = new THREE.Vector3();
  const _q = new THREE.Quaternion();

  function makeBolt() {
    const g = new THREE.Group();
    const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial());
    const glow = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    g.add(core, glow);
    g.visible = false;
    g.userData = {
      vel: new THREE.Vector3(), life: 0, maxLife: 1, bounces: 0, active: false,
      coreMat: core.material, glowMat: glow.material,
    };
    scene.add(g);
    pool.push(g);
    return g;
  }

  // Orienta el cilindro (eje Y) a lo largo de la velocidad
  function orient(g) {
    _dir.copy(g.userData.vel).normalize();
    _q.setFromUnitVectors(_up, _dir);
    g.quaternion.copy(_q);
  }

  function spawn(origin, dir) {
    const g = pool.find((b) => !b.userData.active) || makeBolt();
    g.position.copy(origin);
    g.userData.vel.copy(dir).setY(0).normalize().multiplyScalar(SPEED);
    g.userData.life = lifetime;
    g.userData.maxLife = lifetime;
    g.userData.bounces = 0;
    g.userData.active = true;
    g.visible = true;
    g.userData.coreMat.color.copy(CORE_HOT);
    g.userData.glowMat.color.copy(GLOW_HOT);
    g.userData.glowMat.opacity = 0.45;
    orient(g);
  }

  function update(dt) {
    for (const g of pool) {
      const u = g.userData;
      if (!u.active) continue;

      u.life -= dt;
      if (u.life <= 0) { u.active = false; g.visible = false; continue; }

      // Degradado de color según la vida restante (1 = recién disparado)
      const t = u.life / u.maxLife;
      u.coreMat.color.copy(CORE_COLD).lerp(CORE_HOT, t);
      u.glowMat.color.copy(GLOW_COLD).lerp(GLOW_HOT, t);
      u.glowMat.opacity = 0.45 * t;

      // Avance con rebote por eje contra el grid (muros en bloque)
      let bounced = false;
      const nx = g.position.x + u.vel.x * dt;
      if (isWall(nx, g.position.z)) { u.vel.x *= -1; bounced = true; }
      else g.position.x = nx;

      const nz = g.position.z + u.vel.z * dt;
      if (isWall(g.position.x, nz)) { u.vel.z *= -1; bounced = true; }
      else g.position.z = nz;

      if (bounced) {
        if (++u.bounces > MAX_BOUNCE) { u.active = false; g.visible = false; continue; }
        orient(g);
      }
    }
  }

  // Power-ups: subir la vida del proyectil (más alcance/rebotes en el tiempo)
  const setLifetime = (s) => { lifetime = s; };
  const addLifetime = (d) => { lifetime += d; };

  // Para colisión con enemigos: balas activas y desactivación al impactar
  const getActive = () => pool.filter((b) => b.userData.active);
  const deactivate = (g) => { g.userData.active = false; g.visible = false; };

  return { spawn, update, setLifetime, addLifetime, getActive, deactivate, get lifetime() { return lifetime; } };
}
