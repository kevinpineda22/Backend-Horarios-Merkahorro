// Recording fake of the supabase-js client: chained calls are logged, builders are thenable.
// `tables[name]` / `rpcs[name]` hold the result (or an array consumed one per call).
export function fakeSupabase({ tables = {}, rpcs = {} } = {}) {
  const log = [];
  const pick = (map, key) => {
    const v = map[key] ?? { data: null, error: null };
    return Array.isArray(v) ? v.shift() : v;
  };
  const chain = (result) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
          return (...args) => (log.push([prop, ...args]), chain(result));
        },
      },
    );
  const client = {
    from: (t) => (log.push(["from", t]), chain(pick(tables, t))),
    rpc: (fn, args) => (log.push(["rpc", fn, args]), chain(pick(rpcs, fn))),
  };
  return { client, log };
}

export const has = (log, ...call) => log.some((c) => JSON.stringify(c) === JSON.stringify(call));
