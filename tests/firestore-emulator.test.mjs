import test from "node:test";
import assert from "node:assert/strict";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
import { createFirebaseAdapter, createClient } from "../dist/index.js";
test("Firestore real emulado: CRUD, isolamento e validação pelas regras", { skip: !process.env.FIRESTORE_EMULATOR_HOST }, async () => {
  const [host, rawPort] = process.env.FIRESTORE_EMULATOR_HOST.split(":");
  const appA = firebase.initializeApp({ projectId: "demo-moon" }, "owner-a");
  const appB = firebase.initializeApp({ projectId: "demo-moon" }, "owner-b");
  const dbA = appA.firestore(), dbB = appB.firestore();
  dbA.useEmulator(host, Number(rawPort), { mockUserToken: { sub: "owner-a", user_id: "owner-a" } });
  dbB.useEmulator(host, Number(rawPort), { mockUserToken: { sub: "owner-b", user_id: "owner-b" } });
  const auth = id => ({ async getUser() { return { user: { id } }; } });
  const a = createClient(createFirebaseAdapter(dbA, auth("owner-a"), true));
  const b = createClient(createFirebaseAdapter(dbB, auth("owner-b"), true));
  try {
    const note = await a.entities.Note.create({ title: "Primeiro" });
    assert.equal(note.user_id, "owner-a");
    assert.equal((await a.entities.Note.get(note.id)).title, "Primeiro");
    assert.equal((await b.entities.Note.list()).length, 0);
    await assert.rejects(b.entities.Note.update(note.id, { title: "invasão" }));
    assert.equal((await a.entities.Note.update(note.id, { title: "Segundo" })).title, "Segundo");
    await assert.rejects(dbA.collection("note").doc(note.id).update({ user_id: "owner-b" }));
    await assert.rejects(a.entities.Note.create({}));
    await a.entities.Note.delete(note.id);
    await assert.rejects(a.entities.Note.get(note.id), /not found/);
  } finally { await dbA.terminate(); await dbB.terminate(); await appA.delete(); await appB.delete(); }
});
