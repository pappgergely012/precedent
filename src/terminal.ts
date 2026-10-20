const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const OSC = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`, "g");

const isUnsafe = (code: number): boolean =>
  code < 32 || (code >= 127 && code <= 159) || (code >= 0x200b && code <= 0x200f) || code === 0x2028 || code === 0x2029 || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff;

/**
 * Text from a review comment or a rules file, made safe to print as ONE terminal line: ANSI/OSC sequences are removed,
 * every other control, bidirectional and line-separator character (newlines included) becomes a space, so rule text
 * can neither move the cursor, retitle the window, nor forge an extra output line. Optionally cut to `max` characters.
 */
export function safeLine(text: string, max = 200): string {
  const stripped = text.replace(OSC, " ").replace(CSI, " ");
  let out = "";
  for (const ch of stripped) out += isUnsafe(ch.codePointAt(0)!) ? " " : ch;
  out = out.replace(/ {2,}/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}
