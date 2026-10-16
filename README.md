# Game Night Ready

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

## Where the button is

Three ways in, all GM-only:

- **Ctrl+Shift+G** is the one that works from anywhere, including with no scene
  open. Rebindable under Configure Controls.
- A clipboard button in the **Token**, **Walls** and **Lighting** scene
  controls, which are the three layers you are on while preparing a scene.
- `game.modules.get("game-night-ready").api.run()` from a macro or the console,
  if you would rather put it on your hotbar. It returns the results array as
  well as opening the report.

It is deliberately not its own control group. In v14, `activeTool` resolution
filters out button tools, and a tool's `onChange` fires only on a tool change,
so a group whose only tool is a button renders and does nothing when clicked.

There are no settings. A readiness check with a preferences page has lost the
plot.

## The verdict

The headline is the module's name, and it is a claim, so it is three-valued
rather than two:

| Verdict | When |
|---|---|
| `Game Night Ready.` | Every check passed **and** every check could be read |
| `Not game night ready yet: N outstanding.` | Something is missing |
| `Can't tell yet: N checks could not be read.` | Nothing is outstanding, but a check could not read the field it needs |

The third one matters. A check that could not read its field might be hiding a
gap, so saying "ready" there would make the name a lie. With no scene open,
every check reports unreadable and the module says so rather than passing you.

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

91 tests, no Foundry required: the evaluator and predicates are pure and run
against plain objects.

## Licence

MIT.
