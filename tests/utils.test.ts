import { describe, expect, it } from "vitest";
import { looseNormalize } from "../src/utils";

describe("looseNormalize", () => {
  it("matches common Russian title inflections", () => {
    expect(looseNormalize("Медведь")).toBe(looseNormalize("Медведя"));
    expect(looseNormalize("Медведь")).toBe(looseNormalize("Медведем"));
  });
});
