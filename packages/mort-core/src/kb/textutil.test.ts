import { describe, expect, it } from "vitest";
import { metaField, slugify } from "./textutil";

describe("textutil", () => {
  it("slugify normalises titles", () => {
    expect(slugify("Main Stage — Lighting")).toBe("main-stage-lighting");
    expect(slugify("E2 Camera Patching!")).toBe("e2-camera-patching");
    expect(slugify("   ")).toBe("doc");
  });

  it("metaField reads a Key: value line from the region body", () => {
    const body = "Zone: Main Stage\n\nSystem: Lighting\n\nType: Procedure\n\n## Body";
    expect(metaField(body, "System")).toBe("Lighting");
    expect(metaField(body, "zone")).toBe("Main Stage"); // case-insensitive
    expect(metaField(body, "Missing")).toBe(null);
  });
});
