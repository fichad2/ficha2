import { readFileSync } from "node:fs";
import { beforeEach, after, describe, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";

const PROJECT_ID = "fichad2";

const testEnv = await initializeTestEnvironment({
  projectId: PROJECT_ID,
  firestore: {
    rules: readFileSync("firestore.rules", "utf8"),
  },
});

const users = {
  worker: { uid: "worker-a", email: "worker-a@example.com", companyId: "company-a", role: "trabajador" },
  unverified: { uid: "worker-unverified", email: "worker-unverified@example.com", companyId: "company-a", role: "trabajador" },
  otherWorker: { uid: "worker-b", email: "worker-b@example.com", companyId: "company-b", role: "trabajador" },
  admin: { uid: "admin-a", email: "admin-a@example.com", companyId: "company-a", role: "administrador" },
  otherAdmin: { uid: "admin-b", email: "admin-b@example.com", companyId: "company-b", role: "administrador" },
};

function auth(user, emailVerified = true) {
  return testEnv.authenticatedContext(user.uid, {
    email: user.email,
    email_verified: emailVerified,
  }).firestore();
}

function anon() {
  return testEnv.unauthenticatedContext().firestore();
}

function baseLog(overrides = {}) {
  return {
    userId: users.worker.uid,
    companyId: users.worker.companyId,
    tipo: "entrada",
    timestamp: serverTimestamp(),
    ...overrides,
  };
}

async function seed() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();

    await setDoc(doc(db, "companies/company-a"), {
      name: "Company A",
      cif: "A00000000",
      address: "Street A",
      responsable: "Admin A",
      ownerUid: users.admin.uid,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await setDoc(doc(db, "companies/company-b"), {
      name: "Company B",
      cif: "B00000000",
      address: "Street B",
      responsable: "Admin B",
      ownerUid: users.otherAdmin.uid,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    for (const user of Object.values(users)) {
      await setDoc(doc(db, `users/${user.uid}`), {
        email: user.email,
        role: user.role,
        companyId: user.companyId,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
    }

    await setDoc(doc(db, "logs/log-company-a"), {
      userId: users.worker.uid,
      companyId: users.worker.companyId,
      tipo: "entrada",
      timestamp: new Date("2026-01-01T08:00:00.000Z"),
    });

    await setDoc(doc(db, "logs/log-company-b"), {
      userId: users.otherWorker.uid,
      companyId: users.otherWorker.companyId,
      tipo: "entrada",
      timestamp: new Date("2026-01-01T08:00:00.000Z"),
    });
  });
}

beforeEach(async () => {
  await testEnv.clearFirestore();
  await seed();
});

after(async () => {
  await testEnv.cleanup();
});

describe("ALLOW", () => {
  test("verified worker creates own log", async () => {
    await assertSucceeds(setDoc(doc(auth(users.worker), "logs/new-own-log"), baseLog()));
  });

  test("worker creates log only with own userId", async () => {
    await assertSucceeds(setDoc(doc(auth(users.worker), "logs/new-own-user"), baseLog({ userId: users.worker.uid })));
  });

  test("worker creates log only with own companyId", async () => {
    await assertSucceeds(setDoc(doc(auth(users.worker), "logs/new-own-company"), baseLog({ companyId: users.worker.companyId })));
  });

  test("admin reads own company workers", async () => {
    const workers = query(
      collection(auth(users.admin), "users"),
      where("companyId", "==", users.admin.companyId),
    );

    await assertSucceeds(getDocs(workers));
  });

  test("admin reads own company logs", async () => {
    const logs = query(
      collection(auth(users.admin), "logs"),
      where("companyId", "==", users.admin.companyId),
    );

    await assertSucceeds(getDocs(logs));
  });

  test("admin updates only allowed company fields", async () => {
    await assertSucceeds(updateDoc(doc(auth(users.admin), "companies/company-a"), {
      name: "Company A Updated",
      cif: "A11111111",
      address: "Street A Updated",
      responsable: "Admin A Updated",
      updatedAt: serverTimestamp(),
    }));
  });
});

describe("DENY", () => {
  test("unauthenticated access", async () => {
    await assertFails(getDoc(doc(anon(), "logs/log-company-a")));
    await assertFails(setDoc(doc(anon(), "logs/anon-log"), baseLog()));
  });

  test("worker creates log for another user", async () => {
    await assertFails(setDoc(doc(auth(users.worker), "logs/wrong-user"), baseLog({ userId: users.otherWorker.uid })));
  });

  test("worker creates log for another company", async () => {
    await assertFails(setDoc(doc(auth(users.worker), "logs/wrong-company"), baseLog({ companyId: users.otherWorker.companyId })));
  });

  test("worker sends custom timestamp", async () => {
    await assertFails(setDoc(doc(auth(users.worker), "logs/custom-timestamp"), baseLog({
      timestamp: new Date("2026-01-01T08:00:00.000Z"),
    })));
  });

  test("worker updates/deletes logs", async () => {
    await assertFails(updateDoc(doc(auth(users.worker), "logs/log-company-a"), { tipo: "salida" }));
    await assertFails(deleteDoc(doc(auth(users.worker), "logs/log-company-a")));
  });

  test("unverified worker creates log", async () => {
    await assertFails(setDoc(
      doc(auth(users.unverified, false), "logs/unverified-log"),
      baseLog({ userId: users.unverified.uid }),
    ));
  });

  test("admin updates forbidden company fields", async () => {
    await assertFails(updateDoc(doc(auth(users.admin), "companies/company-a"), {
      ownerUid: "changed-owner",
      updatedAt: serverTimestamp(),
    }));
  });

  test("user updates/deletes own profile", async () => {
    await assertFails(updateDoc(doc(auth(users.worker), `users/${users.worker.uid}`), { role: "administrador" }));
    await assertFails(deleteDoc(doc(auth(users.worker), `users/${users.worker.uid}`)));
  });

  test("cross-company reads", async () => {
    await assertFails(getDoc(doc(auth(users.admin), "users/worker-b")));
    await assertFails(getDoc(doc(auth(users.admin), "logs/log-company-b")));
  });

  test("invalid minutosSesion", async () => {
    await assertFails(setDoc(doc(auth(users.worker), "logs/invalid-minutes"), baseLog({
      tipo: "salida",
      minutosSesion: -1,
      entradaLogId: "log-company-a",
      inicioSesion: new Date("2026-01-01T08:00:00.000Z"),
    })));
  });
});
