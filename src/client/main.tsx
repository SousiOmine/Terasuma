import { render } from "preact";
import { App } from "./components/App";
import { bootstrap } from "./state";

const root = document.getElementById("root");
if (root !== null) render(<App />, root);

void bootstrap();
