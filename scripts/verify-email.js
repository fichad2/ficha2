import admin from "firebase-admin";
import fs from "node:fs";

const [serviceAccountPath, targetEmail] = process.argv.slice(2);

if (!serviceAccountPath || !targetEmail) {
  console.error("Uso: node scripts/verify-email.js <serviceAccount.json> <email>");
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, "utf-8"));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const user = await admin.auth().getUserByEmail(targetEmail);

if (user.emailVerified) {
  console.log(`El usuario ${targetEmail} ya estaba verificado.`);
  process.exit(0);
}

await admin.auth().updateUser(user.uid, { emailVerified: true });
console.log(`Email verificado para ${targetEmail} (uid ${user.uid}).`);
