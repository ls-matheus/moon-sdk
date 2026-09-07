import { writeFileSync } from "node:fs";
import { compileFirestore } from "../bin/database-schema.mjs";
writeFileSync(new URL("./generated-firestore.rules", import.meta.url), compileFirestore({
  version: 1, entities: { Note: { access: "owner", fields: { title: { type: "string", required: true } } } },
}));
