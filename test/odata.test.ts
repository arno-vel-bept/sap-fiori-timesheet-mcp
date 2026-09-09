import { describe, expect, it } from "vitest";
import { odataFilter, sapDate, isoDate, buildBatch, parseBatchResponse, unwrapResults, monthRange } from "../src/sap/odata.js";

describe("OData v2 helpers", () => {
  it("builds $filter strings with quoted values and escaped quotes", () => {
    expect(odataFilter({ Pernr: "08765432", StartDate: "20260901" })).toBe("Pernr eq '08765432' and StartDate eq '20260901'");
    expect(odataFilter({ FieldValue: "O'Brien" })).toBe("FieldValue eq 'O''Brien'");
  });

  it("converts between ISO dates and SAP yyyymmdd", () => {
    expect(sapDate("2026-09-03")).toBe("20260903");
    expect(sapDate(new Date(2026, 8, 3))).toBe("20260903");
    expect(isoDate("20260903")).toBe("2026-09-03");
    expect(() => sapDate("03/09/2026")).toThrow(/YYYY-MM-DD/);
  });

  it("computes a month range", () => {
    expect(monthRange(2026, 9)).toEqual({ start: "20260901", end: "20260930", startIso: "2026-09-01", endIso: "2026-09-30" });
    expect(monthRange(2024, 2).end).toBe("20240229");
  });

  it("unwraps d.results and d", () => {
    expect(unwrapResults({ d: { results: [1, 2] } })).toEqual([1, 2]);
    expect(unwrapResults({ d: { Id: "x" } })).toEqual([{ Id: "x" }]);
    expect(unwrapResults({ d: [] })).toEqual([]);
  });

  it("builds a multipart $batch with one changeset per POST", () => {
    const { body, contentType } = buildBatch(
      [
        { method: "POST", path: "TimeEntries", body: { Counter: "", TimeEntryOperation: "C" } },
        { method: "POST", path: "TimeEntries", body: { Counter: "1", TimeEntryOperation: "D" } },
      ],
      { boundary: "batch_x", changesetBoundary: "changeset_x" },
    );
    expect(contentType).toBe("multipart/mixed; boundary=batch_x");
    expect(body).toContain("--batch_x\r\nContent-Type: multipart/mixed; boundary=changeset_x_0");
    expect(body).toContain("POST TimeEntries HTTP/1.1");
    expect(body).toContain('{"Counter":"","TimeEntryOperation":"C"}');
    expect(body.match(/--changeset_x_\d--/g)).toHaveLength(2);
    expect(body.endsWith("--batch_x--\r\n")).toBe(true);
  });

  it("parses a $batch response into per-request status + bodies", () => {
    const resp = [
      "--B1",
      "Content-Type: multipart/mixed; boundary=C1",
      "",
      "--C1",
      "Content-Type: application/http",
      "Content-Transfer-Encoding: binary",
      "",
      "HTTP/1.1 201 Created",
      "Content-Type: application/json",
      "Content-Length: 25",
      "",
      '{"d":{"Counter":"000001"}}',
      "--C1--",
      "--B1",
      "Content-Type: application/http",
      "Content-Transfer-Encoding: binary",
      "",
      "HTTP/1.1 400 Bad Request",
      "Content-Type: application/json",
      "",
      '{"error":{"code":"X","message":{"lang":"en","value":"Nope"}}}',
      "--B1--",
      "",
    ].join("\r\n");
    const parts = parseBatchResponse(resp, "multipart/mixed; boundary=B1");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ status: 201, json: { d: { Counter: "000001" } } });
    expect(parts[1]).toMatchObject({ status: 400 });
    expect(parts[1].errorMessage).toBe("Nope");
  });
});
