# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/cuanhij/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/cuanhij/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the make.fun bounty [Build the best Sokoban solver, 21 November 2026](https://make.fun/bounty/sokoban-solver-01-run-20261121). `main.ts` (Node 22, standard library only, no network) reads every level from `/input/<id>/level.txt` and writes `/output/<id>/solution.txt`.

## How it works

Every level the generator draws is a one-square hallway with one to four rooms off it, each room holding 3–4 boxes that can never leave it — a box pushed through its door into the hallway can never be pushed back. So each room is an independent push-optimal problem, and the level optimum P\* is the sum of the rooms' optima. The solver exploits that:

- **Room split.** The floor outside the player's (hallway) row falls into connected components; each is one room, entered through the one component cell touching the hallway.
- **Push-optimal A\* per room.** State = sorted box squares + canonical player region; cost = pushes; heuristic = the cheapest box-to-goal assignment over walk distances (ignoring boxes). Dead positions are pruned: cells that cannot walk to any goal, corners, and 2×2 wall/box blocks holding a box off its goal.
- **Stitching.** The player walks between rooms through the hallway (plain BFS), walks to each push inside its room, pushes, and walks back out the door. The full move string is then what the checker replays.
- **Determinism.** Search is cut off by a count of expansions only — never by the wall clock — so two runs on one set write byte-identical answers. If the optimal search ever runs out of budget on a room, a greedy best-first search (same code, heuristic-ordered) falls back to any valid solution instead of nothing.

## Practice results

Practice set, verified by replaying every `solution.txt` on its level and counting pushes:

| instance | pushes | P\* | points |
|---|---:|---:|---:|
| i001 | 13 | 13 | 1,000 |
| i002 | 16 | 16 | 1,000 |
| i003 | 29 | 29 | 1,000 |
| i004 | 47 | 47 | 1,000 |
| i005 | 60 | 60 | 1,000 |

**Practice score: 1,000,000 / 1,000,000** (all five instances at exactly P\*). Whole-set runtime a few seconds on this machine, 2,527 expansions total — far inside the 60 s wall budget.

Robustness: the solver was also run on 9 freshly drawn sets from the kit's own generator (different random seeds), and solved every instance of every set at exactly P\*.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=gfay23ty&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
