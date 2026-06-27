import * as THREE from 'three';

const OVERLAY_FLAG = 'isShaderOverlay';

// Crea un overlay que sigue el mismo esqueleto que el nodo original
function createOverlay(source, material) {
  if (source.isSkinnedMesh) {
    const mesh = new THREE.SkinnedMesh(source.geometry, material);
    mesh.skeleton = source.skeleton;
    mesh.bindMatrix.copy(source.bindMatrix);
    mesh.bindMatrixInverse.copy(source.bindMatrixInverse);
    mesh.bindMode = source.bindMode;
    return mesh;
  }
  return new THREE.Mesh(source.geometry, material);
}

// ── Outline back-face ─────────────────────────────────────────────────────────
export function addOutline(model, color = 0x111111, thickness = 0.05) {
  const meshes = [];
  model.traverse((node) => {
    if (node.isMesh && !node.userData[OVERLAY_FLAG]) meshes.push(node);
  });

  meshes.forEach((node) => {
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide });
    const outline = createOverlay(node, mat);
    outline.userData[OVERLAY_FLAG] = true;
    outline.scale.setScalar(1 + thickness);
    outline.renderOrder = -1;
    node.add(outline);
  });
}

// ── Rim / Fresnel glow ────────────────────────────────────────────────────────
// El vertex shader usa los chunks de Three.js para skinning correcto
export function addRimGlow(model, color = 0x00eeff, power = 2.2, intensity = 1.6) {
  const vertexShader = `
    #include <common>
    #include <skinning_pars_vertex>

    varying vec3 vNormal;
    varying vec3 vViewDir;

    void main() {
      // skinbase_vertex DEBE ir antes que skinnormal_vertex y skinning_vertex
      // porque define boneMatX/Y/Z/W que los otros chunks necesitan
      #include <skinbase_vertex>

      vec3 objectNormal = vec3(normal);
      #include <skinnormal_vertex>
      vNormal = normalize(normalMatrix * objectNormal);

      #include <begin_vertex>
      #include <skinning_vertex>

      vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0);
      vViewDir = normalize(-mvPosition.xyz);
      gl_Position = projectionMatrix * mvPosition;
    }
  `;

  const fragmentShader = `
    uniform vec3  rimColor;
    uniform float rimPower;
    uniform float rimIntensity;

    varying vec3 vNormal;
    varying vec3 vViewDir;

    void main() {
      float cosAngle = max(dot(vNormal, vViewDir), 0.0);
      float rim      = pow(1.0 - cosAngle, rimPower) * rimIntensity;
      gl_FragColor   = vec4(rimColor * rim, rim);
    }
  `;

  const meshes = [];
  model.traverse((node) => {
    if (node.isMesh && !node.userData[OVERLAY_FLAG]) meshes.push(node);
  });

  meshes.forEach((node) => {
    const rimMat = new THREE.ShaderMaterial({
      uniforms: {
        rimColor:     { value: new THREE.Color(color) },
        rimPower:     { value: power },
        rimIntensity: { value: intensity },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,
      side:        THREE.FrontSide,
    });

    const rimMesh = createOverlay(node, rimMat);
    rimMesh.userData[OVERLAY_FLAG] = true;
    rimMesh.renderOrder = 2;
    node.add(rimMesh);
  });
}

// ── Pulso del rim en cada frame ───────────────────────────────────────────────
export function pulseRim(model, time) {
  model.traverse((node) => {
    if (!node.isMesh || !node.userData[OVERLAY_FLAG]) return;
    const u = node.material?.uniforms;
    if (u?.rimIntensity) {
      u.rimIntensity.value = 1.0 + Math.sin(time * 2.5) * 0.6;
    }
  });
}
