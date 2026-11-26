import { describe, expect, it } from "vitest";
import { agyRecordItems, agyUserText } from "./agy-native.ts";

// What AGY 1.5.x records for a message sent after a model switch.
const WRAPPED = `<USER_REQUEST>
hi，测试一下新建会话
</USER_REQUEST>
<ADDITIONAL_METADATA>
The current local time is: 2026-11-26T09:10:07+08:00.
</ADDITIONAL_METADATA>
<USER_SETTINGS_CHANGE>
The user changed setting \`Model Selection\` from None to Gemini 4 Neon (High). No need to comment on this change if the user doesn't ask about it.
</USER_SETTINGS_CHANGE>`;

describe("AGY user input", () => {
  it("keeps only what the user typed", () => {
    expect(agyUserText(WRAPPED)).toBe("hi，测试一下新建会话");
    expect(agyRecordItems({ type: "USER_INPUT", step_index: 3, created_at: "2026-11-26T01:10:07Z", content: WRAPPED }))
      .toEqual([{ id: "agy:3", ts: Date.parse("2026-11-26T01:10:07Z"), kind: "user", text: "hi，测试一下新建会话" }]);
  });

  it("drops input that is only AGY's own blocks and keeps plain text as it is", () => {
    expect(agyRecordItems({ type: "USER_INPUT", step_index: 4, content: "<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>" })).toEqual([]);
    expect(agyUserText("native context")).toBe("native context");
    expect(agyUserText("compare <b> and </b>")).toBe("compare <b> and </b>");
  });

  it("leaves the agent's replies alone", () => {
    expect(agyRecordItems({ type: "PLANNER_RESPONSE", step_index: 5, content: "<USER_REQUEST>x</USER_REQUEST>" })[0]).toMatchObject({ kind: "assistant", text: "<USER_REQUEST>x</USER_REQUEST>" });
  });
});
