# Sokoban Solver — make.fun bounty `sokoban-solver-01-run-20261121`

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/jhonrudi12/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/jhonrudi12/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A make.fun bounty entry for **"Build the best Sokoban solver, 21 November 2026"**
(`sokoban-solver-01-run-20261121`). One program answers all 5 instances of a
set in a single run (60 s wall budget); each instance is a Sokoban level in
XSB, and the answer is the player's moves using as few pushes as possible.
Score is 1,000 × the mean instance points (max 1,000,000); an instance solved
in its push-optimal count P\* earns full points.

## How it works

The levels are a one-square-wide hallway with 1–4 independent rooms off it.
A box pushed out of a room through its door can never be pushed back, so
every box stays in its own room and the level's push-optimal count is the sum
of its rooms' optima. The solver exploits exactly that:

1. **Decompose.** The hallway is the player's row; the other floor
   components are the rooms, each with one door onto the hallway.
2. **Solve each room push-optimally.** A push-based A\* over (sorted boxes,
   player reachable region), starting from the hallway square outside the
   door — a box may start on the door itself, and is pushed in from there.
   The heuristic is the minimum-cost assignment of boxes to goals under
   single-box push distances (an admissible relaxation), with dead-square
   pruning (cells no box can be pushed from to any goal) and 2×2 wall/box
   freeze pruning. A room solution must also leave the player able to walk
   back out to the hallway, so rooms chain.
3. **Stitch.** The room solutions are joined with shortest walks through the
   hallway. If decomposition ever fails, a whole-level push A\* is tried as
   a last resort.

Everything is deterministic — fixed direction order, a heap with an
insertion counter as tie-break, and expansion caps instead of any clock
(the program never reads the wall clock), so two runs write identical bytes.

## Results

Practice set (kit): **1,000,000 / 1,000,000** — every instance solved in
exactly P\* pushes (i001: 13, i002: 16, i003: 29, i004: 47, i005: 60),
whole set in ~0.25 s. Six further sets drawn fresh from the kit's own
generator (random seeds) also scored 1,000,000 each, ~0.3–0.4 s per set.
The house baseline (plain-astar 1.0.0) scores 200,000 on the practice set.

## Run it

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` is the whole entry: Node 22, no dependencies, nothing installed.
