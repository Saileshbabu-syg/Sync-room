// Output encoding helpers for values that end up in outgoing mail.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

// Escapes text for use in HTML element content and quoted attribute values.
// Escape once, at the point of interpolation — never on stored data.
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

// Header values (subject etc.) must never contain line breaks or other control
// characters, otherwise they could smuggle extra headers.
export function sanitizeHeaderValue(value: unknown): string {
  return (
    String(value ?? "")
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
  );
}
