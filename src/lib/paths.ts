/** Demo UI is isolated under /demo. Live product routes stay at the root. */

export const DEMO_PREFIX = "/demo";

export function isDemoPath(pathname: string): boolean {
  return pathname === DEMO_PREFIX || pathname.startsWith(`${DEMO_PREFIX}/`);
}

/** Map a live-shaped path onto the demo tree. `/` becomes `/demo`. */
export function demoHref(path: string): string {
  if (!path || path === "/") return DEMO_PREFIX;
  if (path.startsWith(DEMO_PREFIX)) return path;
  return `${DEMO_PREFIX}${path.startsWith("/") ? path : `/${path}`}`;
}

export function liveTaskHref(taskId: string): string {
  return `/tasks/${taskId}`;
}

export function liveCreateHref(): string {
  return "/tasks/new";
}

export function liveSubmitHref(taskId: string): string {
  return `/tasks/${taskId}/submit`;
}

export function liveDecisionHref(taskId: string): string {
  return `/tasks/${taskId}/decision`;
}

export function liveLibraryHref(): string {
  return "/library";
}

/** Isolated C3 V2 product UI. Does not include `/live-product-v2` harness. */
export function isV2ProductPath(pathname: string): boolean {
  return pathname === "/v2" || pathname.startsWith("/v2/");
}

export function v2BoardHref(): string {
  return "/v2";
}

export function v2CreateHref(): string {
  return "/v2/tasks/new";
}

export function v2TaskHref(taskId: string): string {
  return `/v2/tasks/${taskId}`;
}

export function v2SubmitHref(taskId: string): string {
  return `/v2/tasks/${taskId}/submit`;
}

export function v2DecisionHref(taskId: string): string {
  return `/v2/tasks/${taskId}/decision`;
}

export function v2LibraryHref(): string {
  return "/v2/library";
}
