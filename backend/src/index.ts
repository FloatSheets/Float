import "dotenv/config";

import { app } from "./app";
import { migrate } from "./db/migrate";

const port = Number(process.env.PORT ?? 3001);

await migrate();

app.listen(port, () => {
  console.log(`FloatSheets API listening on :${port}`);
});
