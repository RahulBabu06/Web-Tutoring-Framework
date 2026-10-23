import app, { runParentReminders } from "./app.js";
import { port } from "./config/env.js";

app.listen(port, () => {
    console.log(`Listening on port ${port}: open http://localhost:${port}`);
    setTimeout(runParentReminders, 60 * 1000);
    setInterval(runParentReminders, 15 * 60 * 1000);
});
