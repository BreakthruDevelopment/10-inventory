/** Read a form field as a whole number. Empty is `undefined`. Anything else that is not an integer is `NaN`. */
export function wholeNumber(value: FormDataEntryValue | null): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  if (!/^-?\d+$/.test(value.trim())) return Number.NaN;
  return Number(value);
}

export function textValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}
