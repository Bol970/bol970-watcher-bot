import { describe, expect, it } from "vitest";
import { looselyIncludes, looseNormalize } from "../src/utils";

describe("looseNormalize", () => {
  it("matches common Russian title inflections", () => {
    expect(looseNormalize("Медведь")).toBe(looseNormalize("Медведя"));
    expect(looseNormalize("Медведь")).toBe(looseNormalize("Медведем"));
  });
});

describe("looselyIncludes", () => {
  it("matches a Russian teacher name in another grammatical case", () => {
    expect(looselyIncludes("Алексей Шадрин", "Алексея Шадрина")).toBe(true);
    expect(looselyIncludes("Антон Мартынов", "Алексея Шадрина")).toBe(false);
  });
});
