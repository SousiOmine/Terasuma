import { t } from "../../i18n";
import { SettingsPage } from "../../ui/SettingsSection";
import { WebSearchProviderSection } from "../websearch/WebSearchProviderSection";
import { LlmProviderSection } from "./LlmProviderSection";

/**
 * 設定の「プロバイダ」。
 *
 * モデルに使う LLM と、Web 検索に使う検索プロバイダを同じ場所に置く。
 * どちらも「追加 → 接続を確かめる → 使う」の順で進むので、一覧とダイアログの形を揃えている。
 */
export function ProviderSettingsView() {
  return (
    <SettingsPage title={t("settings.providers")}>
      <section class="border-b border-stroke pb-6">
        <LlmProviderSection />
      </section>
      <section>
        <WebSearchProviderSection />
      </section>
    </SettingsPage>
  );
}
