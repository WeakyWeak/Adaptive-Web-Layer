import { createRoot } from "react-dom/client";
import OptionsApp from "./OptionsApp";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element");
createRoot(root).render(<OptionsApp />);
