import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { ConnectorProviderView } from "../../../shared/api/settings";
import { t } from "../../i18n";
import { Field } from "../../ui/Field";
import { INPUT_CLASS } from "../../ui/styles";
import { ConnectorForm } from "./ConnectorForm";

/** 画面から送る program コネクタの設定。空のキーとモデルは送らない。 */
export type ProgramSetupInput = { provider: string; apiKey?: string; model?: string };

type ProgramSetup = NonNullable<ConnectorProviderView["setup"]>;

/**
 * program コネクタ（pi）の設定。
 *
 * プロバイダを選び、API キーとモデルを入れて保存する。
 * キーが空なら「接続を確かめる」だけ（すでに設定済みのときに使う）。
 * キーはこの画面の state にだけ置き、会話や保存済みの表示には残さない。
 */
export function ProgramSetupForm({
  setup,
  busy,
  setupUrl,
  cancel,
  onSubmit,
}: {
  setup: ProgramSetup;
  busy: boolean;
  setupUrl: string;
  cancel?: ComponentChildren;
  onSubmit: (input: ProgramSetupInput) => void;
}) {
  const choices = setup.provider.choices;
  const [provider, setProvider] = useState(setup.provider.value ?? choices[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(setup.model.value ?? "");

  const selected = choices.find((choice) => choice.id === provider);
  const key = apiKey.trim();
  const configured = setup.provider.value !== null;
  const canSubmit = provider.length > 0 && (key.length > 0 || configured);

  const submit = (): void => {
    if (!canSubmit || busy) return;

    const input: ProgramSetupInput = { provider };
    if (key.length > 0) input.apiKey = key;
    const trimmedModel = model.trim();
    if (trimmedModel.length > 0) input.model = trimmedModel;

    onSubmit(input);
  };

  const submitLabel = t(
    busy
      ? "common.checking"
      : key.length > 0
        ? "settings.connectors.program.connect"
        : "settings.connectors.program.check",
  );

  return (
    <ConnectorForm
      setupUrl={setupUrl}
      setupLabel={t("settings.connectors.openSetup")}
      submitLabel={submitLabel}
      submitDisabled={busy || !canSubmit}
      onSubmit={submit}
      {...(cancel === undefined ? {} : { cancel })}
    >
      <Field label={setup.provider.label} description={setup.provider.description}>
        <select
          class={INPUT_CLASS}
          value={provider}
          aria-label={setup.provider.label}
          disabled={busy}
          onChange={(event) => setProvider(event.currentTarget.value)}
        >
          {choices.map((choice) => (
            <option key={choice.id} value={choice.id}>
              {choice.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label={setup.key.label} description={setup.key.description}>
        <input
          class={INPUT_CLASS}
          type="password"
          value={apiKey}
          placeholder={setup.key.placeholder}
          aria-label={setup.key.label}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          disabled={busy}
          onInput={(event) => setApiKey(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
        />
      </Field>

      <Field label={setup.model.label} description={setup.model.description}>
        <input
          class={INPUT_CLASS}
          type="text"
          value={model}
          placeholder={selected?.defaultModel ?? setup.model.placeholder}
          aria-label={setup.model.label}
          autocomplete="off"
          autocapitalize="off"
          spellcheck={false}
          disabled={busy}
          onInput={(event) => setModel(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            submit();
          }}
        />
      </Field>
    </ConnectorForm>
  );
}
