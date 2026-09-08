/**
 * Which group ROUTES a set of changed paths implies, deduplicated.
 *
 * Shared by the hub (which sends group deltas) and the provider's SSRM mode
 * (which applies them), so it lives in the spec package like the other
 * cross-boundary logic.
 *
 * A group aggregate is rendered by its PARENT's getRows (the parent returns its
 * children, aggregates included), so to refresh the "Govies" aggregate the
 * client refreshes the route to Govies' parent — the root, `[]`. A change deep
 * in the tree therefore refreshes the chain of ancestor routes, but each route
 * at most once: refreshing route `[]` once re-fetches every top-level group's
 * aggregate, so many sibling changes collapse to a single refresh.
 */
const SEP = String.fromCharCode(1);

export function routesToRefresh(changedPaths) {
  const routes = new Map();
  for (const path of changedPaths) {
    const route = path.slice(0, -1);
    routes.set(route.join(SEP), route);
  }
  return [...routes.values()];
}
