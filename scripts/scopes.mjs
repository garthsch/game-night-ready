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

/**
 * The id of the scene Foundry creates with every new world. Fixed string, so
 * recognising it costs one comparison and survives any artwork change.
 */
export const FOUNDRY_DEFAULT_SCENE_ID = "NUEDEFAULTSCENE0";

/** Whatever scene the GM is looking at, including Foundry's own. */
export function viewedScene() {
  return game.scenes?.viewed ?? canvas?.scene ?? null;
}

/**
 * The scene a check should be read against.
 *
 * Foundry's shipped scene has a background, five lights and global illumination
 * off, so grading it hands the GM four passes for work they did not do. It is
 * not a scene under construction, so there is nothing here to read.
 */
export function currentScene() {
  const scene = viewedScene();
  return (scene && (scene.id !== FOUNDRY_DEFAULT_SCENE_ID)) ? scene : null;
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
  const viewed = viewedScene();
  return {
    scene: currentScene(),
    world: worldContext(),
    user: game?.user ?? null,
    onFoundryDefaultScene: viewed?.id === FOUNDRY_DEFAULT_SCENE_ID
  };
}
