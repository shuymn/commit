export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function extractToolResultText(result: unknown): string {
  if (!isObjectRecord(result)) {
    return "";
  }

  const content = result.content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (isObjectRecord(item)) {
        return item.type === "text" && typeof item.text === "string" ? item.text : "";
      }
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

export function extractToolResultDetails(result: unknown): unknown {
  return isObjectRecord(result) ? result.details : undefined;
}
