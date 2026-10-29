import { test } from "vitest";
import assert from "node:assert/strict";
import {
  shiftDate,
  weekDays,
  monthDays,
  inPeriod,
  matchesStatus,
} from "./calendar-model";
test("month navigation clamps month ends and preserves leap days", () => {
  assert.equal(shiftDate("2026-01-31", 1, "month"), "2026-02-28");
  assert.equal(shiftDate("2024-01-31", 1, "month"), "2024-02-29");
  assert.equal(shiftDate("2026-12-31", 1, "month"), "2027-01-31");
});
test("Monday based week spans year boundaries", () => {
  assert.deepEqual(weekDays("2027-01-01"), [
    "2026-12-28",
    "2026-12-29",
    "2026-12-30",
    "2026-12-31",
    "2027-01-01",
    "2027-01-02",
    "2027-01-03",
  ]);
  assert.equal(inPeriod("2026-12-31", "2027-01-01", "week"), true);
  assert.equal(inPeriod("2027-01-04", "2027-01-01", "week"), false);
});
test("month grid includes every date with complete weeks, without treating spillover as in-month", () => {
  const days = monthDays("2026-11-15");
  assert.equal(days.length, 42);
  assert.equal(days[0], "2026-10-26");
  assert.equal(days.at(-1), "2026-12-06");
  assert.equal(new Set(days).size, 42);
  assert.equal(inPeriod("2026-10-31", "2026-11-15", "month"), false);
  assert.equal(inPeriod("", "2026-11-15", "month"), false);
});
test("all includes done; ongoing includes awaiting review but excludes not-started", () => {
  assert.equal(matchesStatus("done", "all"), true);
  assert.equal(matchesStatus("review", "running"), true);
  assert.equal(matchesStatus("todo", "running"), false);
  assert.equal(matchesStatus("review", "done"), false);
  assert.equal(matchesStatus("todo", "todo"), true);
});
