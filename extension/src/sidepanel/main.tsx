import { createRoot } from "react-dom/client";
import SidePanelApp from "./SidePanelApp";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(<SidePanelApp />);
