import * as THREE from 'three';

// Iluminación de estación espacial: ambiente bajo + luz direccional tenue para
// dar forma, una luz que sigue al jugador (revela su entorno) y luces de color
// en los puntos clave del mapa (A, B, desafío, cofres). Esto crea sensación de
// "niebla de guerra" en 3D: solo lo iluminado se ve con claridad.

export function setupLighting(scene) {
  // Ambiente bajo: lo lejano queda en penumbra (niebla de guerra)
  const ambient = new THREE.AmbientLight(0x6f86b8, 0.6);
  scene.add(ambient);

  // Direccional fría tenue (volumen + sombras suaves)
  const dir = new THREE.DirectionalLight(0xaec6ff, 0.6);
  dir.position.set(8, 22, 8);
  dir.castShadow = true;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 0.1;
  dir.shadow.camera.far = 80;
  dir.shadow.camera.left = -30;
  dir.shadow.camera.right = 30;
  dir.shadow.camera.top = 30;
  dir.shadow.camera.bottom = -30;
  scene.add(dir);

  // Luz que acompaña al jugador (lámpara de exploración). Se devuelve para
  // que el loop la mueva con el personaje.
  const playerLight = new THREE.PointLight(0xbfe3ff, 26, 24, 1.5);
  scene.add(playerLight);

  return { ambient, dir, playerLight };
}

// Gestor de las luces específicas de cada mapa (se reconstruyen al regenerar).
export function createMapLights(scene, groundY) {
  const group = new THREE.Group();
  scene.add(group);

  const addPoint = (x, z, color, intensity, dist, yOff) => {
    const l = new THREE.PointLight(color, intensity, dist, 1.8);
    l.position.set(x, groundY(x, z) + yOff, z);
    group.add(l);
  };

  function rebuild(map) {
    while (group.children.length) group.remove(group.children.pop());
    addPoint(map.spawn.x, map.spawn.z, 0x33ff66, 18, 18, 2.4);          // A verde
    addPoint(map.exit.x,  map.exit.z,  0x33ccff, 22, 20, 2.8);          // B cian
    addPoint(map.challenge.x, map.challenge.z, 0xff8822, 30, 28, 3.2);  // desafío naranja
    for (const ch of map.chests) addPoint(ch.x, ch.z, 0xffd24a, 14, 15, 1.8); // cofres dorado
  }

  return { rebuild };
}
