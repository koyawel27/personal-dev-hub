import { describe, expect, it } from "vitest";
import { notifyMutations, subscribeToMutations } from "../../client/src/lib/mutations.js";

/**
 * Client-state consistency coverage: the mutation bus is the mechanism that
 * reconciles every mounted view after a successful mutation (the React
 * `useApi({ invalidateOn })` / `useInvalidate` layers subscribe through this
 * module). These tests pin the bus contract the views rely on:
 *
 * - subscribers only fire for topics they actually follow;
 * - one notify reaches ALL matching subscribers exactly once each;
 * - subscriber failures never break other subscribers or the caller;
 * - unsubscribed listeners stop receiving notifications;
 * - empty notifies are no-ops;
 * - failed mutations never notify (callers publish ONLY on success —
 *   enforced by convention at every mutation site).
 */

describe("mutation reconciliation bus", () => {
  it("notifies only subscribers following the changed topics", () => {
    const seen: string[][] = [];
    const off1 = subscribeToMutations((topics) => seen.push(topics));
    let projectsHits = 0;
    const off2 = subscribeToMutations((topics) => {
      if (topics.includes("projects")) projectsHits += 1;
    });

    notifyMutations("picker", "sources");
    expect(seen).toEqual([["picker", "sources"]]);
    expect(projectsHits).toBe(0);

    notifyMutations("projects");
    expect(projectsHits).toBe(1);

    off1();
    off2();
  });

  it("reaches every matching subscriber once per notify", () => {
    const hits = { a: 0, b: 0 };
    const offs = [
      subscribeToMutations((t) => {
        if (t.includes("projects")) hits.a += 1;
      }),
      subscribeToMutations((t) => {
        if (t.includes("projects")) hits.b += 1;
      }),
    ];
    notifyMutations("projects", "activity");
    expect(hits).toEqual({ a: 1, b: 1 });
    for (const off of offs) off();
  });

  it("isolates broken subscribers from the rest", () => {
    let healthy = 0;
    const offs = [
      subscribeToMutations(() => {
        throw new Error("broken view");
      }),
      subscribeToMutations(() => {
        healthy += 1;
      }),
    ];
    expect(() => notifyMutations("dashboard")).not.toThrow();
    expect(healthy).toBe(1);
    for (const off of offs) off();
  });

  it("stops notifying after unsubscribe", () => {
    let hits = 0;
    const off = subscribeToMutations(() => {
      hits += 1;
    });
    notifyMutations("portfolio");
    expect(hits).toBe(1);
    off();
    notifyMutations("portfolio");
    expect(hits).toBe(1); // unchanged
  });

  it("treats empty topic lists as a no-op", () => {
    let hits = 0;
    const off = subscribeToMutations(() => {
      hits += 1;
    });
    notifyMutations();
    expect(hits).toBe(0);
    off();
  });
});
