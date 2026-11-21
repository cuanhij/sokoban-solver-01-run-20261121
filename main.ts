// Sokoban solver: per-room push-optimal search, stitched through the hallway.
//
// Idea: every level the generator draws is a one-square hallway with one to four
// rooms off it, each room holding 3-4 boxes that can never leave it (a box pushed
// through the door into the hallway can never be pushed back). So each room is an
// independent push-optimal problem, and the level optimum P* is the sum of the
// rooms' optima. This program solves every room with a push-based A* (state =
// sorted box squares + canonical player region, cost = pushes, heuristic = the
// cheapest box-to-goal assignment over walk distances), then walks the player
// between rooms through the hallway and replays each room's pushes.
//
// Determinism: the search is cut off by a count of expansions only, never by the
// wall clock, and it never reads the clock or the environment to decide anything,
// so two runs on one set write byte-identical answers.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEBUG = process.env.MAKEFUN_DEBUG === '1';

// Expansion budgets. They bound work, not time, so the program always finishes
// inside the 60 s wall budget and always answers the same way twice.
const ASTAR_BUDGET_PER_ROOM = 20_000;
const GREEDY_BUDGET_PER_ROOM = 10_000;
const GLOBAL_BUDGET = 50_000;

type Dir = [number, number, string];
const DIRS: Dir[] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: Set<number>;
  boxes: number[];
  player: number;
}

function parse(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = new Set<number>();
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch !== '#') wall[i] = 0;
      if ('.*+'.includes(ch)) goals.add(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  return { w, h, wall, goals, boxes, player };
}

// Breadth-first walk distances from `from` over cells where pass(cell) holds.
// Returns the distance array (-1 = unreachable) and the predecessor array.
function bfs(L: Level, from: number, pass: (c: number) => boolean): { dist: Int32Array; prev: Int32Array } {
  const n = L.w * L.h;
  const dist = new Int32Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const q: number[] = [from];
  dist[from] = 0;
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    const cx = c % L.w;
    const cy = Math.floor(c / L.w);
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d]![0];
      const ny = cy + DIRS[d]![1];
      if (nx < 0 || ny < 0 || nx >= L.w || ny >= L.h) continue;
      const m = ny * L.w + nx;
      if (dist[m] !== -1 || !pass(m)) continue;
      dist[m] = dist[c]! + 1;
      prev[m] = c;
      q.push(m);
    }
  }
  return { dist, prev };
}

// The walk (as u/d/l/r letters) from `from` to `to`, or null when unreachable.
// Boxes and walls block; the caller supplies the pass test.
function walkMoves(L: Level, from: number, to: number, pass: (c: number) => boolean): string | null {
  if (from === to) return '';
  const { dist, prev } = bfs(L, from, pass);
  if (dist[to] === -1) return null;
  const steps: number[] = [];
  for (let cur = to; cur !== from; cur = prev[cur]!) steps.push(cur);
  steps.reverse();
  let out = '';
  let p = from;
  for (const m of steps) {
    const d = m - p;
    out += d === 1 ? 'r' : d === -1 ? 'l' : d === L.w ? 'd' : 'u';
    p = m;
  }
  return out;
}

// Rooms: the connected components of floor cells outside the player's row
// (the hallway). Each component is one room; its door is the component cell
// touching the hallway row.
function findRooms(L: Level): { rooms: number[][]; hy: number } {
  const hy = Math.floor(L.player / L.w);
  const seen = new Uint8Array(L.w * L.h);
  const rooms: number[][] = [];
  for (let i = 0; i < L.w * L.h; i++) {
    if (L.wall[i] || Math.floor(i / L.w) === hy || seen[i]) continue;
    const comp: number[] = [];
    const stack: number[] = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const cx = c % L.w;
      const cy = Math.floor(c / L.w);
      for (let d = 0; d < 4; d++) {
        const nx = cx + DIRS[d]![0];
        const ny = cy + DIRS[d]![1];
        if (nx < 0 || ny < 0 || nx >= L.w || ny >= L.h) continue;
        const q = ny * L.w + nx;
        if (L.wall[q] || ny === hy || seen[q]) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    rooms.push(comp);
  }
  return { rooms, hy };
}

interface RoomResult {
  ok: boolean;
  pushes: [number, number][]; // [box square before the push, direction index]
  expanded: number;
}

// A push-based search over one room (or, as a fallback, the whole level).
// floorCells: every cell the player may walk on (room cells + the entry cell).
// roomCells: cells a box may ever sit on (the entry cell excluded: a box pushed
// out of the door is lost). entry: where the player starts. budget: expansions.
// greedy: when true, order the open list by the heuristic alone (first solution
// found wins; used only after the optimal search runs out of budget).
function solveRoom(
  L: Level,
  floorCells: number[],
  roomCells: number[],
  entry: number,
  startBoxes: number[],
  goals: Set<number>,
  budget: number,
  greedy: boolean,
  global: { used: number; limit: number },
): RoomResult {
  const nCells = L.w * L.h;
  const inFloor = new Uint8Array(nCells);
  for (const c of floorCells) inFloor[c] = 1;
  const inRoom = new Uint8Array(nCells);
  for (const c of roomCells) inRoom[c] = 1;
  const isGoal = (c: number): boolean => goals.has(c);
  const goalArr = [...goals];
  const n = startBoxes.length;

  // Walk distances between floor cells, ignoring boxes: dist[a * nCells + b].
  const dist = new Int32Array(nCells * nCells).fill(-1);
  for (const a of floorCells) {
    const { dist: d } = bfs(L, a, (c) => inFloor[c] === 1);
    for (const b of floorCells) dist[a * nCells + b] = d[b]!;
  }
  const dBetween = (a: number, b: number): number => {
    const v = dist[a * nCells + b];
    return v === -1 ? Infinity : v;
  };

  // A floor cell that cannot walk to any goal can never hold a box on the way
  // to a solution (a box only travels along floor cells).
  const deadCell = new Uint8Array(nCells);
  for (const c of roomCells) {
    if (isGoal(c)) continue;
    let ok = false;
    for (const g of goalArr) {
      if (dBetween(c, g) !== Infinity) { ok = true; break; }
    }
    if (!ok) deadCell[c] = 1;
  }

  // The 2x2 blocks each cell belongs to, for the deadlock test.
  const blocksOf: number[][][] = Array.from({ length: nCells }, () => []);
  for (const c of floorCells) {
    const x = c % L.w;
    const y = Math.floor(c / L.w);
    if (x + 1 >= L.w || y + 1 >= L.h) continue;
    const block = [c, c + 1, c + L.w, c + L.w + 1];
    for (const q of block) blocksOf[q]!.push(block);
  }

  // Heuristic: the cheapest assignment of boxes to goals over walk distances
  // (brute-force permutations while the room is small; the sum of each box's
  // nearest goal when it is not). Every push moves one box one square, so the
  // assignment sum is a lower bound on the pushes still needed.
  const heuristic = (boxes: number[]): number => {
    if (n <= 5) {
      let best = Infinity;
      const perm = goalArr.slice();
      const rec = (i: number, acc: number): void => {
        if (acc >= best) return;
        if (i === n) { best = acc; return; }
        for (let j = i; j < n; j++) {
          const t = perm[i]!; perm[i] = perm[j]!; perm[j] = t;
          const d = dBetween(boxes[i]!, perm[i]!);
          if (d !== Infinity) rec(i + 1, acc + d);
          const t2 = perm[i]!; perm[i] = perm[j]!; perm[j] = t2;
        }
      };
      rec(0, 0);
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (const g of goalArr) {
        const d = dBetween(b, g);
        if (d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  const keyOf = (boxes: number[], reg: number): number | string => {
    if (n <= 4) {
      let k = reg;
      for (let i = n - 1; i >= 0; i--) k = k * 1024 + boxes[i]!;
      return k;
    }
    return boxes.join(',') + '|' + reg;
  };

  // Is the box just pushed onto `dest` dead? Only the moved box can newly be
  // dead: a corner (two perpendicular walls), a dead cell, or completing a 2x2
  // block of walls and boxes that holds a box off its goal.
  const movedBoxDead = (dest: number, boxSet: Set<number>): boolean => {
    if (isGoal(dest)) return false;
    if (deadCell[dest]) return true;
    const wallAt = (c: number): boolean => inFloor[c] === 0;
    const up = dest - L.w;
    const dn = dest + L.w;
    const lf = dest - 1;
    const rt = dest + 1;
    if ((wallAt(up) && wallAt(lf)) || (wallAt(up) && wallAt(rt)) ||
        (wallAt(dn) && wallAt(lf)) || (wallAt(dn) && wallAt(rt))) return true;
    for (const block of blocksOf[dest]!) {
      let boxesHere = 0;
      let allBlocked = true;
      for (const q of block) {
        if (boxSet.has(q)) boxesHere++;
        else if (inFloor[q] === 1) allBlocked = false;
      }
      if (boxesHere > 0 && allBlocked) {
        if (block.some((q) => boxSet.has(q) && !isGoal(q))) return true;
      }
    }
    return false;
  };

  // The player's reachable region from `from` with these boxes in the way:
  // its smallest square is the state's canonical player position.
  const regionMin = (from: number, boxSet: Set<number>): number => {
    const { dist: d } = bfs(L, from, (c) => inFloor[c] === 1 && !boxSet.has(c));
    let m = Infinity;
    for (const c of floorCells) if (d[c] !== -1 && c < m) m = c;
    return m;
  };

  const start = startBoxes.slice().sort((a, b) => a - b);
  const startSet = new Set(start);
  const startReg = regionMin(entry, startSet);
  const hCache = new Map<number | string, number>();
  const hOf = (boxes: number[]): number => {
    const k = keyOf(boxes, 0);
    let v = hCache.get(k);
    if (v === undefined) {
      v = heuristic(boxes);
      hCache.set(k, v);
    }
    return v;
  };
  if (hOf(start) === Infinity) return { ok: false, pushes: [], expanded: 0 };

  // Open list: a binary heap on [priority, -g (deeper first), insertion order].
  const heap: [number, number, number][] = [];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const hpush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      const t = heap[i]!; heap[i] = heap[p]!; heap[p] = t;
      i = p;
    }
  };
  const hpop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        const t = heap[i]!; heap[i] = heap[c]!; heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  const nodesBoxes: number[][] = [start];
  const nodesReg: number[] = [startReg];
  const nodesParent: number[] = [-1];
  const nodesPush: ([number, number] | null)[] = [null];
  const nodesG: number[] = [0];
  const best = new Map<number | string, number>([[keyOf(start, startReg), 0]]);
  const h0 = hOf(start);
  hpush([greedy ? h0 : h0, 0, 0]);
  let expanded = 0;
  let goalNode = -1;
  while (heap.length) {
    const [, negG, id] = hpop();
    const g = -negG;
    const boxes = nodesBoxes[id]!;
    const reg = nodesReg[id]!;
    if (best.get(keyOf(boxes, reg)) !== id) continue;
    if (boxes.every((b) => isGoal(b))) { goalNode = id; break; }
    if (++expanded > budget || ++global.used > global.limit) {
      return { ok: false, pushes: [], expanded };
    }
    const bs = new Set(boxes);
    const { dist: reach } = bfs(L, reg, (c) => inFloor[c] === 1 && !bs.has(c));
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let di = 0; di < 4; di++) {
        const dx = DIRS[di]![0];
        const dy = DIRS[di]![1];
        const dest = b + dy * L.w + dx;
        const behind = b - dy * L.w - dx;
        if (inRoom[dest] === 0 || bs.has(dest)) continue;
        if (inFloor[behind] === 0 || reach[behind] === -1) continue;
        const nb = boxes.slice();
        nb[bi] = dest;
        nb.sort((a, c) => a - c);
        const nbs = new Set(nb);
        if (movedBoxDead(dest, nbs)) continue;
        const hv = hOf(nb);
        if (hv === Infinity) continue;
        const nreg = regionMin(b, nbs);
        const k = keyOf(nb, nreg);
        const prev = best.get(k);
        if (prev !== undefined && nodesG[prev]! <= g + 1) continue;
        const nid = nodesBoxes.length;
        nodesBoxes.push(nb);
        nodesReg.push(nreg);
        nodesParent.push(id);
        nodesPush.push([b, di]);
        nodesG.push(g + 1);
        best.set(k, nid);
        const prio = greedy ? hv : g + 1 + hv;
        hpush([prio, -(g + 1), nid]);
      }
    }
  }
  if (goalNode < 0) return { ok: false, pushes: [], expanded };
  const pushes: [number, number][] = [];
  for (let t = goalNode; t > 0; t = nodesParent[t]!) pushes.push(nodesPush[t]!);
  pushes.reverse();
  return { ok: true, pushes, expanded };
}

// Solve one level. Returns the move string, or '' when it cannot be solved.
function solveLevel(text: string, global: { used: number; limit: number }): { moves: string; stats: string } {
  const L = parse(text);
  const stats: string[] = [];
  if (L.boxes.every((b) => L.goals.has(b))) return { moves: '', stats: 'already solved' };
  const { rooms, hy } = findRooms(L);

  // The per-room plan, each entry: the pushes to play once the player stands
  // on the entry cell outside that room's door.
  interface Plan { entry: number; pushes: [number, number][]; }
  const plans: Plan[] = [];
  for (const comp of rooms) {
    const compSet = new Set(comp);
    const doors = comp.filter((c) => Math.abs(Math.floor(c / L.w) - hy) === 1);
    if (doors.length !== 1) return { moves: '', stats: `room with ${doors.length} doors` };
    const door = doors[0]!;
    const entry = Math.floor(door / L.w) < hy ? door + L.w : door - L.w;
    const roomBoxes = L.boxes.filter((b) => compSet.has(b));
    const roomGoals = new Set([...L.goals].filter((g) => compSet.has(g)));
    const floorCells = [...comp, entry];
    let res = solveRoom(L, floorCells, comp, entry, roomBoxes, roomGoals, ASTAR_BUDGET_PER_ROOM, false, global);
    stats.push(`room(${roomBoxes.length}b):astar exp=${res.expanded} ok=${res.ok}`);
    if (!res.ok) {
      // Fall back to a greedy best-first search: any valid solution still
      // earns points, and it keeps the run inside its work budget.
      res = solveRoom(L, floorCells, comp, entry, roomBoxes, roomGoals, GREEDY_BUDGET_PER_ROOM, true, global);
      stats.push(`room(${roomBoxes.length}b):greedy exp=${res.expanded} ok=${res.ok}`);
    }
    if (!res.ok) return { moves: '', stats: stats.join('; ') };
    plans.push({ entry, pushes: res.pushes });
  }

  if (plans.length === 0) {
    // No rooms found: try one search over the whole level as a last resort.
    const floorCells: number[] = [];
    for (let c = 0; c < L.w * L.h; c++) if (!L.wall[c]) floorCells.push(c);
    const res = solveRoom(L, floorCells, floorCells, L.player, L.boxes, L.goals, ASTAR_BUDGET_PER_ROOM, false, global);
    stats.push(`global:astar exp=${res.expanded} ok=${res.ok}`);
    if (!res.ok) return { moves: '', stats: stats.join('; ') };
    plans.push({ entry: L.player, pushes: res.pushes });
  }

  // Stitch the plans: walk the player between rooms through the hallway,
  // walk to each push inside its room, push, and walk back out its door.
  let player = L.player;
  const boxAt = new Set(L.boxes);
  const passGlobal = (c: number): boolean => L.wall[c] === 0 && !boxAt.has(c);
  let moves = '';
  for (const plan of plans) {
    const w1 = walkMoves(L, player, plan.entry, passGlobal);
    if (w1 === null) return { moves: '', stats: stats.join('; ') + '; cannot reach entry' };
    moves += w1;
    player = plan.entry;
    for (const [boxFrom, di] of plan.pushes) {
      const dx = DIRS[di]![0];
      const dy = DIRS[di]![1];
      const behind = boxFrom - dy * L.w - dx;
      const w2 = walkMoves(L, player, behind, passGlobal);
      if (w2 === null) return { moves: '', stats: stats.join('; ') + '; cannot reach push' };
      moves += w2;
      moves += DIRS[di]![2];
      boxAt.delete(boxFrom);
      boxAt.add(boxFrom + dy * L.w + dx);
      player = boxFrom;
    }
    const w3 = walkMoves(L, player, plan.entry, passGlobal);
    if (w3 === null) return { moves: '', stats: stats.join('; ') + '; cannot exit room' };
    moves += w3;
    player = plan.entry;
  }
  return { moves, stats: stats.join('; ') };
}

const global = { used: 0, limit: GLOBAL_BUDGET };
for (const id of readdirSync(I).sort()) {
  const { moves, stats } = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'), global);
  if (DEBUG) console.error(`${id}: ${stats} moves=${moves.length} globalUsed=${global.used}`);
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
