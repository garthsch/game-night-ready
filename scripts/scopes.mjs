/**
 * Scope resolution: turn Foundry's globals into the plain context objects the
 * check rows are written against.
 *
 * This is the only file that knows about `game` and `canvas`. Keeping it here
 * means the evaluator and the predicates stay testable, and it is the one place
 * to look when a v15 field rename breaks a row.
 *
 * No DOM selectors anywhere: every value below comes from a documented
 * document-model collection or document field.
 */

export const MODULE_ID = "game-night-ready";

/** The scene a check should be read against: whichever one the GM is looking at. */
export function currentScene() {
  return game.scenes?.viewed ?? canvas?.scene ?? null;
}

/**
 * The world context. Flattened deliberately: a row says `activeModuleCount`
 * rather than reaching through a Foundry Map, so the row stays readable and the
 * flattening is reviewable in one place.
 */
export function worldContext() {
  if ( !game?.ready ) return null;
  const modules = Array.from(game.modules?.values?.() ?? []);
  const active = modules.filter(m => m.active && (m.id !== MODULE_ID));
  return {
    activeModuleCount: active.length,
    activeModuleIds: active.map(m => m.id),
    moduleCount: modules.length,
    journal: game.journal?.contents ?? [],
    actors: game.actors?.contents ?? [],
    scenes: game.scenes?.contents ?? [],
    combats: game.combats?.contents ?? [],
    messageCount: game.messages?.size ?? 0,
    // User.character resolves the Actor document; `characterId` is the raw field.
    players: Array.from(game.users?.values?.() ?? [])
      .filter(u => !u.isGM)
      .map(u => ({ id: u.id, name: u.name, role: u.role, characterId: u.character?.id ?? null }))
  };
}

/** Everything a run needs, assembled once. */
export function collectScopes() {
  return {
    scene: currentScene(),
    world: worldContext(),
    user: game?.user ?? null
  };
}
