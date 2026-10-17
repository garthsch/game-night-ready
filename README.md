# Game Night Ready

**A module for [Foundry Virtual Tabletop](https://foundryvtt.com) v14.**

Press one button before a session and see what is still outstanding in the
Foundry world you are about to run.

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
  "week": 2,
  "competency": "Canvas and spatial calibration",
  "topic": "Doors",
  "scope": "scene",
  "predicate": {
    "op": "some",
    "path": "walls",
    "where": {
      "op": "gte",
      "path": "door",
      "value": 1
    },
    "excludeBaseline": true
  },
  "message": "No wall you placed is configured as a door. If your map genuinely has no doors, this is expected.",
  "done": "You have configured a door on this scene.",
  "hint": "Select a wall segment across a doorway and set its Door type. A door you can open at the table is worth more than a wall you have to delete.",
  "needs": "canvas.scene.own",
  "tour": {
    "id": "core.canvasControls",
    "step": "walls"
  }
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

## The button takes you there

Each row may name one of the eight tours Foundry ships, plus the step inside it.
The report's next step then carries a **Show me** button, and pressing it starts
that tour on that step. Foundry's own tours do the work: `CanvasTour` activates
the layer and tool before the step renders, and `SidebarTour` opens the tab.

This module authors no tour steps of its own. Foundry maintains those selectors
for its own new-user experience, which is the only reason pointing at them is
cheap to keep; a step written here would bind the module to core markup, which is
the thing it refuses to do everywhere else.

Nine of the sixteen rows point at a step. The other seven carry their text and no
button, for two reasons. Four are set in Scene Configuration and no shipped step
highlights that dialog. Three want the sidebar's Settings tab, whose only shipped
step is the last step of its tour, and landing there renders the tour's Next
control as a finish-check: one click would complete a tour you never walked and
Foundry would then offer you the next one. A step is only worth pointing at if it
leaves the tour where it found it. A row names its step by id rather than by position, so a step inserted
upstream still resolves and a step renamed upstream drops the button and logs it
instead of sending you somewhere wrong.

Starting a tour at a step is the one place this module touches state outside its
own settings: Foundry saves the step a tour lands on, so the button would leave
your own tour progress moved. It is read before the jump and written back after,
so Foundry's tours stay where you left them.

## Development

Everything at the repository root is what ships: `module.json`, `scripts/`,
`data/`, `lang/`, `styles/`, `LICENSE`, `README.md`. The release zip is those
files and nothing else. Development material lives under `dev/` and is not part
of the module.

```bash
bun test
```

The tests in `dev/test/` need no Foundry: the evaluator and predicates are pure
and run against plain objects, and the parts that do touch Foundry are tested
against a shim of it.

## Licence

MIT.
