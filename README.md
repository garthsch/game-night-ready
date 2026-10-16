# Readiness Check

Press one button before a session and see what is still outstanding in the world
you are about to run.

Paying for content does not buy readiness. Commercial Foundry material ranges
from full builds with walls, lighting and configured sheets down to flat PDFs
dropped into journal entries, and you usually cannot tell which you have until
you are mid-prep. The unconverted remainder lands on you regardless of what you
spent. This module tells you what is left.

It reports **completeness, not correctness**. A wall in the wrong place passes.
Whether the room is worth walking into is yours to judge.

## What it checks

| Competency | Coverage |
|---|---|
| Canvas and spatial calibration | Full — grid calibration, background, walls, doors, sight-blocking, lights, scene and token vision, global illumination |
| System automation execution | Token-to-actor links |
| Visual tools and preparation | Map notes linked to journal entries, journal presence |
| Vanilla-first discipline | Active module count |
| Server administration | Partial — user-to-character assignment. Whether players can reach your server is invisible from inside the client |
| Facilitation and troubleshooting | Not assessed. Judged by running a game in front of people |

The report states the last two limits itself, so a clean run never reads as
"this session will go well".

## Install

Foundry v14 or later. Module management, Install Module, paste the manifest URL.

No dependencies: the manifest declares no `relationships`, so nothing else has
to be installed first.

## How it works

Everything is read from the Foundry **document model** — `game.scenes`, a Scene's
`walls` / `lights` / `tokens` / `notes` / `levels` embedded collections,
`game.users`, `game.journal`, `game.modules` — never from the interface. The
document model is typed and versioned; markup is neither, so a module that binds
to markup breaks silently on the next release.

There is one generic evaluator and N declarative rows in `data/checks.json`.
Adding a check means adding a row:

```json
{
  "id": "canvas.walls.doors",
  "week": 3,
  "competency": "Canvas and spatial calibration",
  "scope": "scene",
  "predicate": {
    "op": "some",
    "path": "walls",
    "where": { "op": "gte", "path": "door", "value": 1 }
  },
  "message": "No wall on this scene is configured as a door.",
  "hint": "Select a wall segment across a doorway and set its Door type."
}
```

`scope` is `scene`, `world` or `user`. `path` is a dot path into the document.
Operators are a closed set of eighteen, listed in `scripts/predicate.mjs`.

A check that cannot read what it needs reports **could not read**, never a
failure. The module has no opinion it will act on: nothing here cancels a hook,
blocks a document or gates a session.

## A failing check is not a wrong scene

The predicates test whether you used the tool, not whether the result looks a
particular way. A deliberately dark dungeon passes: one torch at the entrance,
or a light configured on the token carrying one, is the thing being checked, and
the walls have to be built either way.

## Development

```bash
bun test
```

76 tests, no Foundry required: the evaluator and predicates are pure and run
against plain objects.

## Licence

MIT.
