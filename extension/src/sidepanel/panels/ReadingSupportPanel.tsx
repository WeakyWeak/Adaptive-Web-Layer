import React, { useState } from "react";
import FitTest from "../../fit/FitTest";
import DescribeMe from "./DescribeMe";
import type { SidePanelSectionProps } from "./index";

/** P11 "Reading support": a starting profile from a description, and the reading-fit test that measures. */
export default function ReadingSupportPanel(props: SidePanelSectionProps): React.ReactElement {
  const [fitOpen, setFitOpen] = useState(false);
  return (
    <div className="reading-support">
      <DescribeMe {...props} onConfirm={() => setFitOpen(true)} />
      <details open={fitOpen} onToggle={(event) => setFitOpen((event.target as HTMLDetailsElement).open)}>
        <summary><strong>Find my reading settings</strong> · a 5-minute reading test, no AI</summary>
        <FitTest />
      </details>
    </div>
  );
}
