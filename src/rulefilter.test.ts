import { describe, expect, it } from "vitest";
import { dropReason, isEnglishText } from "./rulefilter.js";

describe("rule filters", () => {
  it("accepts ordinary English rules, including accented identifiers", () => {
    expect(isEnglishText("Use Annotated for dependencies instead of default values in FastAPI routes.")).toBe(true);
    expect(isEnglishText("Rename the café fixture to match the module.")).toBe(true);
  });

  it("rejects text in other scripts or without any English function word", () => {
    expect(isEnglishText("在文档中添加示例代码并保持一致")).toBe(false);
    expect(isEnglishText("Usa siempre parámetros anotados cuando declares dependencias")).toBe(false);
  });

  it("drops rules about agent-generated or local files, but not other dotfiles", () => {
    expect(dropReason({ description: "Add settings.local.json to gitignore.", scope: [".claude/**"] })).toBe("tool-artefact");
    expect(dropReason({ description: "Ignore local overrides.", scope: ["config/*.local.json"] })).toBe("tool-artefact");
    expect(dropReason({ description: "Keep .github workflows pinned to commit SHAs.", scope: [".github/**"] })).toBeUndefined();
  });
});
