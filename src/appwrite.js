// The few Appwrite REST calls the archiver makes, all reads.
//
// Reads bill per row RETURNED, so the archiver never lists a table it can avoid listing: each
// commentary row is read once, by the `$createdAt` watermark, and a match's other rows are single
// `getRow`s by their deterministic id.

const PAGE_SIZE = 1000;

export function appwrite({ endpoint, project, key, fetchFn = fetch }) {
  const base = endpoint.replace(/\/$/, "");
  const headers = { "X-Appwrite-Project": project, "X-Appwrite-Key": key };
  const db = "bouncer-db";

  async function call(path) {
    const res = await fetchFn(base + path, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path.split("?")[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  const encode = (queries) => queries.map((q) => "queries[]=" + encodeURIComponent(JSON.stringify(q))).join("&");

  return {
    /** Every row matching `queries`, in pages, by cursor. Stops after `max` rows. */
    async *rows(table, queries, { max = Infinity } = {}) {
      let cursor = null;
      let seen = 0;
      while (seen < max) {
        const page = [...queries, { method: "limit", values: [Math.min(PAGE_SIZE, max - seen)] }];
        if (cursor) page.push({ method: "cursorAfter", values: [cursor] });
        const body = await call(`/tablesdb/${db}/tables/${table}/rows?${encode(page)}`);
        const rows = body?.rows ?? [];
        for (const row of rows) yield row;
        seen += rows.length;
        if (rows.length < PAGE_SIZE) return;
        cursor = rows[rows.length - 1].$id;
      }
    },

    getRow: (table, id) => call(`/tablesdb/${db}/tables/${table}/rows/${encodeURIComponent(id)}`),

    /** A `cricket-stats` file, parsed, or null when there is none. */
    file: (id) => call(`/storage/buckets/cricket-stats/files/${encodeURIComponent(id)}/download`),
  };
}
