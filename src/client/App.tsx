import { view } from "./state/route";
import { ChatView } from "./features/chat/ChatView";
import { ComputerPane } from "./features/chat/ComputerPane";
import { SettingsView } from "./features/settings/SettingsView";
import { Sidebar } from "./features/chat/Sidebar";

export function App() {
  // 設定は全画面で開くので、チャット側のレイアウトごと差し替える。
  if (view.value === "settings") return <SettingsView />;

  return (
    <div class="flex h-full overflow-hidden">
      <Sidebar />
      <ChatView />
      {/* 右ペインは開いているときだけ出す（閉じている間は noVNC も繋がない）。 */}
      <ComputerPane />
    </div>
  );
}
