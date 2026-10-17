import { ChatScreen } from "@/components/chat/chat-screen";
import { SidebarRail } from "@/components/premium/sidebar-blocks/sidebar-rail";

export function App() {
  return (
    <SidebarRail
      workspaceName="Cognacta"
      workspaceHeader={null}
      contentClassName="p-0 sm:p-0"
    >
      <ChatScreen />
    </SidebarRail>
  );
}

export default App;
