/**
 * 文字列をクリップボードへ写す。写せたら true。
 *
 * navigator.clipboard は https か localhost でしか使えないので、
 * http のまま LAN のアドレスで開いたときに代替が要る。
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined") {
    try {
      const clipboard = navigator.clipboard;
      if (typeof clipboard?.writeText === "function") {
        await clipboard.writeText(text);
        return true;
      }
    } catch {
      // 権限が無い・https でないなどで失敗したら、下の代替へ進む。
    }
  }

  if (typeof document === "undefined") return false;

  let textarea: HTMLTextAreaElement | null = null;
  try {
    textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";

    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea?.remove();
  }
}
