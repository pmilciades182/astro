import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Pistola sci-fi adjunta al hueso de la mano derecha (WristR): sigue
// automáticamente la animación de disparo. Se normaliza a WEAPON_LENGTH en
// unidades de MUNDO (descontando la escala del hueso) y se orienta con
// WEAPON_ROT, calibrada contra la dirección real del brazo.
const WEAPON_LENGTH = 0.54;
const WEAPON_POS    = new THREE.Vector3(0, 0, 0);
const WEAPON_ROT    = new THREE.Euler(-0.0342, 0.179, 1.3564);

// Debug visual: ejes locales (rojo=X cañón, verde=Y, azul=Z) + flecha de
// "adelante". true → arma siempre visible para recalibrar la orientación.
const DEBUG_WEAPON = false;

export function loadWeapon(model, player) {
  const hand = model.getObjectByName('WristR')
            || model.getObjectByName('HandR')
            || model.getObjectByName('mixamorigRightHand');
  if (!hand) { console.warn('No se encontró el hueso de la mano derecha'); return; }

  new GLTFLoader().load('/Scifi Pistol.glb', (g) => {
    const pistol = g.scene;
    pistol.traverse((n) => { if (n.isMesh) n.castShadow = true; });

    const box    = new THREE.Box3().setFromObject(pistol);
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;

    model.updateWorldMatrix(true, true);
    const handWorld = hand.getWorldScale(new THREE.Vector3()).x || 1;
    const s = WEAPON_LENGTH / (maxDim * handWorld);

    const pivot = new THREE.Group();
    pistol.scale.setScalar(s);
    pivot.add(pistol);
    pivot.position.copy(WEAPON_POS);
    pivot.rotation.copy(WEAPON_ROT);
    pivot.visible = false;
    hand.add(pivot);
    player.weapon = pivot;

    if (DEBUG_WEAPON) {
      const pistolAxes = new THREE.AxesHelper(maxDim * 1.4);
      pistolAxes.material.depthTest = false;
      pistol.add(pistolAxes);

      const pivotAxes = new THREE.AxesHelper(0.4 / handWorld);
      pivotAxes.material.depthTest = false;
      pivot.add(pivotAxes);

      const fwdArrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1.2, 0), 2.5, 0xffff00, 0.4, 0.25
      );
      fwdArrow.line.material.depthTest = false;
      fwdArrow.cone.material.depthTest = false;
      player.mesh.add(fwdArrow);

      pivot.visible = true;
      player.weaponDebug = true;
    }
  }, undefined, (err) => console.error('Error loading pistol:', err));
}
