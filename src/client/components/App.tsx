import { view } from "../state";
import { ChatView } from "./ChatView";
import { ComputerPane } from "./ComputerPane";
import { SettingsView } from "./SettingsView";
import { Sidebar } from "./Sidebar";

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
