/** Small OData v2 helpers shared by the timesheet services. */

/** `{A: "1", B: "2"}` -> `A eq '1' and B eq '2'` (values are quoted; single quotes are doubled). */
export function odataFilter(eq: Record<string, string | number | undefined>, extra: string[] = []): string {
  const parts = Object.entries(eq)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} eq '${String(v).replace(/'/g, "''")}'`);
  return [...parts, ...extra].join(" and ");
}

export const odataQuote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** `?a=b&c=d` with spaces encoded as %20 (the way SAP UI5 sends $filter), or "" when empty. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

/** ISO date (YYYY-MM-DD) or Date -> SAP yyyymmdd. */
export function sapDate(d: string | Date): string {
  if (d instanceof Date) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  if (!m) throw new Error(`Invalid date "${d}": expected YYYY-MM-DD`);
  return `${m[1]}${m[2]}${m[3]}`;
}

/** SAP yyyymmdd -> ISO YYYY-MM-DD (already-ISO input is returned unchanged). */
export function isoDate(d: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d);
  if (!m) throw new Error(`Invalid SAP date "${d}": expected yyyymmdd`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function monthRange(year: number, month: number) {
  const mm = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}${mm}01`,
    end: `${year}${mm}${String(lastDay).padStart(2, "0")}`,
    startIso: `${year}-${mm}-01`,
    endIso: `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
  };
}

/** OData v2 JSON envelope -> array of entities. */
export function unwrapResults<T = Record<string, unknown>>(payload: unknown): T[] {
  const d = (payload as { d?: unknown })?.d;
  if (d === undefined || d === null) return [];
  if (Array.isArray(d)) return d as T[];
  const results = (d as { results?: unknown }).results;
  if (Array.isArray(results)) return results as T[];
  return [d as T];
}

export interface BatchRequest {
  method: "GET" | "POST" | "PUT" | "MERGE" | "DELETE";
  /** Relative to the service root, e.g. `TimeEntries` or `Favorites(ID='1',Pernr='2')`. */
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Serializes requests into an OData v2 $batch body. GETs are top-level parts;
 * every mutation gets its own changeset (mirrors the Fiori app, so each entry
 * succeeds or fails independently).
 */
export function buildBatch(
  requests: BatchRequest[],
  ids: { boundary?: string; changesetBoundary?: string } = {},
): { body: string; contentType: string } {
  const boundary = ids.boundary ?? `batch_${rand()}`;
  const csBase = ids.changesetBoundary ?? `changeset_${rand()}`;
  const CRLF = "\r\n";
  const parts: string[] = [];
  let cs = 0;
  for (const r of requests) {
    const bodyStr = r.body === undefined ? "" : JSON.stringify(r.body);
    const headers = [
      `${r.method} ${r.path} HTTP/1.1`,
      "Accept: application/json",
      "Accept-Language: en",
      "DataServiceVersion: 2.0",
      "MaxDataServiceVersion: 2.0",
      ...(bodyStr ? [`Content-Type: application/json`, `Content-Length: ${Buffer.byteLength(bodyStr)}`] : []),
      ...Object.entries(r.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    ].join(CRLF);
    const http = `Content-Type: application/http${CRLF}Content-Transfer-Encoding: binary${CRLF}${CRLF}${headers}${CRLF}${CRLF}${bodyStr}${CRLF}`;
    if (r.method === "GET") {
      parts.push(`--${boundary}${CRLF}${http}`);
    } else {
      const csb = `${csBase}_${cs++}`;
      parts.push(
        `--${boundary}${CRLF}Content-Type: multipart/mixed; boundary=${csb}${CRLF}${CRLF}--${csb}${CRLF}${http}--${csb}--${CRLF}`,
      );
    }
  }
  return { body: parts.join("") + `--${boundary}--${CRLF}`, contentType: `multipart/mixed; boundary=${boundary}` };
}

export interface BatchPart {
  status: number;
  headers: Record<string, string>;
  body: string;
  json?: unknown;
  /** OData error message, when the part failed. */
  errorMessage?: string;
}

/** Parses a $batch response (including nested changesets) into a flat list of parts in request order. */
export function parseBatchResponse(body: string, contentType: string): BatchPart[] {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
  if (!boundary) throw new Error(`No boundary in content-type "${contentType}"`);
  const out: BatchPart[] = [];
  for (const raw of splitMultipart(body, boundary)) {
    const { headers, rest } = splitHeaders(raw);
    const ct = headers["content-type"] ?? "";
    if (ct.startsWith("multipart/mixed")) {
      out.push(...parseBatchResponse(rest, ct));
      continue;
    }
    // application/http: status line, headers, blank line, body
    const { headers: _h, rest: httpMsg } = { headers, rest };
    void _h;
    const m = /^HTTP\/1\.\d (\d{3})[^\r\n]*\r?\n/.exec(httpMsg);
    if (!m) continue;
    const afterStatus = httpMsg.slice(m[0].length);
    const { headers: h2, rest: b } = splitHeaders(afterStatus);
    const part: BatchPart = { status: Number(m[1]), headers: h2, body: b.trim() };
    if (part.body && /json/.test(h2["content-type"] ?? "")) {
      try {
        part.json = JSON.parse(part.body);
      } catch {
        /* leave as text */
      }
    }
    if (part.status >= 400) {
      const err = (part.json as { error?: { message?: { value?: string } | string } })?.error;
      const msg = typeof err?.message === "string" ? err.message : err?.message?.value;
      part.errorMessage = msg ?? part.body.slice(0, 300);
    }
    out.push(part);
  }
  return out;
}

function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  const delim = `--${boundary}`;
  let idx = body.indexOf(delim);
  while (idx !== -1) {
    const afterDelim = idx + delim.length;
    if (body.startsWith("--", afterDelim)) break; // closing delimiter
    const lineEnd = body.indexOf("\n", afterDelim);
    const start = lineEnd === -1 ? afterDelim : lineEnd + 1;
    const next = body.indexOf(delim, start);
    const end = next === -1 ? body.length : next;
    parts.push(body.slice(start, end).replace(/\r?\n$/, ""));
    idx = next;
  }
  return parts;
}

function splitHeaders(block: string): { headers: Record<string, string>; rest: string } {
  const sep = /\r?\n\r?\n/.exec(block);
  const head = sep ? block.slice(0, sep.index) : block;
  const rest = sep ? block.slice(sep.index + sep[0].length) : "";
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, rest };
}

const rand = () => Math.random().toString(16).slice(2, 10);
