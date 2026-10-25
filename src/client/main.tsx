import { render } from "preact";
import { App } from "./App";
import { bootstrap } from "./state/bootstrap";
import { startThemeSync } from "./theme";

startThemeSync();

const root = document.getElementById("root");
if (root !== null) render(<App />, root);

void bootstrap();
