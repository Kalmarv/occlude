/** Group members by a classifier: first-occurrence key order, members in
 * collection order, Map equality on keys, one classifier call per member. */
export function groupRows<V, K>(members: Iterable<V>, rowOf: (v: V) => number, classify: (v: V, i: number) => K): { key: K; rows: number[] }[] {
  const groups = new Map<K, number[]>();
  let i = 0;
  for (const v of members) {
    const k = classify(v, i++);
    let rows = groups.get(k);
    if (!rows) {
      rows = [];
      groups.set(k, rows);
    }
    rows.push(rowOf(v));
  }
  return Array.from(groups, ([key, rows]) => ({ key, rows }));
}

