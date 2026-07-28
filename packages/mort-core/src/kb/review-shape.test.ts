import { describe, expect, it } from "vitest";
import { isDreamProposal, reviewActionable, whyNotActionable } from "./review-shape";

/**
 * What a proposal is, judged the same way on both doors (v2 P8).
 *
 * The admin list and the chat's `decide_review` both ask these questions now.
 * The point of the module — and of this suite — is that there is one answer:
 * an admin told "that can't be approved" in conversation must find the same
 * item un-approvable when they open the console.
 */

describe("reviewActionable", () => {
  it("approves the four actions that have an executor behind them", () => {
    expect(reviewActionable({ action: "CREATE" })).toBe(true);
    expect(reviewActionable({ action: "UPDATE_ADDITIVE", target_doc_id: "d1" })).toBe(true);
    expect(reviewActionable({ action: "ATTACH", target_doc_id: "d1" })).toBe(true);
    expect(reviewActionable({ action: "tombstone" })).toBe(true);
  });

  it("refuses an edit whose target was stripped", () => {
    // Mort guessed a doc id and the invented-target guard removed it, so there
    // is nowhere for the write to land. Offering Approve just yields a 422.
    expect(reviewActionable({ action: "UPDATE_ADDITIVE", target_doc_id: null })).toBe(false);
    expect(reviewActionable({ action: "ATTACH" })).toBe(false);
    expect(whyNotActionable({ action: "ATTACH" })).toMatch(/guessed/);
  });

  it("never lets a dream observation be approved", () => {
    // R7's rule: a dream proposes, a human decides — and there is no edit
    // queued behind the observation for an approval to carry out.
    expect(isDreamProposal("DREAM:CONTRADICTION")).toBe(true);
    expect(reviewActionable({ action: "DREAM:CONTRADICTION" })).toBe(false);
    expect(whyNotActionable({ action: "DREAM:MISSING_PAGE" })).toMatch(/noticed/);
  });

  it("refuses anything nobody wrote an executor for", () => {
    expect(reviewActionable({ action: "REVIEW" })).toBe(false);
    expect(reviewActionable({ action: "SOMETHING_NEW" })).toBe(false);
  });

  it("always explains itself in a sentence a person can act on", () => {
    for (const action of ["ATTACH", "DREAM:MERGE", "REVIEW"]) {
      const why = whyNotActionable({ action });
      expect(why.length).toBeGreaterThan(20);
      expect(why).toMatch(/dismiss/i);
    }
  });
});
