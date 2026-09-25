import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validateEvent } from "../src/art_motif_review.js";

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
}

test("样例符合领域约定", async () => {
  const record = await readJson("../data/sample.json");
  assert.deepEqual(validateEvent(record), []);
});

test("样例事件流逐条符合领域约定", async () => {
  const stream = await readJson("../data/sample_stream.json");
  for (const record of stream) {
    assert.deepEqual(validateEvent(record), [], `${record.event_id} 应通过校验`);
  }
});

test("缺少必填字段或类型不符会被指出", () => {
  assert.deepEqual(validateEvent({ event_id: "x" }), ["kind", "occurred_at", "subject_id", "payload"]);
  assert.ok(validateEvent({ kind: "UNKNOWN_KIND" }).includes("kind"));

  const missingVersion = {
    event_id: "e1",
    kind: "PROVENANCE_RECORDED",
    occurred_at: "2026-06-01T00:00:00+08:00",
    subject_id: "m1",
    payload: { source_claim: "馆藏", evidence_refs: [], recorded_by: "r1" },
  };
  assert.ok(validateEvent(missingVersion).includes("payload.version"));

  const badDecision = {
    event_id: "e2",
    kind: "REVIEW_OPINION_ADDED",
    occurred_at: "2026-06-01T00:00:00+08:00",
    subject_id: "m1",
    payload: {
      opinion_id: "op1",
      reviewer: "r",
      discipline: "legal",
      jurisdiction: "EU",
      decision: "maybe",
      base_versions: { provenance: "pv1" },
    },
  };
  assert.ok(validateEvent(badDecision).includes("payload.decision"));
});

test("紧急停用必须随决定保存补审责任与期限", () => {
  const base = {
    event_id: "e3",
    kind: "RELEASE_SUSPENDED",
    occurred_at: "2026-06-01T00:00:00+08:00",
    subject_id: "pkg-1",
    payload: { reason: "舆情风险", emergency: true },
  };
  assert.ok(validateEvent(base).includes("payload.follow_up"));

  const noDue = { ...base, payload: { ...base.payload, follow_up: { owner: "review-board" } } };
  assert.ok(validateEvent(noDue).includes("payload.follow_up.due_at"));

  const ok = { ...base, payload: { ...base.payload, follow_up: { owner: "review-board", due_at: "2026-07-15" } } };
  assert.deepEqual(validateEvent(ok), []);
});
