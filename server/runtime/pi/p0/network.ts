// Deny every destination except this fixture's exact loopback origin, including
// redirects: native fetch follows redirects without re-entering our wrapper.
export function createFixtureFetch(origin: string, dispatch: typeof fetch): typeof fetch {
  const allowed = new URL(origin);
  if (allowed.protocol !== "http:" || allowed.hostname !== "127.0.0.1") {
    throw new Error("fixture requires an HTTP IPv4 loopback origin");
  }
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== allowed.origin || url.username || url.password) {
      throw new Error("P0 fixture refused a request outside its fake model origin");
    }
    return dispatch(input, { ...init, redirect: "error" });
  };
}
