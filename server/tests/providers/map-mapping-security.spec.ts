import { describe, expect, jest, test } from "@jest/globals";

jest.mock("../../src/parse-workers-manager", () => ({ isUsingAdv3Lite: () => false }));

import MapObjectManager from "../../src/modules/mapcrawling/map-mapping";
import { TadsSymbolManager } from "../../src/modules/symbol-manager";

describe("map inheritance traversal security", () => {
  test("terminates cyclic inheritance while preserving discovered ancestors", () => {
    const symbols = new TadsSymbolManager();
    symbols.inheritanceMap.set("CycleA", "CycleB");
    symbols.inheritanceMap.set("CycleB", "CycleA");
    const manager = new MapObjectManager(symbols);
    const ancestors: string[] = [];

    manager.craftClassInheritanceArray("CycleA", ancestors);

    expect(ancestors).toEqual(["CycleB"]);
    expect(manager.inheritesFrom("CycleA", "Missing")).toBe(false);
  });
});
