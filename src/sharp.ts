/** Shared first-use native image codec. Failed loads may be retried on the next request. */
let pending: Promise<(typeof import("sharp"))["default"]> | undefined;

export function loadSharp(): Promise<(typeof import("sharp"))["default"]> {
  pending ??= import("sharp")
    .then((module) => module.default)
    .catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
  return pending;
}
