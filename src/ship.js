import * as THREE from 'three';

// La nave: hub seguro del viajero interdimensional. Aquí reaparece al morir
// (con todo el maná perdido) y desde aquí, pisando el portal, se lanza a una
// nueva realidad a robar maná. Se construye lejos del origen (donde vive el
// laberinto) para que ambas escenas convivan sin solaparse, solo alternando
// visibilidad.
export function createShip(scene) {
  const OX = 300, OZ = 300;            // desplazamiento: aísla la nave del dungeon
  const HALF = 9, WALL_H = 4, WALL_T = 0.6;

  const group = new THREE.Group();
  group.visible = false;
  scene.add(group);

  // Suelo plano (casco de la nave)
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(HALF * 2, HALF * 2),
    new THREE.MeshToonMaterial({ color: 0x182238, emissive: 0x060a14 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(OX, 0, OZ);
  floor.receiveShadow = true;
  group.add(floor);

  // Muros perimetrales
  const wallMat = new THREE.MeshToonMaterial({ color: 0x2a3350, emissive: 0x0a1024 });
  const addWall = (dx, dz, w, d) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_H, d), wallMat);
    m.position.set(OX + dx, WALL_H / 2, OZ + dz);
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  };
  addWall(0, -HALF, HALF * 2 + WALL_T, WALL_T);
  addWall(0,  HALF, HALF * 2 + WALL_T, WALL_T);
  addWall(-HALF, 0, WALL_T, HALF * 2 + WALL_T);
  addWall( HALF, 0, WALL_T, HALF * 2 + WALL_T);

  // Tiras LED de ambiente en los 4 muros
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x43e0ff });
  const ledSpecs = [
    { dx: -HALF + 0.05, dz: 0, ry: Math.PI / 2 },
    { dx:  HALF - 0.05, dz: 0, ry: Math.PI / 2 },
    { dx: 0, dz: -HALF + 0.05, ry: 0 },
    { dx: 0, dz:  HALF - 0.05, ry: 0 },
  ];
  for (const { dx, dz, ry } of ledSpecs) {
    const led = new THREE.Mesh(new THREE.BoxGeometry(HALF * 1.6, 0.1, 0.06), ledMat);
    led.position.set(OX + dx, 2.6, OZ + dz);
    led.rotation.y = ry;
    group.add(led);
  }

  // Punto de aparición (cerca de un muro) y portal (lado opuesto)
  const spawn  = { x: OX, z: OZ + (HALF - 2.5) };
  const portal = { x: OX, z: OZ - (HALF - 2.5), radius: 1.8 };

  // Portal: anillo en el suelo + columna de energía
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.2, 1.8, 40),
    new THREE.MeshBasicMaterial({ color: 0x43e0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(portal.x, 0.05, portal.z);
  group.add(ring);

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(1.4, 1.4, 3.6, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x43e0ff, transparent: true, opacity: 0.32, side: THREE.DoubleSide })
  );
  beam.position.set(portal.x, 1.8, portal.z);
  group.add(beam);

  // Cristal de maná robado: crece y brilla más cuanto más se acumula
  const crystalMat = new THREE.MeshToonMaterial({
    color: 0x9a6bff, emissive: 0x6a2bff, emissiveIntensity: 0.6, transparent: true, opacity: 0.92,
  });
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), crystalMat);
  crystal.position.set(spawn.x + 2.4, 1.1, spawn.z - 1.2);
  group.add(crystal);
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.6, 0.9, 10),
    new THREE.MeshToonMaterial({ color: 0x3a4258 })
  );
  pedestal.position.set(crystal.position.x, 0.45, crystal.position.z);
  group.add(pedestal);

  // Luces de ambiente
  const light = new THREE.PointLight(0x6fb8ff, 14, 22, 1.8);
  light.position.set(OX, 3, OZ);
  group.add(light);
  const portalLight = new THREE.PointLight(0x43e0ff, 16, 14, 1.8);
  portalLight.position.set(portal.x, 1.6, portal.z);
  group.add(portalLight);

  let manaScale = 1;

  // Animación del portal/cristal — solo cuando la nave está visible
  function update(dt, elapsed) {
    if (!group.visible) return;
    ring.rotation.z += dt * 0.6;
    beam.rotation.y += dt * 0.4;
    crystal.rotation.y += dt * 0.8;
    const pulse = 1 + Math.sin(elapsed * 2) * 0.06;
    crystal.scale.setScalar(manaScale * pulse);
  }

  // El cristal refleja físicamente el maná robado acumulado
  function setMana(mana) {
    const m = Math.min(mana, 20);
    crystalMat.emissiveIntensity = 0.6 + m * 0.12;
    manaScale = 1 + m * 0.04;
  }

  // Colisión simple: el jugador no puede atravesar los muros de la nave
  function isWall(x, z) {
    return Math.abs(x - OX) > HALF - 0.6 || Math.abs(z - OZ) > HALF - 0.6;
  }

  return {
    spawn, portal,
    groundY: () => 0,
    isWall,
    setVisible: (v) => { group.visible = v; },
    update, setMana,
  };
}
