import { view } from "../state";
import { ChatView } from "./ChatView";
import { SettingsView } from "./SettingsView";
import { DeleteSessionDialog, Sidebar } from "./Sidebar";

export function App() {
  // 設定は全画面で開くので、チャット側のレイアウトごと差し替える。
  if (view.value === "settings") return <SettingsView />;

  return (
    <>
      <div class="flex h-full overflow-hidden">
        <Sidebar />
        <ChatView />
      </div>
      <DeleteSessionDialog />
    </>
  );
}
