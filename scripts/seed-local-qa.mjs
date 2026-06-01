import admin from "firebase-admin";
const projectId = "fichad2";
const companyId = "qa-company-local";
const adminEmail = "qa-admin@example.com";
const workerEmail = "qa-worker@example.com";
const qaAdminUid = "qa-admin-local";
const qaWorkerUid = "qa-worker-local";
const adminPassword = "QaAdmin!2026";
const workerPassword = "QaWorker!2026";

process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8080";

admin.initializeApp({ projectId });

const auth = admin.auth();
const db = admin.firestore();
const now = admin.firestore.FieldValue.serverTimestamp();

async function deleteAuthUserByEmail(email) {
  try {
    const user = await auth.getUserByEmail(email);
    await auth.deleteUser(user.uid);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
  }
}

async function getOrCreateAuthUser({ uid, email, password, emailVerified, displayName }) {
  await deleteAuthUserByEmail(email);

  try {
    const userWithUid = await auth.getUser(uid);
    if (userWithUid.email !== email) {
      await auth.deleteUser(uid);
      throw Object.assign(new Error("Recreate QA user with expected email"), {
        code: "auth/user-not-found",
      });
    }
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    await auth.createUser({
      uid,
      email,
      password,
      emailVerified,
      displayName,
    });
  }

  await auth.updateUser(uid, {
    email,
    password,
    emailVerified,
    displayName,
    disabled: false,
  });

  return auth.getUser(uid);
}

async function seedUser({ uid, email, password, role, emailVerified, displayName }) {
  const user = await getOrCreateAuthUser({
    uid,
    email,
    password,
    emailVerified,
    displayName,
  });

  await db.collection("users").doc(uid).set(
    {
      email,
      role,
      companyId,
      displayName,
      name: displayName,
      active: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  );

  const staleProfiles = await db.collection("users").where("email", "==", email).get();
  const staleBatch = db.batch();
  staleProfiles.docs
    .filter((docSnap) => docSnap.id !== uid)
    .forEach((docSnap) => staleBatch.delete(docSnap.ref));
  if (staleProfiles.docs.some((docSnap) => docSnap.id !== uid)) {
    await staleBatch.commit();
  }

  return {
    email,
    password,
    uid,
    role,
    emailVerified,
    displayName: user.displayName,
  };
}

async function deleteQuerySnapshot(querySnapshot) {
  const batch = db.batch();
  querySnapshot.docs.forEach((docSnap) => batch.delete(docSnap.ref));
  if (!querySnapshot.empty) await batch.commit();
}

await db.collection("companies").doc(companyId).set(
  {
    name: "QA Local Company",
    cif: "QA-LOCAL",
    address: "Local emulator only",
    responsable: "QA Admin",
    ownerUid: null,
    createdAt: now,
    updatedAt: now,
  },
  { merge: true },
);

await db.collection("invitations").doc(workerEmail).set({
  email: workerEmail,
  companyId,
  role: "trabajador",
  createdBy: qaAdminUid,
  createdByEmail: adminEmail,
  createdAt: now,
});

const qaAdmin = await seedUser({
  uid: qaAdminUid,
  email: adminEmail,
  password: adminPassword,
  role: "administrador",
  emailVerified: true,
  displayName: "QA Admin Local",
});

const qaWorker = await seedUser({
  uid: qaWorkerUid,
  email: workerEmail,
  password: workerPassword,
  role: "trabajador",
  emailVerified: true,
  displayName: "QA Worker Local",
});

await deleteQuerySnapshot(
  await db.collection("logs").where("companyId", "==", companyId).get(),
);

await deleteQuerySnapshot(
  await db.collection("audit_logs").where("companyId", "==", companyId).get(),
);

await db.collection("companies").doc(companyId).set(
  {
    ownerUid: qaAdmin.uid,
    updatedAt: now,
  },
  { merge: true },
);

console.log(JSON.stringify(
  {
    environment: "Firebase Emulator Suite only",
    projectId,
    authEmulator: process.env.FIREBASE_AUTH_EMULATOR_HOST,
    firestoreEmulator: process.env.FIRESTORE_EMULATOR_HOST,
    companyId,
    invitationCreated: workerEmail,
    credentials: {
      admin: qaAdmin,
      worker: qaWorker,
    },
  },
  null,
  2,
));
