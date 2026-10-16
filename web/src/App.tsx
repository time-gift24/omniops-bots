import { ChatScreen } from "@/components/chat/chat-screen";
import { SidebarRail } from "@/components/premium/sidebar-blocks/sidebar-rail";

export function App() {
  return (
    <SidebarRail workspaceName="Cognacta">
      <ChatScreen />
    </SidebarRail>
  );
}

export default App;
