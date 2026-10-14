import type { ProviderCatalogEntry, ProviderCatalogId } from "../shared/providers";
import { t, type MessageKey } from "./i18n";

/**
 * カタログの名前をそのまま使わないものだけ、ここで差し替える。
 * 固有名詞（DeepSeek など）はカタログの名前をそのまま出す。
 */
const LOCALIZED_NAMES: Partial<Record<ProviderCatalogId, MessageKey>> = {
  custom: "provider.custom.name",
};

export function providerName(entry: ProviderCatalogEntry): string {
  const key = LOCALIZED_NAMES[entry.id];
  return key === undefined ? entry.name : t(key);
}
