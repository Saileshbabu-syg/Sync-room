// Spreadsheet applications run text that starts with = + - @ (or a control
// character) as a formula. Values that employees control - names, meeting
// titles - must not be able to do that in a downloaded report, so such text is
// prefixed with an apostrophe.
export function neutralizeFormula(value: string) {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}
