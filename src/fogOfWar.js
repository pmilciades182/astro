// Niebla de guerra: registra qué celdas del mapa ha descubierto el jugador.
// Persistente por mapa (una vez vista, una celda queda revelada). El minimapa
// solo dibuja las celdas exploradas.

export function createFogOfWar() {
  let map = null;
  let explored = null;

  function setMap(m) {
    map = m;
    explored = Array.from({ length: m.GH }, () => Array(m.GW).fill(false));
  }

  // Revela las celdas dentro de `radius` (en celdas) alrededor de (x,z) mundo.
  function reveal(x, z, radius = 2) {
    if (!map) return;
    const c = Math.floor((x - map.originX) / map.cellSize);
    const r = Math.floor((z - map.originZ) / map.cellSize);
    const r2 = radius * radius + 0.5;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr * dr + dc * dc > r2) continue;
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < map.GH && cc >= 0 && cc < map.GW) explored[rr][cc] = true;
      }
    }
  }

  const isExplored = (c, r) =>
    !!explored && r >= 0 && r < map.GH && c >= 0 && c < map.GW && explored[r][c];

  return { setMap, reveal, isExplored };
}
