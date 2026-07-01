import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createTerrain } from './terrain.js';
import { makeWallTextures, makeMetalTexture, getSignTexture, randomSignMessage } from './textures.js';

export function setupWorld(scene) {
  // Suelo procedural (relieve + textura espacial) y sampler de altura.
  const { groundY, mesh: groundMesh } = createTerrain(scene);

  // ── Dungeon procedural regenerable ────────────────────────────────────────
  // Grid de celdas; 1 = muro, 0 = piso. El anillo exterior queda como muro y
  // sirve de límite. Cada mapa tiene: punto A (inicio), punto B (salida),
  // 3 cofres y una zona central de desafío. Al llegar a B se regenera el mapa.
  const GW = 15, GH = 15;                 // dimensiones del grid (impares)
  const AREA = 90;                        // lado del mapa en unidades de mundo
  const cellSize = AREA / GW;
  const originX = -AREA / 2, originZ = -AREA / 2;
  const wallHeight = 3.2;
  const mid = (GW / 2) | 0;               // celda central

  const cellToWorld = (col, row) => [
    originX + (col + 0.5) * cellSize,
    originZ + (row + 0.5) * cellSize,
  ];

  let grid = [];                          // grid actual (cerrado en closures)
  let mapData = null;

  // Grupo que contiene TODO lo regenerable (muros, marcadores, cofres)
  const dungeon = new THREE.Group();
  scene.add(dungeon);

  // Materiales compartidos (no se recrean por regeneración) — paleta espacial
  const metalTex  = makeMetalTexture();                                // metal opaco con desgaste
  const trimMat   = new THREE.MeshToonMaterial({ color: 0x3a4258, map: metalTex }); // remate metálico oscuro
  // Ductos y cables decorativos sobre el remate
  const ductMat   = new THREE.MeshToonMaterial({ color: 0x8b94a4, map: metalTex, emissive: 0x12161d });
  const cableMat  = new THREE.MeshToonMaterial({ color: 0x3a4150, emissive: 0x0a0c12 });

  // Un material de muro por cada patrón de textura. En cada mapa se reparten por
  // zonas para que convivan varias texturas bien distribuidas.
  const wallMats = makeWallTextures().map((tex) =>
    new THREE.MeshToonMaterial({ color: 0xffffff, emissive: 0x0a1024, map: tex }));
  const ledMat = new THREE.MeshBasicMaterial();          // tiras LED (color por instancia)
  const chestBody = new THREE.MeshToonMaterial({ color: 0x8a5a2b });
  const chestLid  = new THREE.MeshToonMaterial({ color: 0xc8902b });
  const chestTrim = new THREE.MeshToonMaterial({ color: 0xffd24a });

  // Parche de shader: opacidad POR INSTANCIA (atributo `instanceOpacity`).
  // Permite atenuar muros concretos (los que tapan al jugador) sin afectar al
  // resto, aun compartiendo un único material/InstancedMesh.
  const patchInstanceOpacity = (mat) => {
    mat.transparent = true;
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
                 '#include <common>\nattribute float instanceOpacity;\nvarying float vInstOpacity;')
        .replace('#include <begin_vertex>',
                 '#include <begin_vertex>\nvInstOpacity = instanceOpacity;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
                 '#include <common>\nvarying float vInstOpacity;')
        .replace('#include <dithering_fragment>',
                 'gl_FragColor.a *= vInstOpacity;\n#include <dithering_fragment>');
    };
  };
  wallMats.forEach(patchInstanceOpacity);
  patchInstanceOpacity(trimMat);

  // Variante POR VÉRTICE (atributo `vertOpacity`) para mallas fusionadas
  // (cables, ductos) que no son instanced: cada vértice lleva la opacidad de
  // la celda de muro a la que pertenece su adorno.
  const patchVertexOpacity = (mat) => {
    mat.transparent = true;
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
                 '#include <common>\nattribute float vertOpacity;\nvarying float vVertOpacity;')
        .replace('#include <begin_vertex>',
                 '#include <begin_vertex>\nvVertOpacity = vertOpacity;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
                 '#include <common>\nvarying float vVertOpacity;')
        .replace('#include <dithering_fragment>',
                 'gl_FragColor.a *= vVertOpacity;\n#include <dithering_fragment>');
    };
  };
  patchInstanceOpacity(ledMat);     // LEDs: opacidad por instancia
  patchVertexOpacity(cableMat);
  patchVertexOpacity(ductMat);

  const cellKey = (c, r) => r * GW + c;

  // Estado de oclusión (refrescado en cada regeneración).
  // wallMeshes: un InstancedMesh por textura usada; cada uno con su array de
  // opacidad, el índice global (remate único) y la celda de cada instancia.
  let wallMeshes = [], trim = null, trimOpacity = null, wallCountCur = 0;
  // Adornos que también se atenúan según la celda de muro ocluida:
  let ledInfo = null;     // { opacityAttr, keys:Int32Array }
  let signList = [];      // [{ mesh, key }]
  let decoMeshes = [];    // [{ opacityAttr, keys:Int32Array }] (cables/ductos)
  const _ray = new THREE.Raycaster();
  const _dir = new THREE.Vector3();

  function disposeDungeon() {
    while (dungeon.children.length) {
      const c = dungeon.children.pop();
      c.traverse?.((o) => o.geometry?.dispose?.());
      dungeon.remove(c);
    }
  }

  // Adornos en caras de muro expuestas a un pasillo: carteles (mensajes
  // espaciales opacos) y tiras LED. Usa el `grid` actual.
  const LED_COLORS = [new THREE.Color(0x33d6ff), new THREE.Color(0xff8a2e), new THREE.Color(0x9a6bff)];
  const _ledDummy = new THREE.Object3D();
  const _ledTarget = new THREE.Vector3();

  function decorateWalls() {
    signList = [];
    ledInfo = null;
    // Caras expuestas: celda-muro con un vecino abierto → [c, r, dc, dr]
    const faces = [];
    for (let r = 1; r < GH - 1; r++) {
      for (let c = 1; c < GW - 1; c++) {
        if (grid[r][c] !== 1) continue;
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (grid[r + dr]?.[c + dc] === 0) faces.push([c, r, dc, dr]);
        }
      }
    }
    // Mezclar (Fisher–Yates)
    for (let i = faces.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [faces[i], faces[j]] = [faces[j], faces[i]];
    }

    // Repartir caras en carteles (pocos) y tiras LED (varias)
    const signFaces = [], ledFaces = [];
    for (const f of faces) {
      const roll = Math.random();
      if (signFaces.length < 7 && roll < 0.14) signFaces.push(f);
      else if (ledFaces.length < 34 && roll < 0.55) ledFaces.push(f);
    }

    // ── Carteles (planos opacos con textura de mensaje) ──────────────────────
    for (const [c, r, dc, dr] of signFaces) {
      const [wx, wz] = cellToWorld(c, r);
      const baseY = groundY(wx, wz);
      const px = wx + dc * (cellSize / 2 + 0.06);
      const pz = wz + dr * (cellSize / 2 + 0.06);
      // Material propio por cartel (textura compartida) para poder atenuarlo solo
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(cellSize * 0.62, cellSize * 0.38),
        new THREE.MeshBasicMaterial({ map: getSignTexture(randomSignMessage()), side: THREE.DoubleSide, transparent: true })
      );
      sign.position.set(px, baseY + 1.7, pz);
      // lookAt orienta +Z (frente del plano) hacia el objetivo → de cara al pasillo
      sign.lookAt(px + dc, baseY + 1.7, pz + dr);
      dungeon.add(sign);
      signList.push({ mesh: sign, key: cellKey(c, r) });
    }

    // ── Tiras LED (InstancedMesh con color y opacidad por instancia) ──────────
    if (ledFaces.length) {
      const ledGeo = new THREE.BoxGeometry(cellSize * 0.78, 0.14, 0.06);
      const ledOpacity = new Float32Array(ledFaces.length).fill(1);
      ledGeo.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(ledOpacity, 1));
      const ledKeys = new Int32Array(ledFaces.length);
      const leds = new THREE.InstancedMesh(ledGeo, ledMat, ledFaces.length);
      ledFaces.forEach(([c, r, dc, dr], i) => {
        const [wx, wz] = cellToWorld(c, r);
        const baseY = groundY(wx, wz);
        const px = wx + dc * (cellSize / 2 + 0.05);
        const pz = wz + dr * (cellSize / 2 + 0.05);
        const y = baseY + (Math.random() < 0.5 ? 1.1 : 2.4);   // banda baja o alta
        _ledDummy.position.set(px, y, pz);
        _ledTarget.set(px + dc, y, pz + dr);
        _ledDummy.lookAt(_ledTarget);
        _ledDummy.updateMatrix();
        leds.setMatrixAt(i, _ledDummy.matrix);
        leds.setColorAt(i, LED_COLORS[(Math.random() * LED_COLORS.length) | 0]);
        ledKeys[i] = cellKey(c, r);
      });
      leds.instanceMatrix.needsUpdate = true;
      if (leds.instanceColor) leds.instanceColor.needsUpdate = true;
      dungeon.add(leds);
      ledInfo = { opacityAttr: ledGeo.getAttribute('instanceOpacity'), keys: ledKeys };
    }
  }

  // Recorre los remates (cimas de muro) y genera adornos para que no sean
  // planos: CABLES colgantes (catenarias) entre cimas vecinas y DUCTOS
  // (tuberías) a lo largo de tramos rectos de muro. Todo se fusiona en 2 mallas.
  const _q4 = new THREE.Quaternion();
  const _m4 = new THREE.Matrix4();
  const _up = new THREE.Vector3(0, 1, 0);
  const _ddir = new THREE.Vector3();

  // Fusiona sub-geometrías etiquetadas por celda en una sola malla, con atributo
  // `vertOpacity` por vértice (para atenuar por celda en la oclusión).
  function buildMergedDeco(geos, cells, mat) {
    const keys = [];
    geos.forEach((g, i) => {
      const n = g.attributes.position.count;
      g.setAttribute('vertOpacity', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
      for (let k = 0; k < n; k++) keys.push(cells[i]);
    });
    const merged = BufferGeometryUtils.mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    dungeon.add(mesh);
    decoMeshes.push({ opacityAttr: merged.getAttribute('vertOpacity'), keys: Int32Array.from(keys) });
  }

  function decorateTrim() {
    decoMeshes = [];
    const isW = (c, r) => c >= 0 && c < GW && r >= 0 && r < GH && grid[r][c] === 1;
    const railY = (wx, wz) => groundY(wx, wz) + wallHeight + 0.18;

    // ── Cables: catenaria entre las cimas de dos muros vecinos ───────────────
    const cableGeos = [], cableCells = [];
    const addCable = (x1, z1, x2, z2, y, key) => {
      const sag = 0.18 + Math.random() * 0.28;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x1, y, z1),
        new THREE.Vector3((x1 + x2) / 2, y - sag, (z1 + z2) / 2),
        new THREE.Vector3(x2, y, z2),
      ]);
      cableGeos.push(new THREE.TubeGeometry(curve, 12, 0.05 + Math.random() * 0.025, 6, false));
      cableCells.push(key);
    };
    for (let r = 0; r < GH; r++) {
      for (let c = 0; c < GW; c++) {
        if (!isW(c, r)) continue;
        const [wx, wz] = cellToWorld(c, r);
        const y = railY(wx, wz);
        if (isW(c + 1, r) && Math.random() < 0.55) {     // vecino al este
          const [nx, nz] = cellToWorld(c + 1, r);
          const off = (Math.random() - 0.5) * cellSize * 0.4;
          addCable(wx, wz + off, nx, nz + off, y, cellKey(c, r));
        }
        if (isW(c, r + 1) && Math.random() < 0.55) {     // vecino al sur
          const [nx, nz] = cellToWorld(c, r + 1);
          const off = (Math.random() - 0.5) * cellSize * 0.4;
          addCable(wx + off, wz, nx + off, nz, y, cellKey(c, r));
        }
      }
    }
    if (cableGeos.length) buildMergedDeco(cableGeos, cableCells, cableMat);

    // ── Ductos: tubería a lo largo de tramos rectos de muro (≥3 celdas) ───────
    const ductGeos = [], ductCells = [];
    const addDuct = (x1, z1, x2, z2, y, radius, key) => {
      _ddir.set(x2 - x1, 0, z2 - z1);
      const len = _ddir.length() + cellSize;
      _ddir.normalize();
      const geo = new THREE.CylinderGeometry(radius, radius, len, 8);
      _q4.setFromUnitVectors(_up, _ddir);            // eje +Y del cilindro → dirección del tramo
      _m4.compose(new THREE.Vector3((x1 + x2) / 2, y, (z1 + z2) / 2), _q4, new THREE.Vector3(1, 1, 1));
      geo.applyMatrix4(_m4);
      ductGeos.push(geo);
      ductCells.push(key);
    };
    // tramos horizontales (misma fila)
    for (let r = 0; r < GH; r++) {
      let c = 0;
      while (c < GW) {
        if (!isW(c, r)) { c++; continue; }
        let c2 = c; while (c2 + 1 < GW && isW(c2 + 1, r)) c2++;
        if (c2 - c + 1 >= 3 && Math.random() < 0.6) {
          const [x1, z1] = cellToWorld(c, r); const [x2, z2] = cellToWorld(c2, r);
          const off = (Math.random() < 0.5 ? -1 : 1) * cellSize * 0.28;
          addDuct(x1, z1 + off, x2, z2 + off, railY(x1, z1) + 0.06, 0.11 + Math.random() * 0.04, cellKey(c, r));
        }
        c = c2 + 1;
      }
    }
    // tramos verticales (misma columna)
    for (let c = 0; c < GW; c++) {
      let r = 0;
      while (r < GH) {
        if (!isW(c, r)) { r++; continue; }
        let r2 = r; while (r2 + 1 < GH && isW(c, r2 + 1)) r2++;
        if (r2 - r + 1 >= 3 && Math.random() < 0.6) {
          const [x1, z1] = cellToWorld(c, r); const [x2, z2] = cellToWorld(c, r2);
          const off = (Math.random() < 0.5 ? -1 : 1) * cellSize * 0.28;
          addDuct(x1 + off, z1, x2 + off, z2, railY(x1, z1) + 0.06, 0.11 + Math.random() * 0.04, cellKey(c, r));
        }
        r = r2 + 1;
      }
    }
    if (ductGeos.length) buildMergedDeco(ductGeos, ductCells, ductMat);
  }

  // Disco/anillo plano sobre el suelo (marcador)
  function floorRing(x, z, rInner, rOuter, color, opacity = 0.85) {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(rInner, rOuter, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, groundY(x, z) + 0.04, z);
    return m;
  }

  function makeChest(x, z) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.7), chestBody);
    body.position.y = 0.35;
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.32, 0.74), chestLid);
    lid.position.y = 0.82;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(1.07, 0.14, 0.76), chestTrim);
    trim.position.y = 0.68;
    g.add(body, lid, trim);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.position.set(x, groundY(x, z), z);
    return g;
  }

  function generateDungeon() {
    disposeDungeon();

    // 1) Maze (recursive backtracker) — todo muro y se tallan pasillos
    grid = Array.from({ length: GH }, () => Array(GW).fill(1));
    const stack = [[1, 1]];
    grid[1][1] = 0;
    const DIRS = [[0, -2], [0, 2], [-2, 0], [2, 0]];
    while (stack.length) {
      const [cx, cy] = stack[stack.length - 1];
      const opts = [];
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx > 0 && nx < GW - 1 && ny > 0 && ny < GH - 1 && grid[ny][nx] === 1) {
          opts.push([nx, ny, dx, dy]);
        }
      }
      if (opts.length) {
        const [nx, ny, dx, dy] = opts[(Math.random() * opts.length) | 0];
        grid[cy + dy / 2][cx + dx / 2] = 0;
        grid[ny][nx] = 0;
        stack.push([nx, ny]);
      } else {
        stack.pop();
      }
    }
    // 2) Sala central de desafío: 3×3 abierto alrededor del centro
    for (let r = mid - 1; r <= mid + 1; r++)
      for (let c = mid - 1; c <= mid + 1; c++) grid[r][c] = 0;

    // 3) A (inicio) y B (salida) en esquinas opuestas, garantizadas abiertas
    const aCell = [1, 1], bCell = [GW - 2, GH - 2];
    grid[aCell[1]][aCell[0]] = 0;
    grid[bCell[1]][bCell[0]] = 0;
    const challengeCell = [mid, mid];

    const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const openNeighbors = (c, r) => {
      let n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dx, nr = r + dy;
        if (nc >= 0 && nc < GW && nr >= 0 && nr < GH && grid[nr][nc] === 0) n++;
      }
      return n;
    };

    // 4) 3 cofres en SALAS PROPIAS: usamos los dead-ends del laberinto perfecto
    //    (celda-corredor con una sola salida → ya tiene muros en 3 lados y una
    //    única entrada). Se eligen ANTES de abrir bucles para preservarlos.
    const avoid = [aCell, bCell, challengeCell];
    const deadEnds = [];
    for (let r = 1; r < GH - 1; r++)
      for (let c = 1; c < GW - 1; c++)
        if (grid[r][c] === 0 && openNeighbors(c, r) === 1) deadEnds.push([c, r]);
    deadEnds.sort(() => Math.random() - 0.5);

    const chestCells = [];
    const MIN_SEP = 3;
    for (const cell of deadEnds) {
      if (chestCells.length >= 3) break;
      if ([...avoid, ...chestCells].every((p) => cdist(p, cell) >= MIN_SEP)) chestCells.push(cell);
    }
    for (const cell of deadEnds) {   // fallback: relaja separación si faltan
      if (chestCells.length >= 3) break;
      if (!chestCells.includes(cell)) chestCells.push(cell);
    }

    // ¿Es (c,r) la sala de un cofre o uno de sus 3 muros? Para protegerla.
    const isChestArea = (c, r) =>
      chestCells.some(([cc, cr]) => (cc === c && cr === r) ||
        Math.abs(cc - c) + Math.abs(cr - r) === 1);

    // 5) Aperturas extra → bucles (más jugable), SIN tocar las salas de cofres
    //    para que cada cofre conserve su única entrada.
    for (let r = 1; r < GH - 1; r++)
      for (let c = 1; c < GW - 1; c++)
        if (grid[r][c] === 1 && !isChestArea(c, r) && Math.random() < 0.12) grid[r][c] = 0;

    // 6) Construir muros + remate oscuro en la cima.
    //    Repartimos las texturas por BLOQUES (zonas) para que en cada mapa
    //    convivan varios patrones bien distribuidos en lugar de uno solo.
    const BLK = 4;                       // lado del bloque en celdas
    const blockTex = new Map();
    const texFor = (c, r) => {
      const key = ((r / BLK) | 0) * 1000 + ((c / BLK) | 0);
      if (!blockTex.has(key)) blockTex.set(key, (Math.random() * wallMats.length) | 0);
      return blockTex.get(key);
    };

    // Celdas-muro con índice global (para el remate único)
    const cells = [];
    for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) if (grid[r][c]) cells.push([c, r]);
    wallCountCur = cells.length;

    // Remate: un único InstancedMesh, indexado por el índice global de celda
    trimOpacity = new Float32Array(wallCountCur).fill(1);
    trim = new THREE.InstancedMesh(
      new THREE.BoxGeometry(cellSize * 0.96, 0.22, cellSize * 0.96), trimMat, wallCountCur
    );
    trim.geometry.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(trimOpacity, 1));

    // Agrupar celdas por textura
    const groups = wallMats.map(() => []);
    cells.forEach(([c, r], gi) => groups[texFor(c, r)].push({ gi, c, r }));

    const dummy = new THREE.Object3D();
    wallMeshes = [];
    groups.forEach((list, ti) => {
      if (!list.length) return;
      const opacity = new Float32Array(list.length).fill(1);
      const globalIdx = new Int32Array(list.length);
      const cellKeys = new Int32Array(list.length);
      const geo = new THREE.BoxGeometry(cellSize, wallHeight, cellSize);
      geo.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(opacity, 1));
      const mesh = new THREE.InstancedMesh(geo, wallMats[ti], list.length);
      mesh.castShadow = mesh.receiveShadow = true;
      list.forEach(({ gi, c, r }, li) => {
        const [wx, wz] = cellToWorld(c, r);
        const baseY = groundY(wx, wz);
        dummy.position.set(wx, baseY + wallHeight / 2, wz);
        dummy.updateMatrix();
        mesh.setMatrixAt(li, dummy.matrix);
        globalIdx[li] = gi;
        cellKeys[li] = cellKey(c, r);
        dummy.position.set(wx, baseY + wallHeight + 0.02, wz);  // remate sobre la cima
        dummy.updateMatrix();
        trim.setMatrixAt(gi, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      dungeon.add(mesh);
      wallMeshes.push({ mesh, opacity, globalIdx, cellKeys });
    });
    trim.instanceMatrix.needsUpdate = true;
    dungeon.add(trim);

    // 6b) Adornos en caras de muro expuestas a un pasillo: carteles + tiras LED
    decorateWalls();
    // 6c) Adornos sobre el remate: cables colgantes y ductos metálicos
    decorateTrim();

    // 7) Marcadores: A verde, B cian, cofres, zona de desafío naranja
    const [ax, az] = cellToWorld(...aCell);
    const [bx, bz] = cellToWorld(...bCell);
    const [chx, chz] = cellToWorld(...challengeCell);

    dungeon.add(floorRing(ax, az, 1.0, 1.6, 0x33ff66));          // A
    dungeon.add(floorRing(bx, bz, 1.0, 1.6, 0x33ccff));          // B
    // Pilar/portal en B para verlo de lejos
    const portal = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.5, 3.0, 12),
      new THREE.MeshToonMaterial({ color: 0x33ccff, transparent: true, opacity: 0.5 })
    );
    portal.position.set(bx, groundY(bx, bz) + 1.5, bz);
    dungeon.add(portal);

    // Zona de desafío (anillo grande naranja en torno al centro)
    dungeon.add(floorRing(chx, chz, cellSize * 1.1, cellSize * 1.35, 0xff8822, 0.7));

    const chests = chestCells.map(([c, r]) => {
      const [x, z] = cellToWorld(c, r);
      const mesh = makeChest(x, z);
      dungeon.add(mesh);
      return { cell: [c, r], x, z, mesh, opened: false };
    });

    mapData = {
      grid, GW, GH, cellSize, originX, originZ,
      spawn:     { x: ax, z: az },
      exit:      { x: bx, z: bz, cell: bCell },
      challenge: { x: chx, z: chz, radius: cellSize * 1.3, cell: challengeCell },
      chests,
    };
    return mapData;
  }

  // ¿Es muro la posición de mundo (x,z)? Fuera de rango → muro (límite).
  const isWall = (worldX, worldZ) => {
    const c = Math.floor((worldX - originX) / cellSize);
    const r = Math.floor((worldZ - originZ) / cellSize);
    if (c < 0 || c >= GW || r < 0 || r >= GH) return true;
    return grid[r][c] === 1;
  };

  // Oclusión de cámara: los muros entre la cámara y el jugador se vuelven
  // semitransparentes para no tapar la vista. Raycast cámara→jugador, atenúa
  // las instancias golpeadas y restaura el resto (con fundido suave).
  const FADE = 0.18;          // opacidad de un muro que tapa
  const _occluding = new Set();
  const _occCells = new Set();   // celdas de muro actualmente ocluidas
  function updateOcclusion(camera, target) {
    if (!wallMeshes.length || !trimOpacity) return;
    _dir.copy(target).sub(camera.position);
    const dist = _dir.length();
    _dir.normalize();
    _ray.set(camera.position, _dir);
    _ray.far = Math.max(0, dist - 1.2);   // hasta poco antes del jugador
    _occCells.clear();
    for (const wm of wallMeshes) {
      _occluding.clear();
      for (const h of _ray.intersectObject(wm.mesh, false)) {
        if (h.instanceId != null) _occluding.add(h.instanceId);
      }
      for (let i = 0; i < wm.opacity.length; i++) {
        const occ = _occluding.has(i);
        const goal = occ ? FADE : 1;
        wm.opacity[i] += (goal - wm.opacity[i]) * 0.22;        // fundido muro
        const gi = wm.globalIdx[i];
        trimOpacity[gi] += (goal - trimOpacity[gi]) * 0.22;    // y su remate
        if (occ) _occCells.add(wm.cellKeys[i]);
      }
      wm.mesh.geometry.attributes.instanceOpacity.needsUpdate = true;
    }
    trim.geometry.attributes.instanceOpacity.needsUpdate = true;

    // Adornos: se atenúan si están en una celda de muro ocluida.
    if (ledInfo) {
      const arr = ledInfo.opacityAttr.array;
      for (let i = 0; i < ledInfo.keys.length; i++) {
        const goal = _occCells.has(ledInfo.keys[i]) ? FADE : 1;
        arr[i] += (goal - arr[i]) * 0.22;
      }
      ledInfo.opacityAttr.needsUpdate = true;
    }
    for (const s of signList) {
      const goal = _occCells.has(s.key) ? FADE : 1;
      s.mesh.material.opacity += (goal - s.mesh.material.opacity) * 0.22;
    }
    for (const d of decoMeshes) {
      const arr = d.opacityAttr.array;
      for (let v = 0; v < d.keys.length; v++) {
        const goal = _occCells.has(d.keys[v]) ? FADE : 1;
        arr[v] += (goal - arr[v]) * 0.22;
      }
      d.opacityAttr.needsUpdate = true;
    }
  }

  generateDungeon();

  // Oculta/muestra todo el dungeon (muros, suelo, cofres...) — se usa al viajar
  // entre la nave y las realidades, sin tener que destruir/reconstruir nada.
  function setVisible(v) {
    dungeon.visible = v;
    groundMesh.visible = v;
  }

  return {
    getGroundHeight: groundY,
    isWall,
    generate: generateDungeon,
    updateOcclusion,
    setVisible,
    get map() { return mapData; },
  };
}
