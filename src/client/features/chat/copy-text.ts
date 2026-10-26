import type { GroupPart } from "./timeline";

/** まとまりの中の本文だけをつなげる。添付の名前は入れない。 */
export function messageTextOf(parts: readonly GroupPart[]): string {
  const texts: string[] = [];

  for (const part of parts) {
    if (part.type !== "text") continue;

    const text = part.text.trim();
    if (text.length > 0) texts.push(text);
  }

  return texts.join("\n\n");
}
