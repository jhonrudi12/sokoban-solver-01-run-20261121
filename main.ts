// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Strategy (written from scratch for this competition):
//   The levels are a hallway with 1-4 independent rooms off it; a box pushed
//   out of a room can never come back, so every box stays in its own room and
//   the level's push-optimal count is the sum of the rooms' optima. We solve
//   each room on its own with a push-based A* (a state is the boxes plus the
//   player's reachable region), then stitch the room solutions together with
//   walks through the hallway. A push-based search is what the score counts
//   (points fall off with extra pushes), so searching over pushes -- not over
//   single steps -- is the right space.
//
//   Heuristic: minimum-cost assignment of boxes to goals under single-box
//   push distances (a relaxation, hence admissible), computed by DP over
//   goal subsets. Pruning: dead squares (cells no box can be pushed from to
//   any goal, from a reverse push graph), and 2x2 wall/box freezes with no
//   goal inside. A room solution must also leave the player able to walk
//   back to the door, so rooms can be chained.
//
//   Everything is deterministic: fixed direction order, a heap with an
//   insertion counter as tie-break, and expansion caps instead of any clock
//   (the program never reads the wall clock, so two runs write identical
//   bytes). If a room's optimal search ever exhausts its cap, a greedy
//   best-first search falls back to any valid solution for that room; if
//   decomposition itself fails, a whole-level push A* is tried as a last
//   resort before giving up on the level.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// up, down, left, right. Fixed order everywhere: the search is deterministic.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

// Deterministic work budgets (never the clock).
const ROOM_EXPANSIONS = 3_000_000;
const ROOM_GREEDY_EXPANSIONS = 1_000_000;
const WHOLE_EXPANSIONS = 4_000_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

/** Flood fill from `from` over `allowed` cells, treating `blocked` cells as walls. Returns a sorted list. */
function region(w: number, allowed: Uint8Array, blocked: Uint8Array | null, from: number): number[] {
  const seen = new Uint8Array(allowed.length);
  const out: number[] = [from];
  seen[from] = 1;
  for (let i = 0; i < out.length; i++) {
    const c = out[i]!;
    const x = c % w;
    const y = (c / w) | 0;
    if (y > 0) {
      const q = c - w;
      if (allowed[q] && !(blocked && blocked[q]) && !seen[q]) { seen[q] = 1; out.push(q); }
    }
    if (y + 1 < allowed.length / w) {
      const q = c + w;
      if (allowed[q] && !(blocked && blocked[q]) && !seen[q]) { seen[q] = 1; out.push(q); }
    }
    if (x > 0) {
      const q = c - 1;
      if (allowed[q] && !(blocked && blocked[q]) && !seen[q]) { seen[q] = 1; out.push(q); }
    }
    if (x + 1 < w) {
      const q = c + 1;
      if (allowed[q] && !(blocked && blocked[q]) && !seen[q]) { seen[q] = 1; out.push(q); }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Shortest walk from `from` to `to` over `allowed` cells, avoiding `blocked` cells; '' when unreachable. */
function walkPath(w: number, h: number, allowed: Uint8Array, blocked: Uint8Array | null, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(allowed.length).fill(-1);
  const prevCh = new Array<string>(allowed.length).fill('');
  const queue: number[] = [from];
  prev[from] = from;
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i]!;
    for (let d = 0; d < 4; d++) {
      const nx = (c % w) + DX[d]!;
      const ny = ((c / w) | 0) + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const q = ny * w + nx;
      if (!allowed[q] || (blocked && blocked[q]) || prev[q] !== -1) continue;
      prev[q] = c;
      prevCh[q] = CH[d]!;
      if (q === to) {
        let s = '';
        for (let t = q; t !== from; t = prev[t]!) s = prevCh[t]! + s;
        return s;
      }
      queue.push(q);
    }
  }
  return '';
}

interface PushStep {
  /** Cell the box is pushed from. */
  from: number;
  /** Direction index 0..3. */
  dir: number;
}

interface RoomSolution {
  pushes: PushStep[];
  /** Player cell when the room is finished. */
  endPlayer: number;
}

/**
 * Push-optimal (A*) search for one room, or any solution via greedy fallback.
 * `boxCells` is where boxes may sit (the room, door included, never the
 * hallway); `playerCells` is where the player may stand (the room plus the
 * hallway square outside the door, so a box that starts on the door can be
 * pushed in from outside); `exit` is the cell the player must be able to
 * reach at the end (null = no exit requirement, used by the whole-level
 * fallback, where both masks are the whole floor).
 */
function solveRoom(
  w: number,
  h: number,
  wall: Uint8Array,
  goal: Uint8Array,
  boxCells: Uint8Array,
  playerCells: Uint8Array,
  boxes0: number[],
  goals: number[],
  startPlayer: number,
  exit: number | null,
  cap: number,
): RoomSolution | null {
  const n = boxes0.length;
  if (n === 0) return { pushes: [], endPlayer: startPlayer };
  const inBox = (c: number): boolean => c >= 0 && c < w * h && boxCells[c] === 1;
  const inPlayer = (c: number): boolean => c >= 0 && c < w * h && playerCells[c] === 1;

  // Single-box push distances to the nearest goal, by BFS over box positions
  // from every goal (a push p -> p+d needs floor at p+d and floor at p-d, where
  // the player stands). Cells the BFS never reaches are dead squares.
  const INF = 1 << 28;
  const distToGoal = new Int32Array(w * h).fill(INF);
  const bq: number[] = [];
  for (const g of goals) {
    distToGoal[g] = 0;
    bq.push(g);
  }
  for (let i = 0; i < bq.length; i++) {
    const c = bq[i]!;
    for (let d = 0; d < 4; d++) {
      const p = c - DY[d]! * w - DX[d]!;
      if (!inBox(p) || !inPlayer(p - DY[d]! * w - DX[d]!)) continue;
      if (distToGoal[p] === INF) {
        distToGoal[p] = distToGoal[c]! + 1;
        bq.push(p);
      }
    }
  }
  // Pairwise cell->goal push distances: cellGoalDist[c * m + gi] is the
  // single-box push distance from cell c to goal gi (Infinity when a box on
  // c can never be pushed onto gi). Same relaxation as distToGoal, per goal.
  const m0 = goals.length;
  const cellGoalDist = new Int32Array(w * h * m0).fill(INF);
  for (let gi = 0; gi < m0; gi++) {
    const dist = new Int32Array(w * h).fill(INF);
    const q: number[] = [goals[gi]!];
    dist[goals[gi]!] = 0;
    for (let i = 0; i < q.length; i++) {
      const c = q[i]!;
      for (let d = 0; d < 4; d++) {
        const p = c - DY[d]! * w - DX[d]!;
        if (!inBox(p) || !inPlayer(p - DY[d]! * w - DX[d]!)) continue;
        if (dist[p] === INF) {
          dist[p] = dist[c]! + 1;
          q.push(p);
        }
      }
    }
    for (let c = 0; c < w * h; c++) cellGoalDist[c * m0 + gi] = dist[c]!;
  }

  // Admissible heuristic: min-cost assignment of boxes to goals.
  const heuristic = (bs: number[]): number => {
    const m = goals.length;
    const dp = new Float64Array(1 << m).fill(Infinity);
    dp[0] = 0;
    for (let mask = 0; mask < (1 << m); mask++) {
      const bi = popcount(mask);
      if (bi >= n || dp[mask] === Infinity) continue;
      for (let gi = 0; gi < m; gi++) {
        if (mask & (1 << gi)) continue;
        const d = cellGoalDist[bs[bi]! * m + gi]!;
        if (d >= INF) continue;
        const nm = mask | (1 << gi);
        const v = dp[mask]! + d;
        if (v < dp[nm]!) dp[nm] = v;
      }
    }
    let best = Infinity;
    for (let mask = 0; mask < (1 << m); mask++) {
      if (popcount(mask) === n && dp[mask]! < best) best = dp[mask]!;
    }
    return best === Infinity ? INF : best;
  };

  const isGoalState = (bs: number[]): boolean => bs.every((b) => goal[b] === 1);

  // 2x2 freeze: a 2x2 block of wall/box with no goal inside and a box in it.
  const frozen = (bs: number[], boxSet: Uint8Array): boolean => {
    for (const b of bs) {
      if (goal[b] === 1) continue;
      const x = b % w;
      const y = (b / w) | 0;
      for (let oy = -1; oy <= 0; oy++) {
        for (let ox = -1; ox <= 0; ox++) {
          const x0 = x + ox;
          const y0 = y + oy;
          if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
          const cells4 = [y0 * w + x0, y0 * w + x0 + 1, (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1];
          let hasGoal = false;
          let hasBox = false;
          let allBlocked = true;
          for (const c of cells4) {
            if (goal[c] === 1) hasGoal = true;
            if (boxSet[c] === 1) hasBox = true;
            if (wall[c] === 0 && boxSet[c] === 0) allBlocked = false;
          }
          if (!hasGoal && hasBox && allBlocked) return true;
        }
      }
    }
    return false;
  };

  const search = (greedy: boolean): RoomSolution | null => {
    // State arrays; a state is (sorted boxes, player cell).
    const sBoxes: number[][] = [boxes0.slice()];
    const sPlayer: number[] = [startPlayer];
    const sParent: number[] = [-1];
    const sPush: (PushStep | null)[] = [null];
    const sG: number[] = [0];
    const best = new Map<string, number>();
    const keyOf = (bs: number[], reg: number[]): string => bs.join(',') + '|' + reg.join(',');

    const startBlocked = new Uint8Array(w * h);
    for (const b of boxes0) startBlocked[b] = 1;
    const startRegion = region(w, playerCells, startBlocked, startPlayer);
    best.set(keyOf(boxes0, startRegion), 0);

    // Binary heap on [f, g, counter, state].
    const heap: [number, number, number, number][] = [];
    let counter = 0;
    const h0 = heuristic(boxes0);
    if (h0 >= INF) return null;
    const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
      a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
    const heapPush = (e: [number, number, number, number]): void => {
      let i = heap.length;
      heap.push(e);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!heapLess(heap[i]!, heap[p]!)) break;
        [heap[i], heap[p]] = [heap[p]!, heap[i]!];
        i = p;
      }
    };
    const heapPop = (): [number, number, number, number] => {
      const top = heap[0]!;
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        for (let i = 0; ; ) {
          let c = 2 * i + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
          if (!heapLess(heap[c]!, heap[i]!)) break;
          [heap[i], heap[c]] = [heap[c]!, heap[i]!];
          i = c;
        }
      }
      return top;
    };
    heapPush([greedy ? h0 : h0, 0, counter++, 0]);

    let expanded = 0;
    const limit = greedy ? ROOM_GREEDY_EXPANSIONS : cap;
    while (heap.length > 0 && expanded < limit) {
      const [, g, , s] = heapPop();
      const bs = sBoxes[s]!;
      const pl = sPlayer[s]!;
      if (sG[s] !== g) continue;
      const blocked = new Uint8Array(w * h);
      for (const b of bs) blocked[b] = 1;
      const reg = region(w, playerCells, blocked, pl);
      if (best.get(keyOf(bs, reg)) !== s) continue;
      if (isGoalState(bs)) {
        if (exit === null || reg.includes(exit)) {
          const pushes: PushStep[] = [];
          for (let t = s; t > 0; t = sParent[t]!) pushes.push(sPush[t]!);
          pushes.reverse();
          return { pushes, endPlayer: pl };
        }
      }
      expanded++;
      const regSet = new Uint8Array(w * h);
      for (const c of reg) regSet[c] = 1;
      for (let bi = 0; bi < n; bi++) {
        const b = bs[bi]!;
        for (let d = 0; d < 4; d++) {
          const behind = b - DY[d]! * w - DX[d]!;
          const target = b + DY[d]! * w + DX[d]!;
          if (!inBox(target) || blocked[target] === 1) continue;
          if (!inPlayer(behind) || blocked[behind] === 1) continue;
          if (regSet[behind] === 0) continue;
          if (distToGoal[target]! >= INF) continue;
          const nb = bs.slice();
          nb[bi] = target;
          nb.sort((a, b2) => a - b2);
          const nbBlocked = new Uint8Array(w * h);
          for (const x of nb) nbBlocked[x] = 1;
          if (frozen(nb, nbBlocked)) continue;
          const h1 = heuristic(nb);
          if (h1 >= INF) continue;
          const nReg = region(w, playerCells, nbBlocked, b);
          const k = keyOf(nb, nReg);
          const seen = best.get(k);
          if (seen !== undefined && sG[seen]! <= g + 1) continue;
          const t = sBoxes.length;
          sBoxes.push(nb);
          sPlayer.push(b);
          sParent.push(s);
          sPush.push({ from: b, dir: d });
          sG.push(g + 1);
          best.set(k, t);
          heapPush([greedy ? h1 : g + 1 + h1, g + 1, counter++, t]);
        }
      }
    }
    return null;
  };

  return search(false) ?? search(true);
}

function popcount(x: number): number {
  let c = 0;
  while (x > 0) {
    c += x & 1;
    x >>= 1;
  }
  return c;
}

/** Replay a room's pushes into walk+push moves, starting from `player`. */
function replayPushes(
  w: number,
  h: number,
  wall: Uint8Array,
  allowed: Uint8Array,
  boxes: number[],
  player: number,
  pushes: PushStep[],
): string | null {
  let moves = '';
  let pl = player;
  const cur = boxes.slice();
  for (const p of pushes) {
    const blocked = new Uint8Array(w * h);
    for (const b of cur) blocked[b] = 1;
    const behind = p.from - DY[p.dir]! * w - DX[p.dir]!;
    const walk = walkPath(w, h, allowed, blocked, pl, behind);
    if (walk === '' && pl !== behind) return null;
    moves += walk;
    const idx = cur.indexOf(p.from);
    if (idx < 0) return null;
    const target = p.from + DY[p.dir]! * w + DX[p.dir]!;
    if (wall[target] || cur.includes(target)) return null;
    cur[idx] = target;
    cur.sort((a, b) => a - b);
    moves += CH[p.dir]!;
    pl = p.from;
  }
  return moves;
}

function solveLevel(text: string): string {
  const lv = parseLevel(text);
  const { w, h, wall, goal } = lv;
  if (lv.player < 0 || lv.boxes.length === 0) return '';

  // --- Decompose: hallway row = the player's row; rooms = the other components.
  const hallRow = (lv.player / w) | 0;
  const hall = new Uint8Array(w * h);
  {
    const seen = new Uint8Array(w * h);
    const q: number[] = [lv.player];
    seen[lv.player] = 1;
    for (let i = 0; i < q.length; i++) {
      const c = q[i]!;
      hall[c] = 1;
      for (let d = 0; d < 4; d++) {
        const nx = (c % w) + DX[d]!;
        const ny = ((c / w) | 0) + DY[d]!;
        if (ny !== hallRow || nx < 0 || nx >= w) continue;
        const n2 = ny * w + nx;
        if (!wall[n2] && !seen[n2]) {
          seen[n2] = 1;
          q.push(n2);
        }
      }
    }
  }

  interface Room {
    cells: Uint8Array;
    boxes: number[];
    goals: number[];
    door: number;
    entry: number;
  }
  const comp = new Int32Array(w * h).fill(-1);
  const rooms: Room[] = [];
  let compCount = 0;
  let decomposed = true;
  for (let c = 0; c < w * h; c++) {
    if (wall[c] || hall[c] || comp[c] !== -1) continue;
    // New component.
    const cells = new Uint8Array(w * h);
    const q: number[] = [c];
    comp[c] = compCount;
    cells[c] = 1;
    for (let i = 0; i < q.length; i++) {
      const cur = q[i]!;
      for (let d = 0; d < 4; d++) {
        const nx = (cur % w) + DX[d]!;
        const ny = ((cur / w) | 0) + DY[d]!;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n2 = ny * w + nx;
        if (!wall[n2] && !hall[n2] && comp[n2] === -1) {
          comp[n2] = compCount;
          cells[n2] = 1;
          q.push(n2);
        }
      }
    }
    compCount++;
    // Doors: component cells next to a hallway cell.
    const doors: number[] = [];
    let entry = -1;
    for (let i = 0; i < w * h; i++) {
      if (cells[i] !== 1) continue;
      for (let d = 0; d < 4; d++) {
        const nx = (i % w) + DX[d]!;
        const ny = ((i / w) | 0) + DY[d]!;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const n2 = ny * w + nx;
        if (hall[n2] === 1) {
          doors.push(i);
          if (entry === -1) entry = n2;
        }
      }
    }
    const rBoxes = lv.boxes.filter((b) => cells[b] === 1);
    const rGoals: number[] = [];
    for (let i = 0; i < w * h; i++) if (cells[i] === 1 && goal[i] === 1) rGoals.push(i);
    if (doors.length === 0 || rBoxes.length !== rGoals.length) {
      decomposed = false;
      break;
    }
    rooms.push({ cells, boxes: rBoxes, goals: rGoals, door: doors[0]!, entry });
  }
  // Every box must belong to exactly one room.
  if (decomposed) {
    const covered = rooms.reduce((a, r) => a + r.boxes.length, 0);
    if (covered !== lv.boxes.length) decomposed = false;
  }

  const floor = new Uint8Array(w * h);
  for (let c = 0; c < w * h; c++) if (!wall[c]) floor[c] = 1;
  if (decomposed && rooms.length > 0) {
    // Solve rooms one at a time, in reading order of their doors.
    rooms.sort((a, b) => a.door - b.door);
    let moves = '';
    let pl = lv.player;
    const curBoxes = lv.boxes.slice();
    for (const r of rooms) {
      // Walk to the room's entry square in the hallway.
      const blockedAll = new Uint8Array(w * h);
      for (const b of curBoxes) blockedAll[b] = 1;
      const toEntry = walkPath(w, h, floor, blockedAll, pl, r.entry);
      if (toEntry === '' && pl !== r.entry) return wholeLevel(lv);
      moves += toEntry;
      pl = r.entry;
      // The room is solved from the hallway square outside its door: a box
      // may start on the door itself, and is pushed in from here.
      const playerCells = r.cells.slice();
      playerCells[r.entry] = 1;
      const sol = solveRoom(w, h, wall, goal, r.cells, playerCells, r.boxes, r.goals, r.entry, r.entry, ROOM_EXPANSIONS);
      if (sol === null) return wholeLevel(lv);
      const roomMoves = replayPushes(w, h, wall, playerCells, r.boxes, pl, sol.pushes);
      if (roomMoves === null) return wholeLevel(lv);
      moves += roomMoves;
      pl = sol.endPlayer;
      // Update the level's boxes to their solved positions.
      const solved = r.boxes.slice();
      for (const p of sol.pushes) {
        const idx = solved.indexOf(p.from);
        solved[idx] = p.from + DY[p.dir]! * w + DX[p.dir]!;
      }
      solved.sort((a, b) => a - b);
      for (let i = 0; i < curBoxes.length; i++) {
        if (r.boxes.includes(curBoxes[i]!)) {
          // Replace this box with its solved position, in order.
          curBoxes[i] = solved.shift()!;
        }
      }
      curBoxes.sort((a, b) => a - b);
      // Walk back out to the hallway.
      const blockedSolved = new Uint8Array(w * h);
      for (const b of curBoxes) blockedSolved[b] = 1;
      const out = walkPath(w, h, floor, blockedSolved, pl, r.entry);
      if (out === '' && pl !== r.entry) return wholeLevel(lv);
      moves += out;
      pl = r.entry;
    }
    return moves;
  }
  return wholeLevel(lv);
}

/** Last resort: one push A* over the whole level (no exit requirement). */
function wholeLevel(lv: Level): string {
  const { w, h, wall, goal } = lv;
  const cells = new Uint8Array(w * h);
  for (let c = 0; c < w * h; c++) if (!wall[c]) cells[c] = 1;
  const goals: number[] = [];
  for (let c = 0; c < w * h; c++) if (goal[c] === 1) goals.push(c);
  const sol = solveRoom(w, h, wall, goal, cells, cells, lv.boxes, goals, lv.player, null, WHOLE_EXPANSIONS);
  if (sol === null) return '';
  const moves = replayPushes(w, h, wall, cells, lv.boxes, lv.player, sol.pushes);
  return moves ?? '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
