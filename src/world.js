import * as THREE from 'three';
import { createTerrain } from './terrain.js';

export function setupWorld(scene) {
  // Suelo procedural (relieve + textura espacial) y sampler de altura.
  const { groundY } = createTerrain(scene);

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
  const wallMat   = new THREE.MeshToonMaterial({ color: 0x2c3a5c, emissive: 0x0a1024 });
  const trimMat   = new THREE.MeshToonMaterial({ color: 0x141d33 });   // remate más oscuro que el muro
  const chestBody = new THREE.MeshToonMaterial({ color: 0x8a5a2b });
  const chestLid  = new THREE.MeshToonMaterial({ color: 0xc8902b });
  const chestTrim = new THREE.MeshToonMaterial({ color: 0xffd24a });

  function disposeDungeon() {
    while (dungeon.children.length) {
      const c = dungeon.children.pop();
      c.traverse?.((o) => o.geometry?.dispose?.());
      dungeon.remove(c);
    }
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

    // 6) Construir muros (InstancedMesh) + remate de neón cian en la cima
    let wallCount = 0;
    for (let r = 0; r < GH; r++) for (let c = 0; c < GW; c++) if (grid[r][c]) wallCount++;
    const walls = new THREE.InstancedMesh(
      new THREE.BoxGeometry(cellSize, wallHeight, cellSize), wallMat, wallCount
    );
    walls.castShadow = walls.receiveShadow = true;
    const trim = new THREE.InstancedMesh(
      new THREE.BoxGeometry(cellSize * 0.96, 0.22, cellSize * 0.96), trimMat, wallCount
    );
    const dummy = new THREE.Object3D();
    let wi = 0;
    for (let r = 0; r < GH; r++) {
      for (let c = 0; c < GW; c++) {
        if (!grid[r][c]) continue;
        const [wx, wz] = cellToWorld(c, r);
        const baseY = groundY(wx, wz);
        dummy.position.set(wx, baseY + wallHeight / 2, wz);
        dummy.updateMatrix();
        walls.setMatrixAt(wi, dummy.matrix);
        dummy.position.set(wx, baseY + wallHeight + 0.02, wz);  // remate sobre la cima
        dummy.updateMatrix();
        trim.setMatrixAt(wi, dummy.matrix);
        wi++;
      }
    }
    walls.instanceMatrix.needsUpdate = true;
    trim.instanceMatrix.needsUpdate = true;
    dungeon.add(walls);
    dungeon.add(trim);

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

  generateDungeon();

  return {
    getGroundHeight: groundY,
    isWall,
    generate: generateDungeon,
    get map() { return mapData; },
  };
}
