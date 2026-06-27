// Minimapa estilo Minecraft Dungeons: panel en la esquina superior derecha que
// se muestra/oculta con el botón abajo. Con niebla de guerra: solo dibuja las
// celdas ya exploradas (según fogOfWar). Muestra A, B, cofres, zona de desafío
// y la posición/orientación del jugador.

export function createMinimap() {
  const SIZE = 220, pad = 8;

  const wrap = document.createElement('div');
  wrap.id = 'minimap';
  Object.assign(wrap.style, {
    position: 'fixed', top: '16px', right: '16px',
    width: SIZE + 'px', height: SIZE + 'px',
    background: 'rgba(8,10,22,0.78)',
    border: '2px solid rgba(120,150,220,0.6)',
    borderRadius: '14px',
    boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
    padding: pad + 'px',
    pointerEvents: 'none', userSelect: 'none',
    display: 'none',
    backdropFilter: 'blur(2px)',
  });

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE - pad * 2;
  canvas.style.display = 'block';
  wrap.appendChild(canvas);

  const label = document.createElement('div');
  label.textContent = 'MAPA';
  Object.assign(label.style, {
    position: 'absolute', top: '-2px', left: '12px',
    transform: 'translateY(-50%)',
    font: 'bold 11px "Segoe UI", sans-serif', letterSpacing: '2px',
    color: '#bcd0ff', background: 'rgba(8,10,22,0.95)', padding: '1px 8px',
    borderRadius: '6px',
  });
  wrap.appendChild(label);
  document.body.appendChild(wrap);

  const ctx = canvas.getContext('2d');
  let map = null, fog = null, scale = 1;

  const worldToPx = (x, z) => [(x - map.originX) * scale, (z - map.originZ) * scale];

  function setMap(newMap, fogOfWar) {
    map = newMap;
    fog = fogOfWar;
    scale = canvas.width / (map.GW * map.cellSize);
  }

  let visible = false;
  function toggle() {
    visible = !visible;
    wrap.style.display = visible ? 'block' : 'none';
  }

  function update(px, pz, facing) {
    if (!visible || !map) return;
    const cs = map.cellSize * scale;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Celdas exploradas: piso/muro; lo no explorado queda oscuro (niebla)
    for (let r = 0; r < map.GH; r++) {
      for (let c = 0; c < map.GW; c++) {
        if (!fog.isExplored(c, r)) continue;
        ctx.fillStyle = map.grid[r][c] ? '#3a4a72' : '#161c30';
        ctx.fillRect(c * cs, r * cs, cs + 0.5, cs + 0.5);
      }
    }

    const cellExplored = (cell) => fog.isExplored(cell[0], cell[1]);

    // Zona de desafío (si su centro fue explorado)
    if (cellExplored(map.challenge.cell)) {
      const [cx, cy] = worldToPx(map.challenge.x, map.challenge.z);
      ctx.strokeStyle = '#ff8822'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, map.challenge.radius * scale, 0, Math.PI * 2); ctx.stroke();
    }

    const dot = (wx, wz, color, rad) => {
      const [x, y] = worldToPx(wx, wz);
      ctx.fillStyle = color; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    };

    // A y B (al descubrirse). El cell de A/B siempre se explora al spawnear.
    const aCell = [Math.floor((map.spawn.x - map.originX) / map.cellSize),
                   Math.floor((map.spawn.z - map.originZ) / map.cellSize)];
    if (cellExplored(aCell)) dot(map.spawn.x, map.spawn.z, '#33ff66', 5);
    if (cellExplored(map.exit.cell)) dot(map.exit.x, map.exit.z, '#33ccff', 5);

    // Cofres (solo los descubiertos)
    for (const ch of map.chests) {
      if (!cellExplored(ch.cell)) continue;
      const [x, y] = worldToPx(ch.x, ch.z);
      ctx.fillStyle = ch.opened ? '#7a6a3a' : '#ffd24a';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.fillRect(x - 3, y - 3, 6, 6); ctx.strokeRect(x - 3, y - 3, 6, 6);
    }

    // Jugador (flecha; +Z es el frente → punta hacia +Y)
    const [x, y] = worldToPx(px, pz);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-facing);
    ctx.fillStyle = '#ffe04a'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, 8); ctx.lineTo(-5, -5); ctx.lineTo(5, -5); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  return { toggle, setMap, update, get visible() { return visible; } };
}
